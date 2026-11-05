# AI installation guide

Goal: deploy ProkBot, configure its model and connect the clients.

## Before starting

Ask together for: local or remote Host and working directory; Mac / iOS clients and local Mac control; LAN / Tailcat / existing HTTPS access; model endpoint, API key and model ID; and the administrator password for a new deployment. Remote deployment also needs connection details.

Check architecture, memory, disk space and existing deployments. Reuse existing configuration and back up before updating. Install missing Python 3.10+ and Docker Compose. Mac patching runs on an Apple Silicon Mac with Node.js 22.12+.

## Inputs and outputs

| Resource | Processing | Output |
| --- | --- | --- |
| Linux desktop | Build tool pulls the pinned official `9d2ac1b` amd64 image | Execution computer container |
| Host | Tool downloads stable Host `d0a4baa`, applies patches and builds | `grokbot-host:local` image |
| Mac | Patcher downloads and verifies the 0.71.2 Apple Silicon original and patches it | `mac/output.noindex/Grok Bot.app` |
| iOS | Download the patched unsigned IPA from Releases, or use the cleaned original decrypted 1.16.0 (23152) IPA to build it | Unsigned IPA retaining all three extensions |

## Deploy the Host

Obtain the repository. Save access settings in `.env` in the deployment directory and add `--env-file .env` consistently to subsequent Compose commands. Set `GROKBOT_LISTEN_ADDRESS`, `GROKBOT_PUBLIC_PORT`, `GROKBOT_PUBLIC_URL` and the user's timezone `TZ`. LAN access uses `0.0.0.0`, with port 18080 by default. Store model credentials in Host configuration.

The example uses a new project named `prokbot`; reuse the project name and volumes of an existing deployment. Run from the repository root:

```sh
python3 host/release/build-docker.py
docker compose --env-file .env -p prokbot -f host/release/compose.yaml up -d
docker compose --env-file .env -p prokbot -f host/release/compose.yaml exec host cat /data/setup-key
```

Images use Linux amd64; Docker on Apple Silicon uses emulation. For a separate Host and execution computer, select the Compose files described in `host/docs/DEPLOYMENT.en.md`.

Open the administration page, initialize the administrator account, configure the user's model endpoint and key, select a model and test it. Configure and verify Tailcat under Remote Access when selected.

Use the administration UI or consult `host/server/index.mjs` for the current request formats and sessions:

| Purpose | Endpoint |
| --- | --- |
| Initialization and login state | `GET /admin/api/session` |
| Initialize / log in | `POST /admin/api/setup`, `POST /admin/api/login` |
| Configure / test model | `PUT /admin/api/model`, `POST /admin/api/model/test` |
| Check conversation core | `host.connected` in `GET /admin/api/status` |
| Create pairing code | `POST /admin/api/pairing-keys` |

Management endpoints require a login cookie except session and setup/login routes. Mutations include the Host's `Origin`. Create a code when each client is ready: it lasts five minutes and can be used once.

## Mac client

On the user's Mac, run from the repository root:

```sh
node mac/patchers/desktop/patch.mjs
```

Add `--identity auto` when local graphical control is requested and an existing certificate is available. If downloading fails, follow the Patcher's instructions: ask for an original `.app` / `.dmg` and use `--source`.

Install `mac/output.noindex/Grok Bot.app` into Applications. Zip an existing app before updating and preserve its user configuration. Keep builds and temporary apps in `.noindex` directories. Open the app, enter the Host address and a new pairing code, and enable Tailcat when selected. For local control, ask the user to grant Accessibility and Screen Recording access and verify a computer operation.

## iOS client

Use `ProkBot-iOS-1.16.0-unsigned.ipa` from the project release page for user signing and installation. To patch it yourself, use `GrokBot-1.16.0-23152-decrypted-clean.ipa` from the same page:

```sh
python3 ios/release/patch-ios.py \
  --input /path/to/GrokBot-decrypted.ipa \
  --output ./output.noindex/ios \
  --bundle-id dev.grokbot.local
```

Match an existing signing configuration's Bundle ID / App Group. See `ios/docs/SIGNING.en.md` and the generated `extension-signing.json`. Keep Widgets, Share and NotificationService. The user signs and installs the IPA, then connects with the Host address and a fresh pairing code.

## Verify and hand over

- Check container state, `/healthz`, the model connection test and the conversation core in the administration page.
- Connect the selected clients, read the Bot list and complete a short conversation. Verify access over the selected network.
- Provide the administration and client Host URLs, deployment directory, data volumes, app file locations and verification results. Report the actual progress of iOS signing and installation.
- Provide start, stop, logs, backup and update commands with the same Compose project, files and environment settings. Use `host/release/backup.py` for backups and preserve data volumes.
