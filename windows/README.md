# 额度看板 · Windows 预览版

适用于 Windows 11 x64。从 [GitHub Release](https://github.com/wdfau/quota-board/releases/tag/windows-v1.0.0) 下载 `QuotaBoard-windows-x64-1.0.0.zip`，解压整个目录，双击 `Quota Board.exe`。有仓库访问权限的账号可直接下载。预览版应用未签名。

额度看板入口在任务栏通知区域，也可以在隐藏图标菜单中找到。首次打开会引导选择平台、勾选账号、确认导入。总览显示当前账号的最短额度周期，平台详情显示该平台所有已导入账号的额度和重置时间。双击另一个账号并确认即可切换。右上角齿轮进入设置，设置右下角电源图标可退出或重启。

| 平台 | Windows 预览版的读取方式 |
| --- | --- |
| Codex | 安装并登录 Codex CLI 后重新扫描。可读取官方 CLI 返回的周期。 |
| GitHub Copilot | 安装并登录 Copilot CLI 后重新扫描。使用官方 SDK 读取可用配额。若 CLI 安装方式只提供 `.cmd`，需要安装能在 PATH 中调用的原生 `copilot.exe`。 |
| Claude | 安装并登录 Claude Code 可识别当前 CLI 身份。额度需在设置中连接 [Claude Code 状态栏](https://code.claude.com/docs/en/statusline) 导出的本机快照。 |
| Kiro | 可扫描 Kiro CLI 的当前账号。额度可在 Kiro CLI 输入 `/usage` 或从官网核对，并手动记录。 |
| Cursor | 添加邮箱确认账号，再从官网核对并手动记录额度。 |

对于 Codex 或 Copilot，设置中的「添加账号 → 官方登录」会打开独立 CLI 配置。切换后更新看板的当前账号，选中的独立 CLI 配置会在终端中打开。各服务的桌面应用登录由平台管理。官方未返回数值时，额度显示为「暂无额度」。

Claude 状态栏写入额度的脚本位于 `scripts/claude-statusline.mjs`，需使用 Node.js。它接收 Claude Code 的状态栏 JSON，并写入所指定的快照路径。配置状态栏命令时使用脚本和输出文件的绝对路径，例如 `node C:/quota-board/windows/scripts/claude-statusline.mjs C:/quota-board-data/claude-usage.json`。在额度看板中选择该文件连接。

## 从源码构建

在 Windows 安装 Node.js 22 或更新版本，然后从仓库根目录执行：

```powershell
cd windows
npm ci
npm test
npm run test:ui
npm run dist
```

压缩包生成在 `windows/release`。测试使用独立的临时用户目录和示例账号。
