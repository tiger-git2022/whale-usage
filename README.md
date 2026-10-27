# Whale Usage（tiger-git2022/whale-usage）

<p align="center">
  <a href="https://github.com/tiger-git2022/whale-usage/releases/latest"><img src="https://img.shields.io/github/v/release/tiger-git2022/whale-usage?style=for-the-badge&label=%E4%B8%8B%E8%BD%BD%E6%9C%80%E6%96%B0%E7%89%88%20%2F%20Download&color=2ea44f" alt="下载最新版 / Download latest"></a>
</p>

<p align="center">
  <a href="https://github.com/tiger-git2022/whale-usage/actions/workflows/build.yml"><img src="https://github.com/tiger-git2022/whale-usage/actions/workflows/build.yml/badge.svg" alt="Build"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/tiger-git2022/whale-usage" alt="License"></a>
</p>

**[⬇ 下载最新版 / Download the latest release](https://github.com/tiger-git2022/whale-usage/releases/latest)**：免安装选 `WhaleUsage-v…-portable.exe`，想装到电脑上选 `WhaleUsage-v…-setup.exe`。/ `…-portable.exe` runs without installing; `…-setup.exe` installs it.

[中文](#中文) | [English](#english)

## 中文

贴在 Claude 桌面 App 旁边的小桌宠，实时显示 Claude 订阅额度：**蓝色**是 5 小时窗口已用百分比，**紫色**是本周窗口已用百分比。用到 70% 变橙、90% 变红，跨过 80% 和 95% 时自动弹气泡提醒。点一下形象可以看进度条和重置倒计时。

> 个人做的非官方小工具，和 Anthropic 没有关系。

### 安装

需要两样东西：

1. **桌面程序**：从上面的链接下载 exe。
2. **`whale-usage-bridge` 插件**：装进 Claude App，负责把额度交给桌面程序。在 Claude 桌面 App 里点输入框旁的 **+** → **Plugins** → **Add marketplace**，填 `tiger-git2022/whale-usage`，再添加 `whale-usage-bridge`。在终端里用 Claude Code 的话：

   ```
   /plugin install whale-usage-bridge --marketplace tiger-git2022/whale-usage
   ```

装好以后，在 Claude 里发一条消息，额度就会出现。

### 下载与更新

- 每次推送 `main` 都会由 GitHub Actions 打包，并发布一个带编号的新版本（[发布页](https://github.com/tiger-git2022/whale-usage/releases)）。版本号形如 `v0.1.0-t3`：前半部分是基础版本，`t` 后面的数字每次发布加一。旧版本都保留，每个版本附上距上一版的更新内容。
- 程序启动时和之后每 6 小时检查一次更新（托盘菜单可以关掉，也可以手动「检查更新」）。有新版本会弹通知，点「下载并更新」会自动下载并替换：免安装版直接换掉 exe 文件，安装版运行新的安装程序，完成后自动重新打开。
- 检查更新读取的是最新版附带的 `update.json`，读不到才用 GitHub API，不受 API 每小时 60 次的限制。

### 使用

| 操作 | 效果 |
| --- | --- |
| 单击形象 | 打开或关闭额度气泡 |
| 按住拖动 | 移动位置，会记住它相对 Claude 窗口的位置；靠近窗口左右边缘会自动吸附 |
| 在形象上滚动滚轮 | 放大或缩小 |
| 托盘图标右键 | 显示时机、大小、音效、开机自启、更换形象、重置位置、检查更新、打开日志、退出 |

额度只在使用 Claude Code（桌面 App 的 Code 标签页或终端）时刷新，不用的时候显示最后一次的数字和重置倒计时。

### 工作原理

- `plugin/`：`whale-usage-bridge` 插件。Claude Code 每次回复后都会报告当前额度，插件把它写进 `~/.claude/whale/usage.json`。用的是官方插件接口，不读取任何登录凭证。
- `src/`：Electron 桌面程序。读取这个文件并显示；通过 Win32 接口找到 Claude 窗口并跟随它，Claude 不在前台或最小化时自动隐藏。
- 运行日志在 `%APPDATA%\Whale Usage\logs\main.log`，托盘菜单「打开日志文件夹」可以直接打开。出问题时请附上这个文件。

### 从源码运行

需要 Node.js 20 以上。

```bash
npm install
npm start
```

打包：`npm run dist`，产物在 `dist/`。国内网络下载 Electron 慢，可以先设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

### 形象素材

默认形象来自 [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)。按原仓库 `PROVENANCE.md` 的说明，图片素材不在 MIT 许可范围内，只是原样提供。如果你是权利人并希望移除，请开 issue。托盘菜单「更换形象…」可以换成任意图片（建议正方形、透明背景的 PNG）。

## English

A desktop pet that sits next to the Claude desktop app and shows your Claude subscription usage: the **blue** number is the 5-hour window, the **purple** one the weekly window. They turn orange at 70% and red at 90%, and a bubble pops up when one passes 80% or 95%. Click the character for progress bars and reset times.

> An unofficial personal tool, not affiliated with Anthropic.

### Install

1. **The desktop app**: download an exe from the link above.
2. **The `whale-usage-bridge` plugin** in Claude, which hands the usage to the app. In the Claude desktop app: **+** next to the prompt box → **Plugins** → **Add marketplace** `tiger-git2022/whale-usage`, then add `whale-usage-bridge`. In a terminal: `/plugin install whale-usage-bridge --marketplace tiger-git2022/whale-usage`.

Send Claude a message and the usage appears.

### Download and updates

- Every push to `main` is built by GitHub Actions and published as a new numbered [release](https://github.com/tiger-git2022/whale-usage/releases) such as `v0.1.0-t3`: the base version, then a build number that grows with each release. Earlier releases stay, and each lists the changes since the one before.
- The app checks at start and every 6 hours (it can be turned off in the tray menu, or run by hand). On a new release it shows a notification; "下载并更新" downloads it and replaces the app: the portable exe swaps its own file, the installed app runs the new installer, and it starts again.
- The check reads the `update.json` attached to the latest release and falls back to the GitHub API, so the API's 60 requests an hour limit does not apply.

### How it works

- `plugin/`: after each Claude Code response, the plugin writes the reported rate-limit usage to `~/.claude/whale/usage.json`, through the official plugin API, without reading any credentials.
- `src/`: the Electron app shows that file, finds the Claude window through Win32 and follows it, and hides while Claude is in the background or minimized.
- The run log is at `%APPDATA%\Whale Usage\logs\main.log` (tray menu: 打开日志文件夹). Attach it when reporting a problem.

### Artwork

The default character comes from [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget); per its `PROVENANCE.md`, the images are provided as-is and are not covered by its MIT license. Rights holders can open an issue to have it removed.

## License

The code is MIT licensed, see [LICENSE](LICENSE). The images in `skins/` and `build/icon.png` are not covered by it.
