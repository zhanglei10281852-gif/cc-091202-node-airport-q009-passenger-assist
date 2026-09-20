// 追加式领域事件存储（JSONL）。
// 重启后回放事件即可重建全部聚合状态——重复扫码、进程重启都不会产生额外状态。

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export class EventStore {
  constructor(file, { clock = () => new Date() } = {}) {
    this.file = file;
    this.clock = clock;
    this.events = [];
    // 串行化所有追加，避免并发命令交错写坏行序
    this._tail = Promise.resolve();
  }

  async load() {
    let text;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        this.events = [];
        return this.events;
      }
      throw err;
    }
    this.events = text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (err) {
          throw new Error(`corrupt event log at line ${index + 1}: ${err.message}`);
        }
      });
    return this.events;
  }

  byJourney(journeyId) {
    return this.events.filter((event) => event.journeyId === journeyId);
  }

  append(event) {
    // 克隆载荷：已入日志的事件不得被调用方后续修改所污染
    const entry = {
      eventId: event.eventId,
      journeyId: event.journeyId,
      type: event.type,
      at: event.at,
      payload: structuredClone(event.payload),
    };
    this._tail = this._tail.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await appendFile(this.file, `${JSON.stringify(entry)}\n`, "utf8");
      this.events.push(entry);
    });
    return this._tail;
  }
}
