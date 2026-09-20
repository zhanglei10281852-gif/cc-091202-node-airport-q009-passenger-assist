// HTTP 接口层：JSON over HTTP，身份以操作员 ID + PIN 表达（参考实现），
// 旅客侧使用一次性短期查询凭证（Bearer Token）。

import { DomainError } from "../domain/errors.js";

const JSON_LIMIT = 64 * 1024;

export function createHttpHandler(service) {
  return async function handler(req, res) {
    const url = new URL(req.url, "http://localhost");
    try {
      const body = await readBody(req);
      await route(req, res, url, body, service);
    } catch (err) {
      if (err instanceof SyntaxError) {
        return send(res, 400, { error: "invalid_json", message: "请求体不是合法 JSON" });
      }
      if (err instanceof DomainError) {
        return send(res, err.status, { error: err.code, message: err.message, details: err.details });
      }
      console.error("unhandled error:", err);
      return send(res, 500, { error: "internal_error", message: "服务内部错误" });
    }
  };
}

async function route(req, res, url, body, service) {
  const p = url.pathname;

  if (req.method === "GET" && p === "/health") {
    return send(res, 200, { status: "ok" });
  }

  // 协调员（GET 接口用自定义请求头传递身份，避免口令进入 URL 查询串）
  if (req.method === "GET" && p === "/coordinator/dashboard") {
    return send(res, 200, await service.coordinatorDashboard(authHeaders(req)));
  }
  if (req.method === "GET" && p === "/coordinator/audit") {
    return send(res, 200, await service.auditTrail({
      ...authHeaders(req),
      journeyId: url.searchParams.get("journeyId"),
    }));
  }

  // 受理：POST /journeys
  if (req.method === "POST" && p === "/journeys") {
    return send(res, 201, await service.accept({ ...body }));
  }

  // /journeys/:id/...
  const match = p.match(/^\/journeys\/([A-Za-z0-9_]+)(?:\/(.*))?$/);
  if (!match) return send(res, 404, { error: "not_found" });
  const journeyId = match[1];
  const action = match[2] ?? "";

  switch (action) {
    case "":
      break;
    case "handover":
      requireMethod(req, "POST");
      return send(res, 200, await service.handover(journeyId, body));
    case "takeover":
      requireMethod(req, "POST");
      return send(res, 200, await service.takeover(journeyId, body));
    case "complete":
      requireMethod(req, "POST");
      return send(res, 200, await service.complete(journeyId, body));
    case "reassign":
      requireMethod(req, "POST");
      return send(res, 200, await service.reassign(journeyId, body));
    case "route":
      requireMethod(req, "POST");
      return send(res, 200, await service.rebuildRoute(journeyId, body));
    case "operator-view":
      requireMethod(req, "POST");
      return send(res, 200, await service.operatorView(journeyId, body));
    case "health":
      requireMethod(req, "POST");
      return send(res, 200, await service.readHealth(journeyId, body));
    case "progress":
      requireMethod(req, "GET");
      return send(res, 200, await service.passengerProgress(journeyId, {
        token: bearer(req),
      }));
    case "withdraw":
      requireMethod(req, "POST");
      return send(res, 200, await service.withdraw(journeyId, {
        ...body,
        token: body.token ?? bearer(req),
      }));
    default:
      break;
  }
  return send(res, 404, { error: "not_found" });
}

function authHeaders(req) {
  return {
    operatorId: req.headers["x-operator-id"] ? String(req.headers["x-operator-id"]) : null,
    pin: req.headers["x-operator-pin"] ? String(req.headers["x-operator-pin"]) : null,
  };
}

function bearer(req) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

function requireMethod(req, method) {
  if (req.method !== method) {
    const err = new DomainError("method_not_allowed", `仅支持 ${method}`, { status: 405 });
    throw err;
  }
}

async function readBody(req) {
  if (req.method === "GET" || req.method === "HEAD") return {};
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > JSON_LIMIT) {
      throw new DomainError("payload_too_large", "请求体超过 64KiB", { status: 413 });
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return parsed ?? {};
}

function send(res, status, data) {
  const json = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(json);
}
