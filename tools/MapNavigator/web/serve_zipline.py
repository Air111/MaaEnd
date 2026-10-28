"""滑索路径编辑器的轻量服务器 (仅标准库)。

完整 MapNavigator 需要 FastAPI、maafw、numpy 以及 cpp-algo/navmesh；这个页面只需要
读 Ziplines.json / zipline_frames.json，写 ZiplineRoutes.json，所以单独起一个不碰
agent、不连游戏的 server。浏览器打开的是空画布相对位置视图，不依赖底图。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

TOOL_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = TOOL_DIR.parents[1]
STATIC_DIR = TOOL_DIR / "web" / "static"
FRAMES_PATH = PROJECT_ROOT / "assets" / "data" / "MapNavigator" / "zipline_frames.json"

sys.path.insert(0, str(TOOL_DIR))

from zipline_routes import (  # noqa: E402
    SavedZiplineRoute,
    build_delivery_targets,
    delete_saved_route,
    load_saved_routes,
    normalize_saved_route,
    save_saved_route,
)

_RECORDS_PATH = Path()
_ROUTES_PATH = Path()
_ROUTES_LOCK = threading.Lock()
_MAX_BODY = 1_000_000


def _routes_payload(*, include_targets: bool) -> dict[str, Any]:
    error = ""
    try:
        routes = load_saved_routes(_ROUTES_PATH)
    except (OSError, ValueError) as exc:
        routes = []
        error = f"读取手工滑索路径失败：{exc}"

    payload: dict[str, Any] = {
        "routes": [route.as_dict() for route in routes],
        "path": str(_ROUTES_PATH),
        "error": error,
    }
    if include_targets:
        try:
            payload["targets"] = [target.as_dict() for target in build_delivery_targets()]
        except (OSError, ValueError) as exc:
            payload["targets"] = []
            payload["error"] = f"读取 AutoDelivery 送货点失败：{exc}"
    return payload


class Handler(SimpleHTTPRequestHandler):
    server_version = "MaaEndZiplinePreview/1.0"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[zipline] {self.address_string()} {fmt % args}")

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _send_json(self, status: HTTPStatus, payload: Any) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: Path, missing: str) -> None:
        if not path.is_file():
            self._send_json(HTTPStatus.NOT_FOUND, {"error": missing})
            return
        body = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/":
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Location", "/zipline_routes.html?blank=1")
            self.end_headers()
            return
        if path == "/api/zipline-frames":
            self._send_file(FRAMES_PATH, "缺少 zipline_frames.json")
            return
        if path == "/api/zipline-records":
            self._send_file(_RECORDS_PATH, "当前安装目录没有 Ziplines.json")
            return
        if path == "/api/zipline-routes":
            self._send_json(HTTPStatus.OK, _routes_payload(include_targets=True))
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        if urlparse(self.path).path != "/api/zipline-routes":
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > _MAX_BODY:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "请求体为空或过大"})
            return
        try:
            raw = json.loads(self.rfile.read(length).decode("utf-8"))
            route: SavedZiplineRoute = normalize_saved_route(raw)
        except (OSError, ValueError, UnicodeDecodeError) as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        try:
            with _ROUTES_LOCK:
                save_saved_route(_ROUTES_PATH, route)
        except (OSError, ValueError) as exc:
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"保存失败：{exc}"})
            return
        self._send_json(HTTPStatus.OK, _routes_payload(include_targets=False))

    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/api/zipline-routes":
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        query = parse_qs(parsed.query)
        account_id = (query.get("account_id") or [""])[0].strip()
        zone_name = (query.get("zone_name") or [""])[0].strip()
        if not account_id or not zone_name:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "account_id 与 zone_name 不能为空"})
            return
        try:
            goal_x = float((query.get("goal_x") or [""])[0])
            goal_y = float((query.get("goal_y") or [""])[0])
        except ValueError:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "goal_x / goal_y 必须是数字"})
            return
        try:
            with _ROUTES_LOCK:
                delete_saved_route(_ROUTES_PATH, account_id, zone_name, goal_x, goal_y)
        except (OSError, ValueError) as exc:
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"删除失败：{exc}"})
            return
        self._send_json(HTTPStatus.OK, _routes_payload(include_targets=False))


def _bind(port: int) -> ThreadingHTTPServer:
    for candidate in range(port, port + 20):
        try:
            return ThreadingHTTPServer(("127.0.0.1", candidate), Handler)
        except OSError:
            continue
    raise SystemExit(f"从 {port} 开始找不到可用端口")


def main() -> None:
    global _RECORDS_PATH, _ROUTES_PATH
    parser = argparse.ArgumentParser(description="轻量滑索路径编辑器 (无 agent / 无游戏连接)")
    parser.add_argument(
        "--install-dir",
        default=os.environ.get("MAPNAV_INSTALL_DIR") or str(PROJECT_ROOT / "install"),
        help="MaaEnd 安装目录，读取 debug/record/Ziplines.json",
    )
    parser.add_argument("--routes", default="", help="覆盖 ZiplineRoutes.json 路径 (测试用)")
    parser.add_argument("--port", type=int, default=18770)
    parser.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    args = parser.parse_args()

    install_dir = Path(args.install_dir).expanduser().resolve()
    _RECORDS_PATH = install_dir / "debug" / "record" / "Ziplines.json"
    _ROUTES_PATH = (
        Path(args.routes).expanduser().resolve()
        if args.routes
        else install_dir / "debug" / "record" / "ZiplineRoutes.json"
    )

    httpd = _bind(args.port)
    url = f"http://127.0.0.1:{httpd.server_port}/zipline_routes.html?blank=1"
    print(f"安装目录: {install_dir}")
    print(f"记录文件: {_RECORDS_PATH}")
    print(f"路径文件: {_ROUTES_PATH}")
    print(f"服务地址: {url}")
    if not args.no_browser:
        threading.Timer(0.4, webbrowser.open, args=(url,)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
