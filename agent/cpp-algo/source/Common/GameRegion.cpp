#include "GameRegion.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <memory>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <MaaFramework/MaaAPI.h>
#include <MaaUtils/Logger.h>
#include <MaaUtils/Platform.h>

#ifdef _WIN32
#include <MaaUtils/SafeWindows.hpp>

#include <Psapi.h>
#include <winreg.h>
#endif

#include "../MapNavigator/control/controller_info_utils.h"
#include "../MapNavigator/control/controller_type_utils.h"
#include "../utils.h"
#include "paths.h"
#ifdef __APPLE__
#include "MacAppHost.h"
#endif

namespace gamesetting
{

namespace
{

constexpr const char* kEndfieldProcessName = "Endfield.exe";
#ifdef _WIN32
// 云终末地网页版外壳的窗口类名，与 interface.json 中 CloudWeb 控制器的 class_regex、
// CloudShell/src/ShellWindow.h 的 kWindowClassName 保持一致
constexpr const char* kCloudShellWindowClass = "MaaEnd.CloudShell";
#endif
constexpr const char* kSdkDllCN = "hgsdk.dll";
constexpr const char* kSdkDllCNPCGame = "PCGameSDK.dll"; // Bilibili 服，仍归国服
constexpr const char* kSdkDllGlobal = "gfsdk.dll";

constexpr const char* kAdbListProcessesCommand = "ps -A -o NAME";
constexpr const char* kAdbListPackagesCommand = "pm list packages";
constexpr int64_t kAdbShellTimeoutMs = 20000;
// 判区结果落盘，游戏没启动时（导入滑索只开内嵌浏览器）也能复用上一次结果。
constexpr const char* kRegionCacheRelativePath = "debug/record/game_region.txt";
constexpr std::array<std::pair<std::string_view, Region>, 4> kEndfieldAppIds = { {
    { "com.hypergryph.endfield", Region::CN },
    { "com.hypergryph.endfield.bilibili", Region::CN },
    { "com.gryphline.endfield.gp", Region::Global },
    { "com.gryphline.endfield.ios", Region::Global },
} };

std::optional<Region> g_cached_region;

bool EqualsIgnoreCase(std::string_view a, std::string_view b)
{
    if (a.size() != b.size()) {
        return false;
    }
    for (size_t i = 0; i < a.size(); ++i) {
        const unsigned char ca = static_cast<unsigned char>(a[i]);
        const unsigned char cb = static_cast<unsigned char>(b[i]);
        if (std::tolower(ca) != std::tolower(cb)) {
            return false;
        }
    }
    return true;
}

void AppendUniqueDir(std::vector<std::filesystem::path>& dirs, const std::filesystem::path& dir)
{
    if (std::find(dirs.begin(), dirs.end(), dir) != dirs.end()) {
        return;
    }
    dirs.push_back(dir);
}

const char* RegionName(Region region)
{
    switch (region) {
    case Region::CN:
        return "CN";
    case Region::Global:
        return "Global";
    default:
        return "Unknown";
    }
}

std::optional<Region> ParseRegionName(std::string_view name)
{
    if (EqualsIgnoreCase(name, "CN")) {
        return Region::CN;
    }
    if (EqualsIgnoreCase(name, "Global")) {
        return Region::Global;
    }
    return std::nullopt;
}

std::filesystem::path RegionCachePath()
{
    return common::UserDataPath(kRegionCacheRelativePath);
}

std::optional<Region> ReadCachedRegion()
{
    std::ifstream ifs(RegionCachePath());
    if (!ifs) {
        return std::nullopt;
    }

    std::string text;
    std::getline(ifs, text);
    const auto is_space = [](unsigned char ch) {
        return std::isspace(ch) != 0;
    };
    text.erase(text.begin(), std::find_if_not(text.begin(), text.end(), is_space));
    text.erase(std::find_if_not(text.rbegin(), text.rend(), is_space).base(), text.end());
    if (text.empty()) {
        return std::nullopt;
    }
    return ParseRegionName(text);
}

void WriteCachedRegion(Region region)
{
    if (region == Region::Unknown) {
        return;
    }

    const std::filesystem::path path = RegionCachePath();
    std::error_code ec;
    std::filesystem::create_directories(path.parent_path(), ec);
    if (ec) {
        LogWarn << "GameRegion: create region cache dir failed" << VAR(ec.message());
        return;
    }

    std::ofstream ofs(path, std::ios::trunc);
    if (!ofs) {
        LogWarn << "GameRegion: open region cache file failed" << VAR(path);
        return;
    }
    ofs << RegionName(region) << '\n';
    if (!ofs) {
        LogWarn << "GameRegion: write region cache file failed" << VAR(path);
    }
}

// 记录进程内缓存与落盘缓存，供后续没有运行中游戏时复用。
Region RememberRegion(Region region)
{
    if (region == Region::Unknown) {
        return region;
    }
    g_cached_region = region;
    WriteCachedRegion(region);
    return region;
}

#ifdef _WIN32
bool RegistryKeyExists(HKEY root, const wchar_t* sub_key)
{
    HKEY key = nullptr;
    if (RegOpenKeyExW(root, sub_key, 0, KEY_READ | KEY_WOW64_64KEY, &key) != ERROR_SUCCESS) {
        return false;
    }
    RegCloseKey(key);
    return true;
}

// 游戏未运行时按安装/启动器写入的注册表项判区；不要求 Endfield.exe 正在运行。
std::optional<Region> DetectRegionFromRegistry()
{
    const bool has_cn = RegistryKeyExists(HKEY_CURRENT_USER, L"Software\\Hypergryph\\Endfield")
                        || RegistryKeyExists(HKEY_LOCAL_MACHINE, L"Software\\Hypergryph\\Endfield");
    const bool has_global = RegistryKeyExists(HKEY_CURRENT_USER, L"Software\\Gryphline\\Endfield")
                            || RegistryKeyExists(HKEY_LOCAL_MACHINE, L"Software\\Gryphline\\Endfield");

    if (has_cn == has_global) {
        if (has_cn) {
            LogWarn << "GameRegion: both CN and Global install registry keys exist, cannot auto-detect region";
        }
        return std::nullopt;
    }

    const Region region = has_cn ? Region::CN : Region::Global;
    LogInfo << "GameRegion: resolved region from the install registry" << VAR(RegionName(region));
    return region;
}
#endif

// Windows 使用 QUERY_LIMITED_INFORMATION，避免 MaaUtils list_processes 所需的 VM_READ 被拒。
std::vector<std::filesystem::path> CollectEndfieldInstallDirs()
{
    std::vector<std::filesystem::path> dirs;

#ifdef _WIN32
    constexpr size_t kMaxProcesses = 16 * 1024;
    constexpr DWORD kMaxPathChars = 32768;

    auto all_pids = std::make_unique<DWORD[]>(kMaxProcesses);
    DWORD bytes_needed = 0;
    if (!EnumProcesses(all_pids.get(), static_cast<DWORD>(sizeof(DWORD) * kMaxProcesses), &bytes_needed)) {
        const auto error = GetLastError();
        LogError << "GameRegion: EnumProcesses failed" << VAR(error);
        return dirs;
    }

    const DWORD count = bytes_needed / sizeof(DWORD);
    auto path_buff = std::make_unique<WCHAR[]>(kMaxPathChars);

    for (DWORD i = 0; i < count; ++i) {
        const DWORD pid = all_pids[i];
        if (pid == 0) {
            continue;
        }

        HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if (!process) {
            continue;
        }

        DWORD size = kMaxPathChars;
        const BOOL ok = QueryFullProcessImageNameW(process, 0, path_buff.get(), &size);
        CloseHandle(process);
        if (!ok) {
            continue;
        }

        const std::filesystem::path exe_path(path_buff.get());
        const auto name = MAA_NS::from_osstring(exe_path.filename().native());
        if (!EqualsIgnoreCase(name, kEndfieldProcessName)) {
            continue;
        }

        AppendUniqueDir(dirs, exe_path.parent_path().lexically_normal());
    }
#else
    const auto processes = MAA_NS::list_processes();
    for (const auto& info : processes) {
        if (!EqualsIgnoreCase(info.name, kEndfieldProcessName)) {
            continue;
        }
        const auto path_opt = MAA_NS::get_process_path(info.pid);
        if (!path_opt || path_opt->empty()) {
            continue;
        }
        AppendUniqueDir(dirs, path_opt->parent_path().lexically_normal());
    }
#endif

    return dirs;
}

#ifdef _WIN32
// 云终末地网页版的游戏跑在云端服务器上，本机只有一个串流外壳，没有 Endfield.exe 可供按 SDK DLL 判区。
// 外壳只加载国服 https://endfield.hypergryph.com/cloud（见 CloudShell/src/main.cpp），
// 且只允许导航 hypergryph.com，所以认到 CloudWeb 控制器的窗口就直接按国服处理。
bool IsCloudShellController(MaaController* controller)
{
    uint64_t hwnd = 0;
    if (!mapnavigator::TryGetWin32Hwnd(controller, &hwnd)) {
        return false;
    }

    std::array<wchar_t, 256> class_name {};
    const int length =
        GetClassNameW(reinterpret_cast<HWND>(static_cast<uintptr_t>(hwnd)), class_name.data(), static_cast<int>(class_name.size()));
    if (length <= 0) {
        return false;
    }

    return EqualsIgnoreCase(
        MAA_NS::from_osstring(MAA_NS::os_string_view(class_name.data(), static_cast<size_t>(length))),
        kCloudShellWindowClass);
}
#endif

Region DetectGameRegionUncached()
{
    const auto dirs = CollectEndfieldInstallDirs();

    if (dirs.empty()) {
#ifdef _WIN32
        if (const auto region = DetectRegionFromRegistry()) {
            return *region;
        }
#endif
        LogWarn << "GameRegion: Endfield.exe is not running and no install registry key was found; cannot auto-detect region";
        return Region::Unknown;
    }
    if (dirs.size() > 1) {
        LogError << "GameRegion: multiple Endfield.exe directories found, cannot auto-detect region" << VAR(dirs.size());
        return Region::Unknown;
    }

    const auto& dir = dirs.front();
    std::error_code ec;
    const bool has_hg = std::filesystem::exists(dir / kSdkDllCN, ec);
    if (ec) {
        LogError << "GameRegion: failed to stat hgsdk.dll" << VAR(dir) << VAR(ec.message());
        return Region::Unknown;
    }
    ec.clear();
    const bool has_pcgame = std::filesystem::exists(dir / kSdkDllCNPCGame, ec);
    if (ec) {
        LogError << "GameRegion: failed to stat PCGameSDK.dll" << VAR(dir) << VAR(ec.message());
        return Region::Unknown;
    }
    const bool has_cn = has_hg || has_pcgame;
    ec.clear();
    const bool has_global = std::filesystem::exists(dir / kSdkDllGlobal, ec);
    if (ec) {
        LogError << "GameRegion: failed to stat gfsdk.dll" << VAR(dir) << VAR(ec.message());
        return Region::Unknown;
    }

    if (has_cn && !has_global) {
        return Region::CN;
    }
    if (has_global && !has_cn) {
        return Region::Global;
    }
    if (has_cn && has_global) {
        LogError << "GameRegion: both CN SDK (hgsdk.dll/PCGameSDK.dll) and gfsdk.dll exist" << VAR(dir);
        return Region::Unknown;
    }

    LogError << "GameRegion: neither CN SDK (hgsdk.dll/PCGameSDK.dll) nor gfsdk.dll found" << VAR(dir);
    return Region::Unknown;
}

Region RegionOfAppIds(const std::vector<std::string>& app_ids, std::string_view source)
{
    std::set<Region> regions;
    for (const auto& [app_id, region] : kEndfieldAppIds) {
        if (std::find(app_ids.begin(), app_ids.end(), app_id) != app_ids.end()) {
            regions.insert(region);
        }
    }

    switch (regions.size()) {
    case 1:
        return *regions.begin();
    case 0:
        LogWarn << "GameRegion: no known Endfield app among " << source << "; cannot auto-detect region";
        return Region::Unknown;
    default:
        LogWarn << "GameRegion: both CN and Global Endfield found among " << source << ", cannot auto-detect region";
        return Region::Unknown;
    }
}

std::vector<std::string> ListAdbProcessNames(MaaController* controller)
{
    const MaaCtrlId shell_id = MaaControllerPostShell(controller, kAdbListProcessesCommand, kAdbShellTimeoutMs);
    if (MaaControllerWait(controller, shell_id) != MaaStatus_Succeeded) {
        LogWarn << "GameRegion: adb shell failed" << VAR(kAdbListProcessesCommand);
        return {};
    }

    ScopedStringBuffer buffer;
    if (buffer.Get() == nullptr || !MaaControllerGetShellOutput(controller, buffer.Get())) {
        LogWarn << "GameRegion: adb shell output unavailable" << VAR(kAdbListProcessesCommand);
        return {};
    }

    const char* raw = MaaStringBufferGet(buffer.Get());
    std::istringstream output(raw != nullptr ? raw : "");
    return std::vector<std::string>(std::istream_iterator<std::string>(output), std::istream_iterator<std::string>());
}

// 游戏没启动时按已安装包判区，输出形如 "package:com.hypergryph.endfield"。
std::vector<std::string> ListAdbPackages(MaaController* controller)
{
    const MaaCtrlId shell_id = MaaControllerPostShell(controller, kAdbListPackagesCommand, kAdbShellTimeoutMs);
    if (MaaControllerWait(controller, shell_id) != MaaStatus_Succeeded) {
        LogWarn << "GameRegion: adb package list failed" << VAR(kAdbListPackagesCommand);
        return {};
    }

    ScopedStringBuffer buffer;
    if (buffer.Get() == nullptr || !MaaControllerGetShellOutput(controller, buffer.Get())) {
        LogWarn << "GameRegion: adb package list output unavailable" << VAR(kAdbListPackagesCommand);
        return {};
    }

    constexpr std::string_view kPackagePrefix = "package:";
    std::vector<std::string> packages;
    const char* raw = MaaStringBufferGet(buffer.Get());
    std::istringstream output(raw != nullptr ? raw : "");
    for (std::string line; std::getline(output, line);) {
        const auto first = line.find_first_not_of(" \t\r\n");
        if (first == std::string::npos) {
            continue;
        }
        const std::string_view token(line.data() + first, line.size() - first);
        if (token.size() > kPackagePrefix.size() && token.substr(0, kPackagePrefix.size()) == kPackagePrefix) {
            packages.emplace_back(token.substr(kPackagePrefix.size()));
        }
    }
    return packages;
}

} // namespace

Region DetectGameRegion()
{
    if (g_cached_region) {
        return *g_cached_region;
    }

    const Region region = DetectGameRegionUncached();
    if (region != Region::Unknown) {
        return RememberRegion(region);
    }
    if (const auto cached = ReadCachedRegion()) {
        LogInfo << "GameRegion: Endfield is unavailable, reusing the last detected region" << VAR(RegionName(*cached));
        g_cached_region = *cached;
        return *cached;
    }
    return Region::Unknown;
}

Region DetectGameRegion(MaaController* controller)
{
    const std::string controller_type = mapnavigator::DetectControllerType(controller);

    Region region = Region::Unknown;
#ifdef __APPLE__
    if (mapnavigator::IsPlayCoverControllerType(controller_type)) {
        region = RegionOfAppIds(common::macapp::RunningApplicationIds(), "running applications");
    }
#endif
    if (region == Region::Unknown && mapnavigator::IsAdbLikeControllerType(controller_type)) {
        region = RegionOfAppIds(ListAdbProcessNames(controller), "running processes");
        // pm 只对真正的 adb 控制器可用；PlayCover / native_android 没有这条 shell。
        if (region == Region::Unknown && EqualsIgnoreCase(controller_type, "adb")) {
            region = RegionOfAppIds(ListAdbPackages(controller), "installed packages");
        }
    }
    if (region != Region::Unknown) {
        return RememberRegion(region);
    }
#ifdef _WIN32
    if (IsCloudShellController(controller)) {
        LogInfo << "GameRegion: cloud shell controller detected, region is CN" << VAR(controller_type);
        return Region::CN;
    }
#endif
    return DetectGameRegion();
}

} // namespace gamesetting
