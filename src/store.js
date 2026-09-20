// 持久化存储：单文件 JSON，写临时文件后原子改名。
// 服务重启后从磁盘恢复，交接状态与当前负责人不丢失、不重复。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const emptyState = () => ({
  journeys: {},
  secrets: {},
  tokens: {},
  idempotency: {},
  audit: [],
  events: [],
});

export class Store {
  /** file 为 null 时使用纯内存存储（测试/本地临时运行）。 */
  constructor(file = null) {
    this.file = file;
    this.state = null;
  }

  load() {
    if (this.state) return this.state;
    if (this.file && existsSync(this.file)) {
      this.state = { ...emptyState(), ...JSON.parse(readFileSync(this.file, "utf8")) };
    } else {
      this.state = emptyState();
    }
    return this.state;
  }

  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.file);
  }

  /** 所有读写都经 transact 完成，变更后落盘，保证重启安全。 */
  transact(fn) {
    const out = fn(this.load());
    this.save();
    return out;
  }
}
