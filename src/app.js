// HTTP 层：路由、员工/旅客鉴权、Idempotency-Key 重放保护、统一错误格式。
import { createServer } from "node:http";
import { ROLES } from "./templates.js";
import { DomainError } from "./domain.js";

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new DomainError(413, "PAYLOAD_TOO_LARGE", "请求体过大");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DomainError(400, "INVALID_JSON", "请求体不是合法 JSON");
  }
}

function matchPath(pattern, pathname) {
  const p = pattern.split("/").filter(Boolean);
  const a = pathname.split("/").filter(Boolean);
  if (p.length !== a.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i += 1) {
    if (p[i].startsWith(":")) params[p[i].slice(1)] = decodeURIComponent(a[i]);
    else if (p[i] !== a[i]) return null;
  }
  return params;
}

/**
 * routes: [{ method, pattern, auth: "staff"|"passenger"|"none", roles?, handler }]
 * handler(ctx) → { status, body, headers? }；ctx = { actor, params, body, token }。
 */
export function createApp({ service }) {
  const staffActor = (req) => {
    const id = req.headers["x-staff-id"];
    const role = req.headers["x-staff-role"];
    if (typeof id !== "string" || !id || !ROLES.includes(role)) {
      throw new DomainError(401, "STAFF_AUTH_REQUIRED", "需要有效的 x-staff-id 与 x-staff-role 头");
    }
    return { type: "staff", id, role };
  };

  const routes = [
    { method: "GET", pattern: "/health", auth: "none", handler: async () => ({ status: 200, body: { status: "ok" } }) },

    { method: "POST", pattern: "/journeys", auth: "staff", roles: ["coordinator", "checkin_agent"], handler: async (c) => service.intake(c.body, c.actor) },
    { method: "GET", pattern: "/journeys", auth: "staff", handler: async (c) => service.listJourneys(c.actor) },
    { method: "GET", pattern: "/journeys/:id", auth: "staff", handler: async (c) => service.staffView(c.params.id, c.actor) },
    { method: "GET", pattern: "/journeys/:id/health", auth: "staff", handler: async (c) => service.healthView(c.params.id, c.actor) },
    { method: "POST", pattern: "/journeys/:id/offer", auth: "staff", handler: async (c) => service.offer(c.params.id, c.actor, c.body) },
    { method: "POST", pattern: "/journeys/:id/takeover", auth: "staff", handler: async (c) => service.takeover(c.params.id, c.actor, c.body) },
    { method: "POST", pattern: "/journeys/:id/complete", auth: "staff", handler: async (c) => service.complete(c.params.id, c.actor, c.body) },
    { method: "POST", pattern: "/journeys/:id/notes", auth: "staff", handler: async (c) => service.addNote(c.params.id, c.actor, c.body) },
    { method: "POST", pattern: "/journeys/:id/reroute", auth: "staff", roles: ["coordinator"], handler: async (c) => service.reroute(c.params.id, c.actor, c.body) },

    { method: "GET", pattern: "/coordinator/journeys/:id/chain", auth: "staff", roles: ["coordinator"], handler: async (c) => service.chainView(c.params.id, c.actor) },
    { method: "GET", pattern: "/coordinator/journeys/:id/audit", auth: "staff", roles: ["coordinator"], handler: async (c) => service.auditView(c.params.id, c.actor) },
    { method: "GET", pattern: "/coordinator/escalations", auth: "staff", roles: ["coordinator"], handler: async (c) => service.listEscalations(c.actor) },
    { method: "POST", pattern: "/coordinator/escalations/:id/reassign", auth: "staff", roles: ["coordinator"], handler: async (c) => service.reassign(c.params.id, c.actor, c.body) },

    { method: "GET", pattern: "/passenger/journeys/:id/progress", auth: "passenger", handler: async (c) => service.passengerProgress(c.params.id, c.token) },
    { method: "POST", pattern: "/passenger/journeys/:id/withdraw", auth: "passenger", handler: async (c) => service.withdraw(c.params.id, c.token, c.body) },
  ];

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      let matched = null;
      let params = null;
      let pathHit = false;
      for (const route of routes) {
        const p = matchPath(route.pattern, url.pathname);
        if (!p) continue;
        if (route.method === req.method) {
          matched = route;
          params = p;
          break;
        }
        pathHit = true;
      }
      if (!matched) {
        if (pathHit) throw new DomainError(405, "METHOD_NOT_ALLOWED", "方法不允许");
        throw new DomainError(404, "not_found", "资源不存在");
      }

      const ctx = { params, body: {}, actor: null, token: null };
      if (matched.auth === "staff") {
        ctx.actor = staffActor(req);
        if (matched.roles && !matched.roles.includes(ctx.actor.role)) {
          throw new DomainError(403, "ROLE_FORBIDDEN", `需要岗位：${matched.roles.join("/")}`);
        }
      } else if (matched.auth === "passenger") {
        const header = req.headers.authorization ?? "";
        const token = header.startsWith("Bearer ") ? header.slice(7) : null;
        if (!token) throw new DomainError(401, "TOKEN_INVALID", "缺少 Bearer 查询凭证");
        ctx.token = token;
      }
      if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
        ctx.body = await readBody(req);
      }

      // 幂等键：重复扫码/重试直接重放首个结果，不产生第二次状态变更。
      const idemKey = req.headers["idempotency-key"];
      const scopedKey = idemKey ? `${req.method} ${url.pathname} ${ctx.actor?.id ?? "passenger"} ${idemKey}` : null;
      if (scopedKey) {
        const hit = service.store.load().idempotency[scopedKey];
        if (hit) {
          json(res, hit.status, hit.body, { "x-idempotent-replay": "true" });
          return;
        }
      }

      const result = await matched.handler(ctx);
      if (scopedKey && result.status < 500) {
        service.store.transact((state) => {
          state.idempotency[scopedKey] = { status: result.status, body: result.body, createdAt: new Date().toISOString() };
        });
      }
      json(res, result.status, result.body, result.headers ?? {});
    } catch (err) {
      if (err instanceof DomainError) {
        json(res, err.status, { error: { code: err.code, message: err.message, details: err.details ?? null } });
      } else {
        console.error(err);
        json(res, 500, { error: { code: "INTERNAL", message: "服务内部错误" } });
      }
    }
  });
}
