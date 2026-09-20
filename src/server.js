// 服务入口：装配存储、密钥与时钟，暴露 buildServer 供测试与容器启动。
import { join } from "node:path";
import { createApp } from "./app.js";
import { loadHealthKey } from "./crypto.js";
import { AssistService } from "./domain.js";
import { Store } from "./store.js";

export function buildServer(options = {}) {
  // 默认内存存储；设置 DATA_DIR（或显式 storeFile）后落盘，重启不丢交接状态。
  const storeFile = options.storeFile ?? (process.env.DATA_DIR ? join(process.env.DATA_DIR, "store.json") : null);
  const store = options.store ?? new Store(storeFile);
  const service =
    options.service ??
    new AssistService({
      store,
      healthKey: options.healthKey ?? loadHealthKey(),
      now: options.now,
      tokenTtlHours: options.tokenTtlHours ?? Number(process.env.PASSENGER_TOKEN_TTL_HOURS ?? 12),
    });
  const server = createApp({ service });
  server.assistService = service;
  return server;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const server = buildServer();
  // 定时兜底结算：即使长时间无请求，超时交接也会升级为协调员工单。
  const sweeper = setInterval(() => server.assistService.settleAll(), 30_000);
  sweeper.unref();
  server.listen(port, "0.0.0.0", () => {
    console.log(`assist service listening on :${port}`);
  });
}
