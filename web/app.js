"use strict";

const $ = (sel) => document.querySelector(sel);
let META = { statuses: [], formulaFields: [], failSteps: [] };
let roots = [];
let versions = [];
let selectedId = null;

/* ---------------- API ---------------- */

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json" } : {},
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.detail || data.error || "请求失败");
    err.code = data.error;
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(msg, isErr = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast" + (isErr ? " err" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 3200);
  el.classList.remove("hidden");
}

function fmtAt(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------- 加载与渲染 ---------------- */

async function load() {
  [META, roots, versions] = await Promise.all([api("/api/meta"), api("/api/lineage"), api("/api/versions")]);
  renderStats();
  renderTree();
  renderDetail();
}

async function renderStats() {
  const { stats, total } = await api("/api/stats");
  $("#stats").innerHTML =
    META.statuses.map((s) => `<div class="stat"><span>${s}</span><strong>${stats[s] || 0}</strong></div>`).join("") +
    `<div class="stat"><span>全部版本</span><strong>${total}</strong></div>`;
}

function renderTree() {
  const q = $("#searchInput").value.trim();
  const match = (v) => !q || [v.code, v.title, v.formula.smokeSource].some((s) => String(s || "").includes(q));
  const nodeHtml = (node) => {
    const kids = node.children || [];
    const visibleKids = kids.map(nodeHtml).filter(Boolean);
    if (!match(node) && !visibleKids.length) return "";
    return `<div class="tree-node">
      <div class="tree-row ${node.id === selectedId ? "active" : ""}" data-id="${esc(node.id)}">
        <span class="tree-code">${esc(node.code)}</span>
        <span class="pill pill-${esc(node.status)}">${esc(node.status)}</span>
        <span class="tree-title">${esc(node.title)}</span>
      </div>
      ${visibleKids.length ? `<div class="tree-children">${visibleKids.join("")}</div>` : ""}
    </div>`;
  };
  $("#tree").innerHTML = roots.map(nodeHtml).join("") || '<div class="detail-empty">暂无版本</div>';
  $("#tree").querySelectorAll(".tree-row").forEach((row) => {
    row.onclick = () => {
      selectedId = row.dataset.id;
      renderTree();
      renderDetail();
    };
  });
}

function getVersion(id) {
  return versions.find((v) => v.id === id);
}

function renderDetail() {
  const v = selectedId ? getVersion(selectedId) : null;
  const el = $("#detail");
  if (!v) {
    el.className = "detail-empty";
    el.textContent = "从左侧谱系选择一个版本";
    return;
  }
  el.className = "detail";
  const parent = v.parentId ? getVersion(v.parentId) : null;

  const actionBtns = actionsFor(v).map(
    (a) => `<button class="tiny ${a.cls || ""}" data-action="${a.key}">${a.label}</button>`
  ).join("");

  el.innerHTML = `
    <div class="detail-top">
      <div>
        <div class="detail-code">${esc(v.code)} <span class="pill pill-${esc(v.status)}">${esc(v.status)}</span></div>
        <div>${esc(v.title)}</div>
        <div class="detail-parent">
          ${parent ? `父版本 <a data-goto="${esc(parent.id)}">${esc(parent.code)}</a> · 第 ${v.depth + 1} 代` : "根版本"}
          · 建立于 ${fmtAt(v.createdAt)}${v.finalizedAt ? ` · 定版于 ${fmtAt(v.finalizedAt)}` : ""}
        </div>
      </div>
    </div>
    <div class="actions">${actionBtns}</div>

    ${v.rejectReason ? `<div class="callout warn">
      <b>驳回记录：</b>失败步骤 ${esc(v.rejectReason.failSteps.join("、"))}；${esc(v.rejectReason.reason)}
      ${v.rejectReason.adjustmentCode ? `；已生成调整版本 <b>${esc(v.rejectReason.adjustmentCode)}</b>` : ""}
    </div>` : ""}
    ${v.originReject ? `<div class="callout info">
      <b>调整来源：</b>由 ${esc(v.originReject.fromVersion)} 驳回生成（${esc(v.originReject.failSteps.join("、"))}：${esc(v.originReject.reason)}）
    </div>` : ""}

    <div class="section-title">配方快照（完整留痕，不随父版本变化）</div>
    ${formulaTable(v.formula)}

    ${parent ? `<div class="section-title">与父版本差异（${esc(parent.code)} → ${esc(v.code)}）</div>
      <div id="diffBox">差异加载中…</div>` : ""}

    ${v.grind && v.grind.data ? `<div class="section-title">试磨记录</div>${grindTable(v.grind)}` : ""}

    <div class="section-title">时间线</div>
    <ul class="timeline">${[...v.operations].reverse().map(opHtml).join("")}</ul>
  `;

  el.querySelectorAll("[data-action]").forEach((btn) => {
    btn.onclick = () => runAction(btn.dataset.action, v);
  });
  el.querySelectorAll("[data-goto]").forEach((a) => {
    a.onclick = () => {
      selectedId = a.dataset.goto;
      renderTree();
      renderDetail();
    };
  });
  if (parent) loadDiff(parent.id, v.id);
}

function actionsFor(v) {
  const btns = [];
  if (v.status === "待试制") {
    btns.push({ key: "start", label: "▶ 开始试磨" });
    btns.push({ key: "edit", label: "✎ 编辑配方", cls: "ghost" });
  }
  if (v.status === "试磨中") btns.push({ key: "submit", label: "提交试磨结果" });
  if (v.status === "待确认") {
    btns.push({ key: "confirm", label: "✓ 确认定版", cls: "primary" });
    btns.push({ key: "reject", label: "✕ 驳回并生成调整版", cls: "danger" });
  }
  if (v.status === "已定版") btns.push({ key: "derive", label: "⑂ 以此定版衍版" });
  if (v.status !== "已定版") btns.push({ key: "deriveDisabled", label: "⑂ 衍版（未定版不可用）", cls: "ghost" });
  btns.push({ key: "note", label: "＋ 备注", cls: "ghost" });
  return btns;
}

function blank(x) {
  return x === null || x === undefined || x === "" ? "" : String(x);
}

function formulaTable(f) {
  return `<table class="kv"><tbody>
    ${META.formulaFields.map((field) => `<tr><th>${esc(field.label)}</th><td>${esc(blank(f[field.key]))}</td></tr>`).join("")}
  </tbody></table>`;
}

function grindTable(g) {
  const d = g.data || {};
  return `<table class="kv"><tbody>
    <tr><th>试磨纸张</th><td>${esc(blank(d.paper))}</td></tr>
    <tr><th>加水量</th><td>${esc(blank(d.water))}</td></tr>
    <tr><th>出墨速度</th><td>${esc(blank(d.speed))}</td></tr>
    <tr><th>墨色层次</th><td>${esc(blank(d.colorLayer))}</td></tr>
    <tr><th>沉淀情况</th><td>${esc(blank(d.sediment))}</td></tr>
    <tr><th>评分</th><td><b>${d.score === null || d.score === undefined ? "" : d.score}</b></td></tr>
    ${d.note ? `<tr><th>备注</th><td>${esc(d.note)}</td></tr>` : ""}
  </tbody></table>`;
}

function opHtml(op) {
  const cls =
    op.to === "退回调整" || op.type === "derive_origin_reject" ? "t-reject"
    : op.to === "已定版" ? "t-final"
    : op.type === "create" || op.type === "derive" ? "t-create" : "";
  return `<li class="${cls}">
    <div class="tl-at">${fmtAt(op.at)}<span class="tl-badge">${esc(opLabel(op.type))}</span></div>
    <div class="tl-detail">${esc(op.detail || "")}</div>
  </li>`;
}
function opLabel(t) {
  return { create: "建档", edit: "改方", derive: "衍版", transition: "流转", note: "备注", child_created: "出代" }[t] || t;
}

async function loadDiff(fromId, toId) {
  try {
    const d = await api(`/api/versions/${fromId}/diff/${toId}`);
    const changed = d.fields.filter((f) => f.changed);
    $("#diffBox").innerHTML = changed.length
      ? `<table class="diff"><thead><tr><th>字段</th><th>父版本</th><th></th><th>当前版本</th></tr></thead><tbody>
          ${d.fields.filter((f) => f.changed).map(
            (f) => `<tr class="changed"><td>${esc(f.label)}</td><td>${esc(blank(f.from))}</td><td class="arrow">→</td><td>${esc(blank(f.to))}</td></tr>`
          ).join("")}
        </tbody></table>`
      : '<div class="callout">与父版本配方完全一致（仅产生新版本分支）。</div>';
  } catch (e) {
    $("#diffBox").textContent = "差异加载失败：" + e.message;
  }
}

/* ---------------- 动作 ---------------- */

async function runAction(key, v) {
  try {
    if (key === "deriveDisabled") return toast("只有已定版版本才能衍版", true);
    if (key === "start") {
      await api(`/api/versions/${v.id}/start-grinding`, { method: "POST", body: JSON.stringify({}) });
      toast("已进入试磨中，版本已被占用");
    } else if (key === "confirm") {
      if (!confirm("确认将该版本定版？定版后不可重复确认。")) return;
      await api(`/api/versions/${v.id}/confirm`, { method: "POST", body: JSON.stringify({}) });
      toast("已定版");
    } else if (key === "note") {
      const note = prompt("追加备注（仅入时间线，不改配方）");
      if (!note) return;
      await api(`/api/versions/${v.id}/note`, { method: "POST", body: JSON.stringify({ note }) });
    } else if (key === "submit") {
      const out = await openFormModal(`提交试磨结果 · ${v.code}`, grindForm(), { okText: "提交" });
      await api(`/api/versions/${v.id}/submit-grinding`, { method: "POST", body: JSON.stringify(out) });
      toast("试磨结果已提交，进入待确认");
    } else if (key === "edit") {
      const out = await openFormModal(`编辑配方 · ${v.code}`, formulaForm(v.formula, { title: v.title }), { okText: "保存" });
      await api(`/api/versions/${v.id}`, { method: "PATCH", body: JSON.stringify(stripUnchanged(out, v)) });
      toast("配方已更新（后代快照不受影响）");
    } else if (key === "derive") {
      const out = await openFormModal(`自 ${v.code} 衍版`, formulaForm(v.formula, { title: v.title + " · 子版" }), { okText: "建立子版本" });
      await api(`/api/versions/${v.id}/derive`, { method: "POST", body: JSON.stringify(out) });
      toast("子版本已建立，保存完整快照");
    } else if (key === "reject") {
      const out = await openFormModal(`驳回 · ${v.code}`, rejectForm(), { okText: "驳回并生成调整版", danger: true });
      await api(`/api/versions/${v.id}/reject`, { method: "POST", body: JSON.stringify(out) });
      toast("已驳回，调整版本已生成");
    }
    await load();
  } catch (e) {
    toast(e.message, true);
  }
}

function stripUnchanged(out, v) {
  const formula = {};
  for (const f of META.formulaFields) {
    const nv = out[f.key];
    if (String(nv ?? "") !== String(v.formula[f.key] ?? "")) formula[f.key] = nv;
  }
  return { title: out.title, formula };
}

/* ---------------- 弹层表单 ---------------- */

let modalResolve = null;
function openFormModal(title, bodyHtml, opts = {}) {
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = bodyHtml;
  $("#modalOk").textContent = opts.okText || "确定";
  $("#modalOk").className = "primary" + (opts.danger ? " danger" : "");
  $("#modalBackdrop").classList.remove("hidden");
  wireChips();
  return new Promise((resolve) => {
    modalResolve = (out) => resolve(out);
  });
}
function closeModal() {
  $("#modalBackdrop").classList.add("hidden");
  modalResolve = null;
}
$("#modalClose").onclick = closeModal;
$("#modalCancel").onclick = closeModal;
$("#modalBackdrop").addEventListener("click", (e) => {
  if (e.target.id === "modalBackdrop") closeModal();
});
$("#modalOk").onclick = () => {
  const body = $("#modalBody");
  const out = {};
  let valid = true;
  body.querySelectorAll("[name]").forEach((el) => {
    let v = el.type === "number" ? (el.value === "" ? null : Number(el.value)) : el.value.trim();
    if (el.dataset.required && (v === "" || v === null)) {
      el.style.borderColor = "var(--warn)";
      valid = false;
    }
    if (el.dataset.json) out[el.name] = v ? JSON.parse(v) : [];
    else out[el.name] = v;
  });
  if (!valid) return toast("有必填项未填", true);
  const r = modalResolve;
  closeModal();
  if (r) r(out);
};
function wireChips() {
  document.querySelectorAll(".chip").forEach((chip) => {
    chip.onclick = () => chip.classList.toggle("on");
  });
}
function chipSteps() {
  return META.failSteps
    .map((s) => `<span class="chip" data-step="${esc(s)}">${esc(s)}</span>`)
    .join("");
}

function fieldHtml(f, value, required = false) {
  // 未填写的选填项必须是空输入框，不能把 — 占位符回显成真值再提交
  const raw = value === null || value === undefined ? "" : String(value);
  return `<label>${esc(f.label)}${required ? " *" : ""}</label>
    <input name="${esc(f.key)}" type="${f.type === "number" ? "number" : "text"}" value="${esc(raw)}" ${required ? "data-required='1'" : ""}>`;
}
function formulaForm(formula = {}, extra = {}) {
  return `<label>版本标题</label><input name="title" value="${esc(extra.title || "")}">
    ${META.formulaFields.map((f) => fieldHtml(f, formula[f.key], ["smokeSource", "glueRatio", "storageLocation"].includes(f.key))).join("")}`;
}
function grindForm() {
  return `
    <label>试磨纸张 *</label><input name="paper" data-required="1" placeholder="如 净皮宣">
    <div class="form-row-2">
      <div><label>加水量</label><input name="water" placeholder="如 20滴"></div>
      <div><label>出墨速度</label><input name="speed" placeholder="如 快/中/慢"></div>
    </div>
    <div class="form-row-2">
      <div><label>墨色层次</label><input name="colorLayer"></div>
      <div><label>沉淀情况</label><input name="sediment"></div>
    </div>
    <label>评分（0–100）</label><input name="score" type="number" min="0" max="100">
    <label>试磨备注</label><textarea name="note"></textarea>`;
}
function rejectForm() {
  return `
    <div class="callout warn">驳回后当前版本进入「退回调整」终态，并自动生成带原因的调整子版本。</div>
    <label>失败步骤 *（可多选）</label>
    <div class="chips" id="stepChips">${chipSteps()}</div>
    <input type="hidden" name="failSteps" data-json="1" data-required="1" value="">
    <label>失败原因 *</label><textarea name="reason" data-required="1" placeholder="描述失败现象与判断依据"></textarea>
    <div class="section-title">可选：直接给出调整版改动</div>
    <div class="form-row-2">
      <div><label>烟料调整</label><input name="f_smokeSource" placeholder="留空则继承"></div>
      <div><label>胶比调整</label><input name="f_glueRatio" placeholder="留空则继承"></div>
    </div>
    <div class="form-row-2">
      <div><label>存放年限</label><input name="f_ageYears" type="number"></div>
      <div><label>存放位置</label><input name="f_storageLocation"></div>
    </div>
    <div class="form-row-2">
      <div><label>存放温度</label><input name="f_storageTemp"></div>
      <div><label>存放湿度</label><input name="f_storageHumidity"></div>
    </div>`;
}
// 把 chips 选择写入隐藏字段，并把 f_ 前缀字段收进 formulaAdjust
const origOk = $("#modalOk");
$("#modalOk").addEventListener("click", () => {
  const chips = document.querySelectorAll("#stepChips .chip.on");
  const hidden = document.querySelector('input[name="failSteps"]');
  if (hidden) hidden.value = chips.length ? JSON.stringify([...chips].map((c) => c.dataset.step)) : "";
  const adjust = {};
  document.querySelectorAll("[name^='f_']").forEach((el) => {
    if (el.value.trim()) adjust[el.name.slice(2)] = el.type === "number" ? Number(el.value) : el.value.trim();
  });
  if (Object.keys(adjust).length) {
    let input = document.querySelector('input[name="formulaAdjust"]');
    if (!input) {
      input = document.createElement("input");
      input.type = "hidden";
      input.name = "formulaAdjust";
      input.dataset.json = "1";
      $("#modalBody").appendChild(input);
    }
    input.value = JSON.stringify(adjust);
  }
}, true);

/* ---------------- 新建根版本 ---------------- */

$("#newRootBtn").onclick = async () => {
  try {
    const out = await openFormModal("新建根配方", formulaForm(), { okText: "建立版本" });
    await api("/api/versions", { method: "POST", body: JSON.stringify(out) });
    toast("根版本已建立");
    await load();
  } catch (e) {
    toast(e.message, true);
  }
};
$("#reloadBtn").onclick = () => load().then(() => toast("已刷新")).catch((e) => toast(e.message, true));
$("#searchInput").oninput = renderTree;

load().catch((e) => toast("加载失败：" + e.message, true));
