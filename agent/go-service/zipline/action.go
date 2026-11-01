package zipline

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/MaaXYZ/MaaEnd/agent/go-service/pkg/i18n"
	"github.com/MaaXYZ/MaaEnd/agent/go-service/pkg/maafocus"
	maa "github.com/MaaXYZ/maa-framework-go/v4"
	"github.com/rs/zerolog/log"
)

const (
	// actionName 是 Pipeline 里 custom_action 的注册名。
	actionName = "ZiplineRouteGoAction"
	// identityNode 由 CaptureUid 发布，是当前游戏账号的伪匿名标识。
	identityNode = "CurrentAccountIdentity"
	// accountOverrideNode 是设置项「强制使用第一份滑索数据」的载体，优先于当前账号。
	accountOverrideNode = "MapNavigatorZiplineAccount"
	// focusKey 是起飞时给用户看的提示。
	focusKey = "zipline.route.using_saved"
)

// goActionParam 描述「前往目标点」时应该怎么走。
//
// 有匹配的手工链时，先执行链上记录的 entry 传送到离滑索起点最近的锚点，再启用
// zip_move 那条允许滑索的路线；没有匹配或 entry 不可用时执行 fallback 的原有传送流程，
// 并保持 zip_move 禁用。
type goActionParam struct {
	ZoneName  string    `json:"zone_name"`
	Goal      []float64 `json:"goal"`
	GoalDeckY *float64  `json:"goal_deck_y"`
	Fallback  string    `json:"fallback"`
	ZipMove   string    `json:"zip_move"`
}

// RouteGoAction 在传送前决定这次是否使用保存的滑索链。
type RouteGoAction struct{}

var _ maa.CustomActionRunner = &RouteGoAction{}

// Run 实现 maa.CustomActionRunner。
func (a *RouteGoAction) Run(ctx *maa.Context, arg *maa.CustomActionArg) bool {
	if ctx == nil || arg == nil {
		log.Error().Str("component", actionName).Msg("nil context or action arg")
		return false
	}

	var params goActionParam
	if err := json.Unmarshal([]byte(arg.CustomActionParam), &params); err != nil {
		log.Error().
			Err(err).
			Str("component", actionName).
			Str("param", arg.CustomActionParam).
			Msg("failed to parse custom_action_param")
		return false
	}
	if err := params.validate(); err != nil {
		log.Error().Err(err).Str("component", actionName).Msg("invalid custom_action_param")
		return false
	}

	route := lookupRoute(ctx, params)
	if route != nil && route.Entry != "" {
		// 节点不存在或被禁用时和「没有保存路径」一样回退；只有真正跑失败才让本节点失败。
		if !nodeRunnable(ctx, route.Entry) {
			log.Warn().
				Str("component", actionName).
				Str("entry", route.Entry).
				Msg("saved zipline route entry is missing or disabled; falling back")
		} else if runNode(ctx, route.Entry) {
			setZipMoveEnabled(ctx, params.ZipMove, true)
			maafocus.Print(ctx, i18n.T(focusKey, displayRouteName(route, params.ZoneName)))
			log.Info().
				Str("component", actionName).
				Str("zone", params.ZoneName).
				Float64("goal_x", params.Goal[0]).
				Float64("goal_y", params.Goal[1]).
				Str("entry", route.Entry).
				Str("label", route.Label).
				Msg("saved zipline route matched; teleported to its entry and enabled zipline navigation")
			return true
		} else {
			// 入口传送失败时屏幕状态未知，交给 FailureCollector 回到终端重试，
			// 不再从当前位置猜原来的快捷传送流程。
			log.Error().
				Str("component", actionName).
				Str("entry", route.Entry).
				Msg("zipline entry teleport failed")
			return false
		}
	}

	setZipMoveEnabled(ctx, params.ZipMove, false)
	if route != nil {
		log.Warn().
			Str("component", actionName).
			Str("label", route.Label).
			Msg("saved zipline route has no usable teleport entry; falling back to the original flow")
	}
	return runNode(ctx, params.Fallback)
}

