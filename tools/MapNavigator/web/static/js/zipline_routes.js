/**
 * 按「地区-送货点」编辑手工滑索链。
 *
 * 页面只复用只读的 Ziplines.json / zipline_frames.json 与 AutoDelivery 的
 * 送货点列表；保存结果是 debug/record/ZiplineRoutes.json，cpp-algo 运行时
 * 在规划区间终点匹配时直接采用，不再搜索。
 */

import {Camera} from "./camera.js";
import {PanGesture, canvasPoint, observeSize, wheelZoomFactor} from "./map_view.js";
import {
  buildSavedRoutePayload,
  buildZoneTowers,
  findSavedZiplineRoute,
  formatTowerSequence,
  parseTowerSequence,
  resolveSavedChain,
  towerTypeName,
  validateZiplineChain,
} from "./zipline_route_model.js";
import {latestZiplineAccountId, listZiplineAccounts, ziplineAccountLabel} from "./zipline_records.js";

const ACCOUNT_STORAGE = "maaend.mapnavigator.ziplineRouteAccount";
const TARGET_STORAGE = "maaend.mapnavigator.ziplineRouteTarget";
const TOWER_HIT_RADIUS = 14;
const BLANK_CANVAS = new URLSearchParams(window.location.search).get("blank") === "1";

const $ = (id) => document.getElementById(id);
const els = {
  account: $("account"),
  target: $("target"),
  targetInfo: $("target-info"),
  routeSummary: $("route-summary"),
  sequence: $("sequence"),
  chips: $("chips"),
  chainCount: $("chain-count"),
  undo: $("undo"),
  clear: $("clear"),
  save: $("save"),
  delete: $("delete"),
  validation: $("validation"),
  savedList: $("saved-list"),
  savedCount: $("saved-count"),
  routesPath: $("routes-path"),
  notice: $("notice"),
  backLink: $("back-link"),
  blankHint: $("blank-hint"),
  pageSub: $("page-sub"),
  map: $("map"),
  basemap: $("basemap"),
  overlay: $("overlay"),
  status: $("map-status"),
  tooltip: $("tooltip"),
  zoomIn: $("zoom-in"),
  zoomOut: $("zoom-out"),
  fit: $("fit"),
};

const state = {
  records: null,
  frames: null,
  targets: [],
  routes: [],
  accounts: [],
  accountId: "",
  target: null,
  towers: [],
  chain: [],
  savedRoute: null,
  dirty: false,
  hover: null,
  zone: "",
  basemapReady: false,
  routesPath: "",
  noticeKind: "",
  busy: false,
};

const camera = new Camera();
const pan = new PanGesture(camera, els.overlay);
const ctx = /** @type {CanvasRenderingContext2D} */ (els.overlay.getContext("2d"));
let canvasWidth = 1;
let canvasHeight = 1;

// --- 通用 -----------------------------------------------------------------------------

function setStatus(text, tone = "info") {
  els.status.textContent = text || "";
  els.status.dataset.tone = tone;
  els.status.hidden = !text;
}

function showNotice(text, tone = "info", kind = "") {
  els.notice.textContent = text || "";
  els.notice.dataset.tone = tone;
  els.notice.hidden = !text;
  state.noticeKind = text ? kind : "";
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const detail = data && (data.detail || data.error) ? data.detail || data.error : text || response.statusText;
    const error = new Error(String(detail || response.status));
    error.status = response.status;
    throw error;
  }
  return data;
}

function confirmDiscard() {
  return !state.dirty || window.confirm("当前滑索路径尚未保存，切换后会丢失。继续？");
}

function markDirty() {
  state.dirty = true;
}

// --- 启动 / 数据加载 ------------------------------------------------------------------

