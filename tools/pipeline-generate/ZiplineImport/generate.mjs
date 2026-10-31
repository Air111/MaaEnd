import {writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {format, resolveConfig} from "prettier";

import {readJsonc} from "../jsonc.mjs";
import {repoRoot} from "../utils/paths.mjs";

const taskPath = resolve(repoRoot, "assets", "tasks", "ZiplineImport.json");
const locales = [
    "zh_cn",
    "zh_tw",
    "en_us",
    "ja_jp",
    "ko_kr",
];

// 大地区只决定角色实际的 map_id；显示名和地区集合来自 region3d，子地区来自 teleport_anchors。
// 新增大地区时在这里补一个 map_id -> 全局地区 key 的映射，生成器会给出明确的缺失提示。
const regionKeys = {
    map01: "ValleyIV",
    map02: "Wuling",
};

const region3d = readJsonc(resolve(repoRoot, "tools/zmdmap/data/region3d.json"));
const teleport = readJsonc(resolve(repoRoot, "tools/zmdmap/data/teleport_anchors.json"));
const translations = Object.fromEntries(
    locales.map((locale) => [
        locale,
        readJsonc(resolve(repoRoot, "assets/locales/interface", `${locale}.json`)),
    ]),
);

function hasLocaleKey(key) {
    return locales.every((locale) => typeof translations[locale][key] === "string" && translations[locale][key].trim());
}

function caseName(names, levelId) {
    if (typeof names?.en_us !== "string" || !names.en_us.trim()) {
        throw new Error(`${levelId}: missing en_us name`);
    }
    const name = names.en_us
        .replace(/['’]/g, "")
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map((part) => part[0].toUpperCase() + part.slice(1))
        .join("");
    if (!name) throw new Error(`${levelId}: cannot derive a case name from en_us`);
    return name;
}

function buildRegions() {
    const regions = [];
    for (const [
        regionId,
        data,
    ] of Object.entries(region3d)) {
        if (!/^region\d+$/.test(regionId) || !data || typeof data !== "object" || !data.area) {
            continue;
        }
        const mapIds = [
            ...new Set(
                Object.keys(data.area)
                    .map((levelId) => levelId.split("_")[0])
                    .filter((mapId) => /^map\d+$/.test(mapId)),
            ),
        ];
        if (mapIds.length !== 1) {
            throw new Error(`[ZiplineImport] ${regionId} 必须且只能对应一个 map_id，实际为 ${mapIds.join(",")}`);
        }
        const mapId = mapIds[0];
        const regionKey = regionKeys[mapId];
        if (!regionKey) {
            throw new Error(`[ZiplineImport] ${mapId} 没有大地区显示名映射，请在 generate.mjs 的 regionKeys 中补充`);
        }
        const labelKey = `global.region.${regionKey}`;
        if (!hasLocaleKey(labelKey)) {
            throw new Error(`[ZiplineImport] ${mapId} 缺少 locale key ${labelKey}`);
        }

        const subregions = [];
        const seen = new Set();
        for (const levelId of Object.keys(data.area)) {
            if (!levelId.startsWith(`${mapId}_`) || !teleport.levels?.[levelId]) {
                continue;
            }
            const name = caseName(teleport.levels[levelId].names, levelId);
            if (seen.has(name)) {
                throw new Error(`[ZiplineImport] ${mapId} 有重复的子地区 case ${name}`);
            }
            seen.add(name);
            const subregionLabel = `global.region.${name}`;
            if (!hasLocaleKey(subregionLabel)) {
                throw new Error(`[ZiplineImport] ${levelId} 缺少 locale key ${subregionLabel}`);
            }
            subregions.push({
                name,
                label: `$${subregionLabel}`,
                flag: `include_${levelId}`,
                levelId,
            });
        }

        if (subregions.length === 0) {
            throw new Error(`[ZiplineImport] ${regionId}/${mapId} 没有可用的子地区`);
        }
        regions.push({
            regionId,
            mapId,
            regionKey,
            name: data.name,
            label: `$${labelKey}`,
            subregions,
        });
    }
    if (regions.length === 0) {
        throw new Error("[ZiplineImport] region3d 没有可用的大地区");
    }
    return regions;
}

function buildTask(regions) {
    const options = {
        ZiplineImportClearLogin: {
            type: "switch",
            controller: [
                "Win32-Front",
                "ADB",
                "PlayCover",
            ],
            label: "$option.ZiplineImportClearLogin.label",
            cases: [
                {
                    name: "Yes",
                    pipeline_override: {
                        ZiplineImportMain: {
                            attach: {
                                clear_login: true,
                            },
                        },
                    },
                },
                {
                    name: "No",
                },
            ],
            default_case: "No",
        },
    };
    const taskOptions = ["ZiplineImportClearLogin"];

    for (const region of regions) {
        const switchName = `ZiplineImport${region.regionKey}`;
        const subregionsName = `${switchName}Regions`;
        taskOptions.push(switchName);
        options[switchName] = {
            type: "switch",
            label: region.label,
            cases: [
                {
                    name: "Yes",
                    pipeline_override: {
                        ZiplineImportMain: {
                            attach: {
                                [`include_${region.mapId}`]: true,
                            },
                        },
                    },
                },
                {
                    name: "No",
                    option: [subregionsName],
                    pipeline_override: {
                        ZiplineImportMain: {
                            attach: {
                                [`include_${region.mapId}`]: false,
                            },
                        },
                    },
                },
            ],
            default_case: "Yes",
        };
        options[subregionsName] = {
            type: "checkbox",
            label: "$option.ZiplineImportRegions.label",
            cases: region.subregions.map((subregion) => ({
                name: subregion.name,
                label: subregion.label,
                pipeline_override: {
                    ZiplineImportMain: {
                        attach: {
                            [subregion.flag]: true,
                        },
                    },
                },
            })),
        };
    }

    return {
        task: [
            {
                name: "ZiplineImport",
                label: "$task.ZiplineImport.label",
                entry: "ZiplineImportMain",
                description: "$task.ZiplineImport.description",
                group: ["open_world"],
                controller: [
                    "Linux-Gamescope",
                    "Linux-ScreenCast",
                    "Linux-Wlroots",
                    "Win32-Front",
                    "ADB",
                    "PlayCover",
                ],
                option: taskOptions,
            },
        ],
        option: options,
    };
}

async function generate() {
    const regions = buildRegions();
    const task = buildTask(regions);
    const config = await resolveConfig(resolve(repoRoot, ".prettierrc.mjs"));
    const text = await format(`${JSON.stringify(task, null, 4)}\n`, {
        ...config,
        filepath: taskPath,
        parser: "json",
        endOfLine: "lf",
    });
    writeFileSync(taskPath, text, "utf8");
    console.log(
        `[ZiplineImport] Wrote ${regions.length} large regions, ${regions.reduce((total, region) => total + region.subregions.length, 0)} subregions`,
    );
    for (const region of regions) {
        console.log(
            `  ${region.mapId} ${region.name}: ${region.subregions.map((subregion) => subregion.name).join(", ")}`,
        );
    }
}

await generate();
