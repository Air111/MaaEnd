#pragma once

#include <MaaFramework/MaaDef.h>

namespace gamesetting
{

enum class Region
{
    Unknown,
    CN,
    Global,
};

// DetectGameRegion 判定区服，按以下顺序回退：
// 1. 运行中的 Endfield.exe 目录：hgsdk.dll（官服）或 PCGameSDK.dll（Bilibili 服）→ 国服；
//    仅有 gfsdk.dll → 国际服；
// 2. Windows 未运行时读安装/启动器写入的注册表项（Software\Hypergryph|Gryphline\Endfield）；
// 3. 以上都失败时复用上次判区结果（debug/record/game_region.txt）。
// 传 controller 时 ADB 还会先查设备上运行中/已安装的 Endfield 包，因此不要求游戏已启动。
// 成功结果会缓存；无法判定时返回 Region::Unknown。
Region DetectGameRegion();

Region DetectGameRegion(MaaController* controller);

} // namespace gamesetting
