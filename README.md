# 特殊旅客协助交接服务

管理一次无障碍协助旅程（值机柜台 → 安检前 → 航站楼转运 → 登机口 → 机舱门），
把各服务节点串成**有接手时限、可升级、可审计**的交接链。零外部依赖，仅使用 Node.js 内置模块。

## 它解决的问题

- 每次交接必须**交出 + 接手配对**，且由两名不同的操作人完成；
- 接手超时自动**升级给协调员**，协调员可改派；
- **网络恢复后的迟到回执永远不能覆盖已经发生的重新指派**；
- 重复扫码、并发请求、进程重启都不会产生两名当前负责人（事件溯源 + 单写者互斥）；
- 受理时只保存服务必需字段；**健康备注与公开任务物理分离并加密**；
- 执行人员只能读取当前值守/被指派节点所需内容；读健康备注必须填写服务目的并逐次审计；
- 航班/登机口变更时保留所有已开始节点，只重建未开始的后续路线；
- 旅客凭短期查询凭证看进度（看不到员工内部备注），可撤回尚未执行的服务，但事件与审计证据依法保留；
- 协调员仪表盘一眼定位断链位置、上/下游责任人、剩余时限；
- 审计日志为**哈希链**（每行含上一行哈希），任何删改都可被离线核验。

## 运行

```bash
npm test          # 19 个测试：领域流程、并发、HTTP 端到端
npm start         # http://localhost:3000/health
docker compose up --build
```

环境变量：

| 变量 | 说明 |
| --- | --- |
| `PORT` | HTTP 端口，默认 3000 |
| `DATA_DIR` | 数据目录（事件/审计/密文保险库），默认 `./data`，已被 git 忽略 |
| `ASSIST_DATA_KEY` | 健康备注主密钥，32 字节 base64（`openssl rand -base64 32`）。未设置时使用进程内随机密钥，重启后历史密文不可解密 |
| `SWEEP_INTERVAL_MS` | 后台超时扫描间隔，默认 15000 |

## 数据模型

- `data/events.jsonl`：追加式领域事件，重启回放重建全部状态；
- `data/audit.jsonl`：哈希链审计日志，撤回旅程也不删除；
- `data/health.jsonl.enc`：健康备注 AES-256-GCM 信封。事件日志里只有无含义的 `healthRef`；撤回时密文被物理销毁。

## 身份

- 员工：请求体传 `operatorId` + `pin`（参考实现内置名册，见 `src/config/operators.js`）；
- 协调员 GET 接口身份走 `x-operator-id` / `x-operator-pin` 请求头（避免口令进入 URL）；
- 旅客：受理时返回一次性 `queryToken`（仅存其 SHA-256 哈希），放在 `Authorization: Bearer <token>`，默认 24 小时有效，撤回即失效。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/journeys` | 受理。body：`serviceCode`、`flight`、`gate?`、`taskData?`（白名单字段）、`healthNote?`。返回 `journeyId` + `queryToken` |
| POST | `/journeys/:id/handover` | 当前负责人交出到下一节点 |
| POST | `/journeys/:id/takeover` | 被指派人接手；超时/被改派均会被拒并审计 |
| POST | `/journeys/:id/complete` | 节点完成（中途节点须先交出；末端机舱门关闭整段服务） |
| POST | `/journeys/:id/reassign` | 协调员在超时升级后改派 |
| POST | `/journeys/:id/route` | 航班/登机口变更，重建未开始路线（`flight?`、`gate?`） |
| POST | `/journeys/:id/operator-view` | 当前值守/指派视角的最小必要任务信息 |
| POST | `/journeys/:id/health` | 读取健康备注（须 `purpose`，仅开放节点的负责人） |
| GET | `/journeys/:id/progress` | 旅客进度（Bearer 凭证），无员工内部信息 |
| POST | `/journeys/:id/withdraw` | 旅客撤回未执行服务（Bearer 凭证可放 body/头） |
| GET | `/coordinator/dashboard` | 断链、责任人、剩余时限总览 |
| GET | `/coordinator/audit?journeyId=...` | 审计条目与哈希链核验结果 |

## 节点与岗位（`src/config/catalog.js`）

| 节点 | 岗位 | 接手时限 | 健康备注 |
| --- | --- | --- | --- |
| CHECKIN 值机柜台 | CHECKIN_AGENT | 15 分钟 | 不开放 |
| SECURITY_ENTRY 安检前 | SECURITY_ESCORT | 10 分钟 | 不开放 |
| GATE 登机口 | GATE_AGENT | 15 分钟 | 不开放 |
| TERMINAL_TRANSFER 航站楼转运 | TRANSFER_AGENT | 20 分钟 | 仅服务目的下开放 |
| CABIN_DOOR 机舱门 | CABIN_CREW | 10 分钟 | 仅服务目的下开放 |

## 主要不变量

1. 任意时刻至多一个 ACTIVE 节点，负责人唯一；
2. 交接必须跨人；重复交出/接手被拒，状态不产生重复；
3. 超时只允许协调员改派；前任指派人的迟到回执恒被拒绝并留痕；
4. 敏感数据"拿不到（岗位隔离）+ 看不懂（加密）+ 说不清（无目的审计拒绝）"；
5. 撤回只销毁业务与密文，不动审计证据。
