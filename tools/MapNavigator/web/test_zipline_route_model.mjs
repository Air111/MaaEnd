import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSavedRoutePayload,
  buildZoneTowers,
  findReusableZiplineSegment,
  findSavedZiplineRoute,
  formatTowerSequence,
  parseTowerSequence,
  resolveSavedChain,
  validateZiplineChain,
} from "./static/js/zipline_route_model.js";

const frames = {
  types: [{name: "滑索架", template_id: "zipline", max_span: 80, footprint: [3, 3]}],
  power: {sources: [{template_id: "power", radius: 10}]},
  frames: [
    {
      zone_name: "map01base",
      map_id: "map01",
      plane: [1, 0, 0, 0, 1, 0],
      height_scale: 1,
      height_offset: 0,
      template_ids: ["zipline"],
    },
  ],
};

function recordsWith(towers, supplies = []) {
  return {
    maps: [
      {
        account_id: "account-a",
        map_id: "map01",
        marks: [
          ...towers.map(([x, y, z], index) => ({
            level_id: "map01_lv005",
            template_id: "zipline",
            x,
            y,
            z,
            name: `tower-${index + 1}`,
          })),
          ...supplies.map(([x, z]) => ({level_id: "map01_lv005", template_id: "power", x, y: 0, z})),
        ],
      },
    ],
  };
}

test("projects zone pylons, numbers them, and keeps unpowered ones out of reach", () => {
  const records = recordsWith(
    [
      [0, 0, 0],
      [10, 5, 0],
      [100, 0, 0],
    ],
    [[5, 0]],
  );

  const towers = buildZoneTowers(records, frames, "map01base", "account-a");
  assert.deepEqual(
    towers.map((tower) => tower.index),
    [1, 2, 3],
  );
  assert.deepEqual(
    towers.map((tower) => tower.powered),
    [true, true, false],
  );
  assert.deepEqual(towers[1].point, [10, 0]);
  assert.deepEqual(towers[1].world, [10, 5, 0]);
  assert.equal(towers[1].height, 5);

  assert.deepEqual(buildZoneTowers(records, frames, "map01base", "account-b"), []);
  assert.deepEqual(buildZoneTowers(records, frames, "missingbase", "account-a"), []);
});

test("validates power, geometry, and adjacent duplicates", () => {
  const records = recordsWith(
    [
      [0, 0, 0],
      [10, 0, 0],
      [40, 0, 0],
      [200, 0, 0],
    ],
    [
      [5, 0],
      [15, 0],
      [45, 0],
      [205, 0],
    ],
  );
  const towers = buildZoneTowers(records, frames, "map01base", "account-a");

  assert.equal(validateZiplineChain(towers, [1, 2, 3, 4], frames).ok, false);
  const span = validateZiplineChain(towers, [3, 4], frames);
  assert.equal(span.ok, false);
  assert.match(span.errors[0], /跨度/);

  assert.equal(validateZiplineChain(towers, [1, 2, 3], frames).ok, true);

  const duplicate = validateZiplineChain(towers, [1, 1], frames);
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.errors[0], /重复选择/);

  const splitRecords = {
    maps: [
      {
        account_id: "account-a",
        map_id: "map01",
        marks: [
          {level_id: "map01_lv005", template_id: "zipline", x: 0, y: 0, z: 0},
          {level_id: "map01_lv005", template_id: "power", x: 0, y: 0, z: 0},
        ],
      },
      {
        account_id: "account-a",
        map_id: "map01",
        marks: [
          {level_id: "map01_lv005", template_id: "zipline", x: 10, y: 0, z: 0},
          {level_id: "map01_lv005", template_id: "power", x: 10, y: 0, z: 0},
        ],
      },
    ],
  };
  const crossRecord = validateZiplineChain(
    buildZoneTowers(splitRecords, frames, "map01base", "account-a"),
    [1, 2],
    frames,
  );
  assert.equal(crossRecord.ok, false);
  assert.match(crossRecord.errors[0], /同一份滑索记录/);

  const unpowered = buildZoneTowers(recordsWith([[0, 0, 0]]), frames, "map01base", "account-a");
  const powerError = validateZiplineChain([...unpowered, {...unpowered[0], index: 2}], [1, 2], frames);
  assert.equal(powerError.ok, false);
  assert.match(powerError.errors[0], /未通电/);
});

test("parses and formats the sequence field", () => {
  assert.deepEqual(parseTowerSequence("3, 7 12", 12), {indices: [3, 7, 12], error: ""});
  assert.deepEqual(parseTowerSequence("#1、#2", 12), {indices: [1, 2], error: ""});
  assert.deepEqual(parseTowerSequence("  ", 12), {indices: [], error: ""});
  assert.match(parseTowerSequence("1, x", 12).error, /无法识别/);
  assert.match(parseTowerSequence("0", 12).error, /超出/);
  assert.equal(formatTowerSequence([3, 7, 12]), "3, 7, 12");
});

