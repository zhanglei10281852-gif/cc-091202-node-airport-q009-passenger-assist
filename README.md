# 特殊旅客协助交接服务

管理一次行动不便旅客协助旅程的 Node.js 后端：把值机柜台、安检前、航站楼转运、登机口、机舱门等脱敏服务节点串成**有时限的交接链**，覆盖受理、配对交接、超时升级、迟到回执、改期重建、旅客查询与撤回、岗位级健康资料可见与全程审计。

纯 Node.js 20+ 标准库实现，无外部依赖。

## 运行

```bash
npm test          # 领域与接口测试（node:test）
npm run seed      # 用 fixtures/context.json 时间线演示迟到接手场景（写入 var/store.json）
npm start         # 启动服务，默认 :3000
docker compose up --build   # 容器运行（需 ASSIST_HEALTH_KEY，数据落卷 assist-data）
```

环境变量见 `.env.example`：`DATA_DIR`（持久化目录，缺省内存存储）、`ASSIST_HEALTH_KEY`（32 字节健康资料密钥，生产必须）、`PASSENGER_TOKEN_TTL_HOURS`（旅客凭证有效期，默认 12h）、`PORT`。

## 领域规则

- **数据最小化**：受理只保存服务类别、航班、匿名旅客引用、公开任务说明与节点计划；健康备注按字段白名单裁剪后**独立加密**（AES-256-GCM）存放，旅程实体只留引用。
- **配对交接**：`交出(offer)` 与 `接手(takeover)` 是两个独立操作，配对完成才转移责任；任一时刻一条旅程至多一个进行中节点，即至多一名当前负责人。
- **超时升级**：接手超过时限仍未配对，交接单过期、节点升级为协调员工单；协调员重新指派后链条继续。
- **迟到回执不覆盖**：以服务端处理时间为准。网络恢复后补传的接手回执只登记留痕（`lateReceipts`），绝不覆盖已发生的重新指派。
- **改期重建**：航班/登机口变化时保留已完成与进行中的节点，未开始的旧路线标记 `CANCELLED/REROUTE` 留痕，按模板重建后续路线并向当前负责人展示新的下一站。
- **旅客凭证**：受理时下发短期查询凭证（服务端只存散列），旅客可查进度但看不到员工内部备注与健康资料；可撤回尚未执行的服务——完成节点保留、健康资料清除、操作证据（事件与审计）依法保留。
- **岗位可见范围**：健康字段按岗位矩阵披露（如转运员可见 `transfer`，`medical` 仅协调员），且只有当前节点负责人或协调员可读；每次敏感读取的 ALLOW/DENY 与依据都写入审计。
- **幂等与重启安全**：变更类接口支持 `Idempotency-Key` 重放保护，同一员工重复扫码天然幂等；状态原子落盘（`DATA_DIR/store.json`），重启后不丢交接状态、不产生第二名负责人。

## API 一览

员工接口需 `x-staff-id` / `x-staff-role` 头（演示级鉴权，生产应替换为 SSO/mTLS）；旅客接口需 `Authorization: Bearer pt_...`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/journeys` | 受理登记（协调员/值机），返回旅程与旅客凭证 |
| GET | `/journeys` · `/journeys/:id` | 员工视图：公开任务、交接状态、下一站 |
| GET | `/journeys/:id/health` | 健康备注（按岗位裁剪，全程审计） |
| POST | `/journeys/:id/offer` | 当前负责人交出下一节点 |
| POST | `/journeys/:id/takeover` | 扫码接手（幂等；迟到回执 409 留痕） |
| POST | `/journeys/:id/complete` | 完成当前节点（末节点完成旅程） |
| POST | `/journeys/:id/notes` | 员工内部备注（旅客不可见） |
| POST | `/journeys/:id/reroute` | 航班/登机口变化重建后续路线（协调员） |
| GET | `/coordinator/journeys/:id/chain` | 断链位置、责任人、剩余接手时限 |
| GET | `/coordinator/escalations` | 待处理超时升级单 |
| POST | `/coordinator/escalations/:id/reassign` | 协调员重新指派 |
| GET | `/coordinator/journeys/:id/audit` | 审计与事件证据 |
| GET | `/passenger/journeys/:id/progress` | 旅客进度（凭证） |
| POST | `/passenger/journeys/:id/withdraw` | 旅客撤回未执行服务（凭证） |

## 代码结构

```
src/templates.js  节点模板、岗位、健康字段可见范围
src/crypto.js     健康资料 AES-256-GCM 加解密、凭证散列
src/store.js      单文件 JSON 存储（临时文件 + 原子改名）
src/domain.js     交接链状态机与全部业务规则
src/app.js        HTTP 路由、鉴权、Idempotency-Key、错误格式
src/server.js     装配入口（buildServer）与定时超时结算
scripts/seed.mjs  夹具时间线演示脚本
fixtures/         脱敏样例（不含真实姓名、证件号或联系方式）
```

任何真实健康资料、短期查询凭证和加密密钥均由 `.gitignore` 隔离（`var/`、`.env*`）。
