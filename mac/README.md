# ProkBot Mac Patch

为 Grok Bot 0.71.2 Apple Silicon 客户端连接自己的 Host。需要 Node.js 22.12+。

[English](README.en.md)

## 使用

```sh
node patchers/desktop/patch.mjs
```

工具自动下载并校验 0.71.2 Apple Silicon 原版，生成 `output.noindex/Grok Bot.app`。移入「应用程序」，填写 Host 地址和六位配对码。

已有原版 `.app` 或 `.dmg` 时，可增加 `--source "/path/to/Grok Bot.app"`。

需要控制本机图形界面时，在命令中增加 `--identity auto`，使用已有签名证书。

## 许可与支持

仅限非商业使用，见 [LICENSE](LICENSE)。本项目多数代码由 AI 辅助生成。
