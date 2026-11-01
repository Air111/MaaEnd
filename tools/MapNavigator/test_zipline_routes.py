import json
import tempfile
import unittest
from pathlib import Path

from zipline_routes import (
    SavedZiplineRoute,
    ZiplineTowerMark,
    base_zone_for,
    build_delivery_targets,
    build_environment_monitoring_targets,
    build_targets,
    build_teleport_entries,
    delete_saved_route,
    load_saved_routes,
    normalize_saved_route,
    save_saved_route,
)


def _tower(x: float) -> dict:
    return {"level_id": "map01_lv005", "template_id": "zipline", "x": x, "y": 10.0, "z": 20.0}


def _route_node(*navmesh: dict, zone_id: str = "ValleyIV_Base") -> dict:
    return {
        "custom_action": "MapNavigateAction",
        "custom_action_param": {
            "zip": True,
            "path": [{"action": "ZONE", "zone_id": zone_id}, *navmesh, {"action": "INTERACT", "target": [1.0, 2.0]}],
        },
    }


def _navmesh(x: float, y: float, *, required: bool = True, deck: float | None = None) -> dict:
    waypoint: dict = {"action": "NAVMESH", "target": [x, y]}
    if required:
        waypoint["required"] = True
    if deck is not None:
        waypoint["target_deck_y"] = deck
    return waypoint


