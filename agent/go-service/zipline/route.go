package zipline

import (
	"encoding/json"
	"fmt"
	"math"
	"os"

	"github.com/MaaXYZ/MaaEnd/agent/go-service/pkg/fsutil"
)

const (
	// routesFileName 与 cpp-algo ZiplineRoutes 读取的是同一份文件。
	routesFileName = "ZiplineRoutes.json"
	// 与 cpp-algo ZiplineRoutes 的匹配阈值保持一致。
	goalMatchPx   = 1.0
	deckMatchUnit = 1.0
	minTowerCount = 2
)

// savedRoute 是 ZiplineRoutes.json 里一条可被 Pipeline 使用的手工链。
// 这里只关心匹配与传送入口；滑索逐跳执行仍由 cpp-algo 的 PlanZiplineRoute 负责。
type savedRoute struct {
	AccountID string
	ZoneName  string
	Label     string
	GoalX     float64
	GoalY     float64
	GoalDeckY *float64
	// Entry 是起飞前要执行的传送入口节点；为空表示这条链没有指定入口。
	Entry string
}

type routeJSON struct {
	AccountID string            `json:"account_id"`
	ZoneName  string            `json:"zone_name"`
	Label     string            `json:"label"`
	Goal      []float64         `json:"goal"`
	GoalDeckY *float64          `json:"goal_deck_y"`
	Entry     string            `json:"entry"`
	Towers    []json.RawMessage `json:"towers"`
}

type routesDocument struct {
	Routes []json.RawMessage `json:"routes"`
}

// routesPath 返回当前启动目录下的手工链文件；cpp-algo 用同一个相对路径。
func routesPath() string {
	return fsutil.OutputPath("debug", "record", routesFileName)
}

// loadRoutes 读取手工链；文件不存在视为空，内容坏掉返回错误。
func loadRoutes(path string) ([]savedRoute, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	return parseRoutes(raw)
}

func parseRoutes(raw []byte) ([]savedRoute, error) {
	var document routesDocument
	if err := json.Unmarshal(raw, &document); err != nil {
		// 根结构不是带 routes 的对象时整份不可用，与 cpp-algo 的严格程度一致。
		return nil, fmt.Errorf("parse %s: %w", routesFileName, err)
	}

	routes := make([]savedRoute, 0, len(document.Routes))
	for _, item := range document.Routes {
		var entry routeJSON
		if err := json.Unmarshal(item, &entry); err != nil {
			continue
		}
		// 与 cpp-algo 一致：没有区、终点或至少两根架子的记录直接跳过。
		if entry.ZoneName == "" || len(entry.Goal) != 2 || len(entry.Towers) < minTowerCount {
			continue
		}
		if !isFinite(entry.Goal[0]) || !isFinite(entry.Goal[1]) {
			continue
		}
		if entry.GoalDeckY != nil && !isFinite(*entry.GoalDeckY) {
			entry.GoalDeckY = nil
		}
		routes = append(routes, savedRoute{
			AccountID: entry.AccountID,
			ZoneName:  entry.ZoneName,
			Label:     entry.Label,
			GoalX:     entry.Goal[0],
			GoalY:     entry.Goal[1],
			GoalDeckY: entry.GoalDeckY,
			Entry:     entry.Entry,
		})
	}
	return routes, nil
}

// findRoute 复刻 cpp-algo ZiplineRoutes::find 的匹配规则：账号为空视为通配，
// 区名必须相等，层高只用来消歧，终点取最近的一条（1 像素内）。
func findRoute(routes []savedRoute, accountID, zoneName string, goalX, goalY float64, goalDeckY *float64) *savedRoute {
	var best *savedRoute
	bestDistance := goalMatchPx
	for index := range routes {
		route := &routes[index]
		if route.AccountID != "" && route.AccountID != accountID {
			continue
		}
		if route.ZoneName != zoneName {
			continue
		}
		if goalDeckY != nil && route.GoalDeckY != nil && math.Abs(*goalDeckY-*route.GoalDeckY) > deckMatchUnit {
			continue
		}
		distance := math.Hypot(route.GoalX-goalX, route.GoalY-goalY)
		if distance <= bestDistance {
			best = route
			bestDistance = distance
		}
	}
	return best
}

func isFinite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}
