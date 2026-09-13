import http from "node:http";
import { readFile, writeFile, rename, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "data");
const dbPath = process.env.INK_DATA || join(dataDir, "formula-lineage.json");
const webDir = join(__dirname, "web");
const port = Number(process.env.PORT || 3037);

/* ------------------------- 领域常量 ------------------------- */

const STATUS = {
  PENDING: "待试制",
  GRINDING: "试磨中",
  TO_CONFIRM: "待确认",
  FINALIZED: "已定版",
  RETURNED: "退回调整",
};
const STATUSES = [STATUS.PENDING, STATUS.GRINDING, STATUS.TO_CONFIRM, STATUS.FINALIZED, STATUS.RETURNED];

// 合法流转：待试制→试磨中→待确认→已定版；待确认→退回调整
const TRANSITIONS = {
  [STATUS.PENDING]: [STATUS.GRINDING],
  [STATUS.GRINDING]: [STATUS.TO_CONFIRM],
  [STATUS.TO_CONFIRM]: [STATUS.FINALIZED, STATUS.RETURNED],
  [STATUS.FINALIZED]: [],
  [STATUS.RETURNED]: [],
};

const FORMULA_FIELDS = [
  { key: "smokeSource", label: "烟料" },
  { key: "glueRatio", label: "胶比" },
  { key: "ageYears", label: "存放年限", type: "number" },
  { key: "storageLocation", label: "存放位置" },
  { key: "storageTemp", label: "存放温度" },
  { key: "storageHumidity", label: "存放湿度" },
];
const FORMULA_LABELS = Object.fromEntries(FORMULA_FIELDS.map((f) => [f.key, f.label]));
const FAIL_STEPS = ["调胶", "杵捣", "试磨", "成色", "干燥"];

/* ------------------------- 种子数据 ------------------------- */

const now0 = "2026-09-01T09:00:00.000Z";
const seed = {
  counter: 1,
  versions: [
    {
      id: "v_0001",
      code: "FV-0001",
      parentId: null,
      rootId: "v_0001",
      depth: 0,
      title: "黄山松烟基础方",
      formula: {
        smokeSource: "黄山松烟",
        glueRatio: "7.5%",
        ageYears: 8,
        storageLocation: "恒湿柜B",
        storageTemp: "18℃",
        storageHumidity: "60%",
      },
      status: STATUS.FINALIZED,
      note: "",
      rejectReason: null,
      createdAt: now0,
      finalizedAt: "2026-09-05T15:20:00.000Z",
      grind: null,
      operations: [
        { at: now0, type: "create", detail: "建立根版本" },
        { at: "2026-09-02T10:00:00.000Z", type: "transition", from: STATUS.PENDING, to: STATUS.GRINDING, detail: "开始试磨" },
        { at: "2026-09-03T16:00:00.000Z", type: "transition", from: STATUS.GRINDING, to: STATUS.TO_CONFIRM, detail: "提交试磨结果：评分86" },
        { at: "2026-09-05T15:20:00.000Z", type: "transition", from: STATUS.TO_CONFIRM, to: STATUS.FINALIZED, detail: "定版通过" },
      ],
    },
  ],
  idempotency: {},
};

/* ------------------------- 存储：全锁 + 原子落盘 ------------------------- */

