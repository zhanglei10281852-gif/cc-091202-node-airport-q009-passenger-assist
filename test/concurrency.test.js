import assert from "node:assert/strict";
import test from "node:test";
import { makeApp, mutableClock, OPS } from "./helpers.js";
import { reduce, activeNode } from "../src/domain/state.js";

const T0 = "2026-09-12T09:00:00+08:00";

async function accepted(service) {
  return service.accept({ serviceCode: "WCHR", flight: "CA1720" });
}

test("并发：两人同时接手同一交接，恰有一人成功，始终只有一个负责人", async () => {
  const clock = mutableClock(T0);
  const app = await makeApp(clock);
  const { journeyId } = await accepted(app.service);
  await app.service.handover(journeyId, OPS.checkin1);

  // 同一名被指派接手人因重复扫码/网络重试同时发来两个接手请求
  const [a, b] = await Promise.allSettled([
    app.service.takeover(journeyId, OPS.security1),
    app.service.takeover(journeyId, OPS.security1),
  ]);
  const winners = [a, b].filter((r) => r.status === "fulfilled");
  const losers = [a, b].filter((r) => r.status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].reason.code, "no_pending_handover");

  const journey = reduce(app.eventStore.events).get(journeyId);
  const active = activeNode(journey);
  assert.equal(active.code, "SECURITY_ENTRY");
  assert.equal(active.handoff.takeoverOperatorId, "op-security-1");
  // 只有一个 TAKEN_OVER 事件
  const takes = app.eventStore.events.filter((e) => e.type === "TAKEN_OVER");
  assert.equal(takes.length, 1);
  await app.cleanup();
});

test("并发：重复受理请求不会互相污染（各自独立旅程）", async () => {
  const clock = mutableClock(T0);
  const app = await makeApp(clock);
  const results = await Promise.all([
    accepted(app.service),
    accepted(app.service),
    accepted(app.service),
  ]);
  const ids = new Set(results.map((r) => r.journeyId));
  const tokens = new Set(results.map((r) => r.queryToken));
  assert.equal(ids.size, 3);
  assert.equal(tokens.size, 3);
  await app.cleanup();
});

test("并发：同一交接连续交出两次（网络重试）只产生一次", async () => {
  const clock = mutableClock(T0);
  const app = await makeApp(clock);
  const { journeyId } = await accepted(app.service);
  const [a, b] = await Promise.allSettled([
    app.service.handover(journeyId, OPS.checkin1),
    app.service.handover(journeyId, OPS.checkin1),
  ]);
  const winners = [a, b].filter((r) => r.status === "fulfilled");
  const losers = [a, b].filter((r) => r.status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].reason.code, "already_handed_over");
  const hands = app.eventStore.events.filter((e) => e.type === "HANDED_OVER");
  assert.equal(hands.length, 1);
  await app.cleanup();
});
