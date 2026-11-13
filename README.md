# 额度看板 · macOS

额度看板住在 Mac 右上角的菜单栏里。打开后可以查看各服务当前账号的剩余额度，点进某个服务再看它的所有账号、额度周期和重置时间。

当前版本是 SwiftUI 和 AppKit 实现的 macOS 菜单栏应用，适用于 **Apple Silicon、macOS 26.0 或更新版本**。Windows 版仍在开发中。

## 下载和打开

从 [GitHub Releases](https://github.com/wdfau/quota-board/releases) 下载 Mac 版压缩包，解压并打开「额度看板.app」。应用需要系统的 `/usr/bin/python3` 来读取用量。预发布包使用本地签名，尚未经过 Apple 公证。

从 1.5.2 起，首次打开会显示三步引导，依次介绍菜单栏入口、示例额度和账号接入。可以跳过，也可以点击看板底部的问号重新打开。退出引导后会开始读取本机账号的额度。

## 在菜单栏查看额度

1. 点 macOS 菜单栏右上角的额度看板图标，查看各服务当前账号的剩余额度。
2. 点服务的图标或圆环，查看该服务的所有账号。把指针停在详情圆环上可以查看重置时间。
3. 点左上角箭头回到总览，点击面板外部收起。点右下角刷新图标或按 `⌘R` 可以手动更新。

详情中的账号可通过右键修改显示名称或打开官方用量页。自动刷新约每五分钟运行一次。读取失败时，界面会在可核对账号身份的情况下保留上次额度，并标记为旧数据。

## 账号和数据来源

| 服务 | Mac 版的读取方式 |
| --- | --- |
| Codex | 从本机已登录的 Codex 配置读取。当前原型使用 `~/.codex-n`、`~/.codex-b` 和 `~/.codex-w`，并尝试匹配当前桌面登录账号。 |
| Kiro | 从本机独立的 Kiro CLI 账号目录读取额度，按最近使用的入口识别当前账号。 |
| Cursor | 读取本机 Cursor 当前登录账号的额度。 |
| Gemini | 从受支持浏览器中已登录的 Google 账号读取网页额度。Mac 版 Gemini 的账号切换使用其桌面客户端。 |

Cursor 和 Gemini 首次读取时，macOS 可能要求授予本机读取组件相应权限。Gemini 桌面账号切换另需用户在系统设置中允许辅助功能。显示名称、额度和时间戳缓存保存在本机的 `~/Library/Application Support/QuotaBoard/`。

## 从源码构建

在 Apple Silicon Mac 上安装 Xcode Command Line Tools 后，运行：

```sh
git clone https://github.com/wdfau/quota-board.git
cd quota-board
./build.command
open 额度看板.app
```

构建使用 `src/` 下的原生应用、用量读取组件和 Python worker，并将仓库中固定版本的 CodexBar CLI 放进应用包。第三方许可和声明见 [CodexBar 许可证](CodexBar-LICENSE)、[CLI 第三方声明](vendor/THIRD_PARTY_NOTICES) 和 [图标许可证](src/BrandIcons/LobeIcons-LICENSE)。
