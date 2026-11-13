# 额度看板 · macOS

额度看板住在 Mac 右上角的菜单栏里。打开后可以查看各服务当前账号的剩余额度，点进某个服务再看它的所有账号、额度周期和重置时间。

当前版本是 SwiftUI 和 AppKit 实现的 macOS 菜单栏应用，适用于 **Apple Silicon、macOS 26.0 或更新版本**。Windows 版仍在开发中。

## 下载和打开

从 [GitHub Releases](https://github.com/wdfau/quota-board/releases) 下载 Mac 版压缩包，解压并打开「额度看板.app」。应用需要系统的 `/usr/bin/python3` 来读取用量。预发布包使用本地签名，尚未经过 Apple 公证。

首次打开时，先选服务，再勾选要导入的账号，最后确认。在这台 Mac 登录过的账号可以扫描导入。从未登录过，或要添加另一个账号时，在该服务右侧点「添加账号」，在对应客户端或浏览器完成登录，再回到看板点「重新扫描」。如果服务没有返回登录邮箱，导入时可填写用于核对的地址。也可暂不导入，之后从设置补充。

## 在菜单栏查看额度

1. 点 macOS 菜单栏右上角的额度看板图标，查看各服务所选账号最短周期的剩余额度。
2. 点服务的图标或圆环，查看该服务的所有账号。把指针停在详情圆环上可以查看重置时间。
3. 点左上角箭头回到总览，点击面板外部收起。点右下角刷新图标或按 `⌘R` 可以手动更新。
4. 点详情右上角的齿轮打开设置。可以隐藏平台、添加账号、点「切换」打开指定账号，或点铅笔修改显示名称。邮箱用于核对身份。Codex 会退出并重新打开桌面客户端，以应用新登录。
5. 设置底部的「应用操作」可以退出或重新启动额度看板。

[Mac 总览和详情设计稿](https://www.figma.com/design/F3YxSt1aBulzCUxZE6ELzv?node-id=82-247) · [Mac 设置设计稿](https://www.figma.com/design/F3YxSt1aBulzCUxZE6ELzv?node-id=31-3)

详情中的账号可通过右键修改显示名称或打开官方用量页。自动刷新约每五分钟运行一次。读取失败时，界面会在可核对账号身份的情况下保留上次额度，并标记为旧数据。

## 账号和数据来源

| 服务 | Mac 版的读取方式 |
| --- | --- |
| Codex | 读取现有登录或通过 Codex CLI 添加独立登录。切换会保留原登录并更新桌面客户端的登录。 |
| Kiro | 读取 Kiro CLI 默认及已有独立配置。切换会在终端打开指定账号。 |
| Cursor | 读取 Cursor 桌面登录。添加和切换可打开独立配置的 Cursor 窗口。 |
| Claude | 通过 Claude Code 添加订阅账号，通过其登录读取额度。切换会在终端打开指定账号。 |
| GitHub Copilot | 使用 GitHub CLI 授权和切换，读取该账号可查询的 Copilot 用量。 |

Cursor 和 Claude 首次读取时，可以在设置里点「授权读取」。显示名称、用于核对的邮箱及额度缓存在本机。Claude 和 Kiro 的「切换」作用于新开的终端会话，Copilot 的「切换」作用于 GitHub CLI。

## 从源码构建

在 Apple Silicon Mac 上安装 Xcode Command Line Tools 后，运行：

```sh
git clone https://github.com/wdfau/quota-board.git
cd quota-board
./build.command
open 额度看板.app
```

构建使用 `src/` 下的原生应用、用量读取组件和 Python worker，并将仓库中固定版本的 CodexBar CLI 放进应用包。第三方许可和声明见 [CodexBar 许可证](CodexBar-LICENSE)、[CLI 第三方声明](vendor/THIRD_PARTY_NOTICES) 和 [图标许可证](src/BrandIcons/LobeIcons-LICENSE)。
