// 旅程聚合的纯函数状态归约器。
// 节点生命周期： WAITING -> PENDING（上游已交出、待接手）-> ACTIVE（已接手）-> DONE
// 不变量：任一时刻至多一个 ACTIVE 节点（唯一当前负责人）。

import { getNodeDef } from "../config/catalog.js";

export const NODE_STATUS = Object.freeze({
  WAITING: "WAITING",
  PENDING: "PENDING",
  ACTIVE: "ACTIVE",
  DONE: "DONE",
  CANCELLED: "CANCELLED",
});

export function initJourney(event) {
  const p = event.payload;
  return {
    journeyId: event.journeyId,
    serviceCode: p.serviceCode,
    flight: p.flight,
    gate: p.gate ?? null,
    taskData: p.taskData ?? {},
    healthRef: p.healthRef,
    status: "ACTIVE",
    startedAt: p.startedAt,
    tokenHash: p.tokenHash,
    tokenExpiresAt: p.tokenExpiresAt,
    withdrawnAt: null,
    withdrawReason: null,
    nodes: p.route.map((step, index) => ({
      code: step.code,
      dueAt: step.dueAt,
      expectedAssignee: step.expectedAssignee,
      status: index === 0 ? NODE_STATUS.ACTIVE : NODE_STATUS.WAITING,
      activatedAt: index === 0 ? p.startedAt : null,
      completedAt: null,
      handoff: null,
    })),
  };
}

export function reduce(events) {
  const journeys = new Map();
  for (const event of events) {
    let journey = journeys.get(event.journeyId);
    switch (event.type) {
      case "JOURNEY_ACCEPTED":
        journey = initJourney(event);
        break;
      case "HANDED_OVER":
        applyHandedOver(journey, event.payload);
        break;
      case "TAKEN_OVER":
        applyTakenOver(journey, event.payload);
        break;
      case "SERVICE_COMPLETED":
        applyServiceCompleted(journey, event.payload);
        break;
      case "ESCALATED":
        applyEscalated(journey, event.payload);
        break;
      case "REASSIGNED":
        applyReassigned(journey, event.payload);
        break;
      case "ROUTE_REBUILT":
        applyRouteRebuilt(journey, event.payload);
        break;
      case "SERVICE_WITHDRAWN": {
        journey.status = "WITHDRAWN";
        journey.withdrawnAt = event.payload.at;
        journey.withdrawReason = event.payload.reason ?? null;
        journey.tokenHash = null; // 凭证随之失效
        // 尚未执行（含待接手）的节点全部取消；正在执行的节点保留至收尾
        const cancelled = new Set(event.payload.cancelledNodes ?? []);
        for (const node of journey.nodes) {
          if (cancelled.has(node.code)) node.status = NODE_STATUS.CANCELLED;
        }
        break;
      }
      default:
        // 未知事件跳过（前向兼容），不破坏投影
        break;
    }
    if (journey) journeys.set(event.journeyId, journey);
  }
  return journeys;
}

function nodeIndex(journey, code) {
  return journey.nodes.findIndex((node) => node.code === code);
}

function applyHandedOver(journey, p) {
  const idx = nodeIndex(journey, p.node);
  const node = journey.nodes[idx];
  const target = journey.nodes
    .slice(idx + 1)
    .find((candidate) => candidate.status === NODE_STATUS.WAITING);
  node.completedAt = p.at;
  node.status = NODE_STATUS.DONE;
  target.status = NODE_STATUS.PENDING;
  target.handoff = {
    handoffId: p.handoffId,
    fromOperatorId: p.byOperatorId,
    handedAt: p.at,
    deadline: p.deadline,
    currentAssignee: target.expectedAssignee,
    escalated: false,
    escalatedAt: null,
    reassignments: [],
    takenOverAt: null,
    takeoverOperatorId: null,
  };
}

function applyTakenOver(journey, p) {
  const node = journey.nodes[nodeIndex(journey, p.node)];
  node.status = NODE_STATUS.ACTIVE;
  node.activatedAt = p.at;
  node.handoff.takenOverAt = p.at;
  node.handoff.takeoverOperatorId = p.byOperatorId;
}

function applyServiceCompleted(journey, p) {
  const node = journey.nodes[nodeIndex(journey, p.node)];
  node.status = NODE_STATUS.DONE;
  node.completedAt = p.at;
  // 已撤回的旅程保持 WITHDRAWN（其余节点已取消）
  if (journey.status === "ACTIVE") journey.status = "COMPLETED";
}

function applyEscalated(journey, p) {
  const node = journey.nodes[nodeIndex(journey, p.node)];
  node.handoff.escalated = true;
  node.handoff.escalatedAt = p.at;
}

function applyReassigned(journey, p) {
  const node = journey.nodes[nodeIndex(journey, p.node)];
  node.handoff.reassignments.push({
    fromOperatorId: p.fromOperatorId,
    toOperatorId: p.toOperatorId,
    at: p.at,
  });
  node.handoff.currentAssignee = p.toOperatorId;
  node.handoff.deadline = p.newDeadline;
  // 改派后需要新人重新接手，升级标记保留历史但计时重新开始
  node.handoff.escalated = false;
  node.handoff.escalatedAt = null;
}

function applyRouteRebuilt(journey, p) {
  if (p.flight !== undefined) journey.flight = p.flight;
  if (p.gate !== undefined) journey.gate = p.gate;
  // 保留所有已开始节点（PENDING/ACTIVE/DONE），仅重建 WAITING 的后续路线
  const kept = journey.nodes.filter((node) => node.status !== NODE_STATUS.WAITING);
  const rebuilt = p.route.map((step) => ({
    code: step.code,
    dueAt: step.dueAt,
    expectedAssignee: step.expectedAssignee,
    status: NODE_STATUS.WAITING,
    activatedAt: null,
    completedAt: null,
    handoff: null,
  }));
  journey.nodes = [...kept, ...rebuilt];
}

// ---- 投影辅助查询 ----

export function activeNode(journey) {
  return journey.nodes.find((node) => node.status === NODE_STATUS.ACTIVE) ?? null;
}

export function pendingNode(journey) {
  return journey.nodes.find((node) => node.status === NODE_STATUS.PENDING) ?? null;
}

export function nextNode(journey) {
  return (
    journey.nodes.find(
      (node) => node.status === NODE_STATUS.PENDING || node.status === NODE_STATUS.WAITING,
    ) ?? null
  );
}

export function findHandoff(journey, handoffId) {
  for (const node of journey.nodes) {
    if (node.handoff?.handoffId === handoffId) return node;
  }
  return null;
}

// 断链定位：待接手交接点、责任人与剩余时限
export function chainBreak(journey, nowMs) {
  const node = pendingNode(journey);
  if (!node) return null;
  const def = getNodeDef(node.code);
  const deadlineMs = new Date(node.handoff.deadline).getTime();
  return {
    node: node.code,
    nodeName: def.name,
    handoffId: node.handoff.handoffId,
    handedAt: node.handoff.handedAt,
    upstreamOperatorId: node.handoff.fromOperatorId,
    responsibleOperatorId: node.handoff.currentAssignee,
    deadline: node.handoff.deadline,
    remainingMs: deadlineMs - nowMs,
    // 已发生过超时升级即视为断链逾期（即使时钟回拨/补传历史时间戳）
    overdue: nowMs > deadlineMs || node.handoff.escalated,
    escalated: node.handoff.escalated,
  };
}
