"""按「地区-目标点」保存的滑索链。

cpp-algo 的 ``ZiplineRoutes`` 读取同一份 ``debug/record/ZiplineRoutes.json``：
规划区间终点与 ``goal`` 匹配、且手工链每根架子都能在当前账号的已通电记录里认回时，
运行时直接按这条链走，不再搜索；任何一步不成立都会退回原来的自动查找。

这里同时负责枚举可编辑的目标点，供 MapNavigator 页面使用：

- ``delivery``：AutoDelivery 的仓储节点与送货终点，直接读生成的滑索变体路线；
- ``environment_monitoring``：环境监测观察点，路线来自 ``routes.json`` 的 ``NavPath``。

两类目标点共用 ``(account_id, zone_name, goal)`` 这一把键，所以运行时不需要知道它们
来自哪个任务；环境监测额外需要一条「传送到离滑索起点最近的锚点」的入口，由页面在保存时
算好写进 ``entry``（可选字段，旧文件和旧版 cpp-algo 都会忽略）。
"""

from __future__ import annotations

import contextlib
import json
import math
import os
import re
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from json_import import load_jsonc

PROJECT_ROOT = Path(__file__).resolve().parents[2]
AUTODELIVERY_CATALOG = PROJECT_ROOT / "assets" / "data" / "AutoDelivery" / "catalog.json"
AUTODELIVERY_ROUTES = PROJECT_ROOT / "assets" / "resource" / "pipeline" / "AutoDelivery" / "Routes"
ENVIRONMENT_MONITORING_ROUTES = (
    PROJECT_ROOT / "tools" / "pipeline-generate" / "EnvironmentMonitoring" / "routes.json"
)
ZIPLINE_FRAMES = PROJECT_ROOT / "assets" / "data" / "MapNavigator" / "zipline_frames.json"
TELEPORT_NODE_DIR = PROJECT_ROOT / "assets" / "resource" / "pipeline"
TELEPORT_MANAGER_NODES = TELEPORT_NODE_DIR / "SceneManager" / "SceneTeleportAnchor.json"
TELEPORT_INTERFACE_NODES = TELEPORT_NODE_DIR / "Interface" / "SceneTeleportAnchor.json"

TARGET_KIND_DELIVERY = "delivery"
TARGET_KIND_ENVIRONMENT_MONITORING = "environment_monitoring"
TARGET_KIND_LABELS = {
    TARGET_KIND_DELIVERY: "送货",
    TARGET_KIND_ENVIRONMENT_MONITORING: "环境监测",
}
# 传送锚点数据按大区标注，滑索标定按 base 区；只映射有滑索数据的两个大区
REGION_BASE_ZONES = {
    "ValleyIV": "map01base",
    "Wuling": "map02base",
}

ROUTES_VERSION = 1
# 与 cpp-algo ZiplineRoutes 的 kGoalMatchWu 保持同一量级
GOAL_KEY_DECIMALS = 2
# 连续必经点相距不到这个值时视为同一次站位修正, 不再单列一段
TRIVIAL_LEG_DISTANCE = 20.0

# 与 cpp-algo planning/navmesh_cache.cpp 的 kBaseNavZoneAliases 镜像, 用于把路线里的 ZONE 落到 base 底图
BASE_ZONE_ALIASES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("map01base", ("map01", "ValleyIV")),
    ("map02base", ("map02", "Wuling")),
    ("base01", ("base01", "OMVBase")),
    ("dung01", ("dung01", "Dung")),
    ("indie_dg005", ("indie_dg005", "IndieDg005")),
    ("indie_dg007", ("indie_dg007", "IndieDg007")),
    ("indie_dg016", ("indie_dg016", "IndieDg016")),
)

