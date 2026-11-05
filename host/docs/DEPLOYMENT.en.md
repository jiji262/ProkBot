# Deployment and backups

Requires Python 3.10+, Docker and Compose. The runtime uses Linux amd64.

```sh
python3 release/build-docker.py --host-archive /path/to/sand-host-bundle-d0a4baa.tgz
docker compose -f release/compose.yaml up -d
docker compose -f release/compose.yaml exec host cat /data/setup-key
```

Open `http://127.0.0.1:18080`, initialize the administrator account, configure a model and create a six-character pairing code. Omitting `--host-archive` downloads the pinned input. `--box-archive` accepts an offline docker-save archive. After verification, the build tool assigns `grokbot-box-input:9d2ac1b` for Compose to use locally. Inputs are verified against fixed identities.

Use `GROKBOT_LISTEN_ADDRESS=0.0.0.0` for LAN access and `GROKBOT_PUBLIC_PORT` for a different port. For remote access, use HTTPS or optional Tailcat.

The `host-data`, `box-home` and `box-workspace` volumes retain data. The backup tool pauses running containers, saves all project volumes with checksums and resumes them. Restore into a new project without overwriting existing volumes:

```sh
python3 release/backup.py backup --project grokbot --directory backups/2026-10-21 --image grokbot-host:local
python3 release/backup.py restore --project grokbot-restored --directory backups/2026-10-21 --image grokbot-host:local
docker compose -p grokbot-restored -f release/compose.yaml up -d
```

Use the image version matching the backup. The restored instance retains the same identity; stop the original instance before starting the restored one.

Use `release/compose.host.yaml` for a standalone Host. Deploy an execution node on another computer:

```sh
python3 release/build-docker.py --box-only
# Set a random GROKBOT_NODE_TOKEN of at least 32 characters. Add --box-archive above for an offline image.
docker compose -f release/compose.execution.yaml up -d --build
```

Configure its address and key in the Host console. Set `GROKBOT_NODE_LISTEN_ADDRESS=0.0.0.0` for LAN access on port 18443. Enable optional embedded networking with `GROKBOT_TAILCAT_ENABLED=1`; advanced options are `GROKBOT_TAILCAT_RELAY` and `GROKBOT_TAILCAT_DERP_MAP_URL`.

Manage, import and export all applications from Applications. Code apps run on the existing execution computer without extra containers.

See [Application development](../PLUGINS.en.md) for package format, OAuth and bundled skills.