class DeliveryTargetTest(unittest.TestCase):
    def test_lists_required_navmesh_goals_and_dedupes_shared_legs(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            routes = root / "Routes"
            routes.mkdir()
            catalog = {
                "depots": [],
                "destinations": [
                    {"id": "a", "name": {"zh_cn": "甲"}, "area": {"zh_cn": "园区"}, "zip_route_node": "RouteA"},
                    {"id": "b", "name": {"zh_cn": "乙"}, "area": {"zh_cn": "园区"}, "zip_route_node": "RouteB"},
                    {"id": "c", "name": {"zh_cn": "丙"}, "area": {"zh_cn": "园区"}, "zip_route_node": "RouteC"},
                ],
            }
            (root / "catalog.json").write_text(json.dumps(catalog, ensure_ascii=False), encoding="utf-8")
            (routes / "Region.json").write_text(
                json.dumps(
                    {
                        "RouteA": _route_node(_navmesh(100.0, 200.0), _navmesh(101.0, 200.0)),
                        "RouteB": _route_node(_navmesh(100.0, 200.0)),
                        "RouteC": _route_node(_navmesh(300.0, 400.0, deck=90.0), _navmesh(500.0, 600.0)),
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            frames = {"frames": [{"zone_name": "map01base"}]}
            (root / "frames.json").write_text(json.dumps(frames), encoding="utf-8")

            targets = build_delivery_targets(root / "catalog.json", routes, root / "frames.json")

        self.assertEqual(len(targets), 3)
        shared = next(target for target in targets if target.goal == (100.0, 200.0))
        self.assertEqual(shared.destinations, ("甲", "乙"))
        self.assertEqual(shared.label, "园区 · 甲 / 乙")
        self.assertEqual((shared.leg_index, shared.leg_count), (1, 1))
        self.assertEqual(shared.zone_name, "map01base")

        split = next(target for target in targets if target.goal == (300.0, 400.0))
        self.assertEqual((split.leg_index, split.leg_count), (1, 2))
        self.assertEqual(split.label, "园区 · 丙（第 1/2 段）")
        self.assertEqual(split.goal_deck_y, 90.0)
        self.assertEqual(sum(target.destinations == ("丙",) for target in targets), 2)

    def test_falls_back_to_the_last_position_without_required_points(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            routes = root / "Routes"
            routes.mkdir()
            catalog = {
                "destinations": [
                    {"id": "a", "name": {"zh_cn": "甲"}, "area": {"zh_cn": "园区"}, "zip_route_node": "RouteA"}
                ]
            }
            (root / "catalog.json").write_text(json.dumps(catalog, ensure_ascii=False), encoding="utf-8")
            (routes / "Region.json").write_text(
                json.dumps(
                    {
                        "RouteA": _route_node(
                            _navmesh(10.0, 20.0, required=False),
                            _navmesh(30.0, 40.0, required=False),
                        )
                    }
                ),
                encoding="utf-8",
            )
            (root / "frames.json").write_text(json.dumps({"frames": [{"zone_name": "map01base"}]}), encoding="utf-8")

            targets = build_delivery_targets(root / "catalog.json", routes, root / "frames.json")

        # 运行时区间终点取最后一个有坐标的路点；测试路线末尾是 INTERACT
        self.assertEqual([target.goal for target in targets], [(1.0, 2.0)])

    def test_maps_base_zone_aliases_like_the_runtime(self) -> None:
        self.assertEqual(base_zone_for("ValleyIV_Base"), "map01base")
        self.assertEqual(base_zone_for("Wuling_L5_320"), "map02base")
        self.assertEqual(base_zone_for("unknown"), "")


class DepotTargetTest(unittest.TestCase):
    def test_lists_zipline_depots_and_skips_walk_only_ones(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            routes = root / "Routes"
            routes.mkdir()
            catalog = {
                "depots": [
                    {
                        "id": "depot-a",
                        "name": {"zh_cn": "源石研究园"},
                        "zip_route_node": "DepotA",
                    },
                    {
                        "id": "depot-b",
                        "name": {"zh_cn": "供能高地"},
                        "zip_route_node": "DepotB",
                        "walk_only": True,
                    },
                ],
                "destinations": [],
            }
            (root / "catalog.json").write_text(json.dumps(catalog, ensure_ascii=False), encoding="utf-8")
            (routes / "Region.json").write_text(
                json.dumps(
                    {
                        "DepotA": _route_node(_navmesh(1043.463, 799.095, deck=93.098), _navmesh(1043.463, 803.314)),
                        "DepotB": _route_node(_navmesh(500.0, 500.0)),
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            (root / "frames.json").write_text(json.dumps({"frames": [{"zone_name": "map01base"}]}), encoding="utf-8")

            targets = build_delivery_targets(root / "catalog.json", routes, root / "frames.json")

        self.assertEqual(len(targets), 1)
        target = targets[0]
        self.assertEqual(target.kind, "delivery")
        self.assertEqual(target.label, "源石研究园 · 仓储节点")
        self.assertEqual(target.destinations, ("仓储节点",))
        self.assertEqual(target.goal, (1043.463, 799.095))
        self.assertEqual(target.goal_deck_y, 93.098)


class EnvironmentTargetTest(unittest.TestCase):
    def _build(self, routes, frames=None):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "routes.json").write_text(json.dumps(routes, ensure_ascii=False), encoding="utf-8")
            (root / "frames.json").write_text(
                json.dumps(frames or {"frames": [{"zone_name": "map02base"}]}), encoding="utf-8"
            )
            return build_environment_monitoring_targets(root / "routes.json", root / "frames.json")

    def test_uses_the_last_position_of_navpath(self) -> None:
        targets = self._build(
            [
                {
                    "MissionId": "m1m30",
                    "Name": "古树",
                    "NavPath": [
                        {"action": "ZONE", "zone_id": "Wuling_Base"},
                        {"action": "NAVMESH", "target": [829.41, 2576.94]},
                    ],
                    "Heading": 245,
                },
                {
                    "MissionId": "m1m33",
                    "Name": "漱玉",
                    "QuickTeleport": True,
                    "NavPath": [
                        {"action": "ZONE", "zone_id": "Wuling_Base"},
                        [726.02, 2405.0],
                    ],
                },
                {
                    "MissionId": "m1m36",
                    "Name": "东张西望的黑腹雉羽兽",
                    "QuickTeleport": True,
                    "Heading": 90,
                },
            ]
        )

        self.assertEqual([target.label for target in targets], ["古树", "漱玉"])
        self.assertEqual([target.goal for target in targets], [(829.41, 2576.94), (726.02, 2405.0)])
        self.assertTrue(all(target.kind == "environment_monitoring" for target in targets))
        self.assertTrue(all(target.area == "环境监测" for target in targets))
        self.assertTrue(all(target.zone_name == "map02base" for target in targets))

    def test_keeps_target_deck_y(self) -> None:
        targets = self._build(
            [
                {
                    "MissionId": "m1m58",
                    "Name": "水冷外壳装置",
                    "NavZoneId": "Wuling_Base",
                    "NavPath": [{"action": "NAVMESH", "target": [333.71, 2155.67], "target_deck_y": 265.55}],
                }
            ]
        )

        self.assertEqual(targets[0].goal_deck_y, 265.55)

    def test_build_targets_keeps_delivery_first(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            routes = root / "Routes"
            routes.mkdir()
            (root / "catalog.json").write_text(
                json.dumps(
                    {
                        "depots": [{"id": "d", "name": {"zh_cn": "园区"}, "zip_route_node": "Depot"}],
                        "destinations": [],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            (routes / "Region.json").write_text(
                json.dumps({"Depot": _route_node(_navmesh(10.0, 20.0))}), encoding="utf-8"
            )
            (root / "frames.json").write_text(json.dumps({"frames": [{"zone_name": "map01base"}]}), encoding="utf-8")
            env_routes = root / "env.json"
            env_routes.write_text(
                json.dumps(
                    [
                        {
                            "MissionId": "m1",
                            "Name": "古树",
                            "NavPath": [
                                {"action": "ZONE", "zone_id": "Wuling_Base"},
                                {"action": "NAVMESH", "target": [1.0, 2.0]},
                            ],
                        }
                    ],
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            (root / "frames02.json").write_text(
                json.dumps({"frames": [{"zone_name": "map01base"}, {"zone_name": "map02base"}]}),
                encoding="utf-8",
            )

            targets = build_targets(root / "catalog.json", routes, root / "frames02.json", env_routes)

        self.assertEqual([target.kind for target in targets], ["delivery", "environment_monitoring"])

    def test_skips_goals_written_in_tier_coordinates(self) -> None:
        targets = self._build(
            [
                {
                    "MissionId": "m1m62",
                    "Name": "垂藤",
                    "NavPath": [
                        {"action": "NAVMESH", "target": [79.73, 198.88], "target_tier": "Wuling_L4_330"},
                    ],
                },
                {
                    "MissionId": "m1m65",
                    "Name": "彩虹",
                    "NavPath": [
                        {"action": "ZONE", "zone_id": "Wuling_L4_328"},
                        {"action": "NAVMESH", "target": [214.61, 145.62], "target_tier": "Wuling_L4_328"},
                    ],
                },
                {
                    "MissionId": "m1m30",
                    "Name": "古树",
                    "NavPath": [
                        {"action": "ZONE", "zone_id": "Wuling_Base"},
                        {"action": "NAVMESH", "target": [829.41, 2576.94]},
                    ],
                },
            ]
        )

        self.assertEqual([target.label for target in targets], ["古树"])


class TeleportEntryTest(unittest.TestCase):
    def test_maps_public_entries_to_their_anchor_coordinates(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            manager = root / "manager.json"
            interface = root / "interface.json"
            manager.write_text(
                json.dumps(
                    {
                        "__PrivateA": {
                            "desc": "在地图界面找锚点 (景玉谷-生态实验站)",
                            "custom_recognition_param": {"zone": "Wuling", "icon": "TeleportAnchor", "at": [814.6, 2138.9]},
                        },
                        "__PrivateOther": {
                            "desc": "在地图界面找别的东西",
                            "custom_recognition_param": {"zone": "Dijiang", "at": [1.0, 2.0]},
                        },
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            interface.write_text(
                json.dumps(
                    {
                        "SceneEnterWorldWulingJingyuValleyEcologicalResearchStation": {
                            "anchor": {"__ScenePrivateMapTeleportPickAnchor": "__PrivateA"}
                        },
                        "SomeOtherNode": {"anchor": {"__ScenePrivateMapTeleportPickAnchor": "__PrivateA"}},
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            entries = build_teleport_entries(manager, interface)

        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["node"], "SceneEnterWorldWulingJingyuValleyEcologicalResearchStation")
        self.assertEqual(entries[0]["zone"], "Wuling")
        self.assertEqual(entries[0]["base_zone"], "map02base")
        self.assertEqual(entries[0]["at"], [814.6, 2138.9])
        self.assertEqual(entries[0]["label"], "景玉谷-生态实验站")


class SavedRouteTest(unittest.TestCase):
    def test_round_trips_and_replaces_by_account_zone_and_goal(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "ZiplineRoutes.json"
            save_saved_route(path, _saved(goal=(10.0, 20.0), tower_x=1.0))
            routes = save_saved_route(path, _saved(goal=(10.0, 20.004), tower_x=2.0))
            self.assertEqual(len(routes), 1)
            self.assertEqual(routes[0].towers[0].x, 2.0)

            routes = save_saved_route(path, _saved(goal=(30.0, 40.0), tower_x=3.0))
            self.assertEqual(len(routes), 2)
            loaded = load_saved_routes(path)
            self.assertEqual(len(loaded), 2)
            payload = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(payload["version"], 1)
            self.assertIn("_readme", payload)

    def test_delete_removes_only_the_matching_key(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "ZiplineRoutes.json"
            save_saved_route(path, _saved(goal=(10.0, 20.0), tower_x=1.0))
            save_saved_route(path, _saved(goal=(30.0, 40.0), tower_x=2.0))

            routes = delete_saved_route(path, "account-a", "map01base", 10.0, 20.0)

        self.assertEqual([route.goal for route in routes], [(30.0, 40.0)])

    def test_skips_bad_entries_but_rejects_a_corrupt_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "ZiplineRoutes.json"
            path.write_text(
                json.dumps({"routes": [{"account_id": "a"}, _saved(goal=(1.0, 2.0), tower_x=1.0).as_dict()]}),
                encoding="utf-8",
            )
            self.assertEqual(len(load_saved_routes(path)), 1)

            path.write_text(json.dumps({"not_routes": []}), encoding="utf-8")
            with self.assertRaises(ValueError):
                load_saved_routes(path)

    def test_requires_two_towers_and_valid_coordinates(self) -> None:
        payload = _saved(goal=(1.0, 2.0), tower_x=1.0).as_dict()
        payload["towers"] = payload["towers"][:1]
        with self.assertRaises(ValueError):
            normalize_saved_route(payload)

        payload = _saved(goal=(1.0, 2.0), tower_x=1.0).as_dict()
        payload["towers"][0]["x"] = "not-a-number"
        with self.assertRaises(ValueError):
            normalize_saved_route(payload)

    def test_normalizes_one_e_flag_per_hop(self) -> None:
        payload = _saved(goal=(1.0, 2.0), tower_x=1.0).as_dict()
        payload.pop("e_hops", None)
        self.assertEqual(normalize_saved_route(payload).e_hops, (False,))

        payload["e_hops"] = [True]
        self.assertEqual(normalize_saved_route(payload).e_hops, (True,))

        payload["e_hops"] = [True, False, True]
        self.assertEqual(normalize_saved_route(payload).e_hops, (True,))

    def test_keeps_an_optional_entry_and_omits_it_when_empty(self) -> None:
        payload = _saved(goal=(1.0, 2.0), tower_x=1.0).as_dict()
        payload["entry"] = "SceneEnterWorldWulingJingyuValleyEcologicalResearchStation"
        route = normalize_saved_route(payload)
        self.assertEqual(route.entry, "SceneEnterWorldWulingJingyuValleyEcologicalResearchStation")
        self.assertEqual(route.as_dict()["entry"], route.entry)

        payload.pop("entry")
        route = normalize_saved_route(payload)
        self.assertEqual(route.entry, "")
        self.assertNotIn("entry", route.as_dict())


def _saved(*, goal: tuple[float, float], tower_x: float) -> SavedZiplineRoute:
    return SavedZiplineRoute(
        account_id="account-a",
        zone_name="map01base",
        label="园区 · 甲",
        goal=goal,
        goal_deck_y=90.0,
        towers=(
            ZiplineTowerMark(level_id="map01_lv005", template_id="zipline", x=tower_x, y=10.0, z=20.0),
            ZiplineTowerMark(level_id="map01_lv005", template_id="zipline", x=tower_x + 50.0, y=10.0, z=20.0),
        ),
    )


if __name__ == "__main__":
    unittest.main()
