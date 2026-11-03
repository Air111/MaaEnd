package zipline

import maa "github.com/MaaXYZ/maa-framework-go/v4"

// Register 注册与保存的滑索路线相关的自定义动作。
func Register() {
	maa.AgentServerRegisterCustomAction(actionName, &RouteGoAction{})
}
