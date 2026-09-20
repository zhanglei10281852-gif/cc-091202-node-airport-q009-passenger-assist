// 应用服务：事务化命令处理。所有命令经同一互斥链串行执行，
// 每条命令先回放事件得到最新状态再判定，因此重复扫码/并发请求不会产生两名当前负责人。

import { getNodeDef, requireNodeDef, defaultRoute, SERVICE_CODES } from "../config/catalog.js";
import { issueQueryToken, newId, hashToken, safeEqual } from "../security/crypto.js";
import { fail } from "./errors.js";
import {
  reduce,
  activeNode,
  pendingNode,
  nextNode,
  chainBreak,
  NODE_STATUS,
} from "./state.js";

const ALLOWED_TASK_FIELDS = new Set(["bagTags", "transferKind", "boardingSequence", "seatRow"]);
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export class AssistanceService {
  constructor({ eventStore, auditLog, vault, directory, clock = () => new Date() }) {
    this.store = eventStore;
    this.audit = auditLog;
    this.vault = vault;
    this.directory = directory;
    this.clock = clock;
    this._chain = Promise.resolve();
  }

  // 串行执行一段临界区，返回其结果
  _exclusively(job) {
    const run = this._chain.then(() => job());
    // 不让单个失败污染整条链
    this._chain = run.then(() => undefined, () => undefined);
    return run;
  }

  _at(explicit) {
    const d = explicit ? new Date(explicit) : this.clock();
    if (Number.isNaN(d.getTime())) fail("invalid_time", "时间格式无效", 422);
    return d.toISOString();
  }

  _snapshot() {
    return reduce(this.store.events);
  }

  _getJourney(journeyId) {
    const journey = this._snapshot().get(journeyId);
    if (!journey) fail("journey_not_found", "旅程不存在", 404);
    return journey;
  }

  _auth(operatorId, pin, role = null) {
    const op = this.directory.verify(operatorId, pin);
    if (!op) fail("unauthorized", "人员身份或口令无效", 401);
    if (role && op.role !== role) fail("forbidden", "该操作需要岗位：" + role, 403);
    return op;
  }

  // 当前对某 ACTIVE 节点负责的人（首节点为预期值守人，其后为实际接手人）
  _responsibleFor(journey, node) {
    return node.handoff?.takeoverOperatorId ?? node.expectedAssignee;
  }

  // ---- 受理 ----
  accept(input) {
    return this._exclusively(async () => {
      const at = this._at(input.at);
      const serviceCode = input.serviceCode;
      if (!SERVICE_CODES.includes(serviceCode)) {
        fail("invalid_service_code", `服务类别必须是 ${SERVICE_CODES.join("/")}`);
      }
      if (!input.flight || typeof input.flight !== "string") {
        fail("invalid_flight", "航班号为提供服务所必需");
      }
      const flight = input.flight.trim().slice(0, 16);
      const gate = input.gate == null ? null : String(input.gate).trim().slice(0, 8) || null;
      // 最小必要：仅接受白名单内的公开任务字段，不存姓名/证件/联系方式
      const taskData = {};
      for (const [key, value] of Object.entries(input.taskData ?? {})) {
        if (!ALLOWED_TASK_FIELDS.has(key)) {
          fail("field_not_allowed", `字段 ${key} 不属于服务必需信息`, 422);
        }
        taskData[key] = value;
      }

      // 健康备注与公开任务分离；长度封顶以防滥用
      let healthNote = null;
      if (input.healthNote && input.healthNote.trim()) {
        healthNote = String(input.healthNote).trim().slice(0, 2000);
      }

      const startedAtMs = new Date(at).getTime();
      const routeSource = input.route?.length
        ? input.route
        : defaultRoute(startedAtMs);
      const route = routeSource.map((step) => {
        const def = requireNodeDef(step.code);
        return {
          code: step.code,
          dueAt: step.dueAt ?? new Date(startedAtMs + def.defaultOffsetMs).toISOString(),
          expectedAssignee: step.expectedAssignee ?? this.directory.primaryFor(step.code),
        };
      });

      // 校验全部通过后才写入保险库，避免孤立密文
      const healthRef = healthNote ? this.vault.put(healthNote) : null;

      const { token, hash } = issueQueryToken();
      const tokenExpiresAt = new Date(startedAtMs + TOKEN_TTL_MS).toISOString();
      const journeyId = newId("jny");

      await this.store.append({
        eventId: newId("evt"),
        journeyId,
        type: "JOURNEY_ACCEPTED",
        at,
        payload: {
          at,
          serviceCode,
          flight,
          gate,
          taskData,
          healthRef,
          route,
          startedAt: at,
          tokenHash: hash,
          tokenExpiresAt,
        },
      });
      await this.audit.record("JOURNEY_ACCEPTED", {
        journeyId,
        actor: "service-center",
        at,
        detail: { serviceCode, flight, hasHealthNote: healthRef !== null, nodeCount: route.length },
      });
      await this.audit.record("TOKEN_ISSUED", {
        journeyId,
        actor: "service-center",
        at,
        detail: { expiresAt: tokenExpiresAt },
      });
      return { journeyId, queryToken: token, expiresAt: tokenExpiresAt };
    });
  }

  // ---- 交出 ----
  handover(journeyId, { operatorId, pin, at } = {}) {
    return this._exclusively(async () => {
      at = this._at(at);
      const journey = this._getJourney(journeyId);
      const op = this._auth(operatorId, pin);
      if (journey.status === "WITHDRAWN") fail("journey_withdrawn", "服务已撤回", 409);
      if (journey.status === "COMPLETED") fail("journey_completed", "服务已完成", 409);

      const pending = pendingNode(journey);
      // 已有未完成的交接时：交出人重复扫码报“已交出待接手”，其他人一律禁止
      if (pending) {
        if (pending.handoff.fromOperatorId === op.operatorId) {
          fail("already_handed_over", `下一节点 ${pending.code} 仍待接手，不可重复交出`, 409, {
            handoffId: pending.handoff.handoffId,
          });
        }
        fail("forbidden", "存在待接手交接，只有交出人可查看/操作该交接", 403);
      }

      const active = activeNode(journey);
      if (!active) fail("no_active_node", "当前没有进行中的服务节点", 409);
      if (this._responsibleFor(journey, active) !== op.operatorId) {
        fail("forbidden", "只有当前节点负责人才可交出", 403);
      }
      const idx = journey.nodes.findIndex((n) => n.code === active.code);
      // 跳过撤回时已取消的节点，找到下一个尚未开始的节点
      const target = journey.nodes
        .slice(idx + 1)
        .find((n) => n.status === NODE_STATUS.WAITING);
      if (!target) fail("last_node", "已是路线末端，无可交接节点", 409);

      const def = getNodeDef(target.code);
      const deadline = new Date(new Date(at).getTime() + def.takeoverLimitMs).toISOString();
      const handoffId = newId("hnd");
      await this.store.append({
        eventId: newId("evt"),
        journeyId,
        type: "HANDED_OVER",
        at,
        payload: {
          handoffId,
          node: active.code,
          byOperatorId: op.operatorId,
          at,
          deadline,
        },
      });
      await this.audit.record("HANDED_OVER", {
        journeyId,
        actor: op.operatorId,
        at,
        detail: { from: active.code, to: target.code, handoffId, deadline },
      });
      return {
        handoffId,
        from: active.code,
        to: target.code,
        toName: def.name,
        deadline,
        expectedAssignee: target.expectedAssignee,
      };
    });
  }

  // ---- 接手 ----
  takeover(journeyId, { operatorId, pin, at } = {}) {
    return this._exclusively(async () => {
      at = this._at(at);
      const journey = this._getJourney(journeyId);
      const op = this._auth(operatorId, pin);
      if (journey.status === "WITHDRAWN") fail("journey_withdrawn", "服务已撤回", 409);

      const pending = pendingNode(journey);
      if (!pending) fail("no_pending_handover", "当前没有待接手的交接", 409);
      const def = getNodeDef(pending.code);

      const handoff = pending.handoff;

      // 交出与接手必须由不同操作人配对（优先于岗位判断，明确拒绝本人接手）
      if (handoff.fromOperatorId === op.operatorId) {
        fail("self_handover_forbidden", "交出人与接手人不得为同一人", 403);
      }
      if (op.role !== def.role) {
        fail("wrong_station", `该交接需要岗位 ${def.role}`, 403);
      }
      const isCurrentAssignee = handoff.currentAssignee === op.operatorId;
      // 曾被指派但已被改派替换的人：其重发/迟到回执在任何时刻都不得抢回交接
      const wasFormerAssignee = handoff.reassignments.some(
        (r) => r.fromOperatorId === op.operatorId,
      );
      if (!isCurrentAssignee && !wasFormerAssignee) {
        fail("not_assigned", "你不是该交接的指派接手人", 403);
      }
      if (!isCurrentAssignee) {
        await this.audit.record("LATE_TAKEOVER_REJECTED", {
          journeyId,
          actor: op.operatorId,
          at,
          reason: "reassignment_superseded",
          detail: {
            node: pending.code,
            attemptedBy: op.operatorId,
            currentAssignee: handoff.currentAssignee,
          },
        });
        fail("takeover_superseded", "该交接已被协调员重新指派，迟到接手被拒绝", 409);
      }

      const overdue = new Date(at).getTime() > new Date(handoff.deadline).getTime();
      if (overdue) {
        // 幂等升级：未升级则先升级
        if (!handoff.escalated) {
          await this._escalate(journeyId, pending.code, at, "takeover_deadline_exceeded");
        }
        await this.audit.record("LATE_TAKEOVER_REJECTED", {
          journeyId,
          actor: op.operatorId,
          at,
          reason: "deadline_exceeded",
          detail: {
            node: pending.code,
            attemptedBy: op.operatorId,
            currentAssignee: handoff.currentAssignee,
            deadline: handoff.deadline,
          },
        });
        fail("handover_escalated", "接手已超时升级，等待协调员重新指派", 409);
      }

      await this.store.append({
        eventId: newId("evt"),
        journeyId,
        type: "TAKEN_OVER",
        at,
        payload: { handoffId: handoff.handoffId, node: pending.code, byOperatorId: op.operatorId, at },
      });
      await this.audit.record("TAKEN_OVER", {
        journeyId,
        actor: op.operatorId,
        at,
        detail: { node: pending.code, handoffId: handoff.handoffId },
      });
      return {
        handoffId: handoff.handoffId,
        node: pending.code,
        nodeName: def.name,
        takenOverAt: at,
      };
    });
  }

  // ---- 完成当前节点（末端节点由乘务员关闭服务） ----
  complete(journeyId, { operatorId, pin, at } = {}) {
    return this._exclusively(async () => {
      at = this._at(at);
      const journey = this._getJourney(journeyId);
      const op = this._auth(operatorId, pin);
      const active = activeNode(journey);
      if (!active) fail("no_active_node", "当前没有进行中的服务节点", 409);
      if (this._responsibleFor(journey, active) !== op.operatorId) {
        fail("forbidden", "只有当前节点负责人才可完成本节点", 403);
      }
      const idx = journey.nodes.indexOf(active);
      const isLast = idx === journey.nodes.length - 1;
      const hasNext = journey.nodes
        .slice(idx + 1)
        .some((n) => n.status === NODE_STATUS.WAITING || n.status === NODE_STATUS.PENDING);
      // 中途节点必须交出到下一节点；只有末端（机舱门）可直接关闭服务
      if (!isLast && hasNext) {
        fail("must_handover", "中途节点须交出给下一节点，不能直接完成", 409);
      }
      await this.store.append({
        eventId: newId("evt"),
        journeyId,
        type: "SERVICE_COMPLETED",
        at,
        payload: { node: active.code, byOperatorId: op.operatorId, at, final: isLast },
      });
      await this.audit.record("SERVICE_COMPLETED", {
        journeyId,
        actor: op.operatorId,
        at,
        detail: { node: active.code, final: isLast },
      });
      // 撤回后仍在收尾的末端节点：收尾完成即销毁保留的敏感密文
      if (journey.status === "WITHDRAWN" && journey.healthRef
        && this.vault.has(journey.healthRef)) {
        await this.vault.destroy(journey.healthRef);
      }
      return { node: active.code, completedAt: at, serviceFinished: isLast };
    });
  }

  // ---- 超时扫描（定时器入口），幂等 ----
  sweepEscalations(at) {
    return this._exclusively(() => this._sweepEscalations(this._at(at)));
  }

  // 调用方须已持有互斥权
  async _sweepEscalations(at) {
    const escalated = [];
    for (const journey of this._snapshot().values()) {
      if (journey.status !== "ACTIVE") continue;
      const pending = pendingNode(journey);
      if (!pending || pending.handoff.escalated) continue;
      if (new Date(at).getTime() > new Date(pending.handoff.deadline).getTime()) {
        await this._escalate(journey.journeyId, pending.code, at, "takeover_deadline_exceeded");
        escalated.push({ journeyId: journey.journeyId, node: pending.code });
      }
    }
    return escalated;
  }

  // 调用方必须已持有互斥权
  async _escalate(journeyId, node, at, reason) {
    await this.store.append({
      eventId: newId("evt"),
      journeyId,
      type: "ESCALATED",
      at,
      payload: { node, at },
    });
    await this.audit.record("ESCALATED", {
      journeyId,
      actor: "system",
      at,
      reason,
      detail: { node },
    });
  }

  // ---- 协调员改派 ----
  reassign(journeyId, { operatorId, pin, toOperatorId, at } = {}) {
    return this._exclusively(async () => {
      at = this._at(at);
      this._auth(operatorId, pin, "COORDINATOR");
      const journey = this._getJourney(journeyId);
      const pending = pendingNode(journey);
      if (!pending) fail("no_pending_handover", "当前没有待接手的交接", 409);
      if (!pending.handoff.escalated) {
        fail("not_escalated", "仅在超时升级后才可改派", 409);
      }
      const target = this.directory.get(toOperatorId);
      if (!target) fail("unknown_operator", "目标人员不存在", 404);
      const def = getNodeDef(pending.code);
      if (target.role !== def.role) fail("wrong_station", `该节点需要岗位 ${def.role}`, 403);
      if (target.operatorId === pending.handoff.fromOperatorId) {
        fail("self_handover_forbidden", "改派目标不得是交出人本人", 403);
      }

      const newDeadline = new Date(new Date(at).getTime() + def.takeoverLimitMs).toISOString();
      await this.store.append({
        eventId: newId("evt"),
        journeyId,
        type: "REASSIGNED",
        at,
        payload: {
          node: pending.code,
          fromOperatorId: pending.handoff.currentAssignee,
          toOperatorId: target.operatorId,
          newDeadline,
          at,
        },
      });
      await this.audit.record("REASSIGNED", {
        journeyId,
        actor: operatorId,
        at,
        detail: {
          node: pending.code,
          from: pending.handoff.currentAssignee,
          to: target.operatorId,
          newDeadline,
        },
      });
      return { node: pending.code, assignee: target.operatorId, deadline: newDeadline };
    });
  }

  // ---- 航班/登机口变化：保留已开始节点，只重建未开始路线 ----
  rebuildRoute(journeyId, { operatorId, pin, flight, gate, at } = {}) {
    return this._exclusively(async () => {
      at = this._at(at);
      this._auth(operatorId, pin, "COORDINATOR");
      const journey = this._getJourney(journeyId);
      if (journey.status !== "ACTIVE") {
        fail("journey_not_active", "仅进行中的旅程可重建路线", 409);
      }
      if (!flight && !gate) fail("no_change", "须提供新的航班号或登机口", 422);

      const startedCodes = new Set(
        journey.nodes
          .filter((n) => n.status !== NODE_STATUS.WAITING && n.status !== NODE_STATUS.CANCELLED)
          .map((n) => n.code),
      );
      // 按目录标准顺序找出尚未开始的后续节点
      const remaining = ["CHECKIN", "SECURITY_ENTRY", "TERMINAL_TRANSFER", "GATE", "CABIN_DOOR"]
        .map(getNodeDef)
        .filter((def) => !startedCodes.has(def.code));

      await this._appendRebuild(journeyId, {
        flight, gate, remaining, at, baseMs: new Date(at).getTime(), actor: operatorId,
      });
      return this._rebuildResult(journeyId);
    });
  }

  async _appendRebuild(journeyId, { flight, gate, remaining, at, baseMs, actor }) {
    // 用目录中相邻节点的标准时间差安排新路线，首站给一个最短到场窗口
    const route = [];
    let when = baseMs + 10 * 60 * 1000;
    let prevDef = null;
    for (const def of remaining) {
      if (prevDef) when += def.defaultOffsetMs - prevDef.defaultOffsetMs;
      route.push({ code: def.code, dueAt: new Date(when).toISOString(), expectedAssignee: this.directory.primaryFor(def.code) });
      prevDef = def;
    }
    const payload = { route, at };
    if (flight !== undefined) payload.flight = flight;
    if (gate !== undefined) payload.gate = gate;
    await this.store.append({
      eventId: newId("evt"),
      journeyId,
      type: "ROUTE_REBUILT",
      at,
      payload,
    });
    await this.audit.record("ROUTE_REBUILT", {
      journeyId,
      actor,
      at,
      detail: { flight: flight ?? null, gate: gate ?? null, rebuilt: route.map((s) => s.code) },
    });
  }

  _rebuildResult(journeyId) {
    const journey = this._getJourney(journeyId);
    return {
      flight: journey.flight,
      gate: journey.gate,
      next: this._publicNext(journey),
      nodes: journey.nodes.map((n) => ({ code: n.code, status: n.status, dueAt: n.dueAt })),
    };
  }

  _publicNext(journey, { includeStaff = true } = {}) {
    const node = nextNode(journey);
    if (!node) return null;
    const def = getNodeDef(node.code);
    const view = {
      code: node.code,
      name: def.name,
      status: node.status,
      dueAt: node.dueAt,
      deadline: node.handoff?.deadline ?? null,
    };
    if (includeStaff) view.assignee = node.handoff?.currentAssignee ?? node.expectedAssignee;
    return view;
  }

  // ---- 旅客撤回（取消尚未执行的部分；正在执行的节点继续收尾；审计证据依法保留） ----
  withdraw(journeyId, { token, reason, at } = {}) {
    return this._exclusively(async () => {
      at = this._at(at);
      const journey = this._getJourney(journeyId);
      this._requirePassengerToken(journey, token);
      if (journey.status === "COMPLETED") fail("journey_completed", "服务已完成，无法撤回", 409);
      if (journey.status === "WITHDRAWN") fail("already_withdrawn", "服务已撤回", 409);

      // 尚未执行（含已交出但无人接手）的节点取消；ACTIVE 节点由值守人员继续完成收尾
      const cancelledNodes = journey.nodes
        .filter((n) => n.status === NODE_STATUS.WAITING || n.status === NODE_STATUS.PENDING)
        .map((n) => n.code);
      const active = activeNode(journey);

      await this.store.append({
        eventId: newId("evt"),
        journeyId,
        type: "SERVICE_WITHDRAWN",
        at,
        payload: { at, reason: (reason ?? "").slice(0, 200) || null, cancelledNodes },
      });
      // 无在途执行节点时立即物理销毁敏感密文；否则待收尾完成后由留存策略清理
      if (journey.healthRef && !active) await this.vault.destroy(journey.healthRef);
      await this.audit.record("SERVICE_WITHDRAWN", {
        journeyId,
        actor: "passenger",
        at,
        reason: "passenger_request",
        detail: {
          reason: (reason ?? "").slice(0, 200) || null,
          cancelledNodes,
          finishingNode: active ? active.code : null,
        },
      });
      return { withdrawnAt: at, cancelledNodes, finishingNode: active ? active.code : null };
    });
  }

  // ---- 执行人员视图：仅当前节点的最小必要信息 ----
  operatorView(journeyId, { operatorId, pin, at } = {}) {
    return this._exclusively(async () => {
      at = this._at(at);
      const journey = this._getJourney(journeyId);
      const op = this._auth(operatorId, pin);
      const active = activeNode(journey);
      const pending = pendingNode(journey);

      let view = null;
      if (active && this._responsibleFor(journey, active) === op.operatorId) {
        const def = getNodeDef(active.code);
        view = {
          relation: "CURRENT_OWNER",
          node: active.code,
          nodeName: def.name,
          status: active.status,
          task: pick(journey.taskData, def.visibleFields),
          healthAvailable: journey.healthRef !== null && def.healthScope === "SERVICE",
          next: this._publicNext(journey),
        };
      } else if (pending && pending.handoff.currentAssignee === op.operatorId) {
        const def = getNodeDef(pending.code);
        view = {
          relation: "ASSIGNED_TAKEOVER",
          node: pending.code,
          nodeName: def.name,
          status: pending.status,
          handoffId: pending.handoff.handoffId,
          handedAt: pending.handoff.handedAt,
          fromOperatorId: pending.handoff.fromOperatorId,
          deadline: pending.handoff.deadline,
          escalated: pending.handoff.escalated,
          task: pick(journey.taskData, def.visibleFields),
          healthAvailable: journey.healthRef !== null && def.healthScope === "SERVICE",
          next: this._publicNext(journey),
        };
      } else {
        await this.audit.record("OPERATOR_VIEW_DENIED", {
          journeyId,
          actor: op.operatorId,
          at,
          reason: "not_current_or_assignee",
        });
        fail("forbidden", "你只可读取自己当前值守或被指派接手的节点", 403);
      }

      await this.audit.record("OPERATOR_VIEW", {
        journeyId,
        actor: op.operatorId,
        at,
        detail: { node: view.node, relation: view.relation },
      });
      return {
        journeyId,
        serviceCode: journey.serviceCode,
        flight: journey.flight,
        gate: journey.gate,
        status: journey.status,
        view,
      };
    });
  }

  // ---- 健康备注读取：节点需要 + 服务目的 + 逐次审计 ----
  readHealth(journeyId, { operatorId, pin, purpose, at } = {}) {
    return this._exclusively(async () => {
      at = this._at(at);
      const journey = this._getJourney(journeyId);
      const op = this._auth(operatorId, pin);
      if (!purpose || !String(purpose).trim()) {
        fail("purpose_required", "读取健康备注必须填写服务目的", 422);
      }
      const purposeText = String(purpose).trim().slice(0, 200);

      const active = activeNode(journey);
      const pending = pendingNode(journey);
      let node = null;
      if (active && this._responsibleFor(journey, active) === op.operatorId) node = active;
      else if (pending && pending.handoff.currentAssignee === op.operatorId) node = pending;

      if (!node || getNodeDef(node.code).healthScope !== "SERVICE") {
        await this.audit.record("HEALTH_READ_DENIED", {
          journeyId,
          actor: op.operatorId,
          at,
          reason: node ? "node_health_scope_none" : "not_current_or_assignee",
          detail: { requestedNode: node?.code ?? null },
        });
        fail("forbidden", "当前节点不开放健康备注，或你不是该节点负责人", 403);
      }
      if (!journey.healthRef || !this.vault.has(journey.healthRef)) {
        await this.audit.record("HEALTH_READ_DENIED", {
          journeyId,
          actor: op.operatorId,
          at,
          reason: "note_unavailable",
          detail: { node: node.code },
        });
        fail("health_note_unavailable", "没有可读取的健康备注", 404);
      }

      const note = this.vault.reveal(journey.healthRef);
      await this.audit.record("HEALTH_READ", {
        journeyId,
        actor: op.operatorId,
        at,
        reason: purposeText,
        detail: { node: node.code },
      });
      return { node: node.code, purpose: purposeText, note, readAt: at };
    });
  }

  // ---- 旅客进度视图：不含任何员工内部备注 ----
  passengerProgress(journeyId, { token, at } = {}) {
    return this._exclusively(async () => {
      at = this._at(at);
      const journey = this._getJourney(journeyId);
      this._requirePassengerToken(journey, token);
      await this.audit.record("PROGRESS_VIEWED", { journeyId, actor: "passenger", at });
      return {
        journeyId,
        serviceCode: journey.serviceCode,
        flight: journey.flight,
        gate: journey.gate,
        status: journey.status,
        nodes: journey.nodes
          .filter((n) => n.status !== NODE_STATUS.CANCELLED)
          .map((n) => ({
            code: n.code,
            name: getNodeDef(n.code).name,
            status: n.status,
            dueAt: n.dueAt,
            handedAt: n.handoff?.handedAt ?? null,
            takenOverAt: n.handoff?.takenOverAt ?? null,
            completedAt: n.completedAt,
          })),
      };
    });
  }

  _requirePassengerToken(journey, token) {
    if (!token || !journey.tokenHash || !safeEqual(hashToken(token), journey.tokenHash)) {
      fail("invalid_query_token", "查询凭证无效", 401);
    }
    if (this.clock().getTime() > new Date(journey.tokenExpiresAt).getTime()) {
      fail("query_token_expired", "查询凭证已过期", 401);
    }
  }

  // ---- 协调员总览：断链位置、责任人、剩余时限 ----
  coordinatorDashboard({ operatorId, pin, at } = {}) {
    return this._exclusively(async () => {
      at = this._at(at);
      this._auth(operatorId, pin, "COORDINATOR");
      await this._sweepEscalations(at);
      const nowMs = new Date(at).getTime();
      const journeys = [...this._snapshot().values()].map((journey) => {
        const active = activeNode(journey);
        const breakInfo = chainBreak(journey, nowMs);
        return {
          journeyId: journey.journeyId,
          serviceCode: journey.serviceCode,
          flight: journey.flight,
          gate: journey.gate,
          status: journey.status,
          currentNode: active ? {
            code: active.code,
            name: getNodeDef(active.code).name,
            owner: this._responsibleFor(journey, active),
          } : null,
          chainBreak: breakInfo ? {
            ...breakInfo,
            upstreamOperator: this.directory.describe(breakInfo.upstreamOperatorId),
            responsible: this.directory.describe(breakInfo.responsibleOperatorId),
          } : null,
          next: this._publicNext(journey),
        };
      });
      await this.audit.record("COORDINATOR_VIEW", { actor: operatorId, at, detail: { count: journeys.length } });
      return { generatedAt: at, journeys };
    });
  }

  // ---- 审计核验 ----
  auditTrail({ operatorId, pin, journeyId = null } = {}) {
    return this._exclusively(async () => {
      this._auth(operatorId, pin, "COORDINATOR");
      const entries = journeyId ? this.audit.forJourney(journeyId) : this.audit.entries;
      return {
        verified: this.audit.verify(),
        entries: entries.map((e) => ({
          seq: e.seq,
          at: e.at,
          action: e.action,
          journeyId: e.journeyId,
          actor: e.actor,
          reason: e.reason,
          detail: e.detail,
        })),
      };
    });
  }
}

function pick(taskData, fields) {
  const out = {};
  for (const field of fields) {
    if (field in taskData) out[field] = taskData[field];
  }
  return out;
}
