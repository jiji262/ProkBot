# iOS 扩展签名

补丁默认保留 Widgets、Share 和 NotificationService。签名工具需要为以下四个目标配置描述文件：

| 目标 | Bundle ID |
| --- | --- |
| 主应用 | 传入 `--bundle-id` 的值 |
| Widgets | `<主应用 ID>.widgets` |
| Share | `<主应用 ID>.share` |
| NotificationService | `<主应用 ID>.NotificationService` |

四个目标使用同一个 App Group，默认 `group.<主应用 ID>`，可用 `--app-group` 指定。

共享钥匙串组为 `<AppIdentifierPrefix>.<主应用 ID>.shared`。将它加入四个目标的签名 entitlement，并把各目标 Info.plist 的 `SandKeychainAccessGroups` 设置为包含该组的数组。

生成结果中的 `extension-signing.json` 列出了对应配置。

安装包有 APNs 权限时使用 APNs，在 Host 配置推送凭证；没有 APNs 权限时，在 App 通知设置中填写 Bark 链接。
