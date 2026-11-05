# 部署与备份

## 构建

需要 Python 3.10+、Docker 和 Compose。支持 Linux x86_64；Apple Silicon 可以构建 amd64 镜像。

```sh
python3 release/build-docker.py --host-archive /path/to/sand-host-bundle-d0a4baa.tgz
docker compose -f release/compose.yaml up -d
```

省略 `--host-archive` 时从固定来源下载。离线 Box 归档使用 `--box-archive /path/to/box.tar.gz`；构建工具校验后设置本地标签 `grokbot-box-input:9d2ac1b`，Compose 直接使用该镜像。原始资源严格校验，版本见 `recipes/host/manifest.json` 和 `release/build-docker.py`。

打开 `http://127.0.0.1:18080`，读取初始化码并设置管理员密码：

```sh
docker compose -f release/compose.yaml exec host cat /data/setup-key
```

在管理页配置模型，生成六位配对码，再从客户端连接。局域网部署可设置 `GROKBOT_LISTEN_ADDRESS=0.0.0.0`；端口由 `GROKBOT_PUBLIC_PORT` 设置。需要公网访问时使用 HTTPS 反向代理或启用 Tailcat。

## 数据与更新

Compose 持久保存 `host-data`、`box-home`、`box-workspace` 三个卷。备份工具暂停正在运行的容器，保存卷与摘要后恢复运行。恢复到一个新的 Compose 项目，不覆盖现有卷：

```sh
python3 release/backup.py backup --project grokbot --directory backups/2026-10-21 --image grokbot-host:local
python3 release/backup.py restore --project grokbot-restored --directory backups/2026-10-21 --image grokbot-host:local
docker compose -p grokbot-restored -f release/compose.yaml up -d
```

恢复时使用备份对应的镜像。恢复实例与原实例共享同一身份，切换前停止原实例。

## 独立执行电脑与插件

只部署 Host 使用 `release/compose.host.yaml`。另外一台电脑部署执行节点：

```sh
python3 release/build-docker.py --box-only
# 设置至少 32 位随机 GROKBOT_NODE_TOKEN；离线镜像可在上条命令增加 --box-archive
docker compose -f release/compose.execution.yaml up -d --build
```

在 Host 管理页填写执行节点地址和密钥。局域网可设置 `GROKBOT_NODE_LISTEN_ADDRESS=0.0.0.0`，端口默认 18443；启用内嵌网络使用 `GROKBOT_TAILCAT_ENABLED=1`，高级选项为 `GROKBOT_TAILCAT_RELAY` 和 `GROKBOT_TAILCAT_DERP_MAP_URL`。

应用统一在管理页导入、配置和导出分享。代码应用直接运行在现有执行电脑上，无需额外容器。

包格式、授权、附带技能见 [应用开发](../PLUGINS.md)。

`release/patch-host.py --archive ORIGINAL --output NEW_DIRECTORY` 可单独生成 Host 文件并记录补丁耗时。生成过程仅执行固定字节复制与新增规则，不调用 AI 或反编译软件。
