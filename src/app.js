// 应用引导：组装存储、保险库、目录与领域服务（零外部依赖）。

import { resolve } from "node:path";
import { EventStore } from "./store/eventStore.js";
import { AuditLog } from "./store/auditLog.js";
import { HealthVault } from "./store/healthVault.js";
import { OperatorDirectory } from "./config/operators.js";
import { AssistanceService } from "./domain/service.js";

export async function createApp({ dataDir = process.env.DATA_DIR ?? "./data", clock } = {}) {
  const base = resolve(dataDir);
  const eventStore = new EventStore(`${base}/events.jsonl`, { clock });
  const auditLog = new AuditLog(`${base}/audit.jsonl`);
  const vault = new HealthVault(`${base}/health.jsonl.enc`);

  await Promise.all([eventStore.load(), auditLog.load(), vault.load()]);

  const service = new AssistanceService({
    eventStore,
    auditLog,
    vault,
    directory: new OperatorDirectory(),
    clock: clock ?? (() => new Date()),
  });
  return { service, eventStore, auditLog, vault };
}
