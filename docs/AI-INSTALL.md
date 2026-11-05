# 给 AI 的安装指南

目标：完成 ProkBot 部署、模型配置和客户端连接。

## 开始前

一次询问：Host 部署在本机还是远程机器及工作目录、需要 Mac / iOS 哪些客户端及是否控制 Mac、本机或远程的访问方式（局域网 / Tailcat / 已有 HTTPS）、模型接口地址 / API Key / 模型 ID，以及新部署的管理员密码。远程部署还需要连接方式。

检查目标机器架构、内存、磁盘和已有部署；复用用户已有配置，更新前使用备份工具保存数据。安装缺少的 Python 3.10+、Docker Compose；Mac 补丁在 Apple Silicon Mac 上运行，需要 Node.js 22.12+。

## 资源与输出

| 资源 | 处理方式 | 输出 |
| --- | --- | --- |
| Linux 桌面 | 构建工具拉取固定的官方 `9d2ac1b` amd64 镜像 | 执行电脑容器 |
| Host | 工具下载 stable Host `d0a4baa`，应用补丁并构建 | `grokbot-host:local` 镜像 |
| Mac | Patcher 下载并校验 0.71.2 Apple Silicon 原版，应用补丁 | `mac/output.noindex/Grok Bot.app` |
| iOS | 从仓库发行页下载已注入的未签名 IPA；也可下载清理后的 1.16.0（23152）原版砸壳 IPA，自行生成 | 未签名 IPA，保留三个扩展 |

## 部署 Host

获取仓库后，将访问设置写入部署目录的 `.env`，后续 Compose 命令统一加 `--env-file .env`。按选择设置 `GROKBOT_LISTEN_ADDRESS`、`GROKBOT_PUBLIC_PORT`、`GROKBOT_PUBLIC_URL` 和用户时区 `TZ`。局域网监听使用 `0.0.0.0`，默认端口 18080。模型凭据保存在 Host 配置中。

以下以新项目 `prokbot` 为例；已有部署沿用原项目名与数据卷。从仓库根目录执行：

```sh
python3 host/release/build-docker.py
docker compose --env-file .env -p prokbot -f host/release/compose.yaml up -d
docker compose --env-file .env -p prokbot -f host/release/compose.yaml exec host cat /data/setup-key
```

镜像运行架构为 Linux amd64；Apple Silicon Docker 使用转译。Host 与 Linux 桌面可以分开部署，分开时按 `host/docs/DEPLOYMENT.md` 选择对应 Compose。

打开 Host 管理页，完成管理员初始化，填写用户的模型接口与 Key、选择模型并测试连接。需要 Tailcat 时，在「远程访问」配置并检查连接。

可通过管理页操作，也可参考 `host/server/index.mjs` 的管理接口；请求格式与会话处理以该版本源码为准：

| 用途 | 接口 |
| --- | --- |
| 查询初始化与登录状态 | `GET /admin/api/session` |
| 初始化 / 登录 | `POST /admin/api/setup`、`POST /admin/api/login` |
| 模型配置 / 测试 | `PUT /admin/api/model`、`POST /admin/api/model/test` |
| 检查对话核心 | `GET /admin/api/status` 的 `host.connected` |
| 生成配对码 | `POST /admin/api/pairing-keys` |

除会话查询与登录初始化外，管理接口需要登录 Cookie；修改请求带 Host 对应的 `Origin`。每台客户端就绪后再分别生成配对码，配对码 5 分钟有效、使用一次。

## Mac 客户端

在用户的 Mac 上，从仓库根目录执行：

```sh
node mac/patchers/desktop/patch.mjs
```

用户需要本机图形控制且已有签名证书时，增加 `--identity auto`。下载失败时，按 Patcher 提示请用户提供原版 `.app` / `.dmg`，用 `--source` 继续。

将生成的 `mac/output.noindex/Grok Bot.app` 安装到「应用程序」。已有客户端更新时先压缩备份，保留原用户配置；构建与临时 App 放在 `.noindex` 目录。打开 App，填写 Host 地址和新的配对码，按访问方式启用 Tailcat。需要本机控制时，请用户完成辅助功能与屏幕录制授权，并验证一次电脑操作。

## iOS 客户端

优先使用项目发行页的 `ProkBot-iOS-1.16.0-unsigned.ipa`，由用户自行签名安装。需要自行注入时，使用同页的 `GrokBot-1.16.0-23152-decrypted-clean.ipa`：

```sh
python3 ios/release/patch-ios.py \
  --input /path/to/GrokBot-decrypted.ipa \
  --output ./output.noindex/ios \
  --bundle-id dev.grokbot.local
```

已有签名配置时使用匹配的 Bundle ID / App Group；扩展配置见 `ios/docs/SIGNING.md` 与输出的 `extension-signing.json`。保留小组件、分享和通知三个扩展。由用户自行签名安装，再填写 Host 地址和新的配对码。

## 完成验证

- 检查容器状态、`/healthz`、模型连接测试和管理页中的对话核心状态。
- 连接选定的客户端，确认能读取 Bot 列表，完成一条简短对话；检查所选网络方式从客户端可访问。
- 向用户交付管理页 / 客户端 Host 地址、部署目录、数据卷、客户端文件位置和本次验证结果；iOS 签名安装的实际进度如实列出。
- 给出同一 Compose 项目、文件和环境参数下的启动、停止、日志、备份与更新命令。备份使用 `host/release/backup.py`，不要删除数据卷。
