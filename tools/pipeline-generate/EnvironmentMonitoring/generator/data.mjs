import {LOCALES, baseZoneFor, lastNavPathPosition, routeZoneId} from "./common.mjs";
import {monitoringMissions} from "./model.mjs";

export {environmentMonitoringData, MONITORING_TERMINAL_IDS} from "./model.mjs";

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toFlexibleEnglishRegex(text) {
    const escaped = escapeRegex(text.trim());
    return `(?i)${escaped.replace(/\s+/g, "\\s*").replace(/-/g, "\\s*-\\s*")}`;
}

// 移动端 OCR 对拍照任务标题里的引号识别不稳定：可能认成别的字符，也可能整个丢掉。
// 把引号放宽成「任意单字符、可缺省」，落在末尾的那一个直接去掉（后面没有内容可对齐）。
// 英文已经过 escapeRegex，但它不转义引号，所以各语言的引号都按原字符匹配。
const UNSTABLE_QUOTE_PATTERN = /["'“”‘’「」『』]/g;

function toQuoteTolerantExpected(expected) {
    return expected.replace(UNSTABLE_QUOTE_PATTERN, ".?").replace(/\.\?$/, "");
}

function buildExpectedFromLocaleMap(localeMap, {looseQuotes = false} = {}) {
    return LOCALES.map((locale) => {
        const value = localeMap?.[locale];
        if (!value) {
            return null;
        }
        const expected = locale === "en_us" ? toFlexibleEnglishRegex(value) : value;
        return looseQuotes ? toQuoteTolerantExpected(expected) : expected;
    }).filter(Boolean);
}

function rawJson(value) {
    return {
        value,
        raw: JSON.stringify(value, null, 4),
    };
}

function buildGoToMonitoringTerminal(station) {
    // Locations.json 中节点统一遵循 EnvironmentMonitoringGoTo{Station} 命名，新终端在 Locations.json 手写补齐。
    return `EnvironmentMonitoringGoTo${station}`;
}

// 滑索分支只在「有 base 像素终点、且编辑器能录到同一条 goal」的寻路观察点上生成。
// 终点写在 target_tier 里的观察点编辑器换算不出 base 终点，保存的路径永远对不上，
// 因此和其它未适配情况一样不生成分支。
function buildZiplineParams(route, Id) {
    const path = Array.isArray(route?.override?.NavPath) ? route.override.NavPath : [];
    const position = lastNavPathPosition(path);
    const zoneName = baseZoneFor(routeZoneId(route?.override, path));
    const usable =
        Boolean(route?.isAdapted) && !route?.IsDirectPhoto && position !== null && position.tier === "" && zoneName !== "";
    const deckY =
        position?.deckY !== null && position?.deckY !== undefined && Number.isFinite(Number(position.deckY))
            ? Number(position.deckY)
            : null;
    const base = {
        zone_name: zoneName || "map02base",
        goal: position ? [position.x, position.y] : [0, 0],
        ...(deckY !== null ? {goal_deck_y: deckY} : {}),
        zip_move: `${Id}MoveWithZipline`,
    };
    return {
        usable,
        // fallback 是没有保存路径时执行的原有传送流程入口。
        param: (fallback) => rawJson({...base, fallback}),
    };
}

export function buildRow(mission) {
    const {Station, Id, Name, LocalizedName, ShotTargetName, route} = mission;
    const GoToMonitoringTerminal = buildGoToMonitoringTerminal(Station);

    // 游戏内未追踪时无法完成任务，已适配点也要先走追踪确认。
    const TrackOrGoToNext = [
        `Track${Id}`,
        `AlreadyTracked${Id}`,
    ];
    const defaultAfterTrackedNext = route.isAdapted ? [`GoTo${Id}`] : [`${Id}NotAdapted`];
    const legacyAfterTrackNext =
        route.isAdapted && route.QuickTeleport ? [`${Id}InQuickTeleportMap`] : defaultAfterTrackedNext;
    const legacyAfterAlreadyTrackedNext =
        route.isAdapted && route.QuickTeleport ? [`${Id}OpenTrackedMissionMap`] : defaultAfterTrackedNext;
    // 有保存的手工滑索链时，先由 ZiplineRouteGoAction 决定传送入口，再走允许滑索的移动节点；
    // 没有保存路径时仍然执行这里的原有传送流程。
    const zipline = buildZiplineParams(route, Id);
    const afterTrackNext = zipline.usable
        ? [route.QuickTeleport ? `${Id}GoTargetAfterTrack` : `${Id}GoTarget`]
        : legacyAfterTrackNext;
    const afterAlreadyTrackedNext = zipline.usable
        ? [route.QuickTeleport ? `${Id}GoTargetAfterTracked` : `${Id}GoTarget`]
        : legacyAfterAlreadyTrackedNext;
    // 传送点可直接拍照时不需要位置断言：统一先进入大世界，再无条件执行真实传送。
    const GoToNext =
        route.IsDirectPhoto && !route.QuickTeleport
            ? [`GoTo${Id}NotAtStartPos`]
            : [
                  `GoTo${Id}StartPos`,
                  `GoTo${Id}NotAtStartPos`,
              ];
    // NavMesh 可处理传送点附近落点，快捷传送的手录路径也可从固定落点开始；未适配条目才需复核起点。
    const AfterTeleportDescription = route.IsDirectPhoto
        ? route.HasHeading
            ? "传送后调整朝向并拍照"
            : "传送后直接拍照"
        : route.ShouldAssertAfterTeleport
          ? "先传送再检查落点"
          : "先传送再继续寻路";
    const legacyAfterTeleportNext = route.IsDirectPhoto
        ? [route.HasHeading ? `GoTo${Id}Move` : `${Id}TakePhoto`]
        : route.ShouldAssertAfterTeleport
          ? [`GoTo${Id}StartPos`]
          : [`GoTo${Id}Move`];
    // 生成滑索分支时，原传送流程（含 EnterMap 的起点断言）只负责把角色送到地面，
    // 移动统一交给 GoTarget 动作后面的两个移动节点决定。
    const AfterTeleportNext = zipline.usable ? [`${Id}TeleportDone`] : legacyAfterTeleportNext;
    const StartPosNext = zipline.usable ? [`${Id}TeleportDone`] : [`GoTo${Id}Move`];
    const GoToNotAtStartPosDescription = route.IsDirectPhoto
        ? `前往${Name}传送点，${AfterTeleportDescription}`
        : `不在${Name}任务开始位置附近，${AfterTeleportDescription}`;
    const MoveDescription = route.IsDirectPhoto ? `在${Name}传送点调整拍照朝向` : `自动寻路前往${Name}`;
    // 沿途稳定遇敌的线路先清场，再沿独立归位路线返回拍照点。
    // AutoFight 自带进战识别，没打起来时直接落到归位节点。
    const MoveNext = route.FightAfterMove
        ? [
              "[JumpBack]AutoFight",
              `GoTo${Id}MoveAfterFight`,
          ]
        : [
              `${Id}TakePhoto`,
          ];

    return {
        Station,
        Id,
        Name,
        FailureKey: `task.EnvironmentMonitoring.route.${Id}.failed`,
        GoToMonitoringTerminal,
        EnterMap: route.EnterMap,
        MapAssertRecognition: route.MapAssertRecognition,
        MapAssertParam: rawJson(route.MapAssertParam),
        ExpectedText: buildExpectedFromLocaleMap(LocalizedName),
        InExpectedText: buildExpectedFromLocaleMap(ShotTargetName, {looseQuotes: true}),
        OcrReplace: rawJson(route.Replace),
        TrackOrGoToNext: rawJson(TrackOrGoToNext),
        AfterTrackNext: rawJson(afterTrackNext),
        AfterAlreadyTrackedNext: rawJson(afterAlreadyTrackedNext),
        GoToNext: rawJson(GoToNext),
        GoToNotAtStartPosDescription,
        MoveDescription,
        MoveNext: rawJson(MoveNext),
        AfterTeleportDescription,
        AfterTeleportNext: rawJson(AfterTeleportNext),
        StartPosNext: rawJson(StartPosNext),
        RouteAction: route.RouteAction,
        RouteActionParam: rawJson(route.RouteActionParam),
        // 允许滑索的移动节点只由 ZiplineRouteGoAction 在命中手工链时启用，
        // 参数在原有 path 上追加 zip: true。
        ZipRouteActionParam: rawJson({...route.RouteActionParam, zip: true}),
        ZiplineGoParam: zipline.param(`GoTo${Id}`),
        ZiplineGoParamAfterTrack: zipline.param(String(legacyAfterTrackNext[0])),
        ZiplineGoParamAfterTracked: zipline.param(String(legacyAfterAlreadyTrackedNext[0])),
        FightAfterMoveRouteActionParam: rawJson(route.FightAfterMoveRouteActionParam ?? route.RouteActionParam),
    };
}

export default monitoringMissions.map(buildRow);