_ROUTES_README = [
    "按 (account_id, zone_name, goal) 指定的手工滑索链；cpp-algo 只在该区间终点匹配时使用。",
    "goal 是 navmesh base 像素坐标；towers 是世界坐标，重新导入滑索记录后仍按世界坐标认架子。",
    "e_hops 与 towers 逐跳对应，true 表示这一跳的起点塔设置了自动终点；实际按 E 在上一段，第一条跳没有上一段，运行时忽略。",
    "entry 可选，是环境监测等任务在起飞前要执行的传送入口节点；旧文件没有该字段时按任务原有传送流程走。",
    "photo_goal / photo_deck_y / photo_heading 可选，是滑索下索后的自定义拍照点和朝向；原 goal 仍用于匹配，运行时只替换滑索分支的终点/朝向并去掉原途经点。",
    "手工链里的架子未通电、已删除、某跳走不通或本轮已失败过时，运行时会退回自动查找。",
]


@dataclass(frozen=True)
class ZiplineTarget:
    """一个可编辑目标点的一条滑索规划区间。"""

    id: str
    kind: str
    label: str
    area: str
    destinations: tuple[str, ...]
    route_node: str
    zone_id: str
    zone_name: str
    goal: tuple[float, float]
    goal_deck_y: float | None
    leg_index: int
    leg_count: int
    # 原路线写死的拍照朝向; 自定义拍照点时可用来显示/作为自动朝向的兜底.
    heading: float | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "label": self.label,
            "area": self.area,
            "destinations": list(self.destinations),
            "route_node": self.route_node,
            "zone_id": self.zone_id,
            "zone_name": self.zone_name,
            "goal": list(self.goal),
            "goal_deck_y": self.goal_deck_y,
            "leg_index": self.leg_index,
            "leg_count": self.leg_count,
            "heading": self.heading,
        }


# 旧名字保留给既有调用方与测试
DeliveryLegTarget = ZiplineTarget


@dataclass(frozen=True)
class ZiplineTowerMark:
    level_id: str
    template_id: str
    x: float
    y: float
    z: float

    def as_dict(self) -> dict[str, Any]:
        return {
            "level_id": self.level_id,
            "template_id": self.template_id,
            "x": self.x,
            "y": self.y,
            "z": self.z,
        }


@dataclass(frozen=True)
class SavedZiplineRoute:
    account_id: str
    zone_name: str
    label: str
    goal: tuple[float, float]
    goal_deck_y: float | None
    towers: tuple[ZiplineTowerMark, ...]
    # 与 towers 逐跳对应; True 表示这一跳的起点塔设置了自动终点.
    # 实际按 E 发生在进入该起点塔的上一段; 第一条跳没有上一段, 运行时忽略.
    e_hops: tuple[bool, ...] = ()
    # 可选: 起飞前要执行的传送入口节点. 环境监测用它去离滑索起点最近的锚点;
    # 送货任务沿用 AutoDelivery 自己的快捷传送, 一般留空.
    entry: str = ""
    # 可选: 下索后的自定义拍照点. 设置后运行时替换 zip_move 的终点/朝向并去掉途经点;
    # 原 goal 仍是匹配键.
    photo_goal: tuple[float, float] | None = None
    photo_deck_y: float | None = None
    photo_heading: float | None = None

    def as_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "account_id": self.account_id,
            "zone_name": self.zone_name,
            "label": self.label,
            "goal": list(self.goal),
            "goal_deck_y": self.goal_deck_y,
            "towers": [tower.as_dict() for tower in self.towers],
            "e_hops": list(self.e_hops),
        }
        if self.entry:
            payload["entry"] = self.entry
        if self.photo_goal is not None:
            payload["photo_goal"] = list(self.photo_goal)
            if self.photo_deck_y is not None:
                payload["photo_deck_y"] = self.photo_deck_y
            if self.photo_heading is not None:
                payload["photo_heading"] = self.photo_heading
        return payload


