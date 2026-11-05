# ProkBot iOS Patch

Patch a decrypted Grok Bot 1.16.0 (23152), arm64 IPA. The app and all three extensions must be decrypted. Requires Python 3.10+.

[简体中文](README.md)

## Use

Get the supported version from [the IPA download page](https://decrypt.day/app/id6794501026).

```sh
python3 release/patch-ios.py \
  --input /path/to/GrokBot-decrypted.ipa \
  --output ./GrokBot-Patched \
  --bundle-id dev.grokbot.local
```

Outputs `GrokBot-Local-resignable.ipa`, `GrokBotLocal.dylib` and `extension-signing.json`. Sign and install with your own tools, then enter your Host address and six-character pairing code.

[Extension signing](docs/SIGNING.en.md) · Configure APNs or Bark in the Host console. Enable realtime voice in app settings.

## License and support

Noncommercial use only. See [LICENSE](LICENSE). Most code in this project was generated with AI assistance.
