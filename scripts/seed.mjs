// 用 fixtures/context.json 的脱敏时间线演示一次完整交接：
// 受理 → 值机接手 → 交出安检 → 超时升级 → 迟到回执被拒 → 协调员改派。
// 运行：npm run seed（写入 ${DATA_DIR:-./var}/store.json，随后 npm start 可查）。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AssistService } from "../src/domain.js";
import { loadHealthKey } from "../src/crypto.js";
import { Store } from "../src/store.js";

const fixture = JSON.parse(await readFile(new URL("../fixtures/context.json", import.meta.url), "utf8"));
const record = fixture.records.find((r) => r.journeyId);
const events = fixture.records.filter((r) => r.eventId);

let clock = new Date("2026-09-12T09:50:00+08:00");
const storeFile = join(process.env.DATA_DIR ?? "var", "store.json");
const service = new AssistService({ store: new Store(storeFile), healthKey: loadHealthKey(), now: () => clock });

const center = { type: "staff", id: "emp-000", role: "coordinator" };
const checkinStaff = { type: "staff", id: "emp-101", role: "checkin_agent" };
const securityLate = { type: "staff", id: "emp-202", role: "security_officer" };
const securityNew = "emp-203";

if (service.store.load().journeys[record.journeyId]) {
  console.log(`旅程 ${record.journeyId} 已存在，跳过种子导入`);
  process.exit(0);
}

const intake = service.intake(
  {
    journeyId: record.journeyId,
    serviceCode: record.serviceCode,
    flight: { no: record.flight, gate: "G12" },
    passengerRef: "prn-demo-301",
    publicNote: "轮椅协助（公开任务信息）",
    healthNote: { mobility: "自备轮椅至登机口", transfer: "需两人协助换乘", communication: "偏好文字沟通" },
    nodes: record.nodes,
  },
  center,
);
console.log("受理完成，旅客查询凭证：", intake.body.passengerToken);

const firstHandover = intake.body.firstHandover;
clock = new Date("2026-09-12T09:57:00+08:00");
service.takeover(record.journeyId, checkinStaff, { handoverId: firstHandover.id, idempotencyKey: "scan-101-a" });
console.log("09:57 值机人员 emp-101 接手 CHECKIN");

const hand1 = events.find((e) => e.eventId === "hand-1");
clock = new Date(hand1.occurredAt);
const offer = service.offer(record.journeyId, checkinStaff, { idempotencyKey: hand1.eventId });
console.log("09:58 交出 SECURITY_ENTRY，等待安检岗位接手（时限 10:25）");

const take1 = events.find((e) => e.eventId === "take-1");
clock = new Date(take1.occurredAt); // 10:31，已超过 10:25 的接手时限
try {
  service.takeover(record.journeyId, securityLate, { handoverId: offer.body.handover.id, idempotencyKey: take1.eventId, occurredAt: take1.occurredAt });
  console.log("!! 不应到达：迟到接手被接受");
} catch (err) {
  console.log(`10:31 迟到回执被拒（${err.code}）：${err.message}`);
}

const escalations = service.listEscalations(center).body.escalations;
console.log("协调员看到升级单：", escalations.map((e) => `${e.id} @${e.nodeLabel}`).join(", "));
service.reassign(escalations[0].id, center, { staffId: securityNew, idempotencyKey: "reassign-1" });
console.log("协调员改派 emp-203 接手 SECURITY_ENTRY");

const chain = service.chainView(record.journeyId, center).body;
console.log(
  "交接链现状：",
  chain.nodes.map((n) => `${n.code}[${n.status}${n.assignee ? `:${n.assignee}` : ""}]`).join(" → "),
);
console.log(`种子数据已写入 ${storeFile}`);
