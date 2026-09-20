import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../src/domain/errors.js";
import { makeApp, mutableClock, OPS, runHappyChain } from "./helpers.js";

const T0 = "2026-09-12T09:00:00+08:00";

async function acceptJourney(service, overrides = {}) {
  const result = await service.accept({
    serviceCode: "WCHR",
    flight: "CA1720",
    gate: "B12",
    taskData: { bagTags: ["CA123456"], seatRow: "18" },
    healthNote: overrides.healthNote ?? "可短距离行走，登机时需扶手协助",
    ...overrides,
  });
  return result;
}

async function expectError(fn, code, status) {
  await assert.rejects(
    fn,
    (err) => {
      assert.ok(err instanceof DomainError, `期望 DomainError，实际 ${err}`);
      assert.equal(err.code, code);
      if (status) assert.equal(err.status, status);
      return true;
    },
  );
}

test("受理：只存服务必需字段，拒绝姓名证件等非必要字段", async () => {
  const clock = mutableClock(T0);
  const app = await makeApp(clock);
  await expectError(
    () => app.service.accept({
      serviceCode: "WCHR",
      flight: "CA1720",
      taskData: { passengerName: "张三", idNumber: "110xxx" },
    }),
    "field_not_allowed",
    422,
  );
  const { journeyId, queryToken, expiresAt } = await acceptJourney(app.service);
  assert.ok(journeyId.startsWith("jny_"));
  assert.ok(queryToken.length > 20);
  assert.ok(new Date(expiresAt) > new Date(T0));
  await app.cleanup();
});

test("正常交接链：五个节点顺序配对，最终完成", async () => {
  const clock = mutableClock(T0);
  const app = await makeApp(clock);
  const { journeyId } = await acceptJourney(app.service);

  await app.service.handover(journeyId, OPS.checkin1);
  // 同一人不能接手自己的交出
  await expectError(() => app.service.takeover(journeyId, OPS.checkin1), "self_handover_forbidden", 403);
  // 无关岗位不能接手
  await expectError(() => app.service.takeover(journeyId, OPS.gate1), "wrong_station", 403);

  clock.advance(5 * 60 * 1000);
  await app.service.takeover(journeyId, OPS.security1);

  clock.advance(20 * 60 * 1000);
  await app.service.handover(journeyId, OPS.security1);
  clock.advance(8 * 60 * 1000);
  await app.service.takeover(journeyId, OPS.transfer1);

  clock.advance(20 * 60 * 1000);
  await app.service.handover(journeyId, OPS.transfer1);
  clock.advance(10 * 60 * 1000);
  await app.service.takeover(journeyId, OPS.gate1);

  clock.advance(20 * 60 * 1000);
  await app.service.handover(journeyId, OPS.gate1);
  clock.advance(5 * 60 * 1000);
  await app.service.takeover(journeyId, OPS.cabin1);
  await app.service.complete(journeyId, OPS.cabin1);

  const trail = await app.service.auditTrail({ ...OPS.coordinator, journeyId });
  const paired = trail.entries.filter((e) =>
    e.action === "HANDED_OVER" || e.action === "TAKEN_OVER");
  assert.equal(paired.filter((e) => e.action === "HANDED_OVER").length, 4);
  assert.equal(paired.filter((e) => e.action === "TAKEN_OVER").length, 4);
  assert.equal(trail.verified.ok, true);
  await app.cleanup();
});

test("重复交出/重复扫码不会制造两个待接手节点", async () => {
  const clock = mutableClock(T0);
  const app = await makeApp(clock);
  const { journeyId } = await acceptJourney(app.service);
  await app.service.handover(journeyId, OPS.checkin1);
  await expectError(() => app.service.handover(journeyId, OPS.checkin1), "already_handed_over", 409);
  // 被非当前负责人重复扫交出
  await expectError(() => app.service.handover(journeyId, OPS.checkin2), "forbidden", 403);
  await app.service.takeover(journeyId, OPS.security1);
  // 重复接手（第二个安检员）在已有负责人后被拒
  await expectError(() => app.service.takeover(journeyId, OPS.security2), "no_pending_handover", 409);
  await app.cleanup();
});