async function boot() {
  bindUi();
  if (BLANK_CANVAS) {
    els.backLink.hidden = true;
    els.blankHint.hidden = false;
    els.pageSub.textContent = "按地区-送货点固定一条手工滑索链 · 空画布相对位置";
  }
  resizeCanvas();
  observeSize(els.map, () => {
    resizeCanvas();
    draw();
  });
  setStatus("正在读取滑索记录…", "info");

  let records = null;
  let recordsError = "";
  try {
    records = await fetchJson("/api/zipline-records");
  } catch (error) {
    recordsError = error && error.message ? error.message : String(error);
  }
  state.records = records;

  try {
    const [frames, routes] = await Promise.all([
      fetchJson("/api/zipline-frames"),
      fetchJson("/api/zipline-routes"),
    ]);
    state.frames = frames;
    state.targets = Array.isArray(routes && routes.targets) ? routes.targets : [];
    state.routes = Array.isArray(routes && routes.routes) ? routes.routes : [];
    state.routesPath = String((routes && routes.path) || "");
    els.routesPath.textContent = state.routesPath || "debug/record/ZiplineRoutes.json";
    if (routes && routes.error) showNotice(String(routes.error), "warn");
  } catch (error) {
    showNotice(`读取滑索标定或手工路径失败：${error && error.message ? error.message : error}`, "error");
    setStatus("数据加载失败。", "error");
    disableEditing();
    return;
  }

  state.accounts = listZiplineAccounts(records);
  populateAccounts();
  populateTargets();

  if (!records || !state.accounts.length) {
    const detail = recordsError ? `（${recordsError}）` : "";
    showNotice(
      `当前安装目录没有可编辑的滑索账号记录${detail}。请先在 MaaEnd 中导入滑索坐标，或确认本工具读取的 install 目录与游戏使用的安装一致。`,
      "warn",
    );
    disableEditing();
    return;
  }
  if (!state.targets.length) {
    showNotice("当前资源里没有带滑索变体的 AutoDelivery 送货点，暂时没有可编辑的目标。", "warn");
    disableEditing();
    return;
  }

  const rememberedAccount = localStorage.getItem(ACCOUNT_STORAGE);
  const initialAccount = state.accounts.some((account) => account.accountId === rememberedAccount)
    ? rememberedAccount
    : latestZiplineAccountId(records) || state.accounts[0].accountId;
  els.account.value = initialAccount;
  selectAccount(initialAccount, {force: true, initial: true});
}

function disableEditing() {
  els.account.disabled = true;
  els.target.disabled = true;
  els.sequence.disabled = true;
  els.undo.disabled = true;
  els.clear.disabled = true;
  els.save.disabled = true;
  els.delete.disabled = true;
  setStatus("没有可编辑的滑索数据。", "warn");
}

function populateAccounts() {
  els.account.replaceChildren();
  for (const account of state.accounts) {
    const option = document.createElement("option");
    option.value = account.accountId;
    option.textContent = ziplineAccountLabel(account);
    els.account.append(option);
  }
  els.account.disabled = !state.accounts.length;
}

function populateTargets() {
  els.target.replaceChildren();
  if (!state.targets.length) {
    const option = document.createElement("option");
    option.textContent = "（没有可编辑的送货点）";
    els.target.append(option);
    els.target.disabled = true;
    return;
  }
  const groups = new Map();
  for (const target of state.targets) {
    const area = target.area || "未分区";
    if (!groups.has(area)) groups.set(area, []);
    groups.get(area).push(target);
  }
  for (const [area, targets] of groups) {
    const group = document.createElement("optgroup");
    group.label = area;
    for (const target of targets) {
      const option = document.createElement("option");
      option.value = target.id;
      option.textContent = target.label;
      group.append(option);
    }
    els.target.append(group);
  }
  els.target.disabled = false;
}

function selectAccount(accountId, {force = false, initial = false} = {}) {
  if (state.busy) {
    els.account.value = state.accountId;
    return;
  }
  if (!force && accountId === state.accountId) return;
  if (!initial && !confirmDiscard()) {
    els.account.value = state.accountId;
    return;
  }
  state.accountId = accountId;
  localStorage.setItem(ACCOUNT_STORAGE, accountId);
  state.dirty = false;
  state.hover = null;
  hideTooltip();
  setStatus("");
  renderSavedRoutes();

  if (state.target) {
    rebuildTowers();
    loadSavedChain();
    updateChainUi();
    fitView();
    return;
  }
  const rememberedTarget = localStorage.getItem(TARGET_STORAGE);
  const target = state.targets.find((candidate) => candidate.id === rememberedTarget) || state.targets[0] || null;
  if (target) selectTarget(target.id, {force: true});
}

