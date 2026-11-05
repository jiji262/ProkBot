# ProkBot Host Patch

自建 Grok Bot 服务端。需要 Python 3.10+、Docker Compose，运行架构为 Linux amd64。

[English](README.en.md)

## 使用

```sh
python3 release/build-docker.py
docker compose -f release/compose.yaml up -d
docker compose -f release/compose.yaml exec host cat /data/setup-key
```

打开 `http://127.0.0.1:18080`，用初始化码设置管理员账号，配置模型并生成六位配对码。

需要局域网访问时，先设置 `export GROKBOT_LISTEN_ADDRESS=0.0.0.0`，再运行 Compose。

[远程访问、分开部署与备份](docs/DEPLOYMENT.md) · [应用开发](PLUGINS.md)

## 许可与支持

仅限非商业使用，见 [LICENSE](LICENSE)。本项目多数代码由 AI 辅助生成。