test("接手超时 -> 升级 -> 协调员改派；迟到回执不覆盖改派", async () => {
  const clock = mutableClock(T0);
  const app = await makeApp(clock);
  const { journeyId } = await acceptJourney(app.service);

  await app.service.handover(journeyId, OPS.checkin1);
  const handoffDeadline = new Date(clock().getTime() + 10 * 60 * 1000);
  void handoffDeadline;

  // 未超时不能改派
  await expectError(
    () => app.service.reassign(journeyId, { ...OPS.coordinator, toOperatorId: "op-security-2" }),
    "not_escalated",
    409,
  );
  // 非协调员不能改派
  clock.advance(11 * 60 * 1000);
  await expectError(
    () => app.service.reassign(journeyId, { ...OPS.checkin1, toOperatorId: "op-security-2" }),
    "forbidden",
    403,
  );

  // 定时任务扫描出超时并升级
  const escalated = await app.service.sweepEscalations();
  assert.deepEqual(escalated, [{ journeyId, node: "SECURITY_ENTRY" }]);
  // 扫描幂等
  assert.deepEqual(await app.service.sweepEscalations(), []);

  // 原指派接手人网络恢复后发来迟到接手 → 拒绝且留痕
  await expectError(() => app.service.takeover(journeyId, OPS.security1), "handover_escalated", 409);

  // 协调员改派给安检员乙
  const reassigned = await app.service.reassign(journeyId, {
    ...OPS.coordinator,
    toOperatorId: "op-security-2",
  });
  assert.equal(reassigned.node, "SECURITY_ENTRY");
  assert.equal(reassigned.assignee, "op-security-2");

  // 原接手人更晚到达的迟到回执绝不能覆盖改派
  clock.advance(2 * 60 * 1000);
  await expectError(() => app.service.takeover(journeyId, OPS.security1), "takeover_superseded", 409);

  // 新指派接手人在新时限内接手成功；全程只有一个当前负责人
  clock.advance(3 * 60 * 1000);
  const took = await app.service.takeover(journeyId, OPS.security2);
  assert.equal(took.node, "SECURITY_ENTRY");

  const dash = await app.service.coordinatorDashboard(OPS.coordinator);
  const row = dash.journeys.find((j) => j.journeyId === journeyId);
  assert.equal(row.currentNode.owner, "op-security-2");
  assert.equal(row.chainBreak, null);

  // 迟到拒绝在审计中留痕
  const trail = await app.service.auditTrail({ ...OPS.coordinator, journeyId });
  const late = trail.entries.filter((e) => e.action === "LATE_TAKEOVER_REJECTED");
  assert.ok(late.length >= 2);
  assert.ok(late.some((e) => e.reason === "reassignment_superseded"));
  await app.cleanup();
});

test("健康备注与公开任务分离：仅服务节点、当前负责人、有目的才能读", async () => {
  const clock = mutableClock(T0);
  const app = await makeApp(clock);
  const { journeyId } = await acceptJourney(app.service);

  // 值机节点 healthScope=NONE：即使是当前负责人也读不到
  await expectError(
    () => app.service.readHealth(journeyId, { ...OPS.checkin1, purpose: "想看" }),
    "forbidden",
    403,
  );
  // 缺目的
  await app.service.handover(journeyId, OPS.checkin1);
  await app.service.takeover(journeyId, OPS.security1);
  await app.service.handover(journeyId, OPS.security1);
  await app.service.takeover(journeyId, OPS.transfer1);
  await expectError(
    () => app.service.readHealth(journeyId, { ...OPS.transfer1 }),
    "purpose_required",
    422,
  );
  // 非该节点负责人不可读
  await expectError(
    () => app.service.readHealth(journeyId, { ...OPS.gate1, purpose: "转运搀扶需要" }),
    "forbidden",
    403,
  );

  const read = await app.service.readHealth(journeyId, {
    ...OPS.transfer1,
    purpose: "转运搀扶需要确认行动能力",
  });
  assert.match(read.note, /扶手/);
  assert.equal(read.node, "TERMINAL_TRANSFER");

  // 视图层：只能看到本岗位白名单与任务数据的交集，且不含健康备注内容
  const view = await app.service.operatorView(journeyId, OPS.transfer1);
  assert.deepEqual(Object.keys(view.view.task), ["bagTags"]);
  assert.equal(view.view.healthAvailable, true);
  assert.equal(JSON.stringify(view).includes("扶手"), false);

  // 审计可证明每次敏感访问合法
  const trail = await app.service.auditTrail({ ...OPS.coordinator, journeyId });
  const reads = trail.entries.filter((e) => e.action === "HEALTH_READ");
  assert.equal(reads.length, 1);
  assert.equal(reads[0].actor, "op-transfer-1");
  assert.equal(reads[0].reason, "转运搀扶需要确认行动能力");
  const denied = trail.entries.filter((e) => e.action === "HEALTH_READ_DENIED");
  assert.ok(denied.length >= 2);
  await app.cleanup();
});

