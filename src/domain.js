// 协助旅程领域服务：交接链、超时升级、迟到回执、改期重建、撤回与可见范围。
//
// 核心不变量：
//  1. 任一时刻一条旅程至多一个 IN_PROGRESS 节点 —— 即至多一名“当前负责人”；
//  2. 交出(offer)与接手(takeover)是两个独立操作，配对完成才转移责任；
//  3. 状态只向前流转：超时未接手即升级协调员，迟到回执只记录、不覆盖已发生的重新指派；
//  4. 敏感健康资料与公开任务分离加密存储，按岗位可见范围最小披露，访问全部留痕。
import { randomUUID } from "node:crypto";
import { decryptJson, encryptJson, hashToken, newPassengerToken } from "./crypto.js";
import { HEALTH_FIELDS, HEALTH_VISIBILITY, NODE_TEMPLATE, PASSENGER_NODE_STATUS, templateEntry } from "./templates.js";

export class DomainError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const fail = (status, code, message, details) => {
  throw new DomainError(status, code, message, details);
};

export const NODE = {
  PENDING: "PENDING",
  OFFERED: "OFFERED",
  IN_PROGRESS: "IN_PROGRESS",
  COMPLETED: "COMPLETED",
  ESCALATED: "ESCALATED",
  CANCELLED: "CANCELLED",
};

const HO = { OFFERED: "OFFERED", TAKEN: "TAKEN", EXPIRED: "EXPIRED", SUPERSEDED: "SUPERSEDED", CANCELLED: "CANCELLED" };
const JOURNEY = { ACTIVE: "ACTIVE", COMPLETED: "COMPLETED", CANCELLED: "CANCELLED" };

const iso = (d) => new Date(d).toISOString();

export class AssistService {
  constructor({ store, healthKey, now = () => new Date(), tokenTtlHours = 12 }) {
    this.store = store;
    this.healthKey = healthKey;
    this.now = now;
    this.tokenTtlHours = tokenTtlHours;
  }

  // ---------- 内部工具 ----------

