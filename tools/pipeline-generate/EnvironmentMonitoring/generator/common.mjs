import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {readJsonc} from "../../jsonc.mjs";
import {dataDir} from "../../utils/paths.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ENVIRONMENT_MONITORING_DATA_PATH = resolve(dataDir, "environment_monitoring.json");
export const ROUTES_PATH = resolve(__dirname, "..", "routes.json");

// 与环境监测数据中的 names/shot_target_names locale 列表保持一致。
export const LOCALES = [
    "zh_cn",
    "zh_tw",
    "en_us",
    "ja_jp",
    "ko_kr",
];

export function readJson(path) {
    return readJsonc(path);
}

export function readEnvironmentMonitoringData() {
    return readJson(ENVIRONMENT_MONITORING_DATA_PATH);
}

export function buildMonitoringTerminalIds(environmentMonitoringData) {
    return Object.keys(environmentMonitoringData?.terminals || {})
        .filter((terminalId) => environmentMonitoringData.terminals[terminalId]?.missions?.length > 0)
        .sort();
}

export function collectMonitoringMissions(environmentMonitoringData) {
    const missions = [];
    const terminalIds = buildMonitoringTerminalIds(environmentMonitoringData);

    for (const terminalId of terminalIds) {
        const terminal = environmentMonitoringData.terminals[terminalId];
        for (const mission of terminal.missions || []) {
            if (mission?.mission_id && mission?.names?.zh_cn) {
                missions.push({
                    missionId: mission.mission_id,
                    entrustIdx: mission.entrust_index,
                    kiteStation: terminalId,
                    name: mission.names,
                    shotTargetName: mission.shot_target_names,
                    __terminalId: terminalId,
                });
            }
        }
    }

    return missions.sort((a, b) => {
        if (a.__terminalId !== b.__terminalId) {
            return a.__terminalId.localeCompare(b.__terminalId);
        }
        return (a.entrustIdx || 0) - (b.entrustIdx || 0);
    });
}

export function toPascalCase(str) {
    const cleaned = String(str || "")
        .replace(/[^a-zA-Z0-9]+/g, " ")
        .trim();
    if (!cleaned) {
        return "";
    }
    return cleaned
        .split(/\s+/)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("");
}

export function sanitizeDisplayName(name) {
    return String(name || "")
        .replace(/["“”'‘’「」『』《》【】（）()]/g, "")
        .trim();
}

export function buildDefaultId(mission) {
    const fromEnglish = toPascalCase(mission?.name?.en_us);
    if (fromEnglish) {
        return fromEnglish;
    }
    const fromMissionId = toPascalCase(mission?.missionId);
    if (fromMissionId) {
        return `Mission${fromMissionId}`;
    }
    return `Mission${mission?.entrustIdx || "Unknown"}`;
}

export function ensureUniqueId(baseId, usedIds, missionId) {
    // 优先用 missionId 作为冲突后缀，保证 ID 在不同任务间稳定可读。
    // 若仍然撞名（极少见，例如 missionId 也重复），再退化到自增序号兜底。
    if (!usedIds.has(baseId)) {
        usedIds.add(baseId);
        return baseId;
    }
    if (missionId) {
        const withMissionId = `${baseId}_${missionId}`;
        if (!usedIds.has(withMissionId)) {
            usedIds.add(withMissionId);
            return withMissionId;
        }
    }
    let seq = 2;
    let nextId = `${baseId}_${seq}`;
    while (usedIds.has(nextId)) {
        seq += 1;
        nextId = `${baseId}_${seq}`;
    }
    usedIds.add(nextId);
    return nextId;
}

export function buildGeneratedIdIndex(missions) {
    const usedIds = new Set();
    const idByMissionId = new Map();

    for (const mission of missions) {
        idByMissionId.set(mission.missionId, ensureUniqueId(buildDefaultId(mission), usedIds, mission.missionId));
    }

    return idByMissionId;
}

export function buildStationId(environmentMonitoringData, terminalId) {
    const enName = environmentMonitoringData?.terminals?.[terminalId]?.names?.en_us;
    return toPascalCase(enName || terminalId) || terminalId;
}

export function buildStationDisplayName(environmentMonitoringData, terminalId) {
    return environmentMonitoringData?.terminals?.[terminalId]?.names?.zh_cn || terminalId;
}

export function isFieldMissing(value) {
    // null / undefined / 空字符串 / 空数组均视为缺失。
    if (value === undefined || value === null) {
        return true;
    }
    if (typeof value === "string" && value.trim() === "") {
        return true;
    }
    if (Array.isArray(value) && value.length === 0) {
        return true;
    }
    return false;
}

// 与 cpp-algo planning/navmesh_cache.cpp 的 kBaseNavZoneAliases 镜像：
// 把区域标识落到 zipline_frames.json / 手工滑索路径使用的 base 区名。
const BASE_ZONE_ALIASES = [
    ["map01base", ["map01", "ValleyIV"]],
    ["map02base", ["map02", "Wuling"]],
    ["base01", ["base01", "OMVBase"]],
    ["dung01", ["dung01", "Dung"]],
    ["indie_dg005", ["indie_dg005", "IndieDg005"]],
    ["indie_dg007", ["indie_dg007", "IndieDg007"]],
    ["indie_dg016", ["indie_dg016", "IndieDg016"]],
];

export function baseZoneFor(zoneId) {
    const normalized = String(zoneId || "").trim();
    if (!normalized) {
        return "";
    }
    for (const [baseZone, prefixes] of BASE_ZONE_ALIASES) {
        if (normalized === baseZone || prefixes.some((prefix) => normalized.startsWith(prefix))) {
            return baseZone;
        }
    }
    return "";
}

// 取 NavPath 最后一个带坐标的路点。裸数组 [x, y] 也是普通路点（默认 RUN），
// 环境监测的手录路线经常以它结尾；target_tier 只影响坐标系，不影响这里取点。
export function lastNavPathPosition(path) {
    let last = null;
    for (const item of Array.isArray(path) ? path : []) {
        if (Array.isArray(item)) {
            const x = Number(item[0]);
            const y = Number(item[1]);
            if (item.length >= 2 && Number.isFinite(x) && Number.isFinite(y)) {
                last = {x, y, deckY: null, tier: ""};
            }
            continue;
        }
        if (!item || typeof item !== "object") {
            continue;
        }
        const target = Array.isArray(item.target) ? item.target : [];
        const x = Number(target[0]);
        const y = Number(target[1]);
        if (target.length < 2 || !Number.isFinite(x) || !Number.isFinite(y)) {
            continue;
        }
        last = {
            x,
            y,
            deckY: item.target_deck_y ?? null,
            tier: String(item.target_tier || "").trim(),
        };
    }
    return last;
}

export function routeZoneId(override, path) {
    const explicit = String(override?.NavZoneId || "").trim();
    if (explicit) {
        return explicit;
    }
    for (const item of Array.isArray(path) ? path : []) {
        if (!item || typeof item !== "object") {
            continue;
        }
        if (String(item.action || "").toUpperCase() !== "ZONE") {
            continue;
        }
        const zoneId = item.zone_id || item.zone;
        if (zoneId) {
            return String(zoneId);
        }
    }
    return "";
}