def base_zone_for(zone_id: str) -> str:
    """把任意区域标识映射到 zipline_frames.json 的 base 区名。"""
    normalized = str(zone_id or "").strip()
    if not normalized:
        return ""
    for base_zone, prefixes in BASE_ZONE_ALIASES:
        if normalized == base_zone or any(normalized.startswith(prefix) for prefix in prefixes):
            return base_zone
    return ""


def build_delivery_targets(
    catalog_path: Path = AUTODELIVERY_CATALOG,
    routes_dir: Path = AUTODELIVERY_ROUTES,
    frames_path: Path = ZIPLINE_FRAMES,
) -> list[ZiplineTarget]:
    """列出所有带滑索变体的 AutoDelivery 目标点（仓储节点 + 送货终点），按终点去重。"""
    zone_names = _frame_zone_names(frames_path)
    if not zone_names:
        return []
    catalog = load_jsonc(catalog_path)
    if not isinstance(catalog, dict):
        return []
    nodes = _load_route_nodes(routes_dir)

    merged: dict[tuple[str, float, float], dict[str, Any]] = {}
    for source, name_part, area in _iter_delivery_sources(catalog):
        node_name = str(source.get("zip_route_node") or "")
        node = nodes.get(node_name)
        if node is None:
            continue
        param = node.get("custom_action_param")
        if not isinstance(param, dict) or param.get("zip") is not True:
            continue
        path = param.get("path")
        if not isinstance(path, list):
            continue
        zone_id = _first_zone_id(path)
        zone_name = base_zone_for(zone_id)
        if not zone_name or zone_name not in zone_names:
            continue
        legs = _legs_of_route(path)
        if not legs:
            continue
        for leg_index, (goal_x, goal_y, goal_deck_y) in enumerate(legs, start=1):
            key = (zone_name, round(goal_x, GOAL_KEY_DECIMALS), round(goal_y, GOAL_KEY_DECIMALS))
            entry = merged.get(key)
            if entry is None:
                entry = {
                    "zone_id": zone_id,
                    "zone_name": zone_name,
                    "route_node": node_name,
                    "goal": (goal_x, goal_y),
                    "goal_deck_y": goal_deck_y,
                    "areas": [],
                    "destinations": [],
                    "leg_index": leg_index,
                    "leg_count": len(legs),
                }
                merged[key] = entry
            _append_unique(entry["areas"], area)
            _append_unique(entry["destinations"], name_part)
            entry["leg_count"] = max(int(entry["leg_count"]), len(legs))
            if goal_deck_y is not None and entry["goal_deck_y"] is None:
                entry["goal_deck_y"] = goal_deck_y

    targets: list[ZiplineTarget] = []
    for entry in merged.values():
        area = " / ".join(entry["areas"]) or "未分区"
        destinations = " / ".join(entry["destinations"]) or "未命名目标点"
        leg_count = int(entry["leg_count"])
        label = f"{area} · {destinations}"
        if leg_count > 1:
            label += f"（第 {entry['leg_index']}/{leg_count} 段）"
        goal_x, goal_y = entry["goal"]
        targets.append(
            ZiplineTarget(
                id=f"{TARGET_KIND_DELIVERY}|{entry['zone_name']}|{goal_x:.3f}|{goal_y:.3f}",
                kind=TARGET_KIND_DELIVERY,
                label=label,
                area=area,
                destinations=tuple(entry["destinations"]),
                route_node=str(entry["route_node"]),
                zone_id=str(entry["zone_id"]),
                zone_name=str(entry["zone_name"]),
                goal=(round(float(goal_x), 3), round(float(goal_y), 3)),
                goal_deck_y=entry["goal_deck_y"],
                leg_index=int(entry["leg_index"]),
                leg_count=leg_count,
            )
        )
    targets.sort(key=lambda target: (target.area, target.destinations, target.leg_index, target.goal))
    return targets


