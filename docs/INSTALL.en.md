# Installation

[Install with AI](AI-INSTALL.en.md).

## 1. Deploy the Host

Requires Python 3.10+ and Docker Compose. The runtime is Linux amd64; Apple Silicon Macs use emulation.

From `host/` in the repository or extracted patch archive:

```sh
python3 release/build-docker.py
docker compose -f release/compose.yaml up -d
docker compose -f release/compose.yaml exec host cat /data/setup-key
```

Open `http://127.0.0.1:18080` and create an administrator account with the setup code. Enter a model endpoint and API key, then create a six-character pairing code under Devices & Notifications.

## 2. Install an app

| App | Original input | Instructions |
| --- | --- | --- |
| Mac | Automatically downloads Grok Bot 0.71.2 for Apple Silicon | [Patch the app](../mac/README.en.md) and move it into Applications |
| iOS | Decrypted Grok Bot 1.16.0 (23152), arm64 IPA including all three decrypted extensions | [Patch the IPA](../ios/README.en.md), then sign and install it |

Open the app and enter the Host address and six-character pairing code.

Mac graphical control requires certificate signing. See [Extension signing](../ios/docs/SIGNING.en.md) for the iOS app and extensions.

## 3. Connect other devices

For LAN access, set the listen address from `host/`, then start Compose. Enter this computer's LAN IP and port `18080` in the client.

```sh
export GROKBOT_LISTEN_ADDRESS=0.0.0.0
docker compose -f release/compose.yaml up -d
```

For remote access, enable Tailcat under Remote Access on the Host and in the client's connection settings. An existing Tailscale network or HTTPS address also works.

[Separate deployment and backups](../host/docs/DEPLOYMENT.en.md) · [Application development](../host/PLUGINS.en.md)