function selectTarget(targetId, {force = false} = {}) {
  if (state.busy) {
    els.target.value = state.target ? state.target.id : "";
    return;
  }
  const target = state.targets.find((candidate) => candidate.id === targetId);
  if (!target) return;
  if (!force && !confirmDiscard()) {
    els.target.value = state.target ? state.target.id : "";
    return;
  }
  state.target = target;
  localStorage.setItem(TARGET_STORAGE, target.id);
  state.dirty = false;
  state.hover = null;
  hideTooltip();
  setStatus("");
  els.target.value = target.id;
  updateTargetInfo();
  void ensureZone(target.zone_name);
  rebuildTowers();
  loadSavedChain();
  updateChainUi();
  renderSavedRoutes();
  fitView();
}

function updateTargetInfo() {
  if (!state.target) {
    els.targetInfo.textContent = BLANK_CANVAS
      ? "选择一个送货点后显示空画布上的相对位置与滑索架。"
      : "选择一个送货点后显示对应地图与滑索架。";
    return;
  }
  const target = state.target;
  const goal = Array.isArray(target.goal) ? target.goal : [0, 0];
  const deckValue = target.goal_deck_y;
  const hasDeck =
    deckValue !== null && deckValue !== undefined && deckValue !== "" && Number.isFinite(Number(deckValue));
  const deck = hasDeck ? ` · 层高 ${Number(deckValue).toFixed(2)}` : "";
  const leg = target.leg_count > 1 ? ` · 第 ${target.leg_index}/${target.leg_count} 段` : "";
  els.targetInfo.textContent = `${target.area || "未分区"} · ${target.destinations?.join(" / ") || target.label} · ${target.zone_name}${leg} · 终点 [${Number(goal[0]).toFixed(2)}, ${Number(goal[1]).toFixed(2)}]${deck}`;
}

function rebuildTowers() {
  if (!state.records || !state.frames || !state.target) {
    state.towers = [];
    return;
  }
  state.towers = buildZoneTowers(state.records, state.frames, state.target.zone_name, state.accountId);
}

function loadSavedChain() {
  if (state.noticeKind === "chain") showNotice("");
  state.savedRoute = state.target
    ? findSavedZiplineRoute(
        state.routes,
        state.accountId,
        state.target.zone_name,
        state.target.goal,
        state.target.goal_deck_y,
      )
    : null;
  state.chain = [];
  if (!state.savedRoute) return;
  const resolved = resolveSavedChain(state.towers, state.savedRoute);
  if (resolved.missing.length) {
    state.chain = [];
    showNotice(
      `已保存路径里有 ${resolved.missing.length} 座滑索架在当前账号的记录中找不到，运行时也会回退。请重新选择路径。`,
      "warn",
      "chain",
    );
    return;
  }
  state.chain = resolved.indices;
}

// --- 地图 -----------------------------------------------------------------------------

async function ensureZone(zoneName) {
  if (!zoneName || state.zone === zoneName) return;
  state.zone = zoneName;
  state.basemapReady = false;
  els.basemap.style.visibility = "hidden";

  if (BLANK_CANVAS) {
    els.basemap.removeAttribute("src");
    setStatus(`相对位置视图 · ${zoneName}`, "info");
    return;
  }

  const loaded = new Promise((resolve) => {
    els.basemap.addEventListener(
      "load",
      () => {
        if (state.zone !== zoneName) {
          resolve();
          return;
        }
        state.basemapReady = true;
        els.basemap.style.visibility = "visible";
        if (!state.towers.length) {
          fitView();
        } else {
          syncBasemapTransform();
          draw();
        }
        resolve();
      },
      {once: true},
    );
    els.basemap.addEventListener(
      "error",
      () => {
        if (state.zone === zoneName) setStatus(`底图加载失败：${zoneName}`, "error");
        resolve();
      },
      {once: true},
    );
  });
  els.basemap.src = `/basemap-by-zone?zone_id=${encodeURIComponent(zoneName)}`;
  await loaded;
}

