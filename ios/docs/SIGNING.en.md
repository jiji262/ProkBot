# Signing iOS extensions

The patch preserves Widgets, Share and NotificationService. Configure a provisioning profile for each target:

| Target | Bundle ID |
| --- | --- |
| Main app | Your `--bundle-id` value |
| Widgets | `<main ID>.widgets` |
| Share | `<main ID>.share` |
| NotificationService | `<main ID>.NotificationService` |

Use the same App Group for all targets, defaulting to `group.<main ID>`. Set another group with `--app-group`.

Authorize `<AppIdentifierPrefix>.<main ID>.shared` in each target's keychain entitlements. Set each Info.plist's `SandKeychainAccessGroups` array to include this group.

The generated `extension-signing.json` lists the configuration.

An app signed with APNs entitlements uses APNs credentials configured in the Host. Otherwise, enter a Bark URL in the app's notification settings.