def build_environment_monitoring_targets(
    routes_path: Path = ENVIRONMENT_MONITORING_ROUTES,
    frames_path: Path = ZIPLINE_FRAMES,
) -> list[ZiplineTarget]:
    """列出环境监测观察点的寻路终点；传送后直拍的观察点没有终点，不参与编辑。"""
    zone_names = _frame_zone_names(frames_path)
    if not zone_names or not Path(routes_path).is_file():
        return []
    entries = load_jsonc(routes_path)
    if not isinstance(entries, list):
        return []

    targets: list[ZiplineTarget] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        path = entry.get("NavPath")
        if not isinstance(path, list) or not path:
            continue
        mission_id = str(entry.get("MissionId") or "").strip()
        name = str(entry.get("Name") or "").strip()
        if not mission_id or not name:
            continue
        zone_id = str(entry.get("NavZoneId") or _first_zone_id(path)).strip()
        zone_name = base_zone_for(zone_id)
        if not zone_name or zone_name not in zone_names:
            continue
        # tier 局部坐标要在运行时投影到 base 才成为区间终点，编辑器没有投影数据，
        # 列出来只会存成一条永远匹配不上的路径。
        if _ends_in_tier_coordinates(path):
            continue
        legs = _legs_of_route(path)
        heading = _optional_number(entry.get("Heading"))
        for leg_index, (goal_x, goal_y, goal_deck_y) in enumerate(legs, start=1):
            targets.append(
                ZiplineTarget(
                    id=f"{TARGET_KIND_ENVIRONMENT_MONITORING}|{mission_id}|{leg_index}",
                    kind=TARGET_KIND_ENVIRONMENT_MONITORING,
                    label=name,
                    area=TARGET_KIND_LABELS[TARGET_KIND_ENVIRONMENT_MONITORING],
                    destinations=(name,),
                    route_node="",
                    zone_id=zone_id,
                    zone_name=zone_name,
                    goal=(round(float(goal_x), 3), round(float(goal_y), 3)),
                    goal_deck_y=goal_deck_y,
                    leg_index=leg_index,
                    leg_count=len(legs),
                    heading=heading if leg_index == len(legs) else None,
                )
            )
    targets.sort(key=lambda target: (target.area, target.label, target.leg_index, target.goal))
    return targets


def build_targets(
    catalog_path: Path = AUTODELIVERY_CATALOG,
    routes_dir: Path = AUTODELIVERY_ROUTES,
    frames_path: Path = ZIPLINE_FRAMES,
    environment_routes_path: Path = ENVIRONMENT_MONITORING_ROUTES,
) -> list[ZiplineTarget]:
    """两类可编辑目标点：送货（仓储节点 + 终点）与环境监测观察点。"""
    delivery = build_delivery_targets(catalog_path, routes_dir, frames_path)
    environment = build_environment_monitoring_targets(environment_routes_path, frames_path)
    return [*delivery, *environment]


def build_teleport_entries(
    manager_path: Path = TELEPORT_MANAGER_NODES,
    interface_path: Path = TELEPORT_INTERFACE_NODES,
) -> list[dict[str, Any]]:
    """列出可在 Pipeline 里直接调用的大地图传送锚点及其 base 像素坐标。

    环境监测需要「传送到离滑索起点最近的锚点」，页面按这些坐标挑最近的一个，
    并把它的入口节点名写进手工链的 ``entry``。
    """
    if not Path(manager_path).is_file() or not Path(interface_path).is_file():
        return []
    manager = load_jsonc(manager_path)
    interface = load_jsonc(interface_path)
    if not isinstance(manager, dict) or not isinstance(interface, dict):
        return []

    private: dict[str, dict[str, Any]] = {}
    for node_name, node in manager.items():
        if not isinstance(node, dict):
            continue
        param = node.get("custom_recognition_param")
        if not isinstance(param, dict):
            continue
        zone = str(param.get("zone") or "").strip()
        base_zone = REGION_BASE_ZONES.get(zone)
        at = param.get("at")
        if not base_zone or not isinstance(at, list) or len(at) != 2:
            continue
        x = _optional_number(at[0])
        y = _optional_number(at[1])
        if x is None or y is None:
            continue
        private[str(node_name)] = {
            "zone": zone,
            "base_zone": base_zone,
            "at": [round(x, 2), round(y, 2)],
            "label": _teleport_label(node),
        }

    entries: list[dict[str, Any]] = []
    for node_name, node in interface.items():
        if not isinstance(node, dict) or not str(node_name).startswith("SceneEnterWorld"):
            continue
        anchor = node.get("anchor")
        if not isinstance(anchor, dict):
            continue
        info = private.get(str(anchor.get("__ScenePrivateMapTeleportPickAnchor") or ""))
        if info is None:
            continue
        entries.append({"node": str(node_name), **info})
    entries.sort(key=lambda item: (item["base_zone"], item["label"], item["node"]))
    return entries