function syncBasemapTransform() {
  els.basemap.style.transform = `translate(${camera.offsetX}px, ${camera.offsetY}px) scale(${camera.viewScale})`;
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvasWidth = Math.max(1, els.map.clientWidth);
  canvasHeight = Math.max(1, els.map.clientHeight);
  const width = Math.max(1, Math.round(canvasWidth * dpr));
  const height = Math.max(1, Math.round(canvasHeight * dpr));
  if (els.overlay.width !== width || els.overlay.height !== height) {
    els.overlay.width = width;
    els.overlay.height = height;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function fitView() {
  if (!state.target) return;
  const focus = state.chain.length ? state.chain.map((index) => towerByIndex(index)).filter(Boolean) : state.towers;
  const points = focus.map((tower) => tower.point);
  if (Array.isArray(state.target.goal)) points.push(state.target.goal);
  if (points.length) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of points) {
      minX = Math.min(minX, point[0]);
      minY = Math.min(minY, point[1]);
      maxX = Math.max(maxX, point[0]);
      maxY = Math.max(maxY, point[1]);
    }
    camera.fitView([minX, minY, maxX, maxY], canvasWidth, canvasHeight, 90);
  } else if (state.basemapReady) {
    camera.fitView([0, 0, els.basemap.naturalWidth, els.basemap.naturalHeight], canvasWidth, canvasHeight, 40);
  }
  syncBasemapTransform();
  draw();
}

function draw() {
  if (els.overlay.width < 1) return;
  resizeCanvas();
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  drawGoal();
  drawChain();
  drawTowers();
}

