package bettersliding

import "testing"

func TestWithinQuantityTolerance(t *testing.T) {
	a := &BetterSlidingAction{TargetQuantity: 7500, QuantityTolerance: 100}

	if !a.withinQuantityTolerance(7543, 7500) {
		t.Fatal("a miss of 43 is within the 100 tolerance")
	}
	if !a.withinQuantityTolerance(7400, 7500) {
		t.Fatal("the tolerance is symmetric")
	}
	if !a.withinQuantityTolerance(7600, 7500) {
		t.Fatal("a miss equal to the tolerance is accepted")
	}
	if a.withinQuantityTolerance(7601, 7500) {
		t.Fatal("a miss above the tolerance must keep adjusting")
	}

	a.QuantityTolerance = 0
	if a.withinQuantityTolerance(7500, 7500) {
		t.Fatal("without tolerance only the exact-match branch accepts the reading")
	}
}

// 容错 100 时只补足超出部分，而不是逐下点到精确值。
func TestFineTuneRepeatOnlyCorrectsExcess(t *testing.T) {
	cases := []struct{ miss, tolerance, want int }{
		{43, 100, 0},
		{298, 100, 30},
		{126, 100, 26},
		{126, 0, 30},
	}
	for _, c := range cases {
		if got := fineTuneRepeat(c.miss, c.tolerance); got != c.want {
			t.Fatalf("fineTuneRepeat(%d, %d) = %d, want %d", c.miss, c.tolerance, got, c.want)
		}
	}
}

// 容错内的偏差不应再触发精确点击重校准；超出容错但仍在一轮按钮内也不必重校准。
func TestShouldRecalibratePreciseClickRespectsTolerance(t *testing.T) {
	a := &BetterSlidingAction{
		TargetQuantity:    7500,
		QuantityTolerance: 100,
		startBox:          []int{1010, 559, 32, 32},
		preciseClickBase:  [2]int{1073, 575},
	}

	if a.shouldRecalibratePreciseClick(7543) {
		t.Fatal("a miss within the tolerance must not trigger a recalibration click")
	}
	if a.shouldRecalibratePreciseClick(7620) {
		t.Fatal("a miss inside tolerance plus one fine-tune round is handled by the buttons")
	}
	if !a.shouldRecalibratePreciseClick(7200) {
		t.Fatal("a miss beyond tolerance plus one fine-tune round should recalibrate")
	}
}

func TestNormalizeQuantityTolerance(t *testing.T) {
	if got, err := normalizeQuantityTolerance(100, true); err != nil || got != 100 {
		t.Fatalf("got (%d, %v), want (100, nil)", got, err)
	}
	if got, err := normalizeQuantityTolerance(0, false); err != nil || got != 0 {
		t.Fatalf("an absent tolerance must be 0, got (%d, %v)", got, err)
	}
	if _, err := normalizeQuantityTolerance(0, true); err == nil {
		t.Fatal("an explicit 0 must be rejected")
	}
	if _, err := normalizeQuantityTolerance(-1, true); err == nil {
		t.Fatal("a negative tolerance must be rejected")
	}
}
