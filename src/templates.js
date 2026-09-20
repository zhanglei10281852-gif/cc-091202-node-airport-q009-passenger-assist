// 领域模板：脱敏服务节点、岗位与可见范围、接手时限。
// 数据来自资料包口径：值机柜台 → 安检前 → 航站楼转运 → 登机口 → 机舱门。

export const ROLES = [
  "checkin_agent",
  "security_officer",
  "transfer_driver",
  "gate_agent",
  "cabin_crew",
  "coordinator",
];

// offsetMinutes：相对旅程起点各节点的计划接手时刻；
// takeoverTtlMinutes：交出后等待接手的最长时限（用于展示与兜底校验）。
export const NODE_TEMPLATE = [
  { code: "CHECKIN", role: "checkin_agent", label: "值机柜台", offsetMinutes: 0, takeoverTtlMinutes: 20 },
  { code: "SECURITY_ENTRY", role: "security_officer", label: "安检前", offsetMinutes: 25, takeoverTtlMinutes: 15 },
  { code: "TERMINAL_TRANSFER", role: "transfer_driver", label: "航站楼转运", offsetMinutes: 45, takeoverTtlMinutes: 15 },
  { code: "GATE", role: "gate_agent", label: "登机口", offsetMinutes: 70, takeoverTtlMinutes: 15 },
  { code: "CABIN_DOOR", role: "cabin_crew", label: "机舱门", offsetMinutes: 95, takeoverTtlMinutes: 15 },
];

export function templateEntry(code) {
  return NODE_TEMPLATE.find((item) => item.code === code) ?? null;
}

// 健康备注字段全集（受理时只保留这些必要字段，其余一律丢弃）。
export const HEALTH_FIELDS = ["mobility", "transfer", "medical", "communication"];

// 岗位可见范围：执行人员仅能读取当前节点需要的内容；medical 仅协调员可见。
export const HEALTH_VISIBILITY = {
  checkin_agent: ["mobility", "communication"],
  security_officer: ["mobility", "communication"],
  transfer_driver: ["mobility", "transfer", "communication"],
  gate_agent: ["mobility", "communication"],
  cabin_crew: ["mobility", "communication"],
  coordinator: [...HEALTH_FIELDS],
};

// 旅客视图中的节点状态措辞（不暴露“断链/升级”等内部措辞）。
export const PASSENGER_NODE_STATUS = {
  PENDING: "等待",
  OFFERED: "等待交接",
  IN_PROGRESS: "服务中",
  COMPLETED: "已完成",
  ESCALATED: "协调中",
  CANCELLED: "已取消",
};