test("matches saved chains the way the runtime does", () => {
  const routes = [
    {
      account_id: "account-a",
      zone_name: "map01base",
      goal: [100, 200],
      goal_deck_y: 90,
      towers: [],
    },
    {
      account_id: "account-b",
      zone_name: "map01base",
      goal: [100, 200],
      goal_deck_y: 90,
      towers: [],
    },
  ];
  assert.equal(findSavedZiplineRoute(routes, "account-a", "map01base", [100.4, 200], 90.5), routes[0]);
  assert.equal(findSavedZiplineRoute(routes, "account-a", "map01base", [100, 200], null), routes[0]);
  assert.equal(findSavedZiplineRoute(routes, "account-a", "map01base", [103, 200], 90), null);
  assert.equal(findSavedZiplineRoute(routes, "account-a", "map01base", [100, 200], 95), null);
  assert.equal(findSavedZiplineRoute(routes, "account-a", "map02base", [100, 200], 90), null);
});

test("resolves saved world anchors back to current tower numbers", () => {
  const towers = buildZoneTowers(
    recordsWith([
      [0, 0, 0],
      [10, 5, 0],
    ]),
    frames,
    "map01base",
    "account-a",
  );
  const resolved = resolveSavedChain(towers, {
    towers: [
      {level_id: "map01_lv005", x: 0.4, y: 0, z: 0},
      {level_id: "map01_lv005", x: 99, y: 0, z: 0},
    ],
  });
  assert.deepEqual(resolved.indices, [1]);
  assert.equal(resolved.missing.length, 1);
});

test("finds a reusable sub-chain and keeps its E flags", () => {
  const towers = buildZoneTowers(
    recordsWith(
      [
        [0, 0, 0],
        [10, 5, 0],
        [40, 0, 0],
      ],
      [
        [5, 0],
        [15, 0],
        [45, 0],
      ],
    ),
    frames,
    "map01base",
    "account-a",
  );
  const routes = [
    {
      account_id: "account-a",
      zone_name: "map01base",
      label: "园区 · 甲",
      towers: [
        {level_id: "map01_lv005", x: 0, y: 0, z: 0},
        {level_id: "map01_lv005", x: 10, y: 5, z: 0},
        {level_id: "map01_lv005", x: 40, y: 0, z: 0},
      ],
      e_hops: [true, false],
    },
  ];

  const whole = findReusableZiplineSegment(routes, towers, "account-a", "map01base", 1, 3);
  assert.deepEqual(whole.indices, [1, 2, 3]);
  assert.deepEqual(whole.eHops, [true, false]);
  assert.equal(whole.label, "园区 · 甲");

  const tail = findReusableZiplineSegment(routes, towers, "account-a", "map01base", 2, 3);
  assert.deepEqual(tail.indices, [2, 3]);
  assert.deepEqual(tail.eHops, [false]);

  assert.equal(findReusableZiplineSegment(routes, towers, "account-b", "map01base", 1, 3), null);
  assert.equal(findReusableZiplineSegment(routes, towers, "account-a", "map02base", 1, 3), null);
  assert.equal(findReusableZiplineSegment(routes, towers, "account-a", "map01base", 1, 3, [2]), null);
});

test("builds the save payload from the clicked tower order", () => {
  const towers = buildZoneTowers(
    recordsWith([
      [0, 0, 0],
      [10, 5, 2],
    ]),
    frames,
    "map01base",
    "account-a",
  );
  const payload = buildSavedRoutePayload(
    "account-a",
    {label: "园区 · 甲", zone_name: "map01base", goal: [1, 2], goal_deck_y: 90},
    [towers[1], towers[0]],
  );

  assert.deepEqual(payload, {
    account_id: "account-a",
    zone_name: "map01base",
    label: "园区 · 甲",
    goal: [1, 2],
    goal_deck_y: 90,
    towers: [
      {level_id: "map01_lv005", template_id: "zipline", x: 10, y: 5, z: 2},
      {level_id: "map01_lv005", template_id: "zipline", x: 0, y: 0, z: 0},
    ],
    e_hops: [false],
  });
  assert.equal(
    buildSavedRoutePayload("account-a", {label: "园区 · 甲", zone_name: "map01base", goal: [1, 2], goal_deck_y: null}, [
      towers[0],
      towers[1],
    ]).goal_deck_y,
    null,
  );
  assert.deepEqual(
    buildSavedRoutePayload(
      "account-a",
      {label: "园区 · 甲", zone_name: "map01base", goal: [1, 2], goal_deck_y: 90},
      [towers[0], towers[1]],
      [true],
    ).e_hops,
    [true],
  );
});
