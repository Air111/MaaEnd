package zipline

import (
	"encoding/json"
	"strings"

	"github.com/MaaXYZ/MaaEnd/agent/go-service/captureuid"
	maa "github.com/MaaXYZ/maa-framework-go/v4"
	"github.com/rs/zerolog/log"
)

// applyAccountUidActionName 是「按任务设置指定滑索账号」的自定义动作注册名。
const applyAccountUidActionName = "ApplyZiplineAccountUid"

// applyAccountUidParam 是任务选项写入的参数：uid 为原始 8–12 位 UID，空串表示沿用当前游戏账号。
type applyAccountUidParam struct {
	UID string `json:"uid"`
}

// ApplyAccountUidAction 把任务设置里的原始 UID 换算成账号标识，写进
// MapNavigatorZiplineAccount 的 attach.account_id；C++ 与 Go 两端的滑索记录匹配都读这个字段。
//
// account_id 是加盐哈希（captureuid.AccountIDFromRawUID），不能直接写原始 UID；换算放在 Go
// 里做，Windows / Linux / macOS / Android 都能用。留空时写入空串，回到按当前游戏账号匹配。
type ApplyAccountUidAction struct{}

var _ maa.CustomActionRunner = &ApplyAccountUidAction{}

func (a *ApplyAccountUidAction) Run(ctx *maa.Context, arg *maa.CustomActionArg) bool {
	if ctx == nil {
		log.Error().Str("component", applyAccountUidActionName).Msg("nil context")
		return false
	}

	var params applyAccountUidParam
	if arg != nil && strings.TrimSpace(arg.CustomActionParam) != "" {
		if err := json.Unmarshal([]byte(arg.CustomActionParam), &params); err != nil {
			log.Error().
				Err(err).
				Str("component", applyAccountUidActionName).
				Str("param", arg.CustomActionParam).
				Msg("failed to parse custom_action_param")
			return false
		}
	}

	uid := strings.TrimSpace(params.UID)
	accountID := ""
	if uid != "" {
		id, err := captureuid.AccountIDFromRawUID(uid)
		if err != nil {
			log.Error().
				Err(err).
				Int("uid_length", len(uid)).
				Str("component", applyAccountUidActionName).
				Msg("invalid zipline account uid")
			return false
		}
		accountID = id
	}

	// 任务内 override：只影响本次任务的滑索账号，不会把指定账号泄漏给后续任务。
	if err := ctx.OverridePipeline(map[string]any{
		accountOverrideNode: map[string]any{
			"attach": map[string]any{
				"account_id": accountID,
			},
		},
	}); err != nil {
		log.Error().Err(err).Str("component", applyAccountUidActionName).Msg("failed to override zipline account node")
		return false
	}

	if accountID == "" {
		log.Info().Str("component", applyAccountUidActionName).Msg("no zipline account configured; using the current game account")
		return true
	}
	log.Info().
		Str("component", applyAccountUidActionName).
		Str("account_id", accountID).
		Msg("zipline account configured for this task")
	return true
}
