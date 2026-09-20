// 防篡改审计日志（追加式 JSONL + 哈希链）。
// 每一行保存前一行的哈希；任何删改都会让链条断裂，verify() 可离线核验。
// 撤回旅程只删除业务资料，审计证据依法保留。

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

function hashEntry(entry, prevHash) {
  return createHash("sha256")
    .update(`${prevHash}\n${JSON.stringify(entry)}`)
    .digest("hex");
}

export class AuditLog {
  constructor(file) {
    this.file = file;
    this.entries = [];
    this._tail = Promise.resolve();
    this._prevHash = "0".repeat(64);
  }

  async load() {
    let text;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        this.entries = [];
        return;
      }
      throw err;
    }
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    let prev = "0".repeat(64);
    this.entries = lines.map((line, index) => {
      const entry = JSON.parse(line);
      if (entry.prevHash !== prev) {
        throw new Error(`audit chain broken at line ${index + 1}: prevHash mismatch`);
      }
      const expected = hashEntry(stripChain(entry), prev);
      if (entry.hash !== expected) {
        throw new Error(`audit chain broken at line ${index + 1}: hash mismatch`);
      }
      prev = entry.hash;
      return entry;
    });
    this._prevHash = prev;
  }

  record(action, { journeyId = null, actor = null, reason = null, detail = null, at } = {}) {
    const when = at ?? new Date().toISOString();
    // 克隆入参：审计条目须与调用方对象脱钩，防止外部后续修改（如数组 sort）
    // 回头篡改已入链的证据。
    const safeDetail = detail === undefined || detail === null ? null : structuredClone(detail);
    const safeReason = reason === undefined || reason === null ? null : String(reason);
    const body = {
      seq: this.entries.length,
      at: when,
      action: String(action),
      journeyId,
      actor: actor === undefined ? null : actor,
      reason: safeReason,
      detail: safeDetail,
    };
    const entry = { ...body, prevHash: this._prevHash, hash: hashEntry(body, this._prevHash) };
    this._tail = this._tail.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await appendFile(this.file, `${JSON.stringify(entry)}\n`, "utf8");
      this.entries.push(entry);
      this._prevHash = entry.hash;
    });
    return this._tail;
  }

  forJourney(journeyId) {
    return this.entries.filter((entry) => entry.journeyId === journeyId);
  }

  verify() {
    let prev = "0".repeat(64);
    for (const [index, entry] of this.entries.entries()) {
      if (entry.prevHash !== prev) {
        return { ok: false, brokenAt: index + 1, reason: "prevHash mismatch" };
      }
      const expected = hashEntry(stripChain(entry), prev);
      if (entry.hash !== expected) {
        return { ok: false, brokenAt: index + 1, reason: "hash mismatch" };
      }
      prev = entry.hash;
    }
    return { ok: true, count: this.entries.length };
  }
}

function stripChain(entry) {
  const { prevHash: _p, hash: _h, ...body } = entry;
  return body;
}