function drawGoal() {
  if (!state.target) return;
  if (!Array.isArray(state.target.goal) || state.target.goal.length !== 2) return;
  const [x, y] = state.target.goal.map(Number);
  const [cx, cy] = camera.worldToCanvas(x, y);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
  ctx.save();
  ctx.strokeStyle = "#f43f5e";
  ctx.fillStyle = "rgba(244, 63, 94, 0.18)";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(cx, cy, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fillStyle = "#f43f5e";
  ctx.fill();
  ctx.restore();
  drawLabel(cx, cy - 24, "送货点", "#f43f5e");
}

function drawChain() {
  const validation = state.target ? validateZiplineChain(state.towers, state.chain, state.frames) : {hops: []};
  const verdicts = new Map();
  for (const hop of validation.hops || []) {
    verdicts.set(`${hop.from}->${hop.to}`, hop.measurement && hop.measurement.geometryConnected === true);
  }
  for (let i = 0; i + 1 < state.chain.length; i += 1) {
    const from = towerByIndex(state.chain[i]);
    const to = towerByIndex(state.chain[i + 1]);
    if (!from || !to) continue;
    const valid = verdicts.get(`${from.index}->${to.index}`) !== false;
    drawHop(from.point, to.point, i + 1, valid);
  }
}

function drawHop(from, to, hopIndex, valid) {
  const color = valid ? "#22d3ee" : "#f97316";
  const [ax, ay] = camera.worldToCanvas(from[0], from[1]);
  const [bx, by] = camera.worldToCanvas(to[0], to[1]);
  if (![ax, ay, bx, by].every(Number.isFinite)) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(8, 15, 28, 0.8)";
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();
  drawArrow(ax, ay, bx, by, color);
  ctx.restore();
  drawLabel((ax + bx) / 2, (ay + by) / 2 - 12, `${hopIndex}`, color);
}

function drawArrow(ax, ay, bx, by, color) {
  const dx = bx - ax;
  const dy = by - ay;
  const length = Math.hypot(dx, dy);
  if (length < 12) return;
  const ux = dx / length;
  const uy = dy / length;
  const cx = ax + dx * 0.62;
  const cy = ay + dy * 0.62;
  const size = 8;
  ctx.beginPath();
  ctx.moveTo(cx + ux * size, cy + uy * size);
  ctx.lineTo(cx - ux * size - uy * size * 0.7, cy - uy * size + ux * size * 0.7);
  ctx.lineTo(cx - ux * size + uy * size * 0.7, cy - uy * size - ux * size * 0.7);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawTowers() {
  const selected = new Set(state.chain);
  for (const tower of state.towers) {
    const [cx, cy] = camera.worldToCanvas(tower.point[0], tower.point[1]);
    if (cx < -20 || cy < -20 || cx > canvasWidth + 20 || cy > canvasHeight + 20) continue;
    const isSelected = selected.has(tower.index);
    const isHovered = state.hover && state.hover.index === tower.index;
    ctx.save();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(cx, cy, isSelected || isHovered ? 12 : 10, 0, Math.PI * 2);
    ctx.fillStyle = tower.powered
      ? isSelected
        ? "rgba(34, 211, 238, 0.9)"
        : "rgba(139, 92, 246, 0.78)"
      : "rgba(71, 85, 105, 0.72)";
    ctx.fill();
    ctx.strokeStyle = isSelected ? "#a5f3fc" : isHovered ? "#e9d5ff" : "rgba(8, 15, 28, 0.85)";
    ctx.lineWidth = isSelected || isHovered ? 3.5 : 2.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fillStyle = tower.powered ? "#ffffff" : "rgba(203, 213, 225, 0.7)";
    ctx.fill();
    ctx.fillStyle = tower.powered ? "#ffffff" : "#cbd5e1";
    ctx.font = "bold 9px Consolas, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(tower.index), cx, cy + 0.5);
    ctx.restore();

    if (isSelected) {
      const order = state.chain.indexOf(tower.index) + 1;
      drawLabel(cx, cy - 25, `第 ${order} 站`, "#22d3ee");
      if (order === 1) drawLabel(cx, cy - 42, "起点", "#4ade80");
    }
  }
  // 未供电的架子在低缩放下也要能看出异常, 画一条短灰线
  for (const tower of state.towers) {
    if (tower.powered) continue;
    const [cx, cy] = camera.worldToCanvas(tower.point[0], tower.point[1]);
    if (cx < -20 || cy < -20 || cx > canvasWidth + 20 || cy > canvasHeight + 20) continue;
    ctx.save();
    ctx.strokeStyle = "rgba(148, 163, 184, 0.9)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - 5, cy - 13);
    ctx.lineTo(cx + 5, cy - 13);
    ctx.stroke();
    ctx.restore();
  }
}

function drawLabel(cx, cy, text, color) {
  ctx.save();
  ctx.font = "bold 11px Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const width = ctx.measureText(text).width + 10;
  ctx.fillStyle = "rgba(8, 15, 28, 0.82)";
  ctx.fillRect(cx - width / 2, cy - 9, width, 18);
  ctx.fillStyle = color;
  ctx.fillText(text, cx, cy + 0.5);
  ctx.restore();
}

function towerByIndex(index) {
  return state.towers.find((tower) => tower.index === index) || null;
}

function hitTower(canvasX, canvasY) {
  let best = null;
  let bestDistance = TOWER_HIT_RADIUS;
  for (const tower of state.towers) {
    const [cx, cy] = camera.worldToCanvas(tower.point[0], tower.point[1]);
    const distance = Math.hypot(cx - canvasX, cy - canvasY);
    if (distance <= bestDistance) {
      best = tower;
      bestDistance = distance;
    }
  }
  return best;
}

// --- 路径编辑 -------------------------------------------------------------------------

function updateChainUi() {
  els.sequence.value = formatTowerSequence(state.chain);
  els.sequence.classList.remove("invalid");
  els.sequence.disabled = state.busy;
  els.chainCount.textContent = `${Math.max(0, state.chain.length - 1)} 跳 · ${state.chain.length} 站`;
  renderChips();
  const validation = refreshValidation();
  els.undo.disabled = !state.chain.length;
  els.clear.disabled = !state.chain.length;
  els.save.disabled = !state.target || !state.accountId || !validation.ok || state.busy;
  els.delete.disabled = !state.savedRoute || state.busy;
  updateRouteSummary();
}

function updateRouteSummary() {
  if (!state.target) {
    els.routeSummary.textContent = "起点：选择第一根滑索架后显示；终点：选择送货点后显示。";
    return;
  }
  const goal = Array.isArray(state.target.goal) ? state.target.goal : [0, 0];
  const goalText = `[${Number(goal[0]).toFixed(2)}, ${Number(goal[1]).toFixed(2)}]`;
  const first = state.chain.length ? towerByIndex(state.chain[0]) : null;
  const startText = first
    ? `#${first.index} 世界 [${first.world.map((value) => Number(value).toFixed(1)).join(", ")}]`
    : "未选择";
  els.routeSummary.textContent = `${state.target.zone_name} · 起点 ${startText} → 终点 ${goalText}`;
}

function renderChips() {
  els.chips.replaceChildren();
  if (!state.chain.length) {
    const empty = document.createElement("span");
    empty.className = "chip-empty";
    empty.textContent = "尚未选择滑索架";
    els.chips.append(empty);
    return;
  }
  state.chain.forEach((index, position) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.title = `第 ${position + 1} 站 · 点击移除`;
    chip.textContent = `#${index}`;
    chip.addEventListener("click", () => {
      if (state.busy) return;
      state.chain.splice(position, 1);
      markDirty();
      updateChainUi();
      draw();
    });
    els.chips.append(chip);
  });
}

function refreshValidation() {
  els.validation.replaceChildren();
  if (!state.target) {
    appendValidation("先选择一个送货点。", "muted");
    return {ok: false, errors: [], hops: []};
  }
  if (!state.towers.length) {
    appendValidation("当前账号在这个区没有已记录的滑索架。", "warn");
    return {ok: false, errors: [], hops: []};
  }
  const validation = validateZiplineChain(state.towers, state.chain, state.frames);
  if (validation.ok) {
    appendValidation(
      `路径有效：${state.chain.length} 站。运行时仍会检查落脚点与遮挡；走不通或本轮已失败时会自动回退到查找。`,
      "ok",
    );
  } else {
    for (const error of validation.errors) appendValidation(error, "error");
  }
  if (state.savedRoute && state.dirty) appendValidation("已修改，记得保存。", "muted");
  return validation;
}

function appendValidation(text, tone) {
  const row = document.createElement("div");
  row.className = `validation-row validation-${tone}`;
  row.textContent = text;
  els.validation.append(row);
}

function applySequenceText() {
  if (!state.towers.length || state.busy) return;
  const parsed = parseTowerSequence(els.sequence.value, state.towers.length);
  if (parsed.error) {
    setStatus(parsed.error, "warn");
    els.sequence.classList.add("invalid");
    return;
  }
  els.sequence.classList.remove("invalid");
  state.chain = parsed.indices;
  markDirty();
  updateChainUi();
  draw();
}

function clickTower(tower) {
  if (state.busy) return;
  if (!tower.powered) {
    setStatus(`#${tower.index} 没有供电，运行时会被跳过。`, "warn");
    return;
  }
  const last = state.chain[state.chain.length - 1];
  if (last === tower.index) {
    state.chain.pop();
  } else {
    state.chain.push(tower.index);
  }
  markDirty();
  updateChainUi();
  draw();
}

async function saveChain() {
  if (state.busy || !state.target || !state.accountId) return;
  const chainTowers = state.chain.map((index) => towerByIndex(index)).filter(Boolean);
  const validation = validateZiplineChain(state.towers, state.chain, state.frames);
  if (!validation.ok) {
    updateChainUi();
    return;
  }
  state.busy = true;
  updateChainUi();
  setStatus("正在保存…", "info");
  try {
    const payload = buildSavedRoutePayload(state.accountId, state.target, chainTowers);
    const result = await fetchJson("/api/zipline-routes", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload),
    });
    state.routes = Array.isArray(result && result.routes) ? result.routes : state.routes;
    state.savedRoute = findSavedZiplineRoute(
      state.routes,
      state.accountId,
      state.target.zone_name,
      state.target.goal,
      state.target.goal_deck_y,
    );
    state.dirty = false;
    renderSavedRoutes();
    updateChainUi();
    draw();
    if (state.noticeKind === "chain") showNotice("");
    setStatus("已保存。运行时在这个送货点的规划区间会直接采用这条路径。", "ok");
  } catch (error) {
    setStatus(`保存失败：${error && error.message ? error.message : error}`, "error");
  } finally {
    state.busy = false;
    updateChainUi();
  }
}

