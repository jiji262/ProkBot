# v2026.11.05

- Mac：修复 Bot 置顶、分组及折叠状态保存。
- Host 无需更新。

# v2026.11.02

- iOS：修复锁屏后 Tailcat 持续重连，回到前台可自动恢复连接。

# v2026.11.01

首个公开补丁版本：使用自己的 Host 和模型，保留 Grok Bot 的 Mac、iOS 界面。

- `ProkBot-Desktop-Patch.zip`：Mac 补丁，自动下载 0.71.2 Apple Silicon 原版并生成客户端。
- `ProkBot-iOS-Patch.zip`：iOS 补丁，支持 1.16.0（23152）砸壳 IPA，生成后自行签名。
- `ProkBot-Host-Patch.zip`：Host 补丁与 Docker 部署工具。
- `GrokBot-1.16.0-23152-decrypted-clean.ipa`：清理后的原版砸壳包，保留三个扩展。
- `ProkBot-iOS-1.16.0-unsigned.ipa`：已注入补丁的 IPA，自行签名安装。

[安装说明](docs/INSTALL.md) · 仅限非商业使用。
