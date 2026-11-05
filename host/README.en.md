# ProkBot Host Patch

Self-host the Grok Bot server. Requires Python 3.10+ and Docker Compose; the runtime uses Linux amd64.

[简体中文](README.md)

## Use

```sh
python3 release/build-docker.py
docker compose -f release/compose.yaml up -d
docker compose -f release/compose.yaml exec host cat /data/setup-key
```

Open `http://127.0.0.1:18080`, use the setup code to create an administrator account, configure a model and create a six-character pairing code.

For LAN access, run `export GROKBOT_LISTEN_ADDRESS=0.0.0.0` before starting Compose.

[Remote access, separate deployment and backups](docs/DEPLOYMENT.en.md) · [Application development](PLUGINS.en.md)

## License and support

Noncommercial use only. See [LICENSE](LICENSE). Most code in this project was generated with AI assistance.
