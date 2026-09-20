// 健康备注保险库：与领域事件物理分离的加密存储。
// 事件日志里只有 healthRef（无含义随机标识）；明文备注从不落盘。
// 撤回时销毁信封（密文删除即不可恢复），销毁动作本身进入审计。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { encrypt, decrypt, newId } from "../security/crypto.js";

export class HealthVault {
  constructor(file) {
    this.file = file;
    this.records = new Map();
    this._tail = Promise.resolve();
  }

  async load() {
    let text;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
    for (const line of text.split("\n").filter((l) => l.trim())) {
      const record = JSON.parse(line);
      this.records.set(record.healthRef, record.envelope);
    }
  }

  put(note) {
    const healthRef = newId("hr");
    const envelope = encrypt(note);
    this.records.set(healthRef, envelope);
    this._tail = this._tail.then(() => this.persist());
    return healthRef;
  }

  reveal(healthRef) {
    const envelope = this.records.get(healthRef);
    if (!envelope) {
      const err = new Error("health_note_unavailable");
      err.code = "health_note_unavailable";
      throw err;
    }
    return decrypt(envelope);
  }

  has(healthRef) {
    return this.records.has(healthRef);
  }

  destroy(healthRef) {
    if (!this.records.has(healthRef)) return;
    this.records.delete(healthRef);
    this._tail = this._tail.then(() => this.persist());
    return this._tail;
  }

  flushed() {
    return this._tail;
  }

  async persist() {
    // 整文件重写以保证撤回后的密文物理消失（数据量为单次协助旅程级）
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, serialize(this.records), "utf8");
  }
}

function serialize(map) {
  const lines = [...map.entries()].map(([healthRef, envelope]) =>
    JSON.stringify({ healthRef, envelope }));
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
