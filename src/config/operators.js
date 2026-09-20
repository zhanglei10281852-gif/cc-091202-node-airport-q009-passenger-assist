// 岗位人员名册（参考实现的内置名册；生产环境应由人力/排班系统提供）。
// 每个值守点预置两名同岗人员，第二名用于协调员超时改派。

export const SEED_OPERATORS = Object.freeze([
  { operatorId: "op-checkin-1", name: "值机员甲", role: "CHECKIN_AGENT", station: "CHECKIN", pin: "1001" },
  { operatorId: "op-checkin-2", name: "值机员乙", role: "CHECKIN_AGENT", station: "CHECKIN", pin: "1002" },
  { operatorId: "op-security-1", name: "安检陪护员甲", role: "SECURITY_ESCORT", station: "SECURITY_ENTRY", pin: "2001" },
  { operatorId: "op-security-2", name: "安检陪护员乙", role: "SECURITY_ESCORT", station: "SECURITY_ENTRY", pin: "2002" },
  { operatorId: "op-transfer-1", name: "转运员甲", role: "TRANSFER_AGENT", station: "TERMINAL_TRANSFER", pin: "3001" },
  { operatorId: "op-transfer-2", name: "转运员乙", role: "TRANSFER_AGENT", station: "TERMINAL_TRANSFER", pin: "3002" },
  { operatorId: "op-gate-1", name: "登机口员甲", role: "GATE_AGENT", station: "GATE", pin: "4001" },
  { operatorId: "op-gate-2", name: "登机口员乙", role: "GATE_AGENT", station: "GATE", pin: "4002" },
  { operatorId: "op-cabin-1", name: "舱门乘务员甲", role: "CABIN_CREW", station: "CABIN_DOOR", pin: "5001" },
  { operatorId: "op-cabin-2", name: "舱门乘务员乙", role: "CABIN_CREW", station: "CABIN_DOOR", pin: "5002" },
  { operatorId: "coordinator-1", name: "值班协调员", role: "COORDINATOR", station: null, pin: "9001" },
]);

export class OperatorDirectory {
  constructor(operators = SEED_OPERATORS) {
    this.byId = new Map(operators.map((op) => [op.operatorId, op]));
  }

  get(operatorId) {
    return this.byId.get(operatorId) ?? null;
  }

  verify(operatorId, pin) {
    const op = this.byId.get(operatorId);
    if (!op || op.pin !== pin) return null;
    const { pin: _omit, ...publicOperator } = op;
    return publicOperator;
  }

  // 某值守点的首选值守人（受理时各节点的预期接手人）
  primaryFor(station) {
    for (const op of this.byId.values()) {
      if (op.station === station) return op.operatorId;
    }
    return null;
  }

  describe(operatorId) {
    const op = operatorId ? this.byId.get(operatorId) : null;
    if (!op) return null;
    return { operatorId: op.operatorId, name: op.name, role: op.role, station: op.station };
  }
}