async function deleteChain() {
  if (state.busy || !state.target || !state.accountId || !state.savedRoute) return;
  if (!window.confirm("删除这个送货点的手工滑索路径？运行时将回到自动查找。")) return;
  state.busy = true;
  updateChainUi();
  setStatus("正在删除…", "info");
  try {
    const params = new URLSearchParams({
      account_id: state.accountId,
      zone_name: state.target.zone_name,
      goal_x: String(state.target.goal[0]),
      goal_y: String(state.target.goal[1]),
    });
    const result = await fetchJson(`/api/zipline-routes?${params}`, {method: "DELETE"});
    state.routes = Array.isArray(result && result.routes) ? result.routes : state.routes;
    state.savedRoute = null;
    state.chain = [];
    state.dirty = false;
    renderSavedRoutes();
    updateChainUi();
    draw();
    setStatus("已删除，运行时回到自动查找。", "ok");
  } catch (error) {
    setStatus(`删除失败：${error && error.message ? error.message : error}`, "error");
  } finally {
    state.busy = false;
    updateChainUi();
  }
}

// --- 已保存列表 -----------------------------------------------------------------------

function renderSavedRoutes() {
  els.savedList.replaceChildren();
  const routes = state.routes.filter((route) => !route.account_id || route.account_id === state.accountId);
  els.savedCount.textContent = routes.length ? `${routes.length} 条` : "";
  if (!routes.length) {
    const empty = document.createElement("div");
    empty.className = "saved-empty";
    empty.textContent = "这个账号还没有保存过手工路径。";
    els.savedList.append(empty);
    return;
  }
  for (const route of routes) {
    const target = targetForRoute(route);
    const row = document.createElement("div");
    row.className = "saved-item";

    const main = document.createElement("button");
    main.type = "button";
    main.className = "saved-main";
    main.disabled = !target;
    const title = document.createElement("span");
    title.className = "saved-title";
    title.textContent = target ? target.label : route.label || "未命名路径";
    const meta = document.createElement("span");
    meta.className = "saved-meta";
    const leg = target && target.leg_count > 1 ? ` · 第 ${target.leg_index}/${target.leg_count} 段` : "";
    meta.textContent = `${route.zone_name} · ${Array.isArray(route.towers) ? route.towers.length : 0} 站${leg}`;
    main.append(title, meta);
    main.title = target ? "载入这条路径" : "当前 AutoDelivery 路线里找不到对应终点，无法载入";
    main.addEventListener("click", () => void loadSavedRoute(route, target));
    row.append(main);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "saved-remove";
    remove.textContent = "删除";
    remove.title = "删除这条手工路径";
    remove.addEventListener("click", () => void deleteSavedRoute(route));
    row.append(remove);
    if (target && state.target && target.id === state.target.id) {
      row.classList.add("saved-item-current");
    }
    els.savedList.append(row);
  }
}

