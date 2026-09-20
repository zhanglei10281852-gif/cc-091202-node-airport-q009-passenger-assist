import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../src/app.js";
import { loadHealthKey } from "../src/crypto.js";
import { AssistService } from "../src/domain.js";
import { Store } from "../src/store.js";

// 可推进的测试时钟
function makeClock(start = "2026-09-12T09:50:00+08:00") {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    set(iso) {
      t = new Date(iso).getTime();
    },
    advance(minutes) {
      t += minutes * 60_000;
    },
  };
}

async function startServer(service) {
  const server = createApp({ service }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const call = async (method, path, { actor, token, body, idempotencyKey } = {}) => {
    const headers = { "content-type": "application/json" };
    if (actor) {
      headers["x-staff-id"] = actor.id;
      headers["x-staff-role"] = actor.role;
    }
    if (token) headers.authorization = `Bearer ${token}`;
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  return { server, call };
}

function makeService({ clock, storeFile, tokenTtlHours = 12 } = {}) {
  const service = new AssistService({
    store: new Store(storeFile ?? null),
    healthKey: loadHealthKey({}),
    now: clock ? clock.now : undefined,
    tokenTtlHours,
  });
  return service;
}

const COORD = { id: "emp-000", role: "coordinator" };
const CHECKIN = { id: "emp-101", role: "checkin_agent" };
const SECURITY = { id: "emp-202", role: "security_officer" };
const SECURITY_B = { id: "emp-203", role: "security_officer" };
const TRANSFER = { id: "emp-303", role: "transfer_driver" };
const GATE = { id: "emp-404", role: "gate_agent" };
const CABIN = { id: "emp-505", role: "cabin_crew" };

const HEALTH = {
  mobility: "自备轮椅，可短距离步行",
  transfer: "需两人协助换乘",
  medical: "携带冷藏药品",
  communication: "偏好文字沟通",
  unrelatedField: "不应被保存",
};

async function intakeJourney(call, overrides = {}) {
  const res = await call("POST", "/journeys", {
    actor: COORD,
    body: {
      journeyId: overrides.journeyId ?? "assist-301",
      serviceCode: "WCHR",
      flight: { no: "CA1720", gate: "G12", departsAt: "2026-09-12T12:30:00+08:00" },
      passengerRef: "prn-8f3c",
      publicNote: "轮椅协助",
      healthNote: HEALTH,
      nodes: overrides.nodes ?? [
        { code: "CHECKIN", dueAt: "2026-09-12T10:00:00+08:00" },
        { code: "SECURITY_ENTRY", dueAt: "2026-09-12T10:25:00+08:00" },
        { code: "TERMINAL_TRANSFER", dueAt: "2026-09-12T10:45:00+08:00" },
        { code: "GATE", dueAt: "2026-09-12T11:10:00+08:00" },
        { code: "CABIN_DOOR", dueAt: "2026-09-12T11:40:00+08:00" },
      ],
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

test("受理：数据最小化，健康备注分离加密，不下发明文", async () => {
  const dir = mkdtempSync(join(tmpdir(), "assist-"));
  try {
    const service = makeService({ storeFile: join(dir, "store.json") });
    const { server, call } = await startServer(service);
    try {
      const created = await intakeJourney(call);
      const raw = JSON.stringify(created);
      assert.ok(!raw.includes("冷藏药品"), "响应不得包含健康明文");
      assert.ok(!raw.includes("unrelatedField"), "非必要字段被丢弃");
      assert.ok(created.passengerToken.startsWith("pt_"));

      const onDisk = readFileSync(join(dir, "store.json"), "utf8");
      assert.ok(!onDisk.includes("冷藏药品"), "落盘数据不得包含健康明文");
      assert.ok(!onDisk.includes("unrelatedField"));
      const state = JSON.parse(onDisk);
      assert.equal(Object.keys(state.secrets).length, 1);
      assert.equal(state.secrets["hn_assist-301"].alg, "aes-256-gcm");
      // 旅程实体上只有引用，没有健康内容
      assert.equal(state.journeys["assist-301"].healthNoteRef, "hn_assist-301");
      assert.ok(!("healthNote" in state.journeys["assist-301"]));
    } finally {
      server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("交接链：交出/接手配对推进，全程只有一名当前负责人", async () => {
  const clock = makeClock();
  const service = makeService({ clock });
  const { server, call } = await startServer(service);
  try {
    await intakeJourney(call);

    // 首节点已由受理人交出，值机人员扫码接手
    const view0 = await call("GET", "/journeys/assist-301", { actor: CHECKIN });
    const ho1 = view0.body.nodes[0].handovers[0];
    const t1 = await call("POST", "/journeys/assist-301/takeover", {
      actor: CHECKIN,
      body: { handoverId: ho1.id, idempotencyKey: "scan-101" },
    });
    assert.equal(t1.status, 200);
    assert.deepEqual(t1.body.currentResponsible, { nodeSeq: 1, staffId: "emp-101" });

    const staffByNode = { 2: SECURITY, 3: TRANSFER, 4: GATE, 5: CABIN };
    for (const [seq, actor] of Object.entries(staffByNode)) {
      const offer = await call("POST", "/journeys/assist-301/offer", { actor: seq === "2" ? CHECKIN : staffByNode[Number(seq) - 1], body: {} });
      assert.equal(offer.status, 201, JSON.stringify(offer.body));
      const take = await call("POST", "/journeys/assist-301/takeover", {
        actor,
        body: { handoverId: offer.body.handover.id, idempotencyKey: `scan-${actor.id}` },
      });
      assert.equal(take.status, 200, JSON.stringify(take.body));
      const chain = await call("GET", "/coordinator/journeys/assist-301/chain", { actor: COORD });
      const inProgress = chain.body.nodes.filter((n) => n.status === "IN_PROGRESS");
      assert.equal(inProgress.length, 1, "任一时刻至多一个进行中节点");
      assert.equal(inProgress[0].assignee, actor.id);
    }

    const done = await call("POST", "/journeys/assist-301/complete", { actor: CABIN, body: {} });
    assert.equal(done.status, 200);
    assert.equal(done.body.journey.status, "COMPLETED");
  } finally {
    server.close();
  }
});

test("重复扫码与并发接手：幂等重放，绝不出现两名当前负责人", async () => {
  const service = makeService({ clock: makeClock() });
  const { server, call } = await startServer(service);
  try {
    await intakeJourney(call);
    const view = await call("GET", "/journeys/assist-301", { actor: CHECKIN });
    const ho1 = view.body.nodes[0].handovers[0];

    // 同一扫码重复提交（带幂等键）→ 重放首个结果
    const a = await call("POST", "/journeys/assist-301/takeover", { actor: CHECKIN, body: { handoverId: ho1.id }, idempotencyKey: "scan-x" });
    const b = await call("POST", "/journeys/assist-301/takeover", { actor: CHECKIN, body: { handoverId: ho1.id }, idempotencyKey: "scan-x" });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(b.headers.get("x-idempotent-replay"), "true");
    assert.equal(a.body.handover.id, b.body.handover.id);

    // 同一员工不带键重复扫码 → 天然幂等
    const c = await call("POST", "/journeys/assist-301/takeover", { actor: CHECKIN, body: { handoverId: ho1.id } });
    assert.equal(c.status, 200);
    assert.equal(c.body.already, true);

    // 他人重复扫码 → 冲突，不改变负责人
    const d = await call("POST", "/journeys/assist-301/takeover", { actor: SECURITY, body: { handoverId: ho1.id } });
    assert.equal(d.status, 409);
    assert.equal(d.body.error.code, "HANDOVER_ALREADY_TAKEN");

    const chain = await call("GET", "/coordinator/journeys/assist-301/chain", { actor: COORD });
    assert.deepEqual(chain.body.currentResponsible, { nodeSeq: 1, staffId: "emp-101" });
  } finally {
    server.close();
  }
});

test("超时升级 + 迟到回执：重新指派不被覆盖（夹具场景回放）", async () => {
  const clock = makeClock("2026-09-12T09:50:00+08:00");
  const service = makeService({ clock });
  const { server, call } = await startServer(service);
  try {
    await intakeJourney(call, {
      nodes: [
        { code: "CHECKIN", dueAt: "2026-09-12T10:00:00+08:00" },
        { code: "SECURITY_ENTRY", dueAt: "2026-09-12T10:25:00+08:00" },
        { code: "GATE", dueAt: "2026-09-12T11:10:00+08:00" },
      ],
    });

    // 09:57 值机接手首节点；09:58 交出安检前节点（对应夹具 hand-1）
    clock.set("2026-09-12T09:57:00+08:00");
    const view = await call("GET", "/journeys/assist-301", { actor: CHECKIN });
    await call("POST", "/journeys/assist-301/takeover", { actor: CHECKIN, body: { handoverId: view.body.nodes[0].handovers[0].id } });
    clock.set("2026-09-12T09:58:00+08:00");
    const offer = await call("POST", "/journeys/assist-301/offer", { actor: CHECKIN, body: {} });
    const handoverId = offer.body.handover.id;

    // 10:26 之后：接手时限 10:25 已过 → 惰性结算升级
    clock.set("2026-09-12T10:26:00+08:00");
    const escalations = await call("GET", "/coordinator/escalations", { actor: COORD });
    assert.equal(escalations.body.escalations.length, 1);
    assert.equal(escalations.body.escalations[0].reason, "TAKEOVER_TIMEOUT");
    assert.equal(escalations.body.escalations[0].lastResponsible, "emp-101");

    // 协调员重新指派 emp-203
    const escId = escalations.body.escalations[0].id;
    const reassign = await call("POST", `/coordinator/escalations/${escId}/reassign`, { actor: COORD, body: { staffId: "emp-203" } });
    assert.equal(reassign.status, 200);
    assert.deepEqual(reassign.body.currentResponsible, { nodeSeq: 2, staffId: "emp-203" });

    // 网络恢复，emp-202 的迟到回执（夹具 take-1，10:31）到达 → 拒绝且不覆盖改派
    clock.set("2026-09-12T10:31:00+08:00");
    const late = await call("POST", "/journeys/assist-301/takeover", {
      actor: SECURITY,
      body: { handoverId, idempotencyKey: "take-1", occurredAt: "2026-09-12T10:24:00+08:00" },
    });
    assert.equal(late.status, 409);
    assert.equal(late.body.error.code, "HANDOVER_NO_LONGER_OPEN");
    assert.equal(late.body.error.details.currentAssignee, "emp-203");

    // 迟到回执已留痕；负责人仍是 emp-203，断链已修复
    const chain = await call("GET", "/coordinator/journeys/assist-301/chain", { actor: COORD });
    assert.equal(chain.body.brokenChain, false);
    assert.deepEqual(chain.body.currentResponsible, { nodeSeq: 2, staffId: "emp-203" });
    const staff = await call("GET", "/journeys/assist-301", { actor: COORD });
    const ho = staff.body.nodes[1].handovers.find((h) => h.id === handoverId);
    assert.equal(ho.status, "EXPIRED");
    assert.equal(ho.lateReceipts.length, 1);
    assert.equal(ho.lateReceipts[0].staffId, "emp-202");
    assert.equal(ho.lateReceipts[0].claimedAt, "2026-09-12T02:24:00.000Z");
  } finally {
    server.close();
  }
});

test("服务重启：交接状态与幂等记录落盘，不产生第二名负责人", async () => {
  const dir = mkdtempSync(join(tmpdir(), "assist-"));
  const storeFile = join(dir, "store.json");
  try {
    const clock = makeClock();
    // 第一次启动：接手首节点
    let service = makeService({ clock, storeFile });
    let server = createApp({ service }).listen(0, "127.0.0.1");
    await once(server, "listening");
    let port = server.address().port;
    const post = (p, body, actor, key) =>
      fetch(`http://127.0.0.1:${port}${p}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-staff-id": actor.id, "x-staff-role": actor.role, ...(key ? { "idempotency-key": key } : {}) },
        body: JSON.stringify(body),
      }).then(async (r) => ({ status: r.status, body: await r.json(), replay: r.headers.get("x-idempotent-replay") }));
    const get = (p, actor) =>
      fetch(`http://127.0.0.1:${port}${p}`, { headers: { "x-staff-id": actor.id, "x-staff-role": actor.role } }).then(async (r) => ({ status: r.status, body: await r.json() }));

    await post("/journeys", {
      journeyId: "assist-301",
      serviceCode: "WCHR",
      flight: { no: "CA1720" },
      passengerRef: "prn-8f3c",
      nodes: [{ code: "CHECKIN", dueAt: "2026-09-12T10:00:00+08:00" }, { code: "GATE", dueAt: "2026-09-12T11:10:00+08:00" }],
    }, COORD);
    const view = await get("/journeys/assist-301", CHECKIN);
    const ho1 = view.body.nodes[0].handovers[0];
    const taken = await post("/journeys/assist-301/takeover", { handoverId: ho1.id }, CHECKIN, "scan-restart");
    assert.equal(taken.status, 200);
    server.close();
    server.closeAllConnections();
    await once(server, "close");

    // 模拟重启：同一存储文件重建服务
    service = makeService({ clock, storeFile });
    server = createApp({ service }).listen(0, "127.0.0.1");
    await once(server, "listening");
    port = server.address().port;

    const chain = await get("/coordinator/journeys/assist-301/chain", COORD);
    assert.deepEqual(chain.body.currentResponsible, { nodeSeq: 1, staffId: "emp-101" });
    assert.equal(chain.body.nodes.filter((n) => n.status === "IN_PROGRESS").length, 1);

    // 重启后重复同一扫码 → 命中落盘的幂等记录，直接重放
    const replay = await post("/journeys/assist-301/takeover", { handoverId: ho1.id }, CHECKIN, "scan-restart");
    assert.equal(replay.status, 200);
    assert.equal(replay.replay, "true");
    const chain2 = await get("/coordinator/journeys/assist-301/chain", COORD);
    assert.deepEqual(chain2.body.currentResponsible, { nodeSeq: 1, staffId: "emp-101" });
    server.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("登机口变化：保留完成节点，只重建未开始路线，当前负责人看到新下一站", async () => {
  const clock = makeClock();
  const service = makeService({ clock });
  const { server, call } = await startServer(service);
  try {
    await intakeJourney(call);
    const view = await call("GET", "/journeys/assist-301", { actor: CHECKIN });
    await call("POST", "/journeys/assist-301/takeover", { actor: CHECKIN, body: { handoverId: view.body.nodes[0].handovers[0].id } });
    const offer = await call("POST", "/journeys/assist-301/offer", { actor: CHECKIN, body: {} });
    await call("POST", "/journeys/assist-301/takeover", { actor: SECURITY, body: { handoverId: offer.body.handover.id } });
    // 此时：节点1 COMPLETED，节点2 IN_PROGRESS(emp-202)，节点3-5 PENDING

    const reroute = await call("POST", "/journeys/assist-301/reroute", {
      actor: COORD,
      body: { gate: "G88", reason: "登机口变更", startAt: "2026-09-12T10:20:00+08:00" },
    });
    assert.equal(reroute.status, 200, JSON.stringify(reroute.body));
    assert.equal(reroute.body.journey.flight.gate, "G88");
    const nodes = reroute.body.journey.nodes;
    assert.equal(nodes[0].status, "COMPLETED");
    assert.equal(nodes[0].code, "CHECKIN");
    assert.equal(nodes[1].status, "IN_PROGRESS");
    assert.equal(nodes[1].assignee, "emp-202");
    // 未开始的旧节点保留为 CANCELLED 证据，新路线按模板重建并接续编号
    const cancelled = nodes.filter((n) => n.status === "CANCELLED");
    assert.equal(cancelled.length, 3);
    assert.ok(cancelled.every((n) => n.cancelReason === "REROUTE"));
    const pending = nodes.filter((n) => n.status === "PENDING");
    assert.deepEqual(pending.map((n) => n.code), ["TERMINAL_TRANSFER", "GATE", "CABIN_DOOR"]);
    assert.deepEqual(pending.map((n) => n.seq), [6, 7, 8]);
    assert.deepEqual(reroute.body.currentResponsible, { nodeSeq: 2, staffId: "emp-202" });
    assert.equal(reroute.body.nextNode.code, "TERMINAL_TRANSFER");

    // 当前负责人在员工视图中看到新的下一站
    const staffView = await call("GET", "/journeys/assist-301", { actor: SECURITY });
    assert.equal(staffView.body.nextNode.code, "TERMINAL_TRANSFER");
    assert.equal(staffView.body.journeyId, "assist-301");
  } finally {
    server.close();
  }
});

test("旅客：短期凭证查进度，看不到内部备注与健康资料；过期凭证被拒", async () => {
  const clock = makeClock();
  const service = makeService({ clock, tokenTtlHours: 2 });
  const { server, call } = await startServer(service);
  try {
    const created = await intakeJourney(call);
    const token = created.passengerToken;

    // 员工加内部备注
    const view = await call("GET", "/journeys/assist-301", { actor: CHECKIN });
    await call("POST", "/journeys/assist-301/takeover", { actor: CHECKIN, body: { handoverId: view.body.nodes[0].handovers[0].id } });
    await call("POST", "/journeys/assist-301/notes", { actor: CHECKIN, body: { nodeSeq: 1, text: "旅客情绪紧张，注意语速" } });

    const progress = await call("GET", "/passenger/journeys/assist-301/progress", { token });
    assert.equal(progress.status, 200);
    const raw = JSON.stringify(progress.body);
    assert.ok(!raw.includes("情绪紧张"), "旅客视图不得包含员工内部备注");
    assert.ok(!raw.includes("冷藏药品"), "旅客视图不得包含健康资料");
    assert.ok(!raw.includes("emp-"), "旅客视图不得暴露员工工号");
    assert.equal(progress.body.currentStage, "值机柜台");
    assert.equal(progress.body.nodes[0].status, "服务中");

    // 无凭证 / 错凭证
    assert.equal((await call("GET", "/passenger/journeys/assist-301/progress")).status, 401);
    assert.equal((await call("GET", "/passenger/journeys/assist-301/progress", { token: "pt_wrong" })).status, 401);

    // 凭证过期
    clock.advance(3 * 60);
    const expired = await call("GET", "/passenger/journeys/assist-301/progress", { token });
    assert.equal(expired.status, 401);
    assert.equal(expired.body.error.code, "TOKEN_EXPIRED");
  } finally {
    server.close();
  }
});

test("撤回：未执行服务取消、完成节点保留、健康资料清除、操作证据保留", async () => {
  const service = makeService({ clock: makeClock() });
  const { server, call } = await startServer(service);
  try {
    const created = await intakeJourney(call);
    const token = created.passengerToken;
    const view = await call("GET", "/journeys/assist-301", { actor: CHECKIN });
    await call("POST", "/journeys/assist-301/takeover", { actor: CHECKIN, body: { handoverId: view.body.nodes[0].handovers[0].id } });
    const offer = await call("POST", "/journeys/assist-301/offer", { actor: CHECKIN, body: {} });
    await call("POST", "/journeys/assist-301/takeover", { actor: SECURITY, body: { handoverId: offer.body.handover.id } });

    const wd = await call("POST", "/passenger/journeys/assist-301/withdraw", { token, body: { reason: "行程取消" } });
    assert.equal(wd.status, 200);
    assert.equal(wd.body.journey.status, "CANCELLED");
    assert.equal(wd.body.healthNotePurged, true);

    const staff = await call("GET", "/journeys/assist-301", { actor: COORD });
    assert.equal(staff.body.nodes[0].status, "COMPLETED", "已执行节点保留");
    assert.ok(staff.body.nodes.slice(1).every((n) => n.status === "CANCELLED" && n.cancelReason === "WITHDRAWN"));

    // 健康资料已清除，再读返回 410 并留痕
    const health = await call("GET", "/journeys/assist-301/health", { actor: COORD });
    assert.equal(health.status, 410);

    // 操作证据（事件与审计）依法保留
    const audit = await call("GET", "/coordinator/journeys/assist-301/audit", { actor: COORD });
    const actions = audit.body.audit.map((a) => a.action);
    assert.ok(actions.includes("WITHDRAW"));
    const eventTypes = audit.body.events.map((e) => e.type);
    assert.ok(eventTypes.includes("JOURNEY_WITHDRAWN"));
    assert.ok(eventTypes.includes("HANDOVER_TAKEN"));

    // 旅客仍可凭凭证查看已取消的进度（证据可见）
    const progress = await call("GET", "/passenger/journeys/assist-301/progress", { token });
    assert.equal(progress.status, 200);
    assert.equal(progress.body.status, "CANCELLED");
  } finally {
    server.close();
  }
});

test("岗位可见范围：当前负责人按岗位读取健康字段，越权访问被拒并留痕", async () => {
  const service = makeService({ clock: makeClock() });
  const { server, call } = await startServer(service);
  try {
    await intakeJourney(call);
    const view = await call("GET", "/journeys/assist-301", { actor: CHECKIN });
    await call("POST", "/journeys/assist-301/takeover", { actor: CHECKIN, body: { handoverId: view.body.nodes[0].handovers[0].id } });

    // 非当前负责人读取 → 403 + DENY 审计
    const denied = await call("GET", "/journeys/assist-301/health", { actor: GATE });
    assert.equal(denied.status, 403);

    // 值机负责人：可见 mobility/communication，看不到 medical/transfer
    const checkinView = await call("GET", "/journeys/assist-301/health", { actor: CHECKIN });
    assert.equal(checkinView.status, 200);
    assert.deepEqual(Object.keys(checkinView.body.fields).sort(), ["communication", "mobility"]);

    // 推进到转运节点：转运员可见 transfer，仍看不到 medical
    const offer1 = await call("POST", "/journeys/assist-301/offer", { actor: CHECKIN, body: {} });
    await call("POST", "/journeys/assist-301/takeover", { actor: SECURITY, body: { handoverId: offer1.body.handover.id } });
    const offer2 = await call("POST", "/journeys/assist-301/offer", { actor: SECURITY, body: {} });
    await call("POST", "/journeys/assist-301/takeover", { actor: TRANSFER, body: { handoverId: offer2.body.handover.id } });
    const transferView = await call("GET", "/journeys/assist-301/health", { actor: TRANSFER });
    assert.deepEqual(Object.keys(transferView.body.fields).sort(), ["communication", "mobility", "transfer"]);

    // 协调员可见全部字段
    const coordView = await call("GET", "/journeys/assist-301/health", { actor: COORD });
    assert.deepEqual(Object.keys(coordView.body.fields).sort(), ["communication", "medical", "mobility", "transfer"]);

    // 审计：每次敏感访问的合法性都可证明
    const audit = await call("GET", "/coordinator/journeys/assist-301/audit", { actor: COORD });
    const reads = audit.body.audit.filter((a) => a.action === "HEALTH_READ");
    assert.equal(reads.filter((a) => a.decision === "DENY").length, 1);
    assert.equal(reads.filter((a) => a.decision === "ALLOW").length, 3);
    const allow = reads.find((a) => a.decision === "ALLOW" && a.actor.id === "emp-303");
    assert.deepEqual(allow.fields.sort(), ["communication", "mobility", "transfer"]);
    assert.ok(allow.basis.includes("当前负责人"));
  } finally {
    server.close();
  }
});

test("协调员断链视图：断链位置、责任人、剩余接手时限一目了然", async () => {
  const clock = makeClock("2026-09-12T09:58:00+08:00");
  const service = makeService({ clock });
  const { server, call } = await startServer(service);
  try {
    await intakeJourney(call, {
      nodes: [
        { code: "CHECKIN", dueAt: "2026-09-12T10:00:00+08:00" },
        { code: "SECURITY_ENTRY", dueAt: "2026-09-12T10:25:00+08:00" },
        { code: "GATE", dueAt: "2026-09-12T11:10:00+08:00" },
      ],
    });
    // 首节点等待接手，剩余 2 分钟
    const chain0 = await call("GET", "/coordinator/journeys/assist-301/chain", { actor: COORD });
    assert.equal(chain0.body.brokenChain, false);
    assert.equal(chain0.body.nodes[0].takeoverRemainingMs, 2 * 60 * 1000);

    // 超时后：断链定位到节点1，上一责任人（交出方）为受理协调员
    clock.set("2026-09-12T10:01:00+08:00");
    const chain1 = await call("GET", "/coordinator/journeys/assist-301/chain", { actor: COORD });
    assert.equal(chain1.body.brokenChain, true);
    assert.equal(chain1.body.brokenNodeSeq, 1);
    assert.equal(chain1.body.nodes[0].status, "ESCALATED");
    assert.equal(chain1.body.nodes[0].responsible, "emp-000");
    assert.equal(chain1.body.nodes[0].escalations.length, 1);
    assert.equal(chain1.body.currentResponsible, null);
  } finally {
    server.close();
  }
});

test("鉴权与岗位校验：缺少员工头、岗位不符、越权协调接口", async () => {
  const service = makeService({ clock: makeClock() });
  const { server, call } = await startServer(service);
  try {
    assert.equal((await call("GET", "/journeys")).status, 401);
    assert.equal((await call("GET", "/journeys", { actor: { id: "x", role: "ghost" } })).status, 401);
    await intakeJourney(call);
    // 一线员工不能访问协调员接口
    assert.equal((await call("GET", "/coordinator/escalations", { actor: CHECKIN })).status, 403);
    // 岗位不符不能接手（首节点需要 checkin_agent）
    const view = await call("GET", "/journeys/assist-301", { actor: CHECKIN });
    const wrongRole = await call("POST", "/journeys/assist-301/takeover", { actor: GATE, body: { handoverId: view.body.nodes[0].handovers[0].id } });
    assert.equal(wrongRole.status, 403);
    assert.equal(wrongRole.body.error.code, "ROLE_MISMATCH");
  } finally {
    server.close();
  }
});
