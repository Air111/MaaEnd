package zipline

import (
	"encoding/json"
	"testing"
)

func buildRoutesJSON(t *testing.T, routes []map[string]any) []byte {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"version": 1, "routes": routes})
	if err != nil {
		t.Fatalf("marshal routes: %v", err)
	}
	return raw
}

func tower(x float64) map[string]any {
	return map[string]any{"level_id": "map02_lv002", "template_id": "zipline", "x": x, "y": 0.0, "z": 0.0}
}

func routeEntry(account, zone string, goal []float64, deck *float64, entry string) map[string]any {
	item := map[string]any{
		"account_id": account,
		"zone_name":  zone,
		"label":      "古树",
		"goal":       goal,
		"entry":      entry,
		"towers":     []any{tower(0.0), tower(50.0)},
	}
	if deck != nil {
		item["goal_deck_y"] = *deck
	}
	return item
}

func TestParseRoutesSkipsMalformedEntries(t *testing.T) {
	raw := buildRoutesJSON(t, []map[string]any{
		routeEntry("account-a", "map02base", []float64{829.41, 2576.94}, nil, "SceneEnterWorldWulingA"),
		{ // 没有区名
			"account_id": "account-a",
			"goal":       []float64{1.0, 2.0},
			"towers":     []any{tower(0.0), tower(50.0)},
		},
		{ // 架子不足两根
			"account_id": "account-a",
			"zone_name":  "map02base",
			"goal":       []float64{1.0, 2.0},
			"towers":     []any{tower(0.0)},
		},
		{ // 终点不是坐标
			"account_id": "account-a",
			"zone_name":  "map02base",
			"goal":       []float64{1.0},
			"towers":     []any{tower(0.0), tower(50.0)},
		},
	})

	routes, err := parseRoutes(raw)
	if err != nil {
		t.Fatalf("parseRoutes: %v", err)
	}
	if len(routes) != 1 {
		t.Fatalf("expected 1 usable route, got %d", len(routes))
	}
	if routes[0].Entry != "SceneEnterWorldWulingA" {
		t.Fatalf("unexpected entry: %q", routes[0].Entry)
	}
}

func TestParseRoutesRejectsBrokenRoot(t *testing.T) {
	if _, err := parseRoutes([]byte("[]")); err == nil {
		t.Fatal("expected an error for a non-object root")
	}
}

func TestFindRouteMirrorsRuntimeRules(t *testing.T) {
	deck := 265.55
	raw := buildRoutesJSON(t, []map[string]any{
		routeEntry("account-a", "map02base", []float64{100.0, 200.0}, nil, "EntryA"),
		routeEntry("account-a", "map02base", []float64{300.0, 400.0}, &deck, "EntryB"),
		routeEntry("", "map02base", []float64{500.0, 600.0}, nil, "EntryAnyAccount"),
		routeEntry("account-b", "map02base", []float64{700.0, 800.0}, nil, "EntryBAccount"),
	})
	routes, err := parseRoutes(raw)
	if err != nil {
		t.Fatalf("parseRoutes: %v", err)
	}

	cases := []struct {
		name      string
		account   string
		zone      string
		x, y      float64
		deck      *float64
		wantEntry string
	}{
		{"matches account and goal", "account-a", "map02base", 100.4, 200.0, nil, "EntryA"},
		{"wildcard account", "account-c", "map02base", 500.0, 600.0, nil, "EntryAnyAccount"},
		{"other account is not reused", "account-c", "map02base", 700.0, 800.0, nil, ""},
		{"deck must agree", "account-a", "map02base", 300.0, 400.0, ptr(270.0), ""},
		{"deck within tolerance", "account-a", "map02base", 300.0, 400.0, ptr(266.0), "EntryB"},
		{"zone must agree", "account-a", "map01base", 100.0, 200.0, nil, ""},
		{"goal must be within a pixel", "account-a", "map02base", 102.0, 200.0, nil, ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			route := findRoute(routes, tc.account, tc.zone, tc.x, tc.y, tc.deck)
			got := ""
			if route != nil {
				got = route.Entry
			}
			if got != tc.wantEntry {
				t.Fatalf("expected entry %q, got %q", tc.wantEntry, got)
			}
		})
	}
}

func TestFindRoutePicksTheNearestGoal(t *testing.T) {
	raw := buildRoutesJSON(t, []map[string]any{
		routeEntry("account-a", "map02base", []float64{100.0, 200.0}, nil, "Far"),
		routeEntry("account-a", "map02base", []float64{100.6, 200.0}, nil, "Near"),
	})
	routes, err := parseRoutes(raw)
	if err != nil {
		t.Fatalf("parseRoutes: %v", err)
	}

	route := findRoute(routes, "account-a", "map02base", 100.55, 200.0, nil)
	if route == nil || route.Entry != "Near" {
		t.Fatalf("expected the nearest route, got %+v", route)
	}
}

func ptr(value float64) *float64 {
	return &value
}
