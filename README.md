# 配方谱系试制台（墨锭试磨室 v2）

在原墨锭试磨室基础上扩展：把每一次配方试制作为**版本**管理，支持父子谱系、完整快照、
受控状态流转、驳回自动衍版，并保证并发与写入失败下的原子性。

## 运行

```bash
npm start          # http://localhost:3037
npm run verify     # 端到端验证（自动起停服务，使用临时数据文件，71 项断言）
```

数据保存在 `data/formula-lineage.json`（原子写入：先写 `*.tmp` 再 rename，
启动时清理残留临时文件）。可用 `INK_DATA=路径` 和 `PORT=端口` 覆盖。

## 领域模型

- **版本（version）**：编号 `FV-0001…`，含烟料、胶比、存放年限/位置/温度/湿度的**完整配方快照**，
  以及父版本 id、代数、标题、状态、试磨记录、操作时间线。
- **衍版**：只有**已定版**版本能建立子版本；子版本复制父版本完整快照并叠加改动。
  后代不引用父版本的任何字段——父版本之后再被修改（或被存储层篡改），既有后代纹丝不动。
- **驳回**：仅待确认版本可驳回，必须指出**失败步骤**（调胶/杵捣/试磨/成色/干燥，可多选）
  和**原因**；驳回在同一次原子写入里把原版本置为「退回调整」终态，并自动生成带原因快照
  （`originReject`）的调整子版本。

## 状态机

```
待试制 ──开始试磨──▶ 试磨中 ──提交结果──▶ 待确认 ──确认──▶ 已定版（可衍版）
                                       └──驳回──▶ 退回调整（终态，自动出调整版）
```

- 任何非法跳转返回 `409 illegal_transition`。
- 已定版重复确认返回 `409 already_finalized`（确认只能成功一次）。
- 同一版本开始试磨即被占用：重复/并发「开始试磨」只有第一次成功，其余 409。

## 并发与原子性

- 所有写操作走**进程内全局串行锁**；同版本状态变更由锁 + 状态前置条件双重保护，
  并发确认/并发开始试磨保证恰有一次成功。
- 写接口支持 `idempotencyKey`：同键重试（含并发重试）重放首次响应，不会产生第二条记录。
- 每次写操作**一次**原子落盘；业务校验失败或落盘失败都发生在数据文件变更之前，
  不会留下半条版本、试磨或操作记录。
- 失败注入钩子：`ENABLE_TEST_HOOKS=1` 时 `POST /api/test/fail-next-write`
  可让下一次落盘失败，验证脚本用它检验原子性。

## 界面

左侧谱系树（代数缩进、状态色标、搜索），右侧详情：配方快照、与父版本**差异表**、
驳回/调整来源提示、试磨记录、**时间线**；按当前状态给出可执行操作（开始试磨/提交/
确认/驳回/衍版/编辑/备注）。响应式布局，≤860px 自动切单列，手机可用。

## 主要 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/lineage` | 谱系树（嵌套 children） |
| GET | `/api/versions` / `/api/versions/:id` | 版本列表 / 详情 |
| POST | `/api/versions` | 建根版本（待试制） |
| PATCH | `/api/versions/:id` | 待试制版本改配方 |
| POST | `/api/versions/:id/derive` | 已定版衍子版本（body 可带 formula 覆盖项） |
| POST | `/api/versions/:id/start-grinding` | 开始试磨（占用） |
| POST | `/api/versions/:id/submit-grinding` | 提交试磨结果 → 待确认 |
| POST | `/api/versions/:id/confirm` | 确认定版（仅一次） |
| POST | `/api/versions/:id/reject` | 驳回（failSteps + reason，可带 formulaAdjust），返回 rejected/adjustment |
| GET | `/api/versions/:a/diff/:b` | 两版本配方逐字段差异 |
| GET | `/api/stats` `/api/meta` | 状态统计 / 字段与状态机元数据 |

所有 POST/PATCH 可在 JSON body 中带 `idempotencyKey`。
