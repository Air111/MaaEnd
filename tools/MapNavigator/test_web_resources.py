import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from navmesh_backend import rope_interact_text
from web import serve


class WebResourceTest(unittest.TestCase):
    def test_zipline_records_exposes_the_current_installation_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            records = Path(temp_dir) / "Ziplines.json"
            records.write_text('{"maps": []}', encoding="utf-8")
            with patch.object(serve, "ZIPLINE_RECORDS", records):
                response = asyncio.run(serve.api_zipline_records())

        self.assertEqual(Path(response.path), records)
        self.assertEqual(response.media_type, "application/json")

    def test_zipline_records_reports_a_missing_snapshot(self) -> None:
        missing = Path("missing") / "Ziplines.json"
        with (
            patch.object(serve, "ZIPLINE_RECORDS", missing),
            self.assertRaises(HTTPException) as context,
        ):
            asyncio.run(serve.api_zipline_records())

        self.assertEqual(context.exception.status_code, 404)
        self.assertIn("没有滑索记录", str(context.exception.detail))

    def test_route_preview_forwards_the_selected_zipline_account(self) -> None:
        request = serve.RoutePreviewRequest(
            position=[100.0, 200.0],
            position_zone="map02base",
            custom_action_param={"zip": True, "path": []},
            zipline_account_id="account-a",
        )
        with patch.object(
            serve.navmesh_backend,
            "query_latest",
            return_value={"ok": True},
        ) as query_latest:
            response = asyncio.run(serve.api_route_preview(request))

        self.assertEqual(response, {"ok": True})
        query_latest.assert_called_once_with(
            "route-preview",
            "route_preview",
            position=[100.0, 200.0],
            position_zone="map02base",
            floor_y=[],
            custom_action_param={"zip": True, "path": []},
            zipline_account_id="account-a",
            rope_interact_text=rope_interact_text(),
        )

    def test_route_preview_reads_the_runtime_rope_text_node(self) -> None:
        self.assertIn("^使用$", rope_interact_text())

    def test_zipline_routes_round_trip_through_the_editor_api(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "ZiplineRoutes.json"
            with (
                patch.object(serve, "ZIPLINE_ROUTES", path),
                patch.object(serve, "build_delivery_targets", return_value=[]),
            ):
                self.assertEqual(asyncio.run(serve.api_zipline_routes())["routes"], [])
                saved = asyncio.run(
                    serve.api_save_zipline_route(
                        {
                            "account_id": "account-a",
                            "zone_name": "map01base",
                            "label": "园区 · 甲",
                            "goal": [10.0, 20.0],
                            "goal_deck_y": 90.0,
                            "towers": [
                                {"level_id": "map01_lv005", "template_id": "zipline", "x": 0, "y": 0, "z": 0},
                                {"level_id": "map01_lv005", "template_id": "zipline", "x": 50, "y": 0, "z": 0},
                            ],
                        }
                    )
                )
                self.assertEqual(len(saved["routes"]), 1)
                self.assertNotIn("targets", saved)
                deleted = asyncio.run(serve.api_delete_zipline_route("account-a", "map01base", 10.0, 20.0))
                self.assertEqual(deleted["routes"], [])

    def test_zipline_routes_rejects_incomplete_chains(self) -> None:
        with self.assertRaises(HTTPException) as context:
            asyncio.run(
                serve.api_save_zipline_route(
                    {
                        "account_id": "account-a",
                        "zone_name": "map01base",
                        "goal": [10.0, 20.0],
                        "towers": [{"level_id": "map01_lv005", "x": 0, "y": 0, "z": 0}],
                    }
                )
            )

        self.assertEqual(context.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