  #event(state, journey, type, actor, data = {}) {
    state.events.push({
      id: `ev_${randomUUID()}`,
      at: iso(this.now()),
      journeyId: journey.journeyId,
      type,
      actor: { type: actor.type, id: actor.id ?? null, role: actor.role ?? null },
      ...data,
    });
  }

  #audit(state, journeyId, actor, action, extra = {}) {
    state.audit.push({
      id: `aud_${randomUUID()}`,
      at: iso(this.now()),
      journeyId,
      actor: { type: actor.type, id: actor.id ?? null, role: actor.role ?? null },
      action,
      ...extra,
    });
  }

  #journey(state, journeyId) {
    const j = state.journeys[journeyId];
    if (!j) fail(404, "JOURNEY_NOT_FOUND", `旅程 ${journeyId} 不存在`);
    return j;
  }

  #mustActive(j) {
    if (j.status !== JOURNEY.ACTIVE) fail(409, "JOURNEY_CLOSED", `旅程已${j.status === JOURNEY.COMPLETED ? "完成" : "取消"}，不能再操作`);
  }

  /** 超时结算：OFFERED 超过接手时限 → 交接单过期、节点升级、生成协调员升级单。 */
  #settle(journey, state) {
    const now = this.now();
    for (const node of journey.nodes) {
      if (node.status !== NODE.OFFERED) continue;
      const open = node.handovers.find((h) => h.status === HO.OFFERED);
      if (!open || now <= new Date(node.dueAt)) continue;
      open.status = HO.EXPIRED;
      open.expiredAt = iso(now);
      node.status = NODE.ESCALATED;
      const escalation = {
        id: `esc_${randomUUID()}`,
        nodeSeq: node.seq,
        handoverId: open.id,
        reason: "TAKEOVER_TIMEOUT",
        openedAt: iso(now),
        status: "OPEN",
        resolvedAt: null,
        resolvedBy: null,
        resolution: null,
      };
      journey.escalations.push(escalation);
      this.#event(state, journey, "HANDOVER_EXPIRED", { type: "system" }, { nodeSeq: node.seq, handoverId: open.id });
      this.#event(state, journey, "ESCALATION_OPENED", { type: "system" }, { nodeSeq: node.seq, escalationId: escalation.id });
    }
  }

  /** 读取旅程并先做超时结算（惰性结算，重启后首次访问即生效）。 */
  #settled(state, journeyId) {
    const j = this.#journey(state, journeyId);
    if (j.status === JOURNEY.ACTIVE) this.#settle(j, state);
    return j;
  }

  #currentNode(j) {
    return j.nodes.find((n) => n.status === NODE.IN_PROGRESS) ?? null;
  }

  #offeredNode(j) {
    return j.nodes.find((n) => n.status === NODE.OFFERED) ?? null;
  }

  #nextPending(j) {
    return j.nodes.find((n) => n.status === NODE.PENDING) ?? null;
  }

  #publicNode(n) {
    return {
      seq: n.seq,
      code: n.code,
      label: n.label,
      role: n.role,
      location: n.location ?? null,
      status: n.status,
      dueAt: n.dueAt,
      assignee: n.assignee,
      completedAt: n.completedAt ?? null,
      cancelReason: n.cancelReason ?? null,
    };
  }

  #publicJourney(j) {
    return {
      journeyId: j.journeyId,
      serviceCode: j.serviceCode,
      flight: j.flight,
      passengerRef: j.passengerRef,
      status: j.status,
      createdAt: j.createdAt,
    };
  }

  #staffNode(n) {
    return { ...this.#publicNode(n), handovers: n.handovers, internalNotes: n.internalNotes };
  }

  #buildNodes(inputNodes, startAt) {
    return inputNodes.map((item, i) => {
      const tpl = templateEntry(item.code);
      if (!tpl) fail(400, "UNKNOWN_NODE_CODE", `未知节点代码 ${item.code}`);
      const dueAt = item.dueAt
        ? iso(item.dueAt)
        : iso(new Date(startAt).getTime() + (i + 1) * 15 * 60_000);
      return {
        seq: i + 1,
        code: tpl.code,
        label: tpl.label,
        role: tpl.role,
        location: item.location ?? null,
        dueAt,
        status: NODE.PENDING,
        assignee: null,
        handovers: [],
        internalNotes: [],
        completedAt: null,
        cancelReason: null,
      };
    });
  }

  #openOffer(state, j, node, actor, offerKey) {
    const handover = {
      id: `ho_${randomUUID()}`,
      nodeSeq: node.seq,
      offeredBy: actor.id,
      offeredAt: iso(this.now()),
      offerKey: offerKey ?? null,
      status: HO.OFFERED,
      takenBy: null,
      takenAt: null,
      takeKey: null,
      lateReceipts: [],
    };
    node.handovers.push(handover);
    node.status = NODE.OFFERED;
    this.#event(state, j, "HANDOVER_OFFERED", actor, { nodeSeq: node.seq, handoverId: handover.id });
    return handover;
  }

  // ---------- 受理 ----------

  /**
   * 受理：只保存提供服务必需的信息（服务类别、航班、匿名旅客引用、节点计划）。
   * 健康备注按白名单字段裁剪后独立加密存储，旅程上只留引用。
   */
  intake(input, actor) {
    const { serviceCode, flight, passengerRef } = input ?? {};
    if (typeof serviceCode !== "string" || !serviceCode) fail(400, "INVALID_INPUT", "缺少 serviceCode");
    if (!flight || typeof flight.no !== "string" || !flight.no) fail(400, "INVALID_INPUT", "缺少 flight.no");
    if (typeof passengerRef !== "string" || !passengerRef) fail(400, "INVALID_INPUT", "缺少 passengerRef（匿名引用）");

    const journeyId = input.journeyId ?? `assist-${randomUUID().slice(0, 8)}`;
    const startAt = input.startAt ? new Date(input.startAt) : this.now();
    const nodeInputs = input.nodes ?? NODE_TEMPLATE.map((t) => ({ code: t.code, dueAt: iso(startAt.getTime() + t.offsetMinutes * 60_000) }));
    if (!Array.isArray(nodeInputs) || nodeInputs.length === 0) fail(400, "INVALID_INPUT", "节点计划不能为空");

    // 数据最小化：健康备注只保留已知必要字段，其余一律丢弃。
    const healthNote = {};
    for (const field of HEALTH_FIELDS) {
      if (input.healthNote && input.healthNote[field] !== undefined) healthNote[field] = input.healthNote[field];
    }

    return this.store.transact((state) => {
      if (state.journeys[journeyId]) fail(409, "JOURNEY_EXISTS", `旅程 ${journeyId} 已存在`);
      const nowIso = iso(this.now());
      const journey = {
        journeyId,
        serviceCode,
        flight: { no: flight.no, gate: flight.gate ?? null, departsAt: flight.departsAt ?? null },
        passengerRef,
        publicNote: typeof input.publicNote === "string" ? input.publicNote : null,
        status: JOURNEY.ACTIVE,
        createdAt: nowIso,
        nodes: this.#buildNodes(nodeInputs, startAt),
        escalations: [],
        healthNoteRef: null,
        healthNotePurgedAt: null,
      };
      if (Object.keys(healthNote).length > 0) {
        journey.healthNoteRef = `hn_${journeyId}`;
        state.secrets[journey.healthNoteRef] = encryptJson(this.healthKey, healthNote);
      }
      state.journeys[journeyId] = journey;

      // 首节点由受理人直接交出，等待一线人员扫码接手，交接链由此开始。
      const first = journey.nodes[0];
      const handover = this.#openOffer(state, journey, first, actor, input.idempotencyKey ?? null);

      const token = newPassengerToken();
      const expiresAt = iso(this.now().getTime() + this.tokenTtlHours * 3600_000);
      state.tokens[hashToken(token)] = { journeyId, expiresAt, createdAt: nowIso };

      this.#event(state, journey, "JOURNEY_CREATED", actor, { nodeCount: journey.nodes.length });
      this.#audit(state, journeyId, actor, "INTAKE", {
        decision: "ALLOW",
        basis: "受理登记",
        detail: `保存字段：serviceCode/flight/passengerRef/publicNote${journey.healthNoteRef ? "/healthNote(加密)" : ""}`,
      });

      return {
        status: 201,
        body: {
          journey: { ...this.#publicJourney(journey), nodes: journey.nodes.map((n) => this.#publicNode(n)) },
          firstHandover: handover,
          passengerToken: token,
          passengerTokenExpiresAt: expiresAt,
        },
      };
    });
  }

  // ---------- 交接：交出 / 接手（配对） ----------

  /** 交出：当前负责人把下一个未开始节点交出，等待下一岗位接手。 */
  offer(journeyId, actor, { idempotencyKey } = {}) {
    return this.store.transact((state) => {
      const j = this.#settled(state, journeyId);
      this.#mustActive(j);
      const current = this.#currentNode(j);
      if (!current) fail(409, "NO_ACTIVE_NODE", "当前没有进行中的节点，无法交出");
      if (current.assignee !== actor.id && actor.role !== "coordinator") {
        fail(403, "NOT_CURRENT_ASSIGNEE", "只有当前负责人可以交出下一节点");
      }
      const offered = this.#offeredNode(j);
      if (offered) {
        // 天然幂等：同一负责人重复交出同一节点，返回原交接单。
        const open = offered.handovers.find((h) => h.status === HO.OFFERED);
        if (open && open.offeredBy === actor.id) return { status: 200, body: { handover: open, node: this.#publicNode(offered), already: true } };
        fail(409, "OFFER_ALREADY_PENDING", `节点 ${offered.code} 已在等待接手`);
      }
      const next = this.#nextPending(j);
      if (!next) fail(409, "NO_NEXT_NODE", "没有可交出的后续节点");
      const handover = this.#openOffer(state, j, next, actor, idempotencyKey ?? null);
      return { status: 201, body: { handover, node: this.#publicNode(next) } };
    });
  }

  /**
   * 接手（扫码）：与交出配对。重复扫码幂等；超时/被取代的交接单一律拒绝，
   * 迟到回执只登记留痕，绝不覆盖已发生的重新指派。
   */
  takeover(journeyId, actor, { handoverId, idempotencyKey, occurredAt } = {}) {
    if (!handoverId) fail(400, "INVALID_INPUT", "缺少 handoverId");
    return this.store.transact((state) => {
      const j = this.#settled(state, journeyId);
      const node = j.nodes.find((n) => n.handovers.some((h) => h.id === handoverId));
      if (!node) fail(404, "HANDOVER_NOT_FOUND", `交接单 ${handoverId} 不存在`);
      const handover = node.handovers.find((h) => h.id === handoverId);

      if (handover.status === HO.TAKEN) {
        if (handover.takenBy === actor.id) {
          return { status: 200, body: { handover, node: this.#publicNode(node), already: true } };
        }
        fail(409, "HANDOVER_ALREADY_TAKEN", "该交接单已被他人接手", { currentAssignee: handover.takenBy });
      }

      if (handover.status !== HO.OFFERED) {
        // 迟到回执：只记录，不改变任何责任归属。
        const receipt = {
          staffId: actor.id,
          receivedAt: iso(this.now()),
          claimedAt: occurredAt ? iso(occurredAt) : null,
          handoverStatus: handover.status,
        };
        const dup = handover.lateReceipts.some((r) => r.staffId === actor.id && r.claimedAt === receipt.claimedAt);
        if (!dup) handover.lateReceipts.push(receipt);
        this.#event(state, j, "LATE_RECEIPT_RECORDED", actor, { nodeSeq: node.seq, handoverId, handoverStatus: handover.status });
        this.#audit(state, journeyId, actor, "LATE_RECEIPT", {
          decision: "DENY",
          basis: `交接单已${handover.status}，迟到回执不覆盖当前指派`,
          detail: `节点 ${node.code}，当前负责人 ${node.assignee ?? "无"}`,
        });
        fail(409, "HANDOVER_NO_LONGER_OPEN", "交接已超时或被重新指派，迟到回执仅作留痕", {
          handoverStatus: handover.status,
          currentAssignee: node.assignee,
        });
      }

      this.#mustActive(j);
      if (actor.role !== node.role && actor.role !== "coordinator") {
        this.#audit(state, journeyId, actor, "TAKEOVER", { decision: "DENY", basis: `岗位不符：需要 ${node.role}` });
        fail(403, "ROLE_MISMATCH", `节点 ${node.code} 需要岗位 ${node.role}`);
      }

      handover.status = HO.TAKEN;
      handover.takenBy = actor.id;
      handover.takenAt = iso(this.now());
      handover.takeKey = idempotencyKey ?? null;
      node.status = NODE.IN_PROGRESS;
      node.assignee = actor.id;
      const prev = j.nodes.find((n) => n.status === NODE.IN_PROGRESS && n.seq < node.seq);
      if (prev) {
        prev.status = NODE.COMPLETED;
        prev.completedAt = iso(this.now());
      }
      this.#event(state, j, "HANDOVER_TAKEN", actor, { nodeSeq: node.seq, handoverId });
      return {
        status: 200,
        body: {
          handover,
          node: this.#publicNode(node),
          completedNodeSeq: prev?.seq ?? null,
          currentResponsible: { nodeSeq: node.seq, staffId: actor.id },
        },
      };
    });
  }

  /** 完成当前节点；若无后续节点则旅程完成。 */
  complete(journeyId, actor, { idempotencyKey } = {}) {
    return this.store.transact((state) => {
      const j = this.#settled(state, journeyId);
      if (j.status === JOURNEY.COMPLETED) {
        return { status: 200, body: { journey: this.#publicJourney(j), already: true } };
      }
      this.#mustActive(j);
      const current = this.#currentNode(j);
      if (!current) fail(409, "NO_ACTIVE_NODE", "当前没有进行中的节点");
      if (current.assignee !== actor.id && actor.role !== "coordinator") {
        fail(403, "NOT_CURRENT_ASSIGNEE", "只有当前负责人可以完成该节点");
      }
      if (this.#offeredNode(j) || this.#nextPending(j)) {
        fail(409, "CHAIN_NOT_FINISHED", "仍有后续节点，请先交出而不是直接完成");
      }
      current.status = NODE.COMPLETED;
      current.completedAt = iso(this.now());
      j.status = JOURNEY.COMPLETED;
      this.#event(state, j, "NODE_COMPLETED", actor, { nodeSeq: current.seq });
      this.#event(state, j, "JOURNEY_COMPLETED", actor, {});
      return { status: 200, body: { journey: this.#publicJourney(j), completedNodeSeq: current.seq } };
    });
  }

  // ---------- 升级与重新指派 ----------

  /** 协调员重新指派：升级单关闭，节点直接指派给新负责人；旧交接单保持过期，迟到回执无效。 */
  reassign(escalationId, actor, { staffId, idempotencyKey } = {}) {
    if (typeof staffId !== "string" || !staffId) fail(400, "INVALID_INPUT", "缺少 staffId");
    return this.store.transact((state) => {
      let found = null;
      for (const j of Object.values(state.journeys)) {
        const esc = j.escalations.find((e) => e.id === escalationId);
        if (esc) {
          found = { j, esc };
          break;
        }
      }
      if (!found) fail(404, "ESCALATION_NOT_FOUND", `升级单 ${escalationId} 不存在`);
      const { j, esc } = found;
      if (esc.status !== "OPEN") fail(409, "ESCALATION_CLOSED", "升级单已处理", { resolution: esc.resolution });
      const node = j.nodes.find((n) => n.seq === esc.nodeSeq);
      node.status = NODE.IN_PROGRESS;
      node.assignee = staffId;
      const prev = j.nodes.find((n) => n.status === NODE.IN_PROGRESS && n.seq < node.seq);
      if (prev) {
        prev.status = NODE.COMPLETED;
        prev.completedAt = iso(this.now());
      }
      esc.status = "RESOLVED";
      esc.resolvedAt = iso(this.now());
      esc.resolvedBy = actor.id;
      esc.resolution = { staffId };
      this.#event(state, j, "ESCALATION_RESOLVED", actor, { nodeSeq: node.seq, escalationId, staffId });
      this.#audit(state, j.journeyId, actor, "REASSIGN", {
        decision: "ALLOW",
        basis: "接手超时升级，协调员重新指派",
        detail: `节点 ${node.code} 改派 ${staffId}`,
      });
      return {
        status: 200,
        body: { escalation: esc, node: this.#publicNode(node), currentResponsible: { nodeSeq: node.seq, staffId } },
      };
    });
  }

  // ---------- 航班/登机口变化：保留完成节点，重建未开始路线 ----------

  reroute(journeyId, actor, { flightNo, gate, startAt, nodes, reason, idempotencyKey } = {}) {
    return this.store.transact((state) => {
      const j = this.#settled(state, journeyId);
      this.#mustActive(j);
      const kept = j.nodes.filter((n) => n.status === NODE.COMPLETED || n.status === NODE.IN_PROGRESS);
      const dropped = j.nodes.filter((n) => !kept.includes(n));
      for (const node of dropped) {
        for (const h of node.handovers) {
          if (h.status === HO.OFFERED) h.status = HO.SUPERSEDED;
        }
        node.status = NODE.CANCELLED;
        node.cancelReason = "REROUTE";
        for (const esc of j.escalations) {
          if (esc.nodeSeq === node.seq && esc.status === "OPEN") {
            esc.status = "RESOLVED";
            esc.resolvedAt = iso(this.now());
            esc.resolvedBy = actor.id;
            esc.resolution = { rerouted: true };
          }
        }
      }

      const base = startAt ? new Date(startAt) : this.now();
      const maxSeq = Math.max(0, ...j.nodes.map((n) => n.seq));
      let specs;
      if (Array.isArray(nodes) && nodes.length > 0) {
        specs = nodes.map((n, i) => ({ code: n.code, dueAt: n.dueAt ? iso(n.dueAt) : iso(base.getTime() + (i + 1) * 15 * 60_000), location: n.location }));
      } else {
        const lastKept = kept[kept.length - 1];
        const idx = lastKept ? NODE_TEMPLATE.findIndex((t) => t.code === lastKept.code) : -1;
        if (idx === -1 && kept.length > 0) fail(400, "REROUTE_NEEDS_NODES", "当前节点不在标准模板内，请显式提供 nodes");
        const tail = NODE_TEMPLATE.slice(idx + 1);
        if (tail.length === 0) fail(409, "NO_NEXT_NODE", "后续没有可重建的节点");
        const delta = tail[0].offsetMinutes;
        specs = tail.map((t) => ({ code: t.code, dueAt: iso(base.getTime() + (t.offsetMinutes - delta) * 60_000) }));
      }

      const rebuilt = this.#buildNodes(specs, base).map((n, i) => ({ ...n, seq: maxSeq + i + 1 }));
      // 被取消的旧节点保留在链上（状态 CANCELLED/REROUTE）作为证据，新路线接续编号。
      j.nodes = [...j.nodes, ...rebuilt];
      if (flightNo) j.flight.no = flightNo;
      if (gate !== undefined) j.flight.gate = gate;

      // 若重建后无人负责（例如首节点尚未被接手），由操作人重新交出首节点，链条继续。
      if (!this.#currentNode(j)) {
        const first = this.#nextPending(j);
        if (first) this.#openOffer(state, j, first, actor, idempotencyKey ?? null);
      }
      this.#event(state, j, "REROUTED", actor, {
        keptNodeSeqs: kept.map((n) => n.seq),
        rebuiltNodeSeqs: rebuilt.map((n) => n.seq),
        reason: reason ?? null,
      });
      this.#audit(state, journeyId, actor, "REROUTE", { decision: "ALLOW", basis: reason ?? "航班/登机口变化" });
      const next = this.#nextPending(j) ?? this.#offeredNode(j);
      return {
        status: 200,
        body: {
          journey: { ...this.#publicJourney(j), nodes: j.nodes.map((n) => this.#publicNode(n)) },
          currentResponsible: this.#currentNode(j)
            ? { nodeSeq: this.#currentNode(j).seq, staffId: this.#currentNode(j).assignee }
            : null,
          nextNode: next ? this.#publicNode(next) : null,
        },
      };
    });
  }

  // ---------- 旅客：进度查询与撤回 ----------

  #tokenActor(token, journeyId) {
    const state = this.store.load();
    const rec = state.tokens[hashToken(token ?? "")];
    if (!rec || rec.journeyId !== journeyId) fail(401, "TOKEN_INVALID", "查询凭证无效");
    if (this.now() > new Date(rec.expiresAt)) fail(401, "TOKEN_EXPIRED", "查询凭证已过期");
    return { type: "passenger", id: `token:${hashToken(token).slice(0, 12)}`, role: "passenger" };
  }

  passengerProgress(journeyId, token) {
    const actor = this.#tokenActor(token, journeyId);
    return this.store.transact((state) => {
      const j = this.#settled(state, journeyId);
      const current = this.#currentNode(j);
      const offered = this.#offeredNode(j);
      return {
        status: 200,
        body: {
          journeyId: j.journeyId,
          serviceCode: j.serviceCode,
          flight: j.flight,
          status: j.status,
          currentStage: current ? current.label : offered ? `${offered.label}（等待交接）` : null,
          nodes: j.nodes.map((n) => ({ seq: n.seq, code: n.code, label: n.label, status: PASSENGER_NODE_STATUS[n.status] })),
        },
      };
    });
  }

  /** 撤回尚未执行的服务：完成节点保留，未开始/进行中节点取消；健康资料清除，操作证据依法保留。 */
  withdraw(journeyId, token, { reason } = {}) {
    const actor = this.#tokenActor(token, journeyId);
    return this.store.transact((state) => {
      const j = this.#settled(state, journeyId);
      if (j.status !== JOURNEY.ACTIVE) {
        return { status: 200, body: { journey: this.#publicJourney(j), already: true } };
      }
      for (const node of j.nodes) {
        if (node.status === NODE.COMPLETED) continue;
        for (const h of node.handovers) {
          if (h.status === HO.OFFERED) h.status = HO.CANCELLED;
        }
        node.status = NODE.CANCELLED;
        node.cancelReason = "WITHDRAWN";
      }
      for (const esc of j.escalations) {
        if (esc.status === "OPEN") {
          esc.status = "RESOLVED";
          esc.resolvedAt = iso(this.now());
          esc.resolvedBy = actor.id;
          esc.resolution = { withdrawn: true };
        }
      }
      j.status = JOURNEY.CANCELLED;
      if (j.healthNoteRef) {
        delete state.secrets[j.healthNoteRef];
        j.healthNotePurgedAt = iso(this.now());
      }
      this.#event(state, j, "JOURNEY_WITHDRAWN", actor, { reason: reason ?? null });
      this.#audit(state, journeyId, actor, "WITHDRAW", {
        decision: "ALLOW",
        basis: "旅客撤回未执行服务；操作证据与健康资料清除均留痕",
      });
      return { status: 200, body: { journey: this.#publicJourney(j), healthNotePurged: Boolean(j.healthNotePurgedAt) } };
    });
  }

  // ---------- 员工视图与敏感资料 ----------

  staffView(journeyId, actor) {
    return this.store.transact((state) => {
      const j = this.#settled(state, journeyId);
      const current = this.#currentNode(j);
      const next = this.#nextPending(j) ?? this.#offeredNode(j);
      const visibleFields = HEALTH_VISIBILITY[actor.role] ?? [];
      return {
        status: 200,
        body: {
          ...this.#publicJourney(j),
          publicNote: j.publicNote,
          nodes: j.nodes.map((n) => this.#staffNode(n)),
          escalations: j.escalations,
          currentResponsible: current ? { nodeSeq: current.seq, staffId: current.assignee } : null,
          nextNode: next ? this.#publicNode(next) : null,
          health: {
            available: Boolean(j.healthNoteRef) && !j.healthNotePurgedAt,
            fieldsVisibleToYou: visibleFields,
            readable: actor.role === "coordinator" || current?.assignee === actor.id,
          },
        },
      };
    });
  }

  /** 健康备注读取：仅当前节点负责人或协调员，按岗位可见范围裁剪，ALLOW/DENY 全部留痕。 */
  healthView(journeyId, actor) {
    return this.store.transact((state) => {
      const j = this.#settled(state, journeyId);
      const current = this.#currentNode(j);
      const isAssignee = current?.assignee === actor.id;
      if (actor.role !== "coordinator" && !isAssignee) {
        this.#audit(state, journeyId, actor, "HEALTH_READ", { decision: "DENY", basis: "非当前节点负责人" });
        fail(403, "HEALTH_FORBIDDEN", "只有当前节点负责人或协调员可以读取健康备注");
      }
      if (!j.healthNoteRef || j.healthNotePurgedAt) {
        this.#audit(state, journeyId, actor, "HEALTH_READ", { decision: "DENY", basis: "健康备注不存在或已清除" });
        fail(410, "HEALTH_PURGED", "健康备注不存在或已随撤回清除");
      }
      const all = decryptJson(this.healthKey, state.secrets[j.healthNoteRef]);
      const fields = HEALTH_VISIBILITY[actor.role] ?? [];
      const filtered = {};
      for (const f of fields) if (all[f] !== undefined) filtered[f] = all[f];
      this.#audit(state, journeyId, actor, "HEALTH_READ", {
        decision: "ALLOW",
        basis: actor.role === "coordinator" ? "协调员职责" : `节点 ${current.code} 当前负责人`,
        fields: Object.keys(filtered),
      });
      return { status: 200, body: { journeyId, fields: filtered } };
    });
  }

  addNote(journeyId, actor, { nodeSeq, text } = {}) {
    if (typeof text !== "string" || !text.trim()) fail(400, "INVALID_INPUT", "备注内容不能为空");
    return this.store.transact((state) => {
      const j = this.#settled(state, journeyId);
      const node = j.nodes.find((n) => n.seq === nodeSeq) ?? this.#currentNode(j);
      if (!node) fail(404, "NODE_NOT_FOUND", "节点不存在");
      const note = { at: iso(this.now()), by: actor.id, text: text.trim() };
      node.internalNotes.push(note);
      this.#event(state, j, "INTERNAL_NOTE_ADDED", actor, { nodeSeq: node.seq });
      return { status: 201, body: { nodeSeq: node.seq, note } };
    });
  }

  // ---------- 协调员视图 ----------

  chainView(journeyId, actor) {
    return this.store.transact((state) => {
      const j = this.#settled(state, journeyId);
      const now = this.now();
      const current = this.#currentNode(j);
      const brokenNode = j.nodes.find((n) => n.status === NODE.ESCALATED);
      return {
        status: 200,
        body: {
          journeyId: j.journeyId,
          status: j.status,
          brokenChain: Boolean(brokenNode),
          brokenNodeSeq: brokenNode?.seq ?? null,
          currentResponsible: current ? { nodeSeq: current.seq, staffId: current.assignee } : null,
          nodes: j.nodes.map((n) => {
            const open = n.handovers.find((h) => h.status === HO.OFFERED) ?? null;
            const last = n.handovers[n.handovers.length - 1] ?? null;
            return {
              ...this.#publicNode(n),
              responsible: n.assignee ?? last?.offeredBy ?? null,
              takeoverRemainingMs: n.status === NODE.OFFERED ? Math.max(0, new Date(n.dueAt) - now) : null,
              activeHandover: open,
              escalations: j.escalations.filter((e) => e.nodeSeq === n.seq),
            };
          }),
        },
      };
    });
  }

  listEscalations(actor) {
    return this.store.transact((state) => {
      const now = this.now();
      const open = [];
      for (const j of Object.values(state.journeys)) {
        if (j.status === JOURNEY.ACTIVE) this.#settle(j, state);
        for (const esc of j.escalations) {
          if (esc.status !== "OPEN") continue;
          const node = j.nodes.find((n) => n.seq === esc.nodeSeq);
          const handover = node?.handovers.find((h) => h.id === esc.handoverId);
          open.push({
            ...esc,
            journeyId: j.journeyId,
            nodeCode: node?.code,
            nodeLabel: node?.label,
            ageMs: Math.max(0, now - new Date(esc.openedAt)),
            lastResponsible: handover?.offeredBy ?? null,
          });
        }
      }
      return { status: 200, body: { escalations: open } };
    });
  }

  auditView(journeyId, actor) {
    return this.store.transact((state) => {
      this.#settled(state, journeyId);
      return {
        status: 200,
        body: {
          journeyId,
          audit: state.audit.filter((a) => a.journeyId === journeyId),
          events: state.events.filter((e) => e.journeyId === journeyId),
        },
      };
    });
  }

  listJourneys(actor) {
    return this.store.transact((state) => {
      const journeys = Object.values(state.journeys).map((j) => {
        if (j.status === JOURNEY.ACTIVE) this.#settle(j, state);
        const current = this.#currentNode(j);
        return {
          ...this.#publicJourney(j),
          currentResponsible: current ? { nodeSeq: current.seq, staffId: current.assignee } : null,
        };
      });
      return { status: 200, body: { journeys } };
    });
  }

  /** 供定时器调用：对所有活动旅程做超时结算。 */
  settleAll() {
    this.store.transact((state) => {
      for (const j of Object.values(state.journeys)) {
        if (j.status === JOURNEY.ACTIVE) this.#settle(j, state);
      }
    });
  }
}
