# 进度 / Status

2026-11-05

- [x] Mac、iOS、Host 独立补丁工具；校验用户原版输入，保留原文件。
- [x] 用户本地生成 Docker 镜像；DSM 实机部署、模型与工具、备份恢复验证。
- [x] 可选 Tailcat、主/成员 Host、独立执行节点、自定义 DERP。
- [x] 原 Bot/Skill 发布界面与 Host 导入导出。
- [x] Bark 图标、分组、前台抑制及会话跳转。
- [x] Mac 使用原播放组件和系统回声处理，实际插话验证。
- [x] iOS 原生回声处理、AEC3 与持续讲话缓冲；实验性通话默认关闭，已安装实测。
- [ ] 真人近距离插话、耳机及蓝牙路由的进一步验证。
- [x] 统一应用、Mac Codex 委派、群聊成员与名称持久化。
- [x] 中英文 Host 管理界面、K/M 上下文配置和共享通知频率。
- [ ] 耳机/蓝牙切换与 Wi-Fi/蜂窝切换的真实设备验证。现有 iPhone 11 测试设备没有 SIM 卡。

The three patch tools and Docker deployment are implemented and validated with user-supplied originals. iOS voice includes native echo processing, AEC3 and buffered interruption; the experimental voice feature is disabled by default. Headphone/Bluetooth and cellular transitions still need matching hardware for validation.

- [x] 2026-10-27：Mac 原附件预览与下载；Host 补丁运行依赖补齐并检查。 / Mac attachment previews and downloads; Host patch runtime dependency fix and checks.

- [x] 2026-10-27：Mac 附件暂存/上传与手机图片读取；iOS 通话 TLS 兼容与音频清理；Host 附件复制到独立执行节点。
- [x] Mac 麦克风：用户重新切换系统麦克风权限后恢复；虚拟麦克风完整通话通过。
- [ ] 剪贴板图片完整 UI 验收待完成。
- [x] 2026-10-27：启动时先恢复 Host 凭据，已连接客户端不再预先显示连接窗口。

- [x] 2026-10-29：Mac 外部链接、原预览与右键菜单；iOS Tailcat 串行状态、请求前启动、同端口恢复及真实连接状态。
- [x] 34 项 Mac 测试、原生网络生命周期测试、Go race 与真实公共 DERP 传输通过；iOS arm64 构建通过。
- [ ] 本版 iPhone 11 冷启动、后台返回与网络切换复验；本轮没有连接的测试设备。

- [x] 2026-10-29：Mac 恢复原生 Command+W，关闭后保留后台进程，重新打开恢复原会话；13 项测试及实际键盘操作通过。

- [x] 2026-11-01：精简公开版 README、安装文档与发布说明，准备三个补丁包。

- [x] 2026-11-01：Mac 补丁自动下载指定原版，支持缓存与本地输入；实际下载、生成与签名检查通过。

- [x] 2026-11-01：README 提供可复制的 AI 安装指令，具体步骤放入独立指南，加入 iOS 下载入口。

- [x] 2026-11-05：Mac Bot 置顶、分组与折叠状态恢复；复用原 Host 设置，自动化和原界面冷启动验证通过。 / Restore Mac Bot pins, sidebar groups and collapse state using existing Host settings.