test("航班/登机口变更：保留已完成节点，只重建未开始路线", async () => {
  const clock = mutableClock(T0);
  const app = await makeApp(clock);
  const { journeyId } = await acceptJourney(app.service, { gate: "B12" });

  await app.service.handover(journeyId, OPS.checkin1);
  await app.service.takeover(journeyId, OPS.security1);
  await app.service.handover(journeyId, OPS.security1);
  // 此时 SECURITY_ENTRY 已 DONE，TERMINAL_TRANSFER PENDING
  clock.advance(15 * 60 * 1000); // 待接手已超时 -> 先改派消化掉再变更？这里直接测保留语义

  const rebuilt = await app.service.rebuildRoute(journeyId, {
    ...OPS.coordinator,
    flight: "CA1721",
    gate: "C07",
  });
  assert.equal(rebuilt.flight, "CA1721");
  assert.equal(rebuilt.gate, "C07");
  const codes = rebuilt.nodes.map((n) => n.code);
  assert.deepEqual(codes, ["CHECKIN", "SECURITY_ENTRY", "TERMINAL_TRANSFER", "GATE", "CABIN_DOOR"]);
  // 已开始节点保留状态
  assert.equal(rebuilt.nodes[0].status, "DONE");
  assert.equal(rebuilt.nodes[1].status, "DONE");
  // 待接手节点也保留（已经开始的交接不能被静默默杀）
  assert.equal(rebuilt.nodes[2].status, "PENDING");
  // 后续节点重新生成且时限为未来
  assert.equal(rebuilt.nodes[3].status, "WAITING");
  assert.ok(new Date(rebuilt.nodes[3].dueAt) > clock());

  // 当前负责人看到新的下一站（被指派接手人看到的下一站就是待接手节点本身）
  const view = await app.service.operatorView(journeyId, OPS.transfer1);
  assert.equal(view.flight, "CA1721");
  assert.equal(view.view.next.code, "TERMINAL_TRANSFER");
  await app.cleanup();
});

test("旅客凭证：查进度看不到内部备注；可撤回未执行服务；证据保留", async () => {
  const clock = mutableClock(T0);
  const app = await makeApp(clock);
  const { journeyId, queryToken } = await acceptJourney(app.service);
  await app.service.handover(journeyId, OPS.checkin1);
  await app.service.takeover(journeyId, OPS.security1);
  await app.service.handover(journeyId, OPS.security1);

  // 错凭证 / 无凭证
  await expectError(
    () => app.service.passengerProgress(journeyId, { token: "wrong" }),
    "invalid_query_token",
    401,
  );

  const progress = await app.service.passengerProgress(journeyId, { token: queryToken });
  assert.equal(progress.status, "ACTIVE");
  // 进度中不暴露员工/交接内部标识以外的备注
  const json = JSON.stringify(progress);
  assert.equal(json.includes("扶手"), false);
  assert.equal(json.includes("expectedAssignee"), false);
  assert.ok(progress.nodes.some((n) => n.code === "GATE" && n.status === "WAITING"));

  // 撤回：取消待接手与未开始节点；正在执行的 SECURITY 之后无 ACTIVE（当前 PENDING）
  const withdrawal = await app.service.withdraw(journeyId, {
    token: queryToken,
    reason: "旅客身体不适放弃行程",
  });
  assert.deepEqual(withdrawal.cancelledNodes.sort(), ["CABIN_DOOR", "GATE", "TERMINAL_TRANSFER"]);

  // 凭证撤回后失效
  await expectError(
    () => app.service.passengerProgress(journeyId, { token: queryToken }),
    "invalid_query_token",
    401,
  );
  // 健康密文已销毁
  assert.equal(app.vault.has((await snapshotJourney(app, journeyId)).healthRef), false);
  // 事件与审计证据仍在（可审计撤回事实）
  const trail = await app.service.auditTrail({ ...OPS.coordinator, journeyId });
  assert.ok(trail.entries.some((e) => e.action === "SERVICE_WITHDRAWN"));
  assert.equal(trail.verified.ok, true);
  await app.cleanup();
});

