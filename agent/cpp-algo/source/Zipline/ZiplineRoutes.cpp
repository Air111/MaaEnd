#include "ZiplineRoutes.h"

#include <cmath>
#include <fstream>
#include <iterator>
#include <system_error>
#include <utility>

#include <meojson/json.hpp>

#include <MaaUtils/Logger.h>

#include "../Common/output_paths.h"

namespace zipline
{

namespace
{

constexpr const char* kRoutesFileName = "ZiplineRoutes.json";

// 送货点坐标由生成器给出, 手工改过一两位小数时仍应命中同一条
constexpr double kGoalMatchWu = 1.0;
// 两层可走面可能共用同一平面坐标, 高度只用来消歧, 缺省时不参与匹配
constexpr double kGoalDeckMatchWu = 1.0;

std::optional<double> number_at(const json::object& obj, const char* key)
{
    if (!obj.contains(key) || !obj.at(key).is_number()) {
        return std::nullopt;
    }
    const double value = obj.at(key).as_double();
    if (!std::isfinite(value)) {
        return std::nullopt;
    }
    return value;
}

bool parse_goal(const json::object& obj, double& x, double& y)
{
    if (!obj.contains("goal") || !obj.at("goal").is_array()) {
        return false;
    }
    const auto& goal = obj.at("goal").as_array();
    if (goal.size() != 2 || !goal[0].is_number() || !goal[1].is_number()) {
        return false;
    }
    x = goal[0].as_double();
    y = goal[1].as_double();
    return std::isfinite(x) && std::isfinite(y);
}

bool parse_towers(const json::object& obj, std::vector<ZiplineMark>& towers)
{
    if (!obj.contains("towers") || !obj.at("towers").is_array()) {
        return false;
    }
    for (const auto& value : obj.at("towers").as_array()) {
        if (!value.is_object()) {
            continue;
        }
        const auto& mark_obj = value.as_object();
        const std::optional<double> x = number_at(mark_obj, "x");
        const std::optional<double> y = number_at(mark_obj, "y");
        const std::optional<double> z = number_at(mark_obj, "z");
        if (!x || !y || !z) {
            continue;
        }
        ZiplineMark mark;
        mark.template_id = mark_obj.get("template_id", std::string {});
        mark.level_id = mark_obj.get("level_id", std::string {});
        mark.x = *x;
        mark.y = *y;
        mark.z = *z;
        towers.push_back(std::move(mark));
    }
    // 一根架子连不成链, 规划时也没法跳
    return towers.size() >= 2;
}

} // namespace

std::filesystem::path ZiplineRoutes::DefaultPath()
{
    return common::OutputPath("debug/record") / kRoutesFileName;
}

bool ZiplineRoutes::load(const std::filesystem::path& path)
{
    routes_.clear();

    std::error_code ec;
    if (!std::filesystem::exists(path, ec)) {
        LogInfo << "ZiplineRoutes: no edited route yet" << VAR(path);
        return true;
    }

    std::ifstream ifs(path, std::ios::binary);
    if (!ifs) {
        LogError << "ZiplineRoutes: open failed" << VAR(path);
        return false;
    }

    const std::string raw((std::istreambuf_iterator<char>(ifs)), std::istreambuf_iterator<char>());
    if (raw.empty()) {
        LogInfo << "ZiplineRoutes: empty record" << VAR(path);
        return true;
    }

    const auto parsed = json::parse(raw);
    if (!parsed || !parsed->is_object()) {
        LogError << "ZiplineRoutes: record is not a json object" << VAR(path);
        return false;
    }

    const auto& root = parsed->as_object();
    if (!root.contains("routes") || !root.at("routes").is_array()) {
        LogWarn << "ZiplineRoutes: record has no routes array, treated as empty" << VAR(path);
        return true;
    }

    size_t dropped = 0;
    for (const auto& entry : root.at("routes").as_array()) {
        if (!entry.is_object()) {
            ++dropped;
            continue;
        }
        const auto& obj = entry.as_object();

        ZiplineSavedRoute route;
        route.account_id = obj.get("account_id", std::string {});
        route.zone_name = obj.get("zone_name", std::string {});
        route.label = obj.get("label", std::string {});
        route.goal_deck_y = number_at(obj, "goal_deck_y");
        if (route.zone_name.empty() || !parse_goal(obj, route.goal_x, route.goal_y) || !parse_towers(obj, route.towers)) {
            ++dropped;
            continue;
        }

        routes_.push_back(std::move(route));
    }

    if (dropped != 0) {
        LogWarn << "ZiplineRoutes: dropped malformed entries" << VAR(dropped) << VAR(path);
    }
    LogInfo << "ZiplineRoutes: loaded" << VAR(path) << VAR(routes_.size());
    return true;
}

const ZiplineSavedRoute* ZiplineRoutes::find(
    const std::string& account_id,
    const std::string& zone_name,
    double goal_x,
    double goal_y,
    std::optional<double> goal_deck_y) const
{
    const ZiplineSavedRoute* best = nullptr;
    double best_distance = kGoalMatchWu;
    for (const ZiplineSavedRoute& route : routes_) {
        if (!route.account_id.empty() && route.account_id != account_id) {
            continue;
        }
        if (route.zone_name != zone_name) {
            continue;
        }
        if (goal_deck_y && route.goal_deck_y && std::abs(*goal_deck_y - *route.goal_deck_y) > kGoalDeckMatchWu) {
            continue;
        }
        const double distance = std::hypot(route.goal_x - goal_x, route.goal_y - goal_y);
        if (distance <= best_distance) {
            best = &route;
            best_distance = distance;
        }
    }
    return best;
}

} // namespace zipline
