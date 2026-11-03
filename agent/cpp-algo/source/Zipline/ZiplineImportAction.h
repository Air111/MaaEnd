#pragma once

#include <MaaFramework/MaaAPI.h>

namespace zipline
{

// 被动复制官方地图页取回的滑索标记; 默认 profile 在 agent/<exe>.WebView2, attach.uid 选择
// debug/record/<uid> 的账号 profile, attach.clear_login 仍可由 API 用来清空该 profile 的登录态
MaaBool MAA_CALL ZiplineImportActionRun(
    MaaContext* context,
    MaaTaskId task_id,
    const char* node_name,
    const char* custom_action_name,
    const char* custom_action_param,
    MaaRecoId reco_id,
    const MaaRect* box,
    void* trans_arg);

} // namespace zipline
