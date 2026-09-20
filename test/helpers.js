// 测试辅助：临时数据目录 + 可控时钟 + 直接组装应用。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";

export function mutableClock(initialIso) {
  let current = new Date(initialIso).getTime();
  const clock = () => new Date(current);
  clock.set = (iso) => {
    current = new Date(iso).getTime();
  };
  clock.advance = (ms) => {
    current += ms;
  };
  return clock;
}

export async function makeApp(clock) {
  const dir = await mkdtemp(join(tmpdir(), "assist-"));
  const app = await createApp({ dataDir: dir, clock });
  app.dir = dir;
  app.cleanup = () => rm(dir, { recursive: true, force: true });
  return app;
}

export const OPS = {
  checkin1: { operatorId: "op-checkin-1", pin: "1001" },
  checkin2: { operatorId: "op-checkin-2", pin: "1002" },
  security1: { operatorId: "op-security-1", pin: "2001" },
  security2: { operatorId: "op-security-2", pin: "2002" },
  transfer1: { operatorId: "op-transfer-1", pin: "3001" },
  transfer2: { operatorId: "op-transfer-2", pin: "3002" },
  gate1: { operatorId: "op-gate-1", pin: "4001" },
  gate2: { operatorId: "op-gate-2", pin: "4002" },
  cabin1: { operatorId: "op-cabin-1", pin: "5001" },
  cabin2: { operatorId: "op-cabin-2", pin: "5002" },
  coordinator: { operatorId: "coordinator-1", pin: "9001" },
};

// 走完一条正常交接链：CHECKIN -> SECURITY -> TRANSFER -> GATE -> CABIN -> 完成
export async function runHappyChain(service, journeyId) {
  const hops = [
    ["handover", OPS.checkin1],
    ["takeover", OPS.security1],
    ["handover", OPS.security1],
    ["takeover", OPS.transfer1],
    ["handover", OPS.transfer1],
    ["takeover", OPS.gate1],
    ["handover", OPS.gate1],
    ["takeover", OPS.cabin1],
    ["complete", OPS.cabin1],
  ];
  for (const [method, who] of hops) {
    await service[method](journeyId, { ...who });
  }
}