func (p goActionParam) validate() error {
	if strings.TrimSpace(p.ZoneName) == "" {
		return fmt.Errorf("zone_name is empty")
	}
	if len(p.Goal) != 2 {
		return fmt.Errorf("goal must be [x, y]")
	}
	if strings.TrimSpace(p.Fallback) == "" {
		return fmt.Errorf("fallback is empty")
	}
	if strings.TrimSpace(p.ZipMove) == "" {
		return fmt.Errorf("zip_move is empty")
	}
	return nil
}

// lookupRoute 读取手工链并按 (账号, 区, 终点, 层高) 匹配；任何读取或解析问题都只回退，不中断任务。
func lookupRoute(ctx *maa.Context, params goActionParam) *savedRoute {
	routes, err := loadRoutes(routesPath())
	if err != nil {
		log.Warn().Err(err).Str("component", actionName).Msg("failed to load saved zipline routes; falling back")
		return nil
	}
	if len(routes) == 0 {
		return nil
	}
	accountID := currentAccountID(ctx)
	return findRoute(routes, accountID, params.ZoneName, params.Goal[0], params.Goal[1], params.GoalDeckY)
}

// currentAccountID 复刻 cpp-algo ResolveZiplineAccountId 的前两级：设置项指定的账号优先，
// 否则使用当前游戏账号；都读不到时返回空字符串（此时只有账号为空的记录能匹配）。
func currentAccountID(ctx *maa.Context) string {
	for _, nodeName := range []string{accountOverrideNode, identityNode} {
		raw, err := ctx.GetNodeJSON(nodeName)
		if err != nil || strings.TrimSpace(raw) == "" {
			continue
		}
		var node struct {
			Attach struct {
				AccountID string `json:"account_id"`
			} `json:"attach"`
		}
		if err := json.Unmarshal([]byte(raw), &node); err != nil {
			log.Warn().Err(err).Str("component", actionName).Str("node", nodeName).Msg("failed to read account node")
			continue
		}
		if accountID := strings.TrimSpace(node.Attach.AccountID); accountID != "" {
			return accountID
		}
	}
	return ""
}

// runNode 执行一个 Pipeline 节点，并把它后面的链跑完。
// nodeRunnable 判断节点是否存在且未被禁用；用来区分「入口不可用」和「入口执行失败」。
func nodeRunnable(ctx *maa.Context, nodeName string) bool {
	node, err := ctx.GetNode(nodeName)
	if err != nil || node == nil {
		return false
	}
	return node.Enabled == nil || *node.Enabled
}

func runNode(ctx *maa.Context, nodeName string) bool {
	node, err := ctx.GetNode(nodeName)
	if err != nil || node == nil {
		log.Error().Err(err).Str("component", actionName).Str("node", nodeName).Msg("node not found")
		return false
	}
	if node.Enabled != nil && !*node.Enabled {
		log.Error().Str("component", actionName).Str("node", nodeName).Msg("node is disabled")
		return false
	}
	detail, err := ctx.RunTask(nodeName)
	if err != nil || detail == nil || !detail.Status.Success() {
		log.Error().Err(err).Str("component", actionName).Str("node", nodeName).Msg("node run failed")
		return false
	}
	return true
}

// setZipMoveEnabled 打开或关闭「允许滑索」的移动节点；关闭放在回退路径上，
// 避免上一次开启后遗留给同一观察点的下一次执行。
func setZipMoveEnabled(ctx *maa.Context, nodeName string, enabled bool) {
	if strings.TrimSpace(nodeName) == "" {
		return
	}
	if err := ctx.OverridePipeline(map[string]any{
		nodeName: map[string]any{"enabled": enabled},
	}); err != nil {
		log.Error().
			Err(err).
			Str("component", actionName).
			Str("node", nodeName).
			Bool("enabled", enabled).
			Msg("failed to override zipline move node")
	}
}

func displayRouteName(route *savedRoute, fallback string) string {
	if route != nil && strings.TrimSpace(route.Label) != "" {
		return route.Label
	}
	return fallback
}