function targetForRoute(route) {
  const goal = Array.isArray(route && route.goal) ? route.goal : [];
  let best = null;
  let bestDistance = 1;
  for (const target of state.targets) {
    if (!route || target.zone_name !== route.zone_name) continue;
    const distance = Math.hypot(Number(goal[0]) - Number(target.goal[0]), Number(goal[1]) - Number(target.goal[1]));
    if (Number.isFinite(distance) && distance <= bestDistance) {
      best = target;
      bestDistance = distance;
    }
  }
  return best;
}

function loadSavedRoute(route, target) {
  if (!target || state.busy) return;
  if (!confirmDiscard()) return;
  selectTarget(target.id, {force: true});
  const resolved = resolveSavedChain(state.towers, route);
  if (resolved.missing.length) {
    state.chain = [];
    showNotice(
      `这条已保存路径里有 ${resolved.missing.length} 座滑索架在当前账号的记录中找不到，运行时也会回退。`,
      "warn",
      "chain",
    );
  } else {
    state.chain = resolved.indices;
  }
  state.savedRoute = findSavedZiplineRoute(
    state.routes,
    state.accountId,
    target.zone_name,
    target.goal,
    target.goal_deck_y,
  );
  state.dirty = false;
  updateChainUi();
  draw();
  setStatus(`已载入 ${route.label || target.label}。`, resolved.missing.length ? "warn" : "ok");
}

async function deleteSavedRoute(route) {
  if (!route || state.busy) return;
  if (!window.confirm("删除这条手工滑索路径？运行时将回到自动查找。")) return;
  state.busy = true;
  try {
    const params = new URLSearchParams({
      account_id: route.account_id || state.accountId,
      zone_name: route.zone_name,
      goal_x: String(route.goal[0]),
      goal_y: String(route.goal[1]),
    });
    const result = await fetchJson(`/api/zipline-routes?${params}`, {method: "DELETE"});
    state.routes = Array.isArray(result && result.routes) ? result.routes : state.routes;
    renderSavedRoutes();
    if (state.target) {
      const current = findSavedZiplineRoute(
        state.routes,
        state.accountId,
        state.target.zone_name,
        state.target.goal,
        state.target.goal_deck_y,
      );
      if (!current) {
        state.savedRoute = null;
        if (!state.dirty) state.chain = [];
      } else {
        state.savedRoute = current;
      }
      updateChainUi();
      draw();
    }
    setStatus("已删除，运行时回到自动查找。", "ok");
  } catch (error) {
    setStatus(`删除失败：${error && error.message ? error.message : error}`, "error");
  } finally {
    state.busy = false;
    updateChainUi();
  }
}

