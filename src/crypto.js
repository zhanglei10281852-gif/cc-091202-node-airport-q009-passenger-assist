// 健康备注分离加密与短期查询凭证工具。
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";

const DEV_PASSWORD = "assist-dev-only-not-for-production";

// 健康资料密钥：生产必须经 ASSIST_HEALTH_KEY（32 字节，hex 或 base64）注入；
// 开发/测试缺省使用派生的固定密钥，便于本地复现。
export function loadHealthKey(env = process.env) {
  const raw = env.ASSIST_HEALTH_KEY;
  if (raw) {
    const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    if (buf.length !== 32) throw new Error("ASSIST_HEALTH_KEY 必须是 32 字节（hex 或 base64）");
    return buf;
  }
  if (env.NODE_ENV === "production") throw new Error("生产环境必须设置 ASSIST_HEALTH_KEY");
  return scryptSync(DEV_PASSWORD, "assist-health", 32);
}

export function encryptJson(key, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

export function decryptJson(key, blob) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  const data = Buffer.concat([decipher.update(Buffer.from(blob.data, "base64")), decipher.final()]);
  return JSON.parse(data.toString("utf8"));
}

// 旅客短期查询凭证：明文只下发一次，服务端只存散列。
export function newPassengerToken() {
  return `pt_${randomBytes(24).toString("base64url")}`;
}

export function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}