let chain = Promise.resolve();
function withLock(task) {
  const run = chain.then(() => task());
  // 失败也释放锁：下一个请求不能被前一个异常永久堵住
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function loadDb() {
  if (!existsSync(dbPath)) {
    await writeDb(seed);
    return structuredClone(seed);
  }
  const raw = await readFile(dbPath, "utf8");
  const db = JSON.parse(raw);
  db.versions ||= [];
  db.idempotency ||= {};
  db.counter ||= db.versions.length;
  return db;
}

// 测试钩子：置位后下一次落盘必定失败（失败发生在写任何版本文件之前）
let failNextWrite = 0;
function armFailWrite(n = 1) {
  failNextWrite += n;
}

async function writeDb(db) {
  if (failNextWrite > 0) {
    failNextWrite -= 1;
    throw new Error("injected_write_failure: 模拟磁盘写入失败");
  }
  const tmp = `${dbPath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, JSON.stringify(db, null, 2), "utf8");
  await rename(tmp, dbPath);
}

/* ------------------------- HTTP 辅助 ------------------------- */

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "invalid_json", "请求体不是合法 JSON");
  }
}
function httpError(status, code, detail) {
  const e = new Error(detail || code);
  e.status = status;
  e.code = code;
  return e;
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
async function serveStatic(res, pathname) {
  const name = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = normalize(join(webDir, name));
  if (!file.startsWith(webDir)) throw httpError(403, "forbidden");
  if (!existsSync(file)) throw httpError(404, "not_found");
  const ext = file.slice(file.lastIndexOf("."));
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  res.end(await readFile(file));
}

/* ------------------------- 领域逻辑 ------------------------- */

const now = () => new Date().toISOString();

function nextCode(db) {
  db.counter = (db.counter || 0) + 1;
  return "FV-" + String(db.counter).padStart(4, "0");
}

function normalizeFormula(input) {
  const f = input && typeof input === "object" ? input : {};
  const out = {};
  for (const { key, type } of FORMULA_FIELDS) {
    let v = f[key];
    if (v !== undefined && v !== null) v = String(v).trim();
    out[key] = type === "number" ? (v === "" || v === undefined ? null : Number(v)) : v ?? "";
  }
  return out;
}

function validateFormula(f) {
  if (!f.smokeSource) throw httpError(400, "invalid_formula", "烟料必填");
  if (!f.glueRatio) throw httpError(400, "invalid_formula", "胶比必填");
  if (!f.storageLocation) throw httpError(400, "invalid_formula", "存放位置必填");
  if (f.ageYears !== null && Number.isNaN(f.ageYears)) throw httpError(400, "invalid_formula", "存放年限必须是数字");
}

function findVersion(db, idOrCode) {
  return db.versions.find((v) => v.id === idOrCode || v.code === idOrCode);
}

function formulaDiff(a, b) {
  return FORMULA_FIELDS.map(({ key, label }) => ({
    field: key,
    label,
    from: a?.[key] ?? null,
    to: b?.[key] ?? null,
    changed: String(a?.[key] ?? "") !== String(b?.[key] ?? ""),
  }));
}

function buildLineage(db) {
  const byId = new Map(db.versions.map((v) => [v.id, { ...v, children: [] }]));
  const roots = [];
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) byId.get(node.parentId).children.push(node);
    else roots.push(node);
  }
  return roots;
}

function pruneIdempotency(db) {
  const entries = Object.entries(db.idempotency);
  if (entries.length <= 1000) return;
  entries
    .sort((a, b) => (a[1].at < b[1].at ? 1 : -1))
    .slice(1000)
    .forEach(([k]) => delete db.idempotency[k]);
}

function publicVersion(v) {
  return {
    id: v.id,
    code: v.code,
    parentId: v.parentId,
    rootId: v.rootId,
    depth: v.depth,
    title: v.title,
    formula: v.formula,
    status: v.status,
    note: v.note,
    rejectReason: v.rejectReason,
    createdAt: v.createdAt,
    finalizedAt: v.finalizedAt || null,
    grind: v.grind,
    originReject: v.originReject || null,
    operations: v.operations,
  };
}

/**
 * 所有写操作的统一入口：全局串行 + 幂等重放 + 单次原子落盘。
 * 任何一步抛错都不会执行 writeDb，因此不存在半截版本/试磨/操作记录。
 */
async function mutate(req, res, idemKey, handler) {
  return withLock(async () => {
    const db = await loadDb();
    if (idemKey) {
      const hit = db.idempotency[idemKey];
      if (hit) return send(res, hit.status, hit.body);
    }
    const result = await handler(db); // 业务变更只改内存对象
    pruneIdempotency(db);
    // 幂等记录与业务数据同一次原子落盘：要么都在，要么都不在
    if (idemKey) db.idempotency[idemKey] = { at: now(), status: result.status, body: result.body };
    await writeDb(db);
    return send(res, result.status, result.body);
  });
}

/* ------------------------- 路由处理器 ------------------------- */

function handleCreate(db, input) {
  const formula = normalizeFormula(input.formula ?? input);
  validateFormula(formula);
  const v = {
    id: randomUUID(),
    code: nextCode(db),
    parentId: null,
    rootId: null, // 根版本以自身为 root，落盘前补
    depth: 0,
    title: String(input.title || "").trim() || formula.smokeSource + "配方",
    formula,
    status: STATUS.PENDING,
    note: String(input.note || "").trim(),
    rejectReason: null,
    createdAt: now(),
    finalizedAt: null,
    grind: null,
    operations: [],
  };
  v.rootId = v.id;
  v.operations.push({ at: v.createdAt, type: "create", detail: "建立根版本（完整配方快照）" });
  db.versions.push(v);
  return { status: 201, body: publicVersion(v) };
}

function handleEdit(db, v, input) {
  if (v.status !== STATUS.PENDING) {
    throw httpError(409, "not_editable", `当前状态「${v.status}」不可改配方，仅待试制版本可编辑`);
  }
  const next = normalizeFormula({ ...v.formula, ...(input.formula ?? input) });
  validateFormula(next);
  const changes = formulaDiff(v.formula, next).filter((d) => d.changed);
  v.formula = next;
  if (input.title) v.title = String(input.title).trim();
  v.operations.push({
    at: now(),
    type: "edit",
    detail: changes.length ? "调整配方：" + changes.map((c) => `${c.label} ${fmt(c.from)}→${fmt(c.to)}`).join("，") : "仅更新备注",
  });
  return { status: 200, body: publicVersion(v) };
}

function handleDerive(db, v, input) {
  if (v.status !== STATUS.FINALIZED) {
    throw httpError(409, "not_finalized", `只有已定版版本才能衍版，父版本当前为「${v.status}」`);
  }
  // 完整快照复制（后代不依赖父版本任何字段）
  const childFormula = normalizeFormula({ ...v.formula, ...(input.formula ?? input) });
  validateFormula(childFormula);
  const child = {
    id: randomUUID(),
    code: nextCode(db),
    parentId: v.id,
    rootId: v.rootId || v.id,
    depth: v.depth + 1,
    title: String(input.title || "").trim() || v.title + " · 子版",
    formula: childFormula,
    status: STATUS.PENDING,
    note: String(input.note || "").trim(),
    rejectReason: null,
    createdAt: now(),
    finalizedAt: null,
    grind: null,
    operations: [],
  };
  const changes = formulaDiff(v.formula, childFormula);
  const changed = changes.filter((c) => c.changed);
  child.operations.push({
    at: child.createdAt,
    type: "derive",
    detail:
      `自 ${v.code} 衍版，保存独立完整快照` +
      (changed.length ? "；改动：" + changed.map((c) => `${c.label} ${fmt(c.from)}→${fmt(c.to)}`).join("，") : "；配方未改动"),
  });
  db.versions.push(child);
  v.operations.push({ at: child.createdAt, type: "child_created", detail: `衍生子版本 ${child.code}` });
  return { status: 201, body: publicVersion(child) };
}

function handleStartGrinding(db, v) {
  if (v.status !== STATUS.PENDING) {
    throw httpError(409, "illegal_transition", `「${v.status}」不能开始试磨，仅待试制版本可开始`);
  }
  v.status = STATUS.GRINDING;
  v.grind = { startedAt: now(), submittedAt: null, data: null };
  v.operations.push({ at: v.grind.startedAt, type: "transition", from: STATUS.PENDING, to: STATUS.GRINDING, detail: "开始试磨（占用版本）" });
  return { status: 200, body: publicVersion(v) };
}

function handleSubmitGrinding(db, v, input) {
  if (v.status !== STATUS.GRINDING) {
    throw httpError(409, "illegal_transition", `「${v.status}」不能提交试磨结果，仅试磨中版本可提交`);
  }
  const data = {
    paper: String(input.paper || "").trim(),
    water: String(input.water || "").trim(),
    speed: String(input.speed || "").trim(),
    colorLayer: String(input.colorLayer || "").trim(),
    sediment: String(input.sediment || "").trim(),
    score: input.score === undefined || input.score === "" ? null : Number(input.score),
    note: String(input.note || "").trim(),
  };
  if (data.score !== null && (Number.isNaN(data.score) || data.score < 0 || data.score > 100)) {
    throw httpError(400, "invalid_score", "评分需为 0–100 的数字");
  }
  if (!data.paper) throw httpError(400, "invalid_grind", "试磨纸张必填");
  const at = now();
  v.grind.submittedAt = at;
  v.grind.data = data;
  v.status = STATUS.TO_CONFIRM;
  v.operations.push({
    at,
    type: "transition",
    from: STATUS.GRINDING,
    to: STATUS.TO_CONFIRM,
    detail: "提交试磨结果" + (data.score !== null ? `，评分${data.score}` : "") + (data.note ? `；${data.note}` : ""),
  });
  return { status: 200, body: publicVersion(v) };
}

function handleConfirm(db, v) {
  if (v.status === STATUS.FINALIZED) throw httpError(409, "already_finalized", "该版本已定版，不能重复确认");
  if (v.status !== STATUS.TO_CONFIRM) throw httpError(409, "illegal_transition", `「${v.status}」不能确认，仅待确认版本可定版`);
  const at = now();
  v.status = STATUS.FINALIZED;
  v.finalizedAt = at;
  v.operations.push({ at, type: "transition", from: STATUS.TO_CONFIRM, to: STATUS.FINALIZED, detail: "定版通过（快照冻结）" });
  return { status: 200, body: publicVersion(v) };
}

function handleReject(db, v, input) {
  if (v.status === STATUS.FINALIZED) throw httpError(409, "already_finalized", "已定版版本不能驳回");
  if (v.status !== STATUS.TO_CONFIRM) throw httpError(409, "illegal_transition", `「${v.status}」不能驳回，仅待确认版本可驳回`);
  const failSteps = Array.isArray(input.failSteps)
    ? input.failSteps.map((s) => String(s).trim()).filter(Boolean)
    : input.failStep
      ? String(input.failStep)
          .split(/[,，、]/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  if (!failSteps.length) throw httpError(400, "missing_fail_step", "驳回必须指出失败步骤（failSteps）");
  const bad = failSteps.filter((s) => !FAIL_STEPS.includes(s));
  if (bad.length) throw httpError(400, "invalid_fail_step", `未知失败步骤：${bad.join("、")}；可选 ${FAIL_STEPS.join("/")}`);
  const reason = String(input.reason || "").trim();
  if (!reason) throw httpError(400, "missing_reason", "驳回必须填写原因");

  const at = now();
  v.status = STATUS.RETURNED;
  v.rejectReason = { failSteps, reason, at, adjustmentCode: null };
  v.operations.push({ at, type: "transition", from: STATUS.TO_CONFIRM, to: STATUS.RETURNED, detail: `驳回：失败步骤 ${failSteps.join("、")}；${reason}` });

  // 同一次原子写入里生成带原因的调整版本（完整快照）
  const adjustedFormula = normalizeFormula({ ...v.formula, ...(input.formulaAdjust ?? {}) });
  validateFormula(adjustedFormula);
  const child = {
    id: randomUUID(),
    code: nextCode(db),
    parentId: v.id,
    rootId: v.rootId || v.id,
    depth: v.depth + 1,
    title: v.title + " · 调整",
    formula: adjustedFormula,
    status: STATUS.PENDING,
    note: "",
    rejectReason: null,
    originReject: { fromVersion: v.code, failSteps, reason, at },
    createdAt: now(),
    finalizedAt: null,
    grind: null,
    operations: [],
  };
  const changes = formulaDiff(v.formula, adjustedFormula).filter((c) => c.changed);
  child.operations.push({
    at: child.createdAt,
    type: "derive",
    detail:
      `驳回自动生成：继承 ${v.code}，失败步骤 ${failSteps.join("、")}；原因：${reason}` +
      (changes.length ? "；已调整：" + changes.map((c) => `${c.label} ${fmt(c.from)}→${fmt(c.to)}`).join("，") : "；配方待调整"),
  });
  db.versions.push(child);
  v.rejectReason.adjustmentCode = child.code;
  v.operations.push({ at: child.createdAt, type: "child_created", detail: `生成调整版本 ${child.code}` });
  return { status: 201, body: { rejected: publicVersion(v), adjustment: publicVersion(child) } };
}

function handleNote(db, v, input) {
  const note = String(input.note || "").trim();
  if (!note) throw httpError(400, "missing_note", "备注内容为空");
  v.operations.push({ at: now(), type: "note", detail: note });
  return { status: 200, body: publicVersion(v) };
}

function fmt(x) {
  return x === null || x === undefined || x === "" ? "空" : String(x);
}

/* ------------------------- 服务器 ------------------------- */

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    // 静态界面
    if (req.method === "GET" && (p === "/" || p.startsWith("/app.js") || p.startsWith("/styles.css"))) {
      return await serveStatic(res, p);
    }

    // 测试钩子（仅 ENABLE_TEST_HOOKS=1 时可用）
    if (p === "/api/test/fail-next-write") {
      if (process.env.ENABLE_TEST_HOOKS !== "1") throw httpError(404, "not_found");
      if (req.method !== "POST") throw httpError(405, "method_not_allowed");
      armFailWrite(1);
      return send(res, 200, { armed: true });
    }

    if (req.method === "GET" && p === "/api/meta") {
      return send(res, 200, { statuses: STATUSES, formulaFields: FORMULA_FIELDS, failSteps: FAIL_STEPS, transitions: TRANSITIONS });
    }

    if (req.method === "GET" && p === "/api/versions") {
      const db = await loadDb();
      return send(res, 200, db.versions.map(publicVersion));
    }

    if (req.method === "POST" && p === "/api/versions") {
      const input = await readBody(req);
      return await mutate(req, res, input.idempotencyKey, (db) => handleCreate(db, input));
    }

    if (req.method === "GET" && p === "/api/lineage") {
      const db = await loadDb();
      return send(res, 200, buildLineage(db));
    }

    if (req.method === "GET" && p === "/api/stats") {
      const db = await loadDb();
      const stats = Object.fromEntries(STATUSES.map((s) => [s, 0]));
      for (const v of db.versions) if (stats[v.status] !== undefined) stats[v.status] += 1;
      return send(res, 200, { stats, total: db.versions.length });
    }

    const one = p.match(/^\/api\/versions\/([^/]+)$/);
    if (one) {
      if (req.method === "GET") {
        const db = await loadDb();
        const v = findVersion(db, decodeURIComponent(one[1]));
        if (!v) throw httpError(404, "version_not_found", "版本不存在");
        return send(res, 200, publicVersion(v));
      }
      if (req.method === "PATCH") {
        const input = await readBody(req);
        return await mutate(req, res, input.idempotencyKey, (db) => {
          const v = findVersion(db, decodeURIComponent(one[1]));
          if (!v) throw httpError(404, "version_not_found", "版本不存在");
          return handleEdit(db, v, input);
        });
      }
      throw httpError(405, "method_not_allowed");
    }

    const sub = p.match(/^\/api\/versions\/([^/]+)\/(derive|start-grinding|submit-grinding|confirm|reject|note)$/);
    if (sub) {
      const action = sub[2];
      if (req.method !== "POST") throw httpError(405, "method_not_allowed");
      const input = await readBody(req);
      return await mutate(req, res, input.idempotencyKey, (db) => {
        const v = findVersion(db, decodeURIComponent(sub[1]));
        if (!v) throw httpError(404, "version_not_found", "版本不存在");
        switch (action) {
          case "derive":
            return handleDerive(db, v, input);
          case "start-grinding":
            return handleStartGrinding(db, v);
          case "submit-grinding":
            return handleSubmitGrinding(db, v, input);
          case "confirm":
            return handleConfirm(db, v);
          case "reject":
            return handleReject(db, v, input);
          case "note":
            return handleNote(db, v, input);
        }
      });
    }

    const diffM = p.match(/^\/api\/versions\/([^/]+)\/diff\/([^/]+)$/);
    if (diffM && req.method === "GET") {
      const db = await loadDb();
      const a = findVersion(db, decodeURIComponent(diffM[1]));
      const b = findVersion(db, decodeURIComponent(diffM[2]));
      if (!a || !b) throw httpError(404, "version_not_found", "版本不存在");
      return send(res, 200, { from: { code: a.code, id: a.id }, to: { code: b.code, id: b.id }, fields: formulaDiff(a.formula, b.formula) });
    }

    throw httpError(404, "not_found");
  } catch (error) {
    const status = error.status || 500;
    send(res, status, { error: error.code || "internal_error", detail: status === 500 ? String(error.message) : error.message });
  }
});

// 清理上次崩溃可能残留的临时文件
async function cleanupTmp() {
  if (!existsSync(dataDir)) return;
  for (const f of await readdir(dataDir)) {
    if (f.startsWith("formula-lineage.json.tmp-")) {
      try {
        await unlink(join(dataDir, f));
      } catch {}
    }
  }
}

cleanupTmp().then(() => {
  server.listen(port, () => console.log(`配方谱系试制台 listening on http://localhost:${port}`));
});
