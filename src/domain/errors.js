// 领域错误：携带 HTTP 状态码与机器可读 code，处理器统一映射。
export class DomainError extends Error {
  constructor(code, message, { status = 400, details } = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export const fail = (code, message, status = 400, details) => {
  throw new DomainError(code, message, { status, details });
};
