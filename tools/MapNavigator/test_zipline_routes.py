import json
import tempfile
import unittest
from pathlib import Path

from zipline_routes import (
    SavedZiplineRoute,
    ZiplineTowerMark,
    base_zone_for,
    build_delivery_targets,
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
