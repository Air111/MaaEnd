package bettersliding

import "testing"

// 有效容错 = max(配置值, 目标数量的 1%（向上取整）)。
func TestQuantityToleranceFor(t *testing.T) {
	a := &BetterSlidingAction{QuantityTolerance: 100}
	cases := []struct{ target, want int }{
		{0, 100},
		{7500, 100},
		{10000, 100},
		{10001, 101},
		{26253, 263},
		{34520, 346},
		{40000, 400},
	}
	for _, c := range cases {
		if got := a.quantityToleranceFor(c.target); got != c.want {
			t.Fatalf("quantityToleranceFor(%d) = %d, want %d", c.target, got, c.want)
		}
	}

	a.QuantityTolerance = 500
	if got := a.quantityToleranceFor(10000); got != 500 {
		t.Fatalf("the configured value is a floor, got %d, want 500", got)
	}

	a.QuantityTolerance = 0
	if got := a.quantityToleranceFor(40000); got != 0 {
		t.Fatalf("an absent tolerance must stay disabled, got %d", got)
	}
}

func TestWithinQuantityTolerance(t *testing.T) {
	// 目标 34520 -> 有效容错 346。
	a := &BetterSlidingAction{TargetQuantity: 34520, QuantityTolerance: 100}

	if !a.withinQuantityTolerance(34245, 34520) {
		t.Fatal("a miss of 275 is within the 1% tolerance of a 34520 target")
	}
	if !a.withinQuantityTolerance(34866, 34520) {
		t.Fatal("a miss equal to the tolerance is accepted")
	}
	if a.withinQuantityTolerance(34867, 34520) {
		t.Fatal("a miss above the tolerance must keep adjusting")
	}
	if a.withinQuantityTolerance(34100, 34520) {
		t.Fatal("a miss of 420 must keep adjusting")
	}

	// 目标 7500 -> 1% 不足 100，仍用配置下限。
	a.TargetQuantity = 7500
	if !a.withinQuantityTolerance(7600, 7500) {
		t.Fatal("a miss equal to the 100 floor is accepted")
	}
	if a.withinQuantityTolerance(7601, 7500) {
		t.Fatal("a miss above the 100 floor must keep adjusting")
	}

	a.QuantityTolerance = 0
	if a.withinQuantityTolerance(7500, 7500) {
		t.Fatal("without tolerance only the exact-match branch accepts the reading")
	}
}

// 超出容错时只补足超出部分，而不是逐下点到精确值。
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

	// 目标 34520 -> 有效容错 346：275 不进重校准，520 才进。
	b := &BetterSlidingAction{
		TargetQuantity:    34520,
		QuantityTolerance: 100,
		startBox:          []int{1010, 559, 32, 32},
		preciseClickBase:  [2]int{1073, 575},
	}
	if b.shouldRecalibratePreciseClick(34245) {
		t.Fatal("a miss of 275 is within the 1% tolerance and must not recalibrate")
	}
	if !b.shouldRecalibratePreciseClick(34000) {
		t.Fatal("a miss of 520 exceeds tolerance plus one round and should recalibrate")
	}
}

func TestSliderUnitsPerPixel(t *testing.T) {
	a := &BetterSlidingAction{
		startBox:          []int{1010, 559, 32, 32},
		endBox:            []int{1142, 559, 32, 32},
		sliderMaxQuantity: 17503,
	}
	if got := a.sliderUnitsPerPixel(); got != 133 {
		t.Fatalf("sliderUnitsPerPixel() = %d, want 133", got)
	}

	a.sliderMaxQuantity = 1
	if got := a.sliderUnitsPerPixel(); got != 0 {
		t.Fatalf("an unknown slider max must yield 0, got %d", got)
	}
}

// 超出容错后应优先用滑条 1px 偏移：步长可估计、落点不会越过容错带时才尝试。
func TestShouldNudgeInto(t *testing.T) {
	a := &BetterSlidingAction{
		TargetQuantity:    7500,
		QuantityTolerance: 100,
		startBox:          []int{1010, 559, 32, 32},
		endBox:            []int{1142, 559, 32, 32},
		sliderMaxQuantity: 17503,
		preciseClickBase:  [2]int{1073, 575},
	}

	if !a.shouldNudgeInto(7620) {
		t.Fatal("a miss of 120 is one 1px nudge away from the tolerance band")
	}
	if a.shouldNudgeInto(7543) {
		t.Fatal("a miss within tolerance must not nudge")
	}
	if !a.shouldNudgeInto(7200) {
		t.Fatal("a miss larger than one step should nudge toward the target")
	}

	// 步长 531 > 2*容错：1px 偏移会越过容错带，退回按钮。
	a.sliderMaxQuantity = 70000
	if a.shouldNudgeInto(7620) {
		t.Fatal("a step wider than twice the tolerance must not nudge")
	}

	// 偏移方向不允许翻转，避免越过目标后来回震荡。
	a.sliderMaxQuantity = 17503
	a.preciseClickNudges = 1
	a.lastNudgeSign = 1 // 上一次朝增大方向
	if a.shouldNudgeInto(7620) {
		t.Fatal("a flipped nudge direction must be rejected")
	}

	// 次数用尽后退回按钮。
	a.preciseClickNudges = maxSliderNudges
	a.lastNudgeSign = 0
	if a.shouldNudgeInto(7620) {
		t.Fatal("nudging must stop after maxSliderNudges attempts")
	}

	// 几何缺失时无法估算步长，退回按钮。
	a.preciseClickNudges = 0
	a.startBox = nil
	if a.shouldNudgeInto(7620) {
		t.Fatal("nudging needs slider geometry")
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