def _iter_delivery_sources(catalog: dict[str, Any]) -> list[tuple[dict[str, Any], str, str]]:
    """把仓储节点与送货终点摊平成 (来源, 名称片段, 地区) 列表。

    ``walk_only`` 的条目即使有 ``zip_route_node``，运行时分发时也只会走步行节点，
    在这里排除，免得保存出一条永远不会被采用的滑索链。
    """
    sources: list[tuple[dict[str, Any], str, str]] = []
    depots = catalog.get("depots")
    if isinstance(depots, list):
        for depot in depots:
            if not isinstance(depot, dict) or depot.get("walk_only") is True:
                continue
            area = _localized(depot.get("name"))
            sources.append((depot, "仓储节点", area))
    destinations = catalog.get("destinations")
    if isinstance(destinations, list):
        for destination in destinations:
            if not isinstance(destination, dict) or destination.get("walk_only") is True:
                continue
            sources.append((destination, _localized(destination.get("name")), _localized(destination.get("area"))))
    return sources


def normalize_saved_route(payload: Any) -> SavedZiplineRoute:
    """校验并归一化前端提交的一条手工链。"""
    if not isinstance(payload, dict):
        raise ValueError("保存内容必须是 JSON 对象")
    account_id = _text(payload.get("account_id"), "account_id")
    zone_name = _text(payload.get("zone_name"), "zone_name")
    label = str(payload.get("label") or "").strip()
    goal = _goal(payload.get("goal"))
    goal_deck_y = _optional_number(payload.get("goal_deck_y"))
    raw_towers = payload.get("towers")
    if not isinstance(raw_towers, list) or len(raw_towers) < 2:
        raise ValueError("滑索路径至少需要两座滑索架")
    towers: list[ZiplineTowerMark] = []
    for index, raw in enumerate(raw_towers):
        if not isinstance(raw, dict):
            raise ValueError(f"第 {index + 1} 座滑索架不是 JSON 对象")
        level_id = str(raw.get("level_id") or "").strip()
        if not level_id:
            raise ValueError(f"第 {index + 1} 座滑索架缺少 level_id")
        towers.append(
            ZiplineTowerMark(
                level_id=level_id,
                template_id=str(raw.get("template_id") or "").strip(),
                x=_number(raw.get("x"), f"第 {index + 1} 座滑索架的 x"),
                y=_number(raw.get("y"), f"第 {index + 1} 座滑索架的 y"),
                z=_number(raw.get("z"), f"第 {index + 1} 座滑索架的 z"),
            )
        )
    raw_e_hops = payload.get("e_hops")
    e_hops: list[bool] = []
    if isinstance(raw_e_hops, list):
        e_hops = [value is True for value in raw_e_hops[: len(towers) - 1]]
    e_hops.extend([False] * (len(towers) - 1 - len(e_hops)))
    photo_goal: tuple[float, float] | None = None
    raw_photo_goal = payload.get("photo_goal")
    if raw_photo_goal is not None:
        xy = _xy(raw_photo_goal)
        if xy is None:
            raise ValueError("photo_goal 必须是 [x, y]")
        photo_goal = (round(xy[0], 3), round(xy[1], 3))
    photo_heading = _optional_number(payload.get("photo_heading"))
    if photo_heading is not None:
        photo_heading %= 360.0
    return SavedZiplineRoute(
        account_id=account_id,
        zone_name=zone_name,
        label=label,
        goal=goal,
        goal_deck_y=goal_deck_y,
        towers=tuple(towers),
        e_hops=tuple(e_hops),
        entry=str(payload.get("entry") or "").strip(),
        photo_goal=photo_goal,
        photo_deck_y=_optional_number(payload.get("photo_deck_y")),
        photo_heading=photo_heading,
    )


