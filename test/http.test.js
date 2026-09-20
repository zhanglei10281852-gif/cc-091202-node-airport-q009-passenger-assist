import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { buildServer } from "../src/server.js";
import { mutableClock } from "./helpers.js";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

test("HTTP：完整端到端旅程（受理→交接→健康门控→旅客视图→审计）", async (context) => {
  const clock = mutableClock("2026-09-12T09:00:00+08:00");
  const server = buildServer({ dataDir: await tmpData(), clock });
  context.after(() => server.close());
  const base = await listen(server);

  const post = (path, body) => fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

  // 受理
  const accepted = await post("/journeys", {
    serviceCode: "WCHR",
    flight: "CA1720",
    gate: "B12",
    taskData: { bagTags: ["CA123456"] },
    healthNote: "需轮椅转运，左腿术后",
  });
  assert.equal(accepted.status, 201);
  const jid = accepted.body.journeyId;
  const token = accepted.body.queryToken;

  // 非必要字段被拒
  const rejected = await post("/journeys", {
    serviceCode: "WCHR",
    flight: "CA1720",
    taskData: { phone: "13800000000" },
  });
  assert.equal(rejected.status, 422);
  assert.equal(rejected.body.error, "field_not_allowed");

  // 值机交出 → 安检接手
  let r = await post(`/journeys/${jid}/handover`, { operatorId: "op-checkin-1", pin: "1001" });
  assert.equal(r.status, 200);
  assert.equal(r.body.to, "SECURITY_ENTRY");
  assert.ok(r.body.deadline);

  r = await post(`/journeys/${jid}/takeover`, { operatorId: "op-security-1", pin: "2001" });
  assert.equal(r.status, 200);

  // 安检交出 → 转运接手（该节点可读健康备注）
  assert.equal((await post(`/journeys/${jid}/handover`, { operatorId: "op-security-1", pin: "2001" })).status, 200);
  assert.equal((await post(`/journeys/${jid}/takeover`, { operatorId: "op-transfer-1", pin: "3001" })).status, 200);

  // 无目的读取健康备注 → 422
  const noPurpose = await post(`/journeys/${jid}/health`, { operatorId: "op-transfer-1", pin: "3001" });
  assert.equal(noPurpose.status, 422);
  // 值机员越权读健康 → 403
  const denied = await post(`/journeys/${jid}/health`, {
    operatorId: "op-checkin-1", pin: "1001", purpose: "好奇",
  });
  assert.equal(denied.status, 403);
  // 合法读取
  const health = await post(`/journeys/${jid}/health`, {
    operatorId: "op-transfer-1", pin: "3001", purpose: "推送轮椅并固定腿部",
  });
  assert.equal(health.status, 200);
  assert.match(health.body.note, /轮椅/);

  // 执行人员视图：无健康备注明文
  const view = await post(`/journeys/${jid}/operator-view`, { operatorId: "op-transfer-1", pin: "3001" });
  assert.equal(view.status, 200);
  assert.equal(JSON.stringify(view.body).includes("术后"), false);

  // 旅客进度：Bearer 凭证，不含员工备注
  const progressRes = await fetch(`${base}/journeys/${jid}/progress`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(progressRes.status, 200);
  const progress = await progressRes.json();
  assert.equal(progress.nodes.length, 5);
  assert.equal(JSON.stringify(progress).includes("术后"), false);
  assert.equal(progress.nodes.some((n) => "fromOperatorId" in n || "assignee" in n), false);

  // 错误凭证
  const badProgress = await fetch(`${base}/journeys/${jid}/progress`, {
    headers: { authorization: "Bearer nope" },
  });
  assert.equal(badProgress.status, 401);

  // 协调员仪表盘（身份走请求头）
  const dashRes = await fetch(`${base}/coordinator/dashboard`, {
    headers: { "x-operator-id": "coordinator-1", "x-operator-pin": "9001" },
  });
  assert.equal(dashRes.status, 200);
  const dash = await dashRes.json();
  assert.equal(dash.journeys[0].journeyId, jid);
  assert.equal(dash.journeys[0].currentNode.code, "TERMINAL_TRANSFER");

  // 普通岗位不能看仪表盘
  const dashDenied = await fetch(`${base}/coordinator/dashboard`, {
    headers: { "x-operator-id": "op-gate-1", "x-operator-pin": "4001" },
  });
  assert.equal(dashDenied.status, 403);

  // 审计：哈希链完整，敏感访问可溯源
  const auditRes = await fetch(`${base}/coordinator/audit?journeyId=${jid}`, {
    headers: { "x-operator-id": "coordinator-1", "x-operator-pin": "9001" },
  });
  const audit = await auditRes.json();
  assert.equal(audit.verified.ok, true);
  const reads = audit.entries.filter((e) => e.action === "HEALTH_READ");
  assert.equal(reads.length, 1);
  assert.equal(reads[0].reason, "推送轮椅并固定腿部");
});

test("HTTP：超时升级后改派，迟到回执不覆盖（端到端）", async (context) => {
  const clock = mutableClock("2026-09-12T09:00:00+08:00");
  const server = buildServer({ dataDir: await tmpData(), clock });
  context.after(() => server.close());
  const base = await listen(server);
  const post = (path, body) => fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

  const acc = await post("/journeys", { serviceCode: "MAAS", flight: "MU5100" });
  const jid = acc.body.journeyId;
  await post(`/journeys/${jid}/handover`, { operatorId: "op-checkin-1", pin: "1001" });

  // 超过 10 分钟接手时限
  clock.advance(11 * 60 * 1000);
  const late = await post(`/journeys/${jid}/takeover`, { operatorId: "op-security-1", pin: "2001" });
  assert.equal(late.status, 409);
  assert.equal(late.body.error, "handover_escalated");

  const reassign = await post(`/journeys/${jid}/reassign`, {
    operatorId: "coordinator-1", pin: "9001", toOperatorId: "op-security-2",
  });
  assert.equal(reassign.status, 200);

  // 原接手人迟到回执
  const superseded = await post(`/journeys/${jid}/takeover`, { operatorId: "op-security-1", pin: "2001" });
  assert.equal(superseded.status, 409);
  assert.equal(superseded.body.error, "takeover_superseded");

  // 新接手人成功
  const took = await post(`/journeys/${jid}/takeover`, { operatorId: "op-security-2", pin: "2002" });
  assert.equal(took.status, 200);
  assert.equal(took.body.node, "SECURITY_ENTRY");
});

test("HTTP：健康检查与未知路由", async (context) => {
  const server = buildServer({ dataDir: await tmpData(), clock: mutableClock("2026-09-12T09:00:00+08:00") });
  context.after(() => server.close());
  const base = await listen(server);
  const health = await fetch(`${base}/health`);
  assert.deepEqual(await health.json(), { status: "ok" });
  const missing = await fetch(`${base}/nope`);
  assert.equal(missing.status, 404);
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function tmpData() {
  const dir = await mkdtemp(join(tmpdir(), "assist-http-"));
  // 不立即清理：服务器生命周期内保留；进程退出即随 tmp 回收
  return dir;
}
