package zipline

import (
	"testing"
)

func TestBuildZipMoveOverrideReplacesGoalAndDropsViaPoints(t *testing.T) {
	nodeJSON := `{
		"enabled": false,
		"action": {
			"param": {
				"custom_action": "MapNavigateAction",
				"custom_action_param": {
					"path": [
						{"action": "ZONE", "zone_id": "Wuling_Base"},
						{"action": "NAVMESH", "target": [100, 200]},
						{"action": "NAVMESH", "target": [300, 400]},
						{"action": "HEADING", "angle": 10}
					],
					"zip": true,
					"heading_source": "character"
				}
			}
		}
	}`
	deck := 12.5
	heading := -20.0
	route := &savedRoute{PhotoGoal: []float64{500, 600}, PhotoDeckY: &deck, PhotoHeading: &heading}
	matchDeck := 8.0

	override, err := buildZipMoveOverride(nodeJSON, route, []float64{900, 1000}, &matchDeck)
	if err != nil {
		t.Fatalf("build override: %v", err)
	}
	if enabled, _ := override["enabled"].(bool); !enabled {
		t.Fatal("node should be enabled")
	}
	param, _ := override["custom_action_param"].(map[string]any)
	if param == nil {
		t.Fatal("missing custom_action_param")
	}
	if zip, _ := param["zip"].(bool); !zip {
		t.Fatal("zip should be preserved")
	}
	path, _ := param["path"].([]any)
	if len(path) != 3 {
		t.Fatalf("path length = %d, want 3 (ZONE + NAVMESH + HEADING)", len(path))
	}
	zone, _ := path[0].(map[string]any)
	if zone["action"] != "ZONE" || zone["zone_id"] != "Wuling_Base" {
		t.Fatalf("zone waypoint not preserved: %#v", zone)
	}
	nav, _ := path[1].(map[string]any)
	if nav["action"] != "NAVMESH" {
		t.Fatalf("second waypoint should be NAVMESH: %#v", nav)
	}
	target, _ := nav["target"].([]any)
	if len(target) != 2 || target[0] != 500.0 || target[1] != 600.0 {
		t.Fatalf("target = %#v, want [500, 600]", target)
	}
	if nav["target_deck_y"] != deck {
		t.Fatalf("target_deck_y = %#v, want %v", nav["target_deck_y"], deck)
	}
	headingNode, _ := path[2].(map[string]any)
	if headingNode["action"] != "HEADING" || headingNode["angle"] != 340.0 {
		t.Fatalf("heading = %#v, want 340", headingNode)
	}
	match, _ := param["zipline_match_goal"].([]any)
	if len(match) != 2 || match[0] != 900.0 || match[1] != 1000.0 {
		t.Fatalf("match goal = %#v, want [900, 1000]", match)
	}
	if param["zipline_match_deck_y"] != matchDeck {
		t.Fatalf("match deck = %#v, want %v", param["zipline_match_deck_y"], matchDeck)
	}
}

func TestBuildZipMoveOverrideKeepsOriginalHeadingAndDropsDeck(t *testing.T) {
	nodeJSON := `{
		"action": {
			"param": {
				"custom_action_param": {
					"path": [
						{"action": "ZONE", "zone_id": "Wuling_Base"},
						{"action": "HEADING", "angle": 45}
					]
				}
			}
		}
	}`
	route := &savedRoute{PhotoGoal: []float64{1, 2}}
	override, err := buildZipMoveOverride(nodeJSON, route, []float64{3, 4}, nil)
	if err != nil {
		t.Fatalf("build override: %v", err)
	}
	param, _ := override["custom_action_param"].(map[string]any)
	path, _ := param["path"].([]any)
	nav, _ := path[1].(map[string]any)
	if _, ok := nav["target_deck_y"]; ok {
		t.Fatal("old deck should not leak into the new NAVMESH")
	}
	headingNode, _ := path[2].(map[string]any)
	if headingNode["angle"] != 45.0 {
		t.Fatalf("original heading = %#v, want 45", headingNode["angle"])
	}
	if _, ok := param["zipline_match_deck_y"]; ok {
		t.Fatal("match deck should be omitted when nil")
	}
}

func TestBuildZipMoveOverrideRejectsBadInput(t *testing.T) {
	route := &savedRoute{PhotoGoal: []float64{1, 2}}
	if _, err := buildZipMoveOverride("not json", route, []float64{3, 4}, nil); err == nil {
		t.Fatal("expected parse error")
	}
	if _, err := buildZipMoveOverride(`{"action":{"param":{}}}`, route, []float64{3, 4}, nil); err == nil {
		t.Fatal("expected missing custom_action_param error")
	}
	if _, err := buildZipMoveOverride(
		`{"action":{"param":{"custom_action_param":{"path":[]}}}}`,
		route,
		[]float64{3, 4},
		nil,
	); err == nil {
		t.Fatal("expected empty path error")
	}
}

func TestParseRoutesReadsPhotoTarget(t *testing.T) {
	raw := []byte(`{
		"routes": [{
			"account_id": "",
			"zone_name": "map02base",
			"label": "储备站周围的生态环境",
			"goal": [909.81, 1921.56],
			"goal_deck_y": 10.0,
			"photo_goal": [880.5, 1928.5],
			"photo_deck_y": 4.0,
			"photo_heading": 200,
			"entry": "SceneEnterWorldWulingWulingCityFieldLogisticsDepotWest",
			"towers": [{}, {}]
		}]
	}`)
	routes, err := parseRoutes(raw)
	if err != nil {
		t.Fatalf("parse routes: %v", err)
	}
	if len(routes) != 1 {
		t.Fatalf("routes = %d, want 1", len(routes))
	}
	route := routes[0]
	if len(route.PhotoGoal) != 2 || route.PhotoGoal[0] != 880.5 || route.PhotoGoal[1] != 1928.5 {
		t.Fatalf("photo goal = %#v", route.PhotoGoal)
	}
	if route.PhotoDeckY == nil || *route.PhotoDeckY != 4.0 {
		t.Fatalf("photo deck = %#v", route.PhotoDeckY)
	}
	if route.PhotoHeading == nil || *route.PhotoHeading != 200.0 {
		t.Fatalf("photo heading = %#v", route.PhotoHeading)
	}
}
