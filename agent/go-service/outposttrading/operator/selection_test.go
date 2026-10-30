package operator

import (
	"reflect"
	"testing"
)

// TestPreferredTargetCandidatesIgnoreOutpostProsperity 验证“忽略据点发展值”只按交易收益分档：
// 未忽略时优先发展值 + 交易收益双加成；忽略后发展值不再参与比较，
// 同时具备调度券积累与售卖的完美候选优先，当前派驻无需为了发展值切换。
func TestPreferredTargetCandidatesIgnoreOutpostProsperity(t *testing.T) {
	candidates := []operatorCandidate{
		{
			Name:                          "ExpMoney",
			Expected:                      []string{"ExpMoney"},
			BonusTier:                     0,
			OutpostProsperityMaxBonusTier: 0,
		},
		{
			Name:                          "ExpOnly",
			Expected:                      []string{"ExpOnly"},
			BonusTier:                     1,
			OutpostProsperityMaxBonusTier: 1,
		},
		{
			Name:                          "Dual",
			Expected:                      []string{"Dual"},
			BonusTier:                     2,
			OutpostProsperityMaxBonusTier: 0,
		},
	}
	owned := map[string]struct{}{
		"ExpMoney": {},
		"ExpOnly":  {},
		"Dual":     {},
	}
	// Dual 同时出现在恢复候选里，表示它兼具调度券积累与售卖。
	restoreGroups := []operatorCandidateGroup{
		{
			Location:   "Loc",
			Candidates: []operatorCandidate{{Name: "Dual"}},
		},
	}
	maxLocations := map[string]struct{}{}

	tests := []struct {
		name                    string
		ignoreOutpostProsperity bool
		want                    []string
	}{
		{
			name:                    "prosperity counted",
			ignoreOutpostProsperity: false,
			want:                    []string{"ExpMoney"},
		},
		{
			name:                    "prosperity ignored",
			ignoreOutpostProsperity: true,
			want:                    []string{"Dual"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := preferredTargetCandidates(
				candidates,
				owned,
				"Loc",
				restoreGroups,
				maxLocations,
				tt.ignoreOutpostProsperity,
			)
			if names := operatorCandidateNames(got); !reflect.DeepEqual(names, tt.want) {
				t.Fatalf("candidates = %v, want %v", names, tt.want)
			}
		})
	}
}

func operatorCandidateNames(candidates []operatorCandidate) []string {
	names := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		names = append(names, candidate.Name)
	}
	return names
}
