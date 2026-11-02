package zipline

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"

	maa "github.com/MaaXYZ/maa-framework-go/v4"
	"github.com/rs/zerolog/log"
)

// applyPhotoTarget 在手工链命中且 entry 成功后，把自定义拍照点覆盖到 zip_move 上。
// 没有 photo_goal 或节点结构不认识时返回 false，调用方继续按原路线启用节点。
func applyPhotoTarget(ctx *maa.Context, params goActionParam, route *savedRoute) bool {
	if route == nil || len(route.PhotoGoal) != 2 {
		return false
	}
	raw, err := ctx.GetNodeJSON(params.ZipMove)
	if err != nil || strings.TrimSpace(raw) == "" {
		log.Warn().
			Err(err).
			Str("component", actionName).
			Str("node", params.ZipMove).
			Msg("failed to read zipline move node for photo target")
		return false
	}
	node, err := buildZipMoveOverride(raw, route, params.Goal, params.GoalDeckY)
	if err != nil {
		log.Warn().
			Err(err).
			Str("component", actionName).
			Str("node", params.ZipMove).
			Msg("failed to rewrite zipline move path for photo target")
		return false
	}
	if err := ctx.OverridePipeline(map[string]any{params.ZipMove: node}); err != nil {
		log.Error().
			Err(err).
			Str("component", actionName).
			Str("node", params.ZipMove).
			Msg("failed to override zipline move with photo target")
		return false
	}
	log.Info().
		Str("component", actionName).
		Str("node", params.ZipMove).
		Float64("photo_x", route.PhotoGoal[0]).
		Float64("photo_y", route.PhotoGoal[1]).
		Msg("enabled zipline navigation with the saved photo target")
	return true
}

// buildZipMoveOverride 把手工链里的拍照点写成 zip_move 的 override：
// 保留 ZONE，丢掉原路径里的途经点，只留一个指向 photo_goal 的 NAVMESH 和最终 HEADING；
// 同时带上原观察点的 goal，让 cpp-algo 仍能命中同一条手工链。
//
// GetNodeJSON 返回的是 PipelineDumper 的规范化形态，action 参数在
// action.param.custom_action_param 下，不是直接挂在节点上。
func buildZipMoveOverride(nodeJSON string, route *savedRoute, matchGoal []float64, matchDeckY *float64) (map[string]any, error) {
	if route == nil || len(route.PhotoGoal) != 2 {
		return nil, fmt.Errorf("route has no usable photo_goal")
	}
	if len(matchGoal) != 2 {
		return nil, fmt.Errorf("match goal must be [x, y]")
	}

	var node struct {
		CustomActionParam map[string]any `json:"custom_action_param"`
		Action            struct {
			Param struct {
				CustomActionParam map[string]any `json:"custom_action_param"`
			} `json:"param"`
		} `json:"action"`
	}
	if err := json.Unmarshal([]byte(nodeJSON), &node); err != nil {
		return nil, fmt.Errorf("parse zip move node: %w", err)
	}
	param := node.Action.Param.CustomActionParam
	if param == nil {
		param = node.CustomActionParam
	}
	if param == nil {
		return nil, fmt.Errorf("zip move node has no custom_action_param object")
	}
	rawPath, ok := param["path"].([]any)
	if !ok || len(rawPath) == 0 {
		return nil, fmt.Errorf("zip move node has no path")
	}

	path := make([]any, 0, 3)
	headingAngle := 0.0
	hasHeading := false
	for _, raw := range rawPath {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		action, _ := item["action"].(string)
		switch action {
		case "ZONE":
			path = append(path, item)
		case "HEADING":
			if angle, ok := numberValue(item["angle"]); ok {
				headingAngle = angle
				hasHeading = true
			}
		}
	}

	navmesh := map[string]any{
		"action": "NAVMESH",
		"target": []any{route.PhotoGoal[0], route.PhotoGoal[1]},
	}
	if route.PhotoDeckY != nil {
		navmesh["target_deck_y"] = *route.PhotoDeckY
	}
	path = append(path, navmesh)

	if route.PhotoHeading != nil {
		headingAngle = normalizeHeading(*route.PhotoHeading)
		hasHeading = true
	}
	if hasHeading {
		path = append(path, map[string]any{"action": "HEADING", "angle": headingAngle})
	}

	param["path"] = path
	param["zipline_match_goal"] = []any{matchGoal[0], matchGoal[1]}
	if matchDeckY != nil {
		param["zipline_match_deck_y"] = *matchDeckY
	} else {
		delete(param, "zipline_match_deck_y")
	}
	return map[string]any{
		"enabled":             true,
		"custom_action_param": param,
	}, nil
}

func numberValue(value any) (float64, bool) {
	number, ok := value.(float64)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
		return 0, false
	}
	return number, true
}

func normalizeHeading(angle float64) float64 {
	normalized := math.Mod(angle, 360)
	if normalized < 0 {
		normalized += 360
	}
	return normalized
}
