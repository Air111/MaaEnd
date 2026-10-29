//go:build linux && !android

package ziplineimport

import "strings"

// areaSelection 是 ZiplineImport 的区域筛选：大区（map01/map02）选整张图，
// 小区（map01_lv005 等）只替换对应 level 的标记。没有任何 include_* 标志时保持旧行为，导入全部标定图。
type areaSelection struct {
	explicit bool
	maps     map[string]bool
	levels   map[string]bool
}

func newAreaSelection(flags map[string]any) areaSelection {
	selection := areaSelection{maps: make(map[string]bool), levels: make(map[string]bool)}
	for key, value := range flags {
		if !strings.HasPrefix(key, "include_map") {
			continue
		}
		selection.explicit = true
		enabled, ok := value.(bool)
		if !ok || !enabled {
			continue
		}
		area := strings.TrimPrefix(key, "include_")
		if strings.Contains(area, "_lv") {
			selection.levels[area] = true
		} else {
			selection.maps[area] = true
		}
	}
	return selection
}

func (s areaSelection) includesMap(mapID string) bool {
	if !s.explicit || s.maps[mapID] {
		return true
	}
	prefix := mapID + "_"
	for level := range s.levels {
		if strings.HasPrefix(level, prefix) {
			return true
		}
	}
	return false
}

func (s areaSelection) fullyIncludesMap(mapID string) bool {
	return !s.explicit || s.maps[mapID]
}

func (s areaSelection) includesLevel(levelID string) bool {
	if !s.explicit {
		return true
	}
	if levelID == "" {
		return false
	}
	if s.maps[mapIDForLevel(levelID)] {
		return true
	}
	return s.levels[levelID]
}

func (s areaSelection) levelsForMap(mapID string) map[string]bool {
	levels := make(map[string]bool)
	if s.maps[mapID] {
		return levels
	}
	prefix := mapID + "_"
	for level := range s.levels {
		if strings.HasPrefix(level, prefix) {
			levels[level] = true
		}
	}
	return levels
}

func (s areaSelection) selectedMaps(all map[string]bool) map[string]bool {
	if !s.explicit {
		return all
	}
	selected := make(map[string]bool)
	for mapID := range s.maps {
		selected[mapID] = true
	}
	for level := range s.levels {
		if mapID := mapIDForLevel(level); mapID != "" {
			selected[mapID] = true
		}
	}
	return selected
}

func mapIDForLevel(levelID string) string {
	if index := strings.Index(levelID, "_lv"); index > 0 {
		return levelID[:index]
	}
	return ""
}
