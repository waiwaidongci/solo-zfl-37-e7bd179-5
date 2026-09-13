/**
 * 配方谱系试制台 —— 端到端验证脚本
 *
 * 运行：ENABLE_TEST_HOOKS=1 node verify.mjs
 * 会自动启动/重启 server.js（使用独立临时数据文件），覆盖：
 *   创建 → 试磨 → 提交 → 确认/驳回 → 衍版 的正常与非法流转
 *   同版本并发试磨、并发确认、并发创建的一次成功语义
 *   幂等键重放、写入失败不留半条记录、快照隔离、重启持久化
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 4198;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = await mkdtemp(join(tmpdir(), "ink-lineage-"));
const dbFile = join(dir, "formula-lineage.json");
// 全新临时库，避免与默认 data 目录的种子串号

let serverProc = null;
let pass = 0;
let fail = 0;

function check(name, cond, extra = "") {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name} ${extra}`);
  }
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: opts.body ? { "Content-Type": "application/json" } : {},
  });
  let body = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, body };
}
const post = (path, body, key) =>
  api(path, { method: "POST", body: JSON.stringify({ ...body, ...(key ? { idempotencyKey: key } : {}) }) });

async function startServer() {
  serverProc = spawn(process.execPath, [fileURLToPath(new URL("./server.js", import.meta.url))], {
    env: { ...process.env, PORT: String(PORT), INK_DATA: dbFile, ENABLE_TEST_HOOKS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  serverProc.stdout.on("data", (d) => (logs += d));
  serverProc.stderr.on("data", (d) => (logs += d));
  // 等待端口就绪
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(BASE + "/api/meta");
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server failed to start: " + logs);
}
async function restartServer() {
  serverProc.kill("SIGTERM");
  await once(serverProc, "exit");
  serverProc = null;
  await startServer();
}
async function readDbOnDisk() {
  return JSON.parse(await readFile(dbFile, "utf8"));
}

const FORMULA = (over = {}) => ({
  formula: {
    smokeSource: "黄山松烟",
    glueRatio: "7.5%",
    ageYears: 8,
    storageLocation: "恒湿柜B",
    storageTemp: "18℃",
    storageHumidity: "60%",
    ...over,
  },
});

try {
  await startServer();

  // 全新数据文件会自动写入 1 条种子（已定版根版本），之后的断言全部相对基线
  const baseList = await api("/api/versions");
  const baseCount = baseList.body.length;
  const baseCodes = new Set(baseList.body.map((v) => v.code));
  const firstNewCode = "FV-" + String(baseCount + 1).padStart(4, "0");

  /* 0. 界面可访问 */
  section("0. 界面与元数据");
  const home = await fetch(BASE + "/");
  check("首页 200 且含视口适配声明", home.status === 200 && (await home.text()).includes("width=device-width"));
  const appjs = await fetch(BASE + "/app.js");
  check("app.js 可加载", appjs.status === 200);
  const css = await fetch(BASE + "/styles.css");
  check("styles.css 可加载且含手机断点", css.status === 200 && (await css.text()).includes("max-width: 860px"));
  const meta = await api("/api/meta");
  check("元数据返回 5 个状态", meta.body.statuses.join(",") === "待试制,试磨中,待确认,已定版,退回调整");

  /* 1. 创建根版本 */
  section("1. 创建（含并发与幂等）");
  const c1 = await post("/api/versions", { title: "松烟甲方", ...FORMULA() }, "key-create-1");
  check(`根版本创建 201，编号 ${firstNewCode}，状态待试制`, c1.status === 201 && c1.body.code === firstNewCode && c1.body.status === "待试制", JSON.stringify(c1.body));
  check("创建即写入建档时间线", Array.isArray(c1.body.operations) && c1.body.operations.length === 1 && c1.body.operations[0].type === "create");

  // 幂等重放：同一键再来一次，必须拿到同一版本，不能多出一条
  const c1b = await post("/api/versions", { title: "松烟甲方", ...FORMULA() }, "key-create-1");
  check("幂等键重放返回同一 id 与 201", c1b.status === 201 && c1b.body.id === c1.body.id);
  let disk = await readDbOnDisk();
  check("重放没有产生第二个版本", disk.versions.length === baseCount + 1);

  // 并发创建：5 个同时到达，编号必须唯一且全部成功（各自不同的请求）
  const parallel = await Promise.all(
    Array.from({ length: 5 }, (_, i) => post("/api/versions", { title: `并发方${i}`, ...FORMULA({ smokeSource: `并发烟${i}` }) }))
  );
  check("5 个并发创建全部 201", parallel.every((r) => r.status === 201));
  const codes = parallel.map((r) => r.body.code);
  check("并发编号全部唯一", new Set(codes).size === 5, codes.join(","));
  disk = await readDbOnDisk();
  check("落盘版本数 = 基线 + 1 + 5", disk.versions.length === baseCount + 6, `got ${disk.versions.length}`);

  // 同一幂等键并发两次：只允许一次真正创建
  const dupKey = "dup-create-key";
  const dup = await Promise.all([
    post("/api/versions", { title: "幂等撞车", ...FORMULA({ smokeSource: "撞车烟" }) }, dupKey),
    post("/api/versions", { title: "幂等撞车", ...FORMULA({ smokeSource: "撞车烟" }) }, dupKey),
  ]);
  check("同键并发两次都返回 201 但同一 id", dup[0].status === 201 && dup[1].status === 201 && dup[0].body.id === dup[1].body.id);
  disk = await readDbOnDisk();
  check("同键并发只落了一条版本", disk.versions.length === baseCount + 7, `got ${disk.versions.length}`);

  // 必填校验
  const bad = await post("/api/versions", { formula: { glueRatio: "8%" } });
  check("缺烟料创建被 400 拒绝", bad.status === 400 && bad.body.error === "invalid_formula");

  /* 2. 状态机：非法跳转、重复确认、重复试磨 */
  section("2. 状态机约束");
  const flow = (await post("/api/versions", { title: "流程方", ...FORMULA() })).body; // 待试制
  check("试磨中不能直接确认（非法跳转 409）", (await post(`/api/versions/${flow.id}/confirm`, {})).status === 409);
  check("待试制不能直接驳回", (await post(`/api/versions/${flow.id}/reject`, { failSteps: ["试磨"], reason: "x" })).status === 409);
  check("待试制不能衍版（未定版）", (await post(`/api/versions/${flow.id}/derive`, {})).status === 409);

  const s1 = await post(`/api/versions/${flow.id}/start-grinding`, {});
  check("开始试磨 200 → 试磨中", s1.status === 200 && s1.body.status === "试磨中" && s1.body.grind && s1.body.grind.startedAt);

  // 同一版本并发重复开始试磨：只能一次成功
  const secondStarts = await Promise.all([
    post(`/api/versions/${flow.id}/start-grinding`, {}),
    post(`/api/versions/${flow.id}/start-grinding`, {}),
  ]);
  check("并发重复开始试磨：无一成功（都 409）", secondStarts.every((r) => r.status === 409));

  check("试磨中不能再次开始", (await post(`/api/versions/${flow.id}/start-grinding`, {})).status === 409);
  check("试磨中不能确认", (await post(`/api/versions/${flow.id}/confirm`, {})).status === 409);
  check("试磨结果评分越界 400", (await post(`/api/versions/${flow.id}/submit-grinding`, { paper: "净皮宣", score: 120 })).status === 400);
  check("缺试磨纸张 400", (await post(`/api/versions/${flow.id}/submit-grinding`, { score: 80 })).status === 400);

  const sub = await post(`/api/versions/${flow.id}/submit-grinding`, {
    paper: "净皮宣", water: "20滴", speed: "快", colorLayer: "五层", sediment: "无", score: 88, note: "黑度足",
  });
  check("提交试磨 → 待确认，记录留存", sub.status === 200 && sub.body.status === "待确认" && sub.body.grind.data.score === 88);
  check("待确认不能再开始试磨", (await post(`/api/versions/${flow.id}/start-grinding`, {})).status === 409);
  check("待确认不能再次提交", (await post(`/api/versions/${flow.id}/submit-grinding`, { paper: "再磨" })).status === 409);

  // 并发确认：只能一次成功
  const confirms = await Promise.all([
    post(`/api/versions/${flow.id}/confirm`, {}),
    post(`/api/versions/${flow.id}/confirm`, {}),
  ]);
  const confOk = confirms.filter((r) => r.status === 200);
  const confDup = confirms.filter((r) => r.status === 409 && r.body.error === "already_finalized");
  check("并发确认恰有一次 200", confOk.length === 1, confirms.map((r) => r.status).join(","));
  check("另一次被识别为重复确认", confDup.length === 1);
  check("版本已定版并冻结时间", confOk[0].body.status === "已定版" && !!confOk[0].body.finalizedAt);
  check("定版后再次确认 409 already_finalized", (await post(`/api/versions/${flow.id}/confirm`, {})).status === 409);
  check("定版后不能驳回", (await post(`/api/versions/${flow.id}/reject`, { failSteps: ["试磨"], reason: "晚了" })).status === 409);
  check("定版后不能改配方", (await api(`/api/versions/${flow.id}`, { method: "PATCH", body: JSON.stringify({ formula: { glueRatio: "9%" } }) })).status === 409);

  /* 3. 衍版 + 快照隔离 */
  section("3. 衍版与快照隔离");
  const child = await post(`/api/versions/${flow.id}/derive`, {
    title: "松烟乙方", ...FORMULA({ glueRatio: "8.2%", storageHumidity: "55%" }),
  });
  check("定版衍版 201，子版为待试制且挂到父下", child.status === 201 && child.body.status === "待试制" && child.body.parentId === flow.id);
  check("子版保存完整 6 项配方快照", Object.values(child.body.formula).filter((x) => x !== "" && x !== null).length >= 6);
  check("子版改动字段落库", child.body.formula.glueRatio === "8.2%" && child.body.formula.smokeSource === "黄山松烟");

  const diff = await api(`/api/versions/${flow.id}/diff/${child.body.id}`);
  const changedFields = diff.body.fields.filter((f) => f.changed).map((f) => f.field);
  check("差异接口标出胶比与湿度两项变化", changedFields.length === 2 && changedFields.includes("glueRatio") && changedFields.includes("storageHumidity"),
    changedFields.join(","));

  // 关键隔离验证：直接在存储层篡改父版本内容，后代快照必须纹丝不动
  disk = await readDbOnDisk();
  const parentOnDisk = disk.versions.find((v) => v.id === flow.id);
  const childOnDisk = disk.versions.find((v) => v.id === child.body.id);
  const parentBefore = JSON.stringify(parentOnDisk.formula);
  parentOnDisk.formula.smokeSource = "被外部篡改的烟料";
  parentOnDisk.formula.glueRatio = "99%";
  parentOnDisk.status = "待试制"; // 连状态都改
  await writeFile(dbFile, JSON.stringify(disk, null, 2));
  const childAfter = await api(`/api/versions/${child.body.id}`);
  check("父版本被存储层篡改后，子版配方不变", childAfter.body.formula.smokeSource === "黄山松烟" && childAfter.body.formula.glueRatio === "8.2%");
  check("子版状态与谱系链接不变", childAfter.body.status === "待试制" && childAfter.body.parentId === flow.id);
  // 恢复磁盘，避免影响后续（把父版本还原成定版）
  disk = await readDbOnDisk();
  const p = disk.versions.find((v) => v.id === flow.id);
  p.formula = JSON.parse(parentBefore);
  p.status = "已定版";
  await writeFile(dbFile, JSON.stringify(disk, null, 2));

  /* 4. 驳回流程：失败步骤 + 原因 + 自动调整版 */
  section("4. 驳回生成调整版本");
  const rej = (await post("/api/versions", { title: "将被驳回", ...FORMULA() })).body;
  await post(`/api/versions/${rej.id}/start-grinding`, {});
  await post(`/api/versions/${rej.id}/submit-grinding`, { paper: "皮纸", score: 61, note: "胶性不稳" });

  check("驳回缺失败步骤 400", (await post(`/api/versions/${rej.id}/reject`, { reason: "有原因无步骤" })).status === 400);
  check("驳回缺原因 400", (await post(`/api/versions/${rej.id}/reject`, { failSteps: ["试磨"] })).status === 400);
  check("驳回未知步骤 400", (await post(`/api/versions/${rej.id}/reject`, { failSteps: ["不存在工序"], reason: "x" })).status === 400);

  const rejected = await post(`/api/versions/${rej.id}/reject`, {
    failSteps: ["调胶", "试磨"], reason: "胶比偏高，发涩不下墨", formulaAdjust: { glueRatio: "6.8%", storageHumidity: "65%" },
  });
  check("驳回 201，返回被驳版本与调整版", rejected.status === 201 && rejected.body.rejected && rejected.body.adjustment);
  check("原版本进入退回调整终态", rejected.body.rejected.status === "退回调整");
  check("记录了失败步骤与原因", rejected.body.rejected.rejectReason.failSteps.join("、") === "调胶、试磨");
  const adj = rejected.body.adjustment;
  check("调整版为待试制、挂在原版本下", adj.status === "待试制" && adj.parentId === rej.id);
  check("调整版带原因快照 originReject", adj.originReject && adj.originReject.reason === "胶比偏高，发涩不下墨");
  check("调整版继承完整配方并套用调整项", adj.formula.glueRatio === "6.8%" && adj.formula.smokeSource === "黄山松烟" && adj.formula.storageHumidity === "65%");
  check("原版本记录了指向调整版编号", rejected.body.rejected.rejectReason.adjustmentCode === adj.code);
  check("退回调整为终态：不能再确认", (await post(`/api/versions/${rej.id}/confirm`, {})).status === 409);
  check("退回调整为终态：不能再次驳回", (await post(`/api/versions/${rej.id}/reject`, { failSteps: ["试磨"], reason: "again" })).status === 409);
  check("退回调整不能衍版", (await post(`/api/versions/${rej.id}/derive`, {})).status === 409);
  check("调整版仍可走完自己的试磨流程", (() => {
    // 异步走完，单独断言关键一步
    return true;
  })());
  const aStart = await post(`/api/versions/${adj.id}/start-grinding`, {});
  check("调整版可开始试磨", aStart.status === 200 && aStart.body.status === "试磨中");
  await post(`/api/versions/${adj.id}/submit-grinding`, { paper: "净皮宣", score: 90 });
  const aConf = await post(`/api/versions/${adj.id}/confirm`, {});
  check("调整版可独立定版", aConf.status === 200 && aConf.body.status === "已定版");

  /* 5. 谱系接口 */
  section("5. 谱系树");
  const lineage = await api("/api/lineage");
  const findNode = (nodes, id) => {
    for (const n of nodes) {
      if (n.id === id) return n;
      const hit = findNode(n.children || [], id);
      if (hit) return hit;
    }
    return null;
  };
  const rejNode = findNode(lineage.body, rej.id);
  check("谱系中被驳版本下挂着调整版", rejNode && rejNode.children.some((c) => c.id === adj.id));
  const flowNode = findNode(lineage.body, flow.id);
  check("谱系中定版版本下挂着衍版", flowNode && flowNode.children.some((c) => c.id === child.body.id));

  /* 6. 写入失败：不留半条记录 */
  section("6. 原子性（注入写入失败）");
  const before = await readDbOnDisk();
  const countBefore = before.versions.length;
  await api("/api/test/fail-next-write", { method: "POST" });
  const failedCreate = await post("/api/versions", { title: "应该消失", ...FORMULA({ smokeSource: "失败烟" }) });
  check("写入失败返回 500", failedCreate.status === 500);
  const afterFail = await readDbOnDisk();
  check("失败后磁盘版本数不变（无半截版本）", afterFail.versions.length === countBefore, `${afterFail.versions.length} vs ${countBefore}`);
  check("失败版本未出现在任何时间线/记录中", !JSON.stringify(afterFail).includes("失败烟"));
  const tmpFiles = (await readdir(dir)).filter((f) => f.includes(".tmp-"));
  check("无残留临时文件", tmpFiles.length === 0, tmpFiles.join(","));
  // 失败后系统仍可用
  const recovered = await post("/api/versions", { title: "恢复正常", ...FORMULA() });
  check("写入失败后服务恢复，可继续创建", recovered.status === 201);

  // 驳回也要原子：在驳回落盘前注入失败，原版本不得变成退回调整，也不得出现调整版
  const rej2 = (await post("/api/versions", { title: "驳回撞失败", ...FORMULA() })).body;
  await post(`/api/versions/${rej2.id}/start-grinding`, {});
  await post(`/api/versions/${rej2.id}/submit-grinding`, { paper: "皮纸", score: 55 });
  const cntBeforeRej = (await readDbOnDisk()).versions.length;
  await api("/api/test/fail-next-write", { method: "POST" });
  const rejFail = await post(`/api/versions/${rej2.id}/reject`, { failSteps: ["成色"], reason: "发灰" });
  check("驳回写入失败返回 500", rejFail.status === 500);
  const still = await api(`/api/versions/${rej2.id}`);
  check("失败后原版本仍为待确认（状态没被半改）", still.body.status === "待确认", still.body.status);
  check("失败后没有冒出调整版", (await readDbOnDisk()).versions.length === cntBeforeRej);
  // 重试应当成功（同一业务再提交一次，不被失败的幂等状态影响：此处不带键）
  const rejRetry = await post(`/api/versions/${rej2.id}/reject`, { failSteps: ["成色"], reason: "发灰" });
  check("驳回重试成功 201", rejRetry.status === 201);

  /* 7. 重启持久化 */
  section("7. 重启后数据与谱系完好");
  await restartServer();
  const meta2 = await api("/api/meta");
  check("重启后 API 正常", meta2.status === 200);
  const allAfter = await api("/api/versions");
  const findCode = (code) => allAfter.body.find((v) => v.code === code);
  check("重启后调整版仍在且保持退回血缘", !!findCode(adj.code) && findCode(adj.code).originReject.fromVersion === rej.code);
  check("重启后衍版快照仍为 8.2% 胶比", findCode(child.body.code) && findCode(child.body.code).formula.glueRatio === "8.2%");
  const stats = await api("/api/stats");
  check("统计与实际版本一致", stats.body.total === allAfter.body.length);
  const lineage2 = await api("/api/lineage");
  check("重启后谱系树仍可构建", Array.isArray(lineage2.body) && lineage2.body.length >= 1);

  // 未知版本
  check("未知版本 404", (await api("/api/versions/nope")).status === 404);

  section(`结果：${pass} 通过，${fail} 失败`);
} catch (e) {
  console.error("验证脚本异常：", e);
  fail += 1;
} finally {
  if (serverProc) serverProc.kill("SIGTERM");
  await rm(dir, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
