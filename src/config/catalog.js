// 服务节点目录：脱敏节点、岗位角色、接手时限与岗位可见范围。
// 健康备注（healthScope === "SERVICE"）只在提供身体协助确有必要的节点开放，
// 且每次解密仍须给出服务目的并写入审计。

export const NODE_CATALOG = Object.freeze([
  {
    code: "CHECKIN",
    name: "值机柜台",
    role: "CHECKIN_AGENT",
    takeoverLimitMs: 15 * 60 * 1000,
    healthScope: "NONE",
    // 该岗位执行任务时允许看到的字段白名单（最小必要）
    visibleFields: ["serviceCode", "flight", "gate", "bagTags"],
    defaultOffsetMs: 0,
  },
  {
    code: "SECURITY_ENTRY",
    name: "安检前交接点",
    role: "SECURITY_ESCORT",
    takeoverLimitMs: 10 * 60 * 1000,
    healthScope: "NONE",
    visibleFields: ["serviceCode", "flight", "gate"],
    defaultOffsetMs: 25 * 60 * 1000,
  },
  {
    code: "TERMINAL_TRANSFER",
    name: "航站楼转运",
    role: "TRANSFER_AGENT",
    takeoverLimitMs: 20 * 60 * 1000,
    healthScope: "SERVICE",
    visibleFields: ["serviceCode", "flight", "gate", "transferKind", "bagTags"],
    defaultOffsetMs: 45 * 60 * 1000,
  },
  {
    code: "GATE",
    name: "登机口",
    role: "GATE_AGENT",
    takeoverLimitMs: 15 * 60 * 1000,
    healthScope: "NONE",
    visibleFields: ["serviceCode", "flight", "gate", "boardingSequence"],
    defaultOffsetMs: 70 * 60 * 1000,
  },
  {
    code: "CABIN_DOOR",
    name: "机舱门",
    role: "CABIN_CREW",
    takeoverLimitMs: 10 * 60 * 1000,
    healthScope: "SERVICE",
    visibleFields: ["serviceCode", "flight", "seatRow"],
    defaultOffsetMs: 85 * 60 * 1000,
  },
]);

const BY_CODE = new Map(NODE_CATALOG.map((node) => [node.code, node]));

export function getNodeDef(code) {
  return BY_CODE.get(code);
}

export function requireNodeDef(code) {
  const def = BY_CODE.get(code);
  if (!def) {
    const err = new Error(`unknown_node:${code}`);
    err.code = "unknown_node";
    throw err;
  }
  return def;
}

// 默认路线：受理时刻 + 各节点偏移
export function defaultRoute(startedAt) {
  return NODE_CATALOG.map((def) => ({
    code: def.code,
    dueAt: new Date(startedAt + def.defaultOffsetMs).toISOString(),
  }));
}

export const SERVICE_CODES = Object.freeze(["WCHR", "WCHS", "WCHC", "MAAS"]);
