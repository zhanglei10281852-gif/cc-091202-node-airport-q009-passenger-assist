import { createServer } from "node:http";
import { createApp } from "./app.js";
import { createHttpHandler } from "./http/handler.js";

export function buildServer(options = {}) {
  // 引导（回放事件/审计/保险库）异步进行；在就绪前到达的请求会等待。
  const ready = createApp(options)
    .then(({ service }) => {
      const handle = createHttpHandler(service);
      return { service, handle };
    })
    .catch((err) => {
      console.error("应用引导失败：", err);
      process.exitCode = 1;
      throw err;
    });

  const server = createServer((req, res) => {
    ready.then(
      ({ handle }) => handle(req, res),
      () => {
        res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "boot_failed" }));
      },
    );
  });

  // 定时扫描接手超时并升级（默认 15 秒）；unref 以免阻止进程退出
  const interval = setInterval(() => {
    ready.then(({ service }) => service.sweepEscalations()).catch(() => {});
  }, Number.parseInt(process.env.SWEEP_INTERVAL_MS ?? "15000", 10));
  interval.unref?.();
  server.on("close", () => clearInterval(interval));

  return server;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  buildServer().listen(port, "0.0.0.0", () => {
    console.log(`assistance service listening on :${port}`);
  });
}
