/**
 * Pure helpers for the per-delivery-point zipline chain editor.
 *
 * The runtime (cpp-algo `ZiplineRoutes` + `PlanZiplineRoute`) uses the same
 * account/zone/goal key and the same geometric checks; this module only
 * mirrors the parts the browser can evaluate without the navmesh: power,
 * tower type span, and level. Occlusion and landing reachability stay
 * runtime-only, so a chain accepted here can still fall back there.
 *
 * @module zipline_route_model
 */

import {measureZiplinePair} from "./zipline_records.js";

const GOAL_MATCH_PX = 1;
const GOAL_DECK_MATCH_Y = 1;

function finite(value) {
  // Number(null) 是 0, 缺省的 goal_deck_y 不能因此被当成真实层高
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function frameForZone(frameConfig, zoneName) {
  const wanted = String(zoneName || "").toLowerCase();
  return (frameConfig && Array.isArray(frameConfig.frames) ? frameConfig.frames : []).find(
    (frame) => String(frame && frame.zone_name).toLowerCase() === wanted,
  );
}

function typeOf(frameConfig, templateId) {
  return (frameConfig && Array.isArray(frameConfig.types) ? frameConfig.types : []).find(
    (type) => String(type && type.template_id) === String(templateId || ""),
  );
}

function powerSourceOf(frameConfig, templateId) {
  const sources =
    frameConfig && frameConfig.power && Array.isArray(frameConfig.power.sources) ? frameConfig.power.sources : [];
  return sources.find((source) => String(source && source.template_id) === String(templateId || ""));
}

function footprintOf(type) {
  if (!type || !Array.isArray(type.footprint) || type.footprint.length !== 2) return null;
  const values = type.footprint.map(Number);
  if (values.some((value) => !Number.isInteger(value) || value <= 0 || value % 2 === 0)) return null;
  return values;
}

function gridHalfSpan(size) {
  return (size - 1) / 2;
}

function gridAreasMayOverlap(deltaX, deltaZ, coverageSize, supplyFootprint, towerFootprint) {
  const centerReachX = gridHalfSpan(coverageSize[0]) + gridHalfSpan(towerFootprint[0]);
  const centerReachZ = gridHalfSpan(coverageSize[1]) + gridHalfSpan(towerFootprint[1]);
  const anchorUncertaintyX = gridHalfSpan(supplyFootprint[0]) + gridHalfSpan(towerFootprint[0]);
  const anchorUncertaintyZ = gridHalfSpan(supplyFootprint[1]) + gridHalfSpan(towerFootprint[1]);
  return Math.abs(deltaX) <= centerReachX + anchorUncertaintyX && Math.abs(deltaZ) <= centerReachZ + anchorUncertaintyZ;
}

/**
 * Reproduce `is_powered` from the runtime: a tower needs one supply structure
 * whose radius or coverage grid reaches it. Height is intentionally ignored.
 * @param {Object} mark tower record
 * @param {Array<Object>} supplies marks with a registered power-source template
 * @param {Object} frameConfig parsed zipline_frames.json
 * @returns {boolean}
 */
export function isZiplinePowered(mark, supplies, frameConfig) {
  const towerFootprint = footprintOf(typeOf(frameConfig, mark.template_id)) || [1, 1];
  return supplies.some((supply) => {
    const source = powerSourceOf(frameConfig, supply.template_id);
    if (!source) return false;
    const coverage = Array.isArray(source.coverage_size) ? source.coverage_size.map(Number) : [];
    if (coverage.length === 2 && coverage[0] > 0 && coverage[1] > 0) {
      const sourceFootprint = footprintOf(source) || [1, 1];
      return gridAreasMayOverlap(
        Number(supply.x) - Number(mark.x),
        Number(supply.z) - Number(mark.z),
        coverage,
        sourceFootprint,
        towerFootprint,
      );
    }
    const radius = finite(source.radius);
    return (
      radius !== null && Math.hypot(Number(supply.x) - Number(mark.x), Number(supply.z) - Number(mark.z)) <= radius
    );
  });
}

function projectMark(frame, mark) {
  if (!frame || !Array.isArray(frame.plane) || frame.plane.length !== 6) return null;
  const plane = frame.plane.map(finite);
  const scale = finite(frame.height_scale);
  const offset = finite(frame.height_offset);
  const x = finite(mark.x);
  const y = finite(mark.y);
  const z = finite(mark.z);
  if (plane.some((value) => value === null) || scale === null || offset === null) return null;
  if ([x, y, z].some((value) => value === null)) return null;
  return {
    point: [plane[0] * x + plane[1] * z + plane[2], plane[3] * x + plane[4] * z + plane[5]],
    height: scale * y + offset,
    world: [x, y, z],
  };
}

/**
 * Project one zone's recorded pylons into base pixels and number them for the
 * editor. Unpowered pylons keep their numbers but are marked so they cannot be
 * selected.
 * @param {Object} records parsed record/Ziplines.json
 * @param {Object} frameConfig parsed zipline_frames.json
 * @param {string} zoneName base zone such as map02base
 * @param {string} [accountId]
 * @returns {Array<Object>}
 */
export function buildZoneTowers(records, frameConfig, zoneName, accountId = "") {
  const frame = frameForZone(frameConfig, zoneName);
  if (!frame) return [];
  const accepted = new Set(Array.isArray(frame.template_ids) ? frame.template_ids.map(String) : []);
  const maps = records && Array.isArray(records.maps) ? records.maps : [];
  const wantedAccount = String(accountId || "");
  const hasScopedRecords = maps.some((map) => String((map && map.account_id) || ""));
  if (!wantedAccount && hasScopedRecords) return [];
  const requirePower = Boolean(
    frameConfig && frameConfig.power && Array.isArray(frameConfig.power.sources) && frameConfig.power.sources.length,
  );

  const towers = [];
  let index = 0;
  for (let recordIndex = 0; recordIndex < maps.length; recordIndex += 1) {
    const map = maps[recordIndex];
    const recordAccount = String((map && map.account_id) || "");
    if (wantedAccount && recordAccount !== wantedAccount) continue;
    const mapId = String((map && map.map_id) || "");
    if (frame.map_id && mapId !== String(frame.map_id)) continue;
    const marks = Array.isArray(map && map.marks) ? map.marks : [];
    const supplies = marks.filter((mark) => powerSourceOf(frameConfig, mark && mark.template_id));
    for (const mark of marks) {
      const templateId = String((mark && mark.template_id) || "");
      if (accepted.size && !accepted.has(templateId)) continue;
      const projection = projectMark(frame, mark || {});
      if (!projection) continue;
      index += 1;
      towers.push({
        index,
        recordKey: String(recordIndex),
        point: projection.point,
        height: projection.height,
        world: projection.world,
        mapId,
        levelId: String(mark.level_id || ""),
        templateId,
        powered: !requirePower || isZiplinePowered(mark, supplies, frameConfig),
      });
    }
  }
  return towers;
}

/**
 * Validate a chain of tower numbers against the checks the browser can make.
 * @param {Array<Object>} towers result of {@link buildZoneTowers}
 * @param {number[]} indices 1-based tower numbers in ride order
 * @param {Object} frameConfig parsed zipline_frames.json
 * @returns {{ok:boolean, errors:string[], hops:Array<Object>}}
 */
export function validateZiplineChain(towers, indices, frameConfig) {
  const errors = [];
  const hops = [];
  const chain = Array.isArray(indices) ? indices : [];
  if (chain.length < 2) {
    errors.push("至少选择两座滑索架。");
    return {ok: false, errors, hops};
  }
  for (let i = 0; i < chain.length; i += 1) {
    const tower = towers.find((candidate) => candidate.index === chain[i]);
    if (!tower) {
      errors.push(`第 ${i + 1} 座滑索架不存在。`);
      continue;
    }
    if (!tower.powered) {
      errors.push(`第 ${i + 1} 座（#${tower.index}）未通电，运行时会被跳过。`);
    }
  }
  if (errors.length) return {ok: false, errors, hops};

  for (let i = 0; i + 1 < chain.length; i += 1) {
    const from = towers.find((candidate) => candidate.index === chain[i]);
    const to = towers.find((candidate) => candidate.index === chain[i + 1]);
    if (!from || !to) continue;
    if (from.index === to.index) {
      errors.push(`第 ${i + 1} 跳重复选择 #${from.index}。`);
      continue;
    }
    if (String(from.recordKey) !== String(to.recordKey)) {
      errors.push(`第 ${i + 1} 跳 #${from.index} → #${to.index} 不在同一份滑索记录里。`);
      continue;
    }
    const measurement = measureZiplinePair(from, to, frameConfig);
    hops.push({from: from.index, to: to.index, measurement});
    if (measurement.geometryConnected !== true) {
      errors.push(`第 ${i + 1} 跳 #${from.index} → #${to.index} 不成立：${measurement.geometryReason}。`);
    }
  }
  return {ok: errors.length === 0, errors, hops};
}

/**
 * Parse the sidebar text field: `3, 7, 12`, `3 7 12`, or `#3 #7 #12`.
 * @param {string} text
 * @param {number} towerCount
 * @returns {{indices:number[], error:string}}
 */
export function parseTowerSequence(text, towerCount) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return {indices: [], error: ""};
  const tokens = trimmed.split(/[\s,，、;；]+/).filter(Boolean);
  const indices = [];
  for (const token of tokens) {
    if (!/^#?\d+$/.test(token)) return {indices: [], error: `无法识别编号「${token}」。`};
    const value = Number(token.replace(/^#/, ""));
    if (value < 1 || value > towerCount) return {indices: [], error: `编号 ${value} 超出 1–${towerCount}。`};
    indices.push(value);
  }
  return {indices, error: ""};
}

/** @param {number[]} indices @returns {string} */
export function formatTowerSequence(indices) {
  return (Array.isArray(indices) ? indices : []).join(", ");
}

/**
 * Find the saved chain the runtime would pick for this leg.
 * @param {Array<Object>} routes saved routes from the API
 * @param {string} accountId
 * @param {string} zoneName
 * @param {number[]} goal base-pixel goal
 * @param {?number} goalDeckY
 * @returns {?Object}
 */
export function findSavedZiplineRoute(routes, accountId, zoneName, goal, goalDeckY) {
  if (!Array.isArray(routes) || !Array.isArray(goal) || goal.length !== 2) return null;
  const goalX = finite(goal[0]);
  const goalY = finite(goal[1]);
  if (goalX === null || goalY === null) return null;
  const deck = finite(goalDeckY);
  let best = null;
  let bestDistance = GOAL_MATCH_PX;
  for (const route of routes) {
    if (!route || String(route.zone_name || "") !== String(zoneName || "")) continue;
    const routeAccount = String(route.account_id || "");
    if (routeAccount && routeAccount !== accountId) continue;
    const routeDeck = finite(route.goal_deck_y);
    if (deck !== null && routeDeck !== null && Math.abs(deck - routeDeck) > GOAL_DECK_MATCH_Y) continue;
    const routeGoal = Array.isArray(route.goal) ? route.goal : [];
    const distance = Math.hypot(Number(routeGoal[0]) - goalX, Number(routeGoal[1]) - goalY);
    if (Number.isFinite(distance) && distance <= bestDistance) {
      best = route;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Map a saved route's world-coordinate anchors back to the current numbered
 * pylons. Re-importing Ziplines.json may reorder marks, so indices are never
 * persisted.
 * @param {Array<Object>} towers current zone towers
 * @param {?Object} savedRoute
 * @returns {{indices:number[], missing:Array<Object>}}
 */
export function resolveSavedChain(towers, savedRoute) {
  const marks = savedRoute && Array.isArray(savedRoute.towers) ? savedRoute.towers : [];
  const indices = [];
  const missing = [];
  for (const mark of marks) {
    let hit = null;
    let nearest = 2;
    const levelId = String((mark && mark.level_id) || "");
    for (const tower of towers) {
      if (levelId && tower.levelId !== levelId) continue;
      const distance = Math.hypot(
        Number(tower.world[0]) - Number(mark.x),
        Number(tower.world[1]) - Number(mark.y),
        Number(tower.world[2]) - Number(mark.z),
      );
      if (Number.isFinite(distance) && distance <= nearest) {
        nearest = distance;
        hit = tower;
      }
    }
    if (hit) indices.push(hit.index);
    else missing.push(mark);
  }
  return {indices, missing};
}

/**
 * Find a contiguous sub-chain from one saved route that starts at `fromIndex`
 * and ends at `toIndex`. The longest match wins; the returned `eHops` slice
 * keeps the source route's auto-destination flags in the same hop order.
 * @param {Array<Object>} routes saved routes from the API
 * @param {Array<Object>} towers current zone towers
 * @param {string} accountId
 * @param {string} zoneName
 * @param {number} fromIndex
 * @param {number} toIndex
 * @param {number[]} [blockedIndices] towers already in the new chain; a segment that would repeat any of them is skipped
 * @returns {?{indices:number[], eHops:boolean[], label:string}}
 */
export function findReusableZiplineSegment(
  routes,
  towers,
  accountId,
  zoneName,
  fromIndex,
  toIndex,
  blockedIndices = [],
) {
  if (!Array.isArray(routes) || !Array.isArray(towers) || fromIndex === toIndex) return null;
  const blocked = new Set(Array.isArray(blockedIndices) ? blockedIndices : []);
  let best = null;
  for (const route of routes) {
    if (!route || String(route.zone_name || "") !== String(zoneName || "")) continue;
    const routeAccount = String(route.account_id || "");
    if (routeAccount && routeAccount !== String(accountId || "")) continue;
    const resolved = resolveSavedChain(towers, route);
    if (resolved.missing.length) continue;
    const indices = resolved.indices;
    const flags = Array.isArray(route.e_hops) ? route.e_hops : [];
    for (let start = 0; start < indices.length; start += 1) {
      if (indices[start] !== fromIndex) continue;
      for (let end = start + 1; end < indices.length; end += 1) {
        if (indices[end] !== toIndex) continue;
        const segment = indices.slice(start, end + 1);
        if (new Set(segment).size !== segment.length) continue;
        if (segment.slice(1).some((index) => blocked.has(index))) continue;
        const eHops = Array.from({length: segment.length - 1}, (_, offset) => flags[start + offset] === true);
        if (!best || segment.length > best.indices.length) {
          best = {indices: segment, eHops, label: String(route.label || "")};
        }
      }
    }
  }
  return best;
}

/**
 * Build the POST body for one chain. The tower order is the click order.
 * @param {string} accountId
 * @param {Object} target delivery target from the API
 * @param {Array<Object>} chainTowers selected tower objects in order
 * @param {boolean[]} [eHops] per-hop E-chain flags, one per tower gap
 * @returns {Object}
 */
export function buildSavedRoutePayload(accountId, target, chainTowers, eHops = []) {
  const hopCount = Math.max(0, chainTowers.length - 1);
  return {
    account_id: String(accountId || ""),
    zone_name: String(target && target.zone_name ? target.zone_name : ""),
    label: String(target && target.label ? target.label : ""),
    goal: Array.isArray(target && target.goal) ? target.goal.slice(0, 2) : [],
    goal_deck_y: finite(target && target.goal_deck_y),
    towers: chainTowers.map((tower) => ({
      level_id: tower.levelId,
      template_id: tower.templateId,
      x: tower.world[0],
      y: tower.world[1],
      z: tower.world[2],
    })),
    e_hops: Array.from({length: hopCount}, (_, index) => eHops[index] === true),
  };
}

/** @param {Object} tower @param {Object} frameConfig @returns {string} */
export function towerTypeName(tower, frameConfig) {
  const type = typeOf(frameConfig, tower && tower.templateId);
  return String((type && type.name) || "滑索架");
}
