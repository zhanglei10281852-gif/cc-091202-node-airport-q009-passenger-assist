// 敏感数据加密与凭证工具，全部基于 Node 内置 crypto（零外部依赖）。
//
// 健康备注与公开任务分离：任务数据明文保存，健康备注以独立信封加密，
// 只有在节点 healthScope === "SERVICE" 且携带服务目的时才解密。

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;

// 主密钥来自环境变量（32 字节 base64）；未提供时生成进程内随机密钥。
// 注意：随机密钥意味着进程重启后历史健康备注无法解密——这正是“密钥不得入库”的默认姿态，
// 生产部署必须通过 ASSIST_DATA_KEY 注入。
let cachedKey = null;

export function getDataKey() {
  if (cachedKey) return cachedKey;
  if (process.env.ASSIST_DATA_KEY) {
    const key = Buffer.from(process.env.ASSIST_DATA_KEY, "base64");
    if (key.length !== KEY_LEN) {
      throw new Error("ASSIST_DATA_KEY must decode to 32 bytes (base64)");
    }
    cachedKey = key;
  } else {
    cachedKey = randomBytes(KEY_LEN);
  }
  return cachedKey;
}

export function encrypt(plaintext, key = getDataKey()) {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    alg: ALGO,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decrypt(envelope, key = getDataKey()) {
  if (!envelope || envelope.alg !== ALGO) {
    const err = new Error("bad_envelope");
    err.code = "bad_envelope";
    throw err;
  }
  const decipher = createDecipheriv(
    ALGO,
    key,
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

// 查询凭证：旅客短期持有。只保存其哈希（存库即存令牌等价于明文令牌）。
export function issueQueryToken() {
  const token = randomBytes(24).toString("base64url"); // 约 192 bit 熵
  return { token, hash: hashToken(token) };
}

export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function newId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

// 恒定时间比较，避免凭证比对计时侧信道
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