// --- 交互绑定 -------------------------------------------------------------------------

function bindUi() {
  els.account.addEventListener("change", () => void selectAccount(els.account.value));
  els.target.addEventListener("change", () => void selectTarget(els.target.value));
  els.sequence.addEventListener("change", applySequenceText);
  els.sequence.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    applySequenceText();
    els.sequence.blur();
  });
  els.undo.addEventListener("click", () => {
    if (state.busy) return;
    state.chain.pop();
    markDirty();
    updateChainUi();
    draw();
  });
  els.clear.addEventListener("click", () => {
    if (state.busy) return;
    state.chain = [];
    markDirty();
    updateChainUi();
    draw();
  });
  els.save.addEventListener("click", () => void saveChain());
  els.delete.addEventListener("click", () => void deleteChain());
  els.zoomIn.addEventListener("click", () => {
    camera.zoomAt(canvasWidth / 2, canvasHeight / 2, 1.25);
    syncBasemapTransform();
    draw();
  });
  els.zoomOut.addEventListener("click", () => {
    camera.zoomAt(canvasWidth / 2, canvasHeight / 2, 0.8);
    syncBasemapTransform();
    draw();
  });
  els.fit.addEventListener("click", fitView);

  els.overlay.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const [x, y] = canvasPoint(event, els.overlay);
      camera.zoomAt(x, y, wheelZoomFactor(event, canvasHeight));
      syncBasemapTransform();
      draw();
    },
    {passive: false},
  );

  els.overlay.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const [x, y] = canvasPoint(event, els.overlay);
    pan.arm(x, y);
    els.overlay.setPointerCapture(event.pointerId);
  });

  els.overlay.addEventListener("pointermove", (event) => {
    const [x, y] = canvasPoint(event, els.overlay);
    if (pan.armed || pan.active) {
      pan.move(x, y);
      if (pan.active) {
        syncBasemapTransform();
        draw();
      }
      return;
    }
    const tower = hitTower(x, y);
    if ((tower && tower.index) !== (state.hover && state.hover.index)) {
      state.hover = tower;
      draw();
    }
    updateTooltip(tower, x, y);
  });

  els.overlay.addEventListener("pointerup", (event) => {
    const [x, y] = canvasPoint(event, els.overlay);
    const wasDragging = pan.active;
    pan.cancel();
    els.overlay.style.cursor = "";
    if (wasDragging) return;
    const tower = hitTower(x, y);
    if (tower) clickTower(tower);
  });

  els.overlay.addEventListener("pointerleave", () => {
    hideTooltip();
    if (state.hover) {
      state.hover = null;
      draw();
    }
  });

  els.overlay.addEventListener("pointercancel", () => {
    pan.cancel();
    els.overlay.style.cursor = "";
    hideTooltip();
  });

  window.addEventListener("resize", () => {
    resizeCanvas();
    draw();
  });
  window.addEventListener("beforeunload", (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

function updateTooltip(tower, x, y) {
  if (!tower) {
    hideTooltip();
    return;
  }
  const power = tower.powered ? "已供电" : "未通电（不可选）";
  els.tooltip.textContent = `#${tower.index} · ${towerTypeName(tower, state.frames)} · ${power} · ${tower.levelId} · 高度 ${Number(tower.height).toFixed(2)} · 世界 [${tower.world.map((value) => Number(value).toFixed(1)).join(", ")}]`;
  els.tooltip.hidden = false;
  const maxX = Math.max(8, canvasWidth - els.tooltip.offsetWidth - 12);
  const maxY = Math.max(8, canvasHeight - els.tooltip.offsetHeight - 12);
  els.tooltip.style.left = `${Math.min(maxX, x + 14)}px`;
  els.tooltip.style.top = `${Math.min(maxY, y + 14)}px`;
}

function hideTooltip() {
  els.tooltip.hidden = true;
}

boot();