def load_saved_routes(path: Path) -> list[SavedZiplineRoute]:
    """读取手工链；文件不存在视为空。单条坏记录跳过，根结构坏掉时抛 ValueError。"""
    if not path.is_file():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("routes"), list):
        raise ValueError("ZiplineRoutes.json 根结构必须是带 routes 数组的对象")
    routes: list[SavedZiplineRoute] = []
    for raw in payload["routes"]:
        try:
            routes.append(normalize_saved_route(raw))
        except (TypeError, ValueError):
            continue
    return routes


def save_saved_route(path: Path, route: SavedZiplineRoute) -> list[SavedZiplineRoute]:
    """按 (账号, 区, 终点) 覆盖或追加一条手工链，原子落盘后返回最新列表。"""
    key = route_key(route)
    updated = [existing for existing in load_saved_routes(path) if route_key(existing) != key]
    updated.append(route)
    _write_routes(path, updated)
    return updated


def delete_saved_route(
    path: Path,
    account_id: str,
    zone_name: str,
    goal_x: float,
    goal_y: float,
) -> list[SavedZiplineRoute]:
    """按 (账号, 区, 终点) 删除一条手工链。"""
    key = (account_id, zone_name, round(float(goal_x), GOAL_KEY_DECIMALS), round(float(goal_y), GOAL_KEY_DECIMALS))
    routes = [route for route in load_saved_routes(path) if route_key(route) != key]
    _write_routes(path, routes)
    return routes


def route_key(route: SavedZiplineRoute) -> tuple[str, str, float, float]:
    return (
        route.account_id,
        route.zone_name,
        round(route.goal[0], GOAL_KEY_DECIMALS),
        round(route.goal[1], GOAL_KEY_DECIMALS),
    )


