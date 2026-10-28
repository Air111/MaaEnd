#pragma once

#include <filesystem>
#include <optional>
#include <string>
#include <vector>

#include "ZiplineStore.h"

namespace zipline
{

// 用户按「地区-送货点」手工排好的滑索链, 一条记录锁定一个规划区间
struct ZiplineSavedRoute
{
    // 为空表示不限定账号, 旧文件或手工写的记录可以不带
    std::string account_id;
    // 与 navmesh base 区名一致, 例如 map01base
    std::string zone_name;
    // 只给人看
    std::string label;
    // base 像素坐标, 须与规划区间终点落在同一处
    double goal_x = 0.0;
    double goal_y = 0.0;
    std::optional<double> goal_deck_y;
    // 按执行顺序排列, 至少两根; 只存世界坐标, 重新导入后仍能认回同一根架子
    std::vector<ZiplineMark> towers;
};

class ZiplineRoutes
{
public:
    // 与 Ziplines.json 同目录的 record/ZiplineRoutes.json
    static std::filesystem::path DefaultPath();

    // 文件不存在视为没有手工路径并返回 true, 只有内容坏掉才返回 false
    bool load(const std::filesystem::path& path);

    // 优先返回终点最近的一条; 没有匹配时返回 nullptr
    const ZiplineSavedRoute* find(
        const std::string& account_id,
        const std::string& zone_name,
        double goal_x,
        double goal_y,
        std::optional<double> goal_deck_y) const;

private:
    std::vector<ZiplineSavedRoute> routes_;
};

} // namespace zipline