async function snapshotJourney(app, journeyId) {
  const { reduce } = await import("../src/domain/state.js");
  return reduce(app.eventStore.events).get(journeyId);
}

test("撤回时仍有在途执行节点：后续取消、在途收尾后销毁密文", async () => {
  const clock = mutableClock(T0);
  const app = await makeApp(clock);
  const { journeyId, queryToken } = await acceptJourney(app.service);
  // 走到转运员接手（TERMINAL_TRANSFER ACTIVE）
  await app.service.handover(journeyId, OPS.checkin1);
  await app.service.takeover(journeyId, OPS.security1);
  await app.service.handover(journeyId, OPS.security1);
  await app.service.takeover(journeyId, OPS.transfer1);

  const result = await app.service.withdraw(journeyId, { token: queryToken, reason: "取消后续" });
  assert.deepEqual(result.cancelledNodes.sort(), ["CABIN_DOOR", "GATE"]);
  assert.equal(result.finishingNode, "TERMINAL_TRANSFER");
  // 在途节点仍可继续操作直到收尾；密文暂保留给收尾人员
  const health = await app.service.readHealth(journeyId, {
    ...OPS.transfer1,
    purpose: "收尾搀扶",
  });
  assert.ok(health.note);
  await app.service.complete(journeyId, OPS.transfer1);
  // 收尾完成：敏感密文销毁，旅程为撤回态，审计证据保留
  const { reduce } = await import("../src/domain/state.js");
  const snap = reduce(app.eventStore.events).get(journeyId);
  assert.equal(snap.status, "WITHDRAWN");
  assert.equal(app.vault.has(snap.healthRef), false);
  const trail = await app.service.auditTrail({ ...OPS.coordinator, journeyId });
  assert.equal(trail.verified.ok, true);
  await app.cleanup();
});

test("协调员仪表盘定位断链：责任人与剩余时限", async () => {
  const clock = mutableClock(T0);
  const app = await makeApp(clock);
  const { journeyId } = await acceptJourney(app.service);
  await app.service.handover(journeyId, OPS.checkin1);
  clock.advance(4 * 60 * 1000);

  const dash = await app.service.coordinatorDashboard(OPS.coordinator);
  const row = dash.journeys.find((j) => j.journeyId === journeyId);
  assert.equal(row.chainBreak.node, "SECURITY_ENTRY");
  assert.equal(row.chainBreak.responsibleOperatorId, "op-security-1");
  assert.equal(row.chainBreak.upstreamOperatorId, "op-checkin-1");
  assert.ok(row.chainBreak.remainingMs > 0);
  assert.equal(row.chainBreak.overdue, false);
  assert.ok(row.chainBreak.responsible.name.includes("安检"));

  clock.advance(10 * 60 * 1000);
  const dash2 = await app.service.coordinatorDashboard(OPS.coordinator);
  const row2 = dash2.journeys.find((j) => j.journeyId === journeyId);
  assert.equal(row2.chainBreak.overdue, true);
  assert.equal(row2.chainBreak.escalated, true);
  await app.cleanup();
});

test("审计哈希链：篡改任意一行即可被发现", async () => {
  const clock = mutableClock(T0);
  const app = await makeApp(clock);
  const { journeyId } = await acceptJourney(app.service);
  await app.service.handover(journeyId, OPS.checkin1);
  assert.equal(app.auditLog.verify().ok, true);
  // 直接篡改内存中的条目（模拟磁盘篡改）
  app.auditLog.entries[0].action = "TAMPERED";
  assert.equal(app.auditLog.verify().ok, false);
  await app.cleanup();
});

test("完整流程可从事件日志重放：重启不产生两名负责人", async () => {
  const clock = mutableClock(T0);
  const app = await makeApp(clock);
  const { journeyId } = await acceptJourney(app.service);
  await runHappyChain(app.service, journeyId);
  const dir = app.dir;

  // 新进程：重新引导，事件全部重放
  const { createApp } = await import("../src/app.js");
  const restarted = await createApp({ dataDir: dir, clock });
  const dash = await restarted.service.coordinatorDashboard(OPS.coordinator);
  const row = dash.journeys.find((j) => j.journeyId === journeyId);
  assert.equal(row.status, "COMPLETED");
  assert.equal(row.currentNode, null);
  assert.equal(row.chainBreak, null);
  await restarted.vault.flushed();
  const { rm } = await import("node:fs/promises");
  await rm(dir, { recursive: true, force: true });
});