def _write_routes(path: Path, routes: list[SavedZiplineRoute]) -> None:
    payload = {
        "_readme": _ROUTES_README,
        "version": ROUTES_VERSION,
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "routes": [route.as_dict() for route in routes],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(prefix=f"{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=4)
            stream.write("\n")
        os.replace(temp_name, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(temp_name)
        raise


def _frame_zone_names(frames_path: Path) -> set[str]:
    if not frames_path.is_file():
        return set()
    frames = load_jsonc(frames_path)
    if not isinstance(frames, dict):
        return set()
    names: set[str] = set()
    entries = frames.get("frames")
    if not isinstance(entries, list):
        return names
    for frame in entries:
        if isinstance(frame, dict):
            name = str(frame.get("zone_name") or "").strip()
            if name:
                names.add(name)
    return names


def _load_route_nodes(routes_dir: Path) -> dict[str, dict[str, Any]]:
    nodes: dict[str, dict[str, Any]] = {}
    if not routes_dir.is_dir():
        return nodes
    for file_path in sorted(routes_dir.glob("*.json")):
        try:
            data = load_jsonc(file_path)
        except (OSError, ValueError):
            # 工具允许在生成器/编辑器写文件的过程中打开；坏文件只跳过自己
            continue
        if not isinstance(data, dict):
            continue
        for node_name, node in data.items():
            if isinstance(node, dict):
                nodes[str(node_name)] = node
    return nodes


def _first_zone_id(path: list[Any]) -> str:
    for item in path:
        if not isinstance(item, dict):
            continue
        if str(item.get("action") or "").strip().upper() != "ZONE":
            continue
        zone_id = item.get("zone_id") or item.get("zone")
        if zone_id:
            return str(zone_id)
    return ""


def _legs_of_route(path: list[Any]) -> list[tuple[float, float, float | None]]:
    """返回这条路线会被滑索替换的区间终点。

    运行时在每个 ``required`` 路点或路线末点结束一个规划区间，区间终点取该区间
    最后一个有坐标的路点；这里按同样规则取终点，并把相距不到
    ``TRIVIAL_LEG_DISTANCE`` 的站位修正合并掉。
    """
    required: list[tuple[float, float, float | None]] = []
    last_position: tuple[float, float, float | None] | None = None
    for item in path:
        leg = _position_of(item)
        if leg is None:
            continue
        last_position = leg
        if isinstance(item, dict) and item.get("required") is True:
            required.append(leg)
    if not required:
        return [last_position] if last_position is not None else []

    legs: list[tuple[float, float, float | None]] = []
    for leg in required:
        if legs:
            previous = legs[-1]
            if math.hypot(leg[0] - previous[0], leg[1] - previous[1]) < TRIVIAL_LEG_DISTANCE:
                continue
        legs.append(leg)
    return legs


def _ends_in_tier_coordinates(path: list[Any]) -> bool:
    """路线的区间终点是否写在 tier 局部坐标里。

    运行时会把带 ``target_tier`` 的点投影到 base 再当终点；编辑器没有投影数据，
    这类观察点列出来也只会存成一条永远匹配不上的手工链，直接跳过。
    """
    last: Any = None
    for item in path:
        if _position_of(item) is not None:
            last = item
    if not isinstance(last, dict):
        return False
    return bool(str(last.get("target_tier") or "").strip())


def _position_of(item: Any) -> tuple[float, float, float | None] | None:
    """取一个路点的坐标。

    对象路点读 ``target`` 与 ``target_deck_y``；裸数组 ``[x, y]`` 也是导航的普通
    路点（默认 RUN），环境监测的手录路线经常以它结尾，不认就会漏掉终点。
    """
    if isinstance(item, (list, tuple)):
        target = _xy(item[:2]) if len(item) >= 2 else None
        if target is None:
            return None
        return (target[0], target[1], None)
    if isinstance(item, dict):
        target = _xy(item.get("target"))
        if target is None:
            return None
        return (target[0], target[1], _optional_number(item.get("target_deck_y")))
    return None


def _teleport_label(node: dict[str, Any]) -> str:
    """从「在地图界面找锚点 (景玉谷-生态实验站)」这类 desc 里取出地名。"""
    desc = str(node.get("desc") or "").strip()
    match = re.search(r"[（(]([^（）()]*)[）)]\s*$", desc)
    if match:
        return match.group(1).strip()
    return desc


def _localized(value: Any, language: str = "zh_cn") -> str:
    if not isinstance(value, dict):
        return ""
    text = value.get(language) or value.get("en_us")
    return str(text or "").strip()


def _append_unique(values: list[str], value: str) -> None:
    if value and value not in values:
        values.append(value)


def _text(value: Any, name: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{name} 不能为空")
    return text


def _goal(value: Any) -> tuple[float, float]:
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        raise ValueError("goal 必须是 [x, y]")
    return (round(_number(value[0], "goal[0]"), 3), round(_number(value[1], "goal[1]"), 3))


def _number(value: Any, name: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} 必须是数字") from exc
    if not math.isfinite(number):
        raise ValueError(f"{name} 必须是有限数字")
    return number


def _optional_number(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _xy(value: Any) -> tuple[float, float] | None:
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    x = _optional_number(value[0])
    y = _optional_number(value[1])
    if x is None or y is None:
        return None
    return (x, y)
