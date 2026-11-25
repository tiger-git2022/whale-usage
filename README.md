# Whale Usage（tiger-git2022/whale-usage）

<p align="center">
  <a href="https://github.com/tiger-git2022/whale-usage/releases/latest"><img src="https://img.shields.io/github/v/release/tiger-git2022/whale-usage?style=for-the-badge&label=%E4%B8%8B%E8%BD%BD%E6%9C%80%E6%96%B0%E7%89%88%20%2F%20Download&color=2ea44f" alt="下载最新版 / Download latest"></a>
</p>

<p align="center">
  <a href="https://github.com/tiger-git2022/whale-usage/actions/workflows/build.yml"><img src="https://github.com/tiger-git2022/whale-usage/actions/workflows/build.yml/badge.svg" alt="Build"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/tiger-git2022/whale-usage" alt="License"></a>
</p>

**[⬇ 下载最新版 / Download the latest release](https://github.com/tiger-git2022/whale-usage/releases/latest)**：下载 `WhaleUsage-v…-portable.exe`，免安装，放在任意文件夹双击运行。/ Download `WhaleUsage-v…-portable.exe`; it runs from any folder without installing.

[中文](#中文) | [English](#english)

## 中文

贴在 Claude 和 Antigravity（反重力）桌面 App 旁边的小桌宠，实时显示订阅额度：
- **Claude 模式**：**蓝色**是 5 小时窗口已用百分比，**紫色**是本周窗口已用百分比。
- **Antigravity 模式**：根据当前选择的模型（Gemini Pro / Gemini Flash / Claude / GPT 等）自动切换对应分组额度，点击气泡可同时查看所有分组并可手动固定分组；同时实时读取每个反重力任务的上下文窗口占用（Token 数、压缩阈值百分比、模型与构成明细），脚下胶囊换行显示当前任务 `上下文 %`，点任务卡片可固定追踪。

统一以「已用 %」展示，用到 70% 变橙、90% 变红，跨过 80% 和 95% 时自动弹气泡提醒。点一下形象可以看进度条和重置倒计时。

> 个人做的非官方小工具，和 Anthropic / Google 没有关系。

### 安装

需要两样东西：

1. **桌面程序**：从上面的链接下载 exe。
2. **`whale-usage-bridge` 插件**：装进 Claude App，负责把额度交给桌面程序。在 Claude 桌面 App 里点输入框旁的 **+** → **Plugins** → **Add marketplace**，填 `tiger-git2022/whale-usage`，再添加 `whale-usage-bridge`。在终端里用 Claude Code 的话：

   ```
   /plugin install whale-usage-bridge --marketplace tiger-git2022/whale-usage
   ```

装好以后，在 Claude 里发一条消息，额度就会出现。

添加时如果提示「无法连接到市场」，是 Claude App 连不上 GitHub：它下载插件时用的是 git，不走系统代理。开着代理的话，让 git 访问 GitHub 时走代理就行（端口换成你自己代理的）：

```
git config --global http.https://github.com.proxy http://127.0.0.1:7890
```

### 下载与更新

- 每次推送 `main` 都会由 GitHub Actions 打包，并发布一个新版本（[发布页](https://github.com/tiger-git2022/whale-usage/releases)）。版本号是 `vX.Y.Z`：修 bug 和小调整涨 Z，加新功能涨 Y，大改涨 X。旧版本都保留（2026-11 以前的是 `v0.1.0-t013` 这种写法），每个版本附上距上一版的更新内容。
- 程序启动时和之后每 6 小时检查一次更新，有新版本就直接在后台下载，下载完自动退出、替换原来的 exe 文件并重新打开，前后只要几秒，会弹通知告诉你。右键菜单里可以关掉「自动更新」，也可以随时点「检查更新」立刻更新。
- 检查更新读取的是最新版附带的 `update.json`，读不到才用 GitHub API，不受 API 每小时 60 次的限制。

### 使用

| 操作 | 效果 |
| --- | --- |
| 单击形象 | 打开或关闭额度气泡 |
| 按住拖动 | 移动位置，会记住它相对输入框（或 Claude 窗口）的位置；靠近右边缘会自动吸附 |
| 在形象上滚动滚轮 | 放大或缩小 |
| 右键形象或托盘图标 | 打开菜单：显示时机、大小、切换形象、用自己的图片、贴着输入框、重置位置、自动关掉每周限额提醒、两种提醒、音效、开机自启、检查更新、打开日志、退出 |

默认「贴着输入框」：鲸鱼站在 Claude 输入框的右上角，输入框打字变高、加附件、开分屏时跟着移动；分屏时站在最右边那个输入框上。位置是通过 Windows 的辅助功能接口（UI 自动化）读 Claude 窗口里的输入框得到的，后台会开一个不显示窗口的 PowerShell。找不到输入框时（比如在设置页），回到按窗口右下角定位。不想要就在右键菜单里关掉「贴着输入框」。

默认还会自动关掉 Claude 输入框上方那条「即将达到每周使用限额」的提醒（它会挡住鲸鱼）：每周额度到 70% 以后，每 3 秒通过同样的辅助功能接口看一眼，看到就点它的关闭按钮，不会动鼠标；关掉后要等每周额度再涨 3% 才重新查（Claude 也不会更早再显示）。不想要就在右键菜单里关掉「自动关掉「即将达到每周限额」提醒」。

额度只在使用 Claude Code（桌面 App 的 Code 标签页或终端）时刷新，不用的时候显示最后一次的数字和重置倒计时。

#### 读取全部对话的额度（可选）

插件只看得到 Claude Code 里的对话；普通聊天、Cowork、网页和手机上用掉的额度，要等下次在 Claude Code 里收到回复时才更新。想实时看到，右键菜单点「登录 claude.ai，读取全部额度…」，在弹出的 claude.ai 窗口里登录一次（建议用邮箱登录，Google 登录在内嵌窗口里可能被拒绝）。之后鲸鱼每分钟向 claude.ai 查一次额度，和插件的数字合并：同一个额度窗口里取较大的那个。

- 登录状态只存在鲸鱼自己的浏览器存储里（`%APPDATA%\Whale Usage\Partitions\claude-ai`），不读取 Claude App 的登录信息，密码也不经过鲸鱼的代码。
- claude.ai 前面有 Cloudflare 安全验证，第一次打开窗口时可能要等几秒。验证过期后菜单会显示「claude.ai 额度暂时读不到」，点一下重新打开窗口，验证通过后窗口会自动关掉。
- 不想用了，在菜单里点「从 claude.ai 读取全部额度」退出登录。

### 提醒

两种提醒都在右键菜单里单独开关，声音跟着「音效」开关。鲸鱼藏起来的时候（Claude 不在前台）看不到气泡，但声音照样会响。

- **等我回答或批准时提醒**：Claude 问你问题、等你批准某个操作或确认计划时，鲸鱼响一声并冒出带橙色边的气泡，你回答或批准后自动消失。几个会话同时在等时会写出还有几个。点气泡可以先收起来，下次有新的等待会再提醒。
- **每轮结束提示用了多少额度**：一轮对话结束时，鲸鱼响一声并显示这轮让额度涨了多少，比如蓝色 `+2%`（5 小时）和紫色 `+1%`（本周）。额度只精确到 1%，两个都没涨就什么也不显示、不响。气泡停留 20 秒，鼠标放在上面时不消失，点一下就收起。只统计 Claude Code 里的对话，普通聊天和 Cowork 的对话插件看不到。

这两个提醒需要插件 0.2.0 或更新的版本。以前装过插件的话，在 Claude 的插件管理里把 `whale-usage-bridge` 更新一下。

### 工作原理

- `plugin/`：`whale-usage-bridge` 插件。Claude Code 每次回复后都会报告当前额度，插件把它写进 `~/.claude/whale/usage.json`；每个会话是否在等你、上一轮让额度涨了多少，写进 `~/.claude/whale/sessions/<会话 id>.json`。用的是官方插件接口，不读取任何登录凭证，也不记录对话内容。
- `antigravity-plugin/`：Antigravity 官方原生插件（`plugin.json` + `hooks.json`），将目录复制到 `~/.gemini/config/plugins/whale-usage-antigravity/` 后即可启用，负责把当前模型名写入 `~/.gemini/antigravity/whale/state.json`，把等待提问和每轮结束写入 `~/.gemini/antigravity/whale/sessions/<会话 id>.json`。
- `src/`：Electron 桌面程序。自动跟随前台的 Claude 或 Antigravity 2.0 桌面窗口（右键菜单「跟随」可切换自动 / 仅 Claude / 仅反重力），贴在输入框右上角并在 Antigravity 下自动识别当前选择的模型。

#### 在 Antigravity（反重力）中使用

1. **自动跟随与切换**：直接运行 Whale Usage，默认「跟随：自动」——Claude 在前台就贴 Claude 并显示 Claude 额度，Antigravity 2.0 在前台就自动切到 Antigravity 窗口、独立位置锚点和 Antigravity 分组额度。
2. **接入实时额度与任务上下文**（自动，无需安装）：
   - **反重力本地接口（默认，推荐）**：Whale Usage 直接读取 Antigravity 2.0 自带 `language_server.exe` 的本地 RPC，自动从 `~/.gemini/antigravity/daemon/hub_<端口>.json` 读取 CSRF token（旧版回退到进程命令行）、枚举监听端口并只接受返回 200 的有效端口（跳过 401 端口），读取「每周限额 + 5 小时限额」（Gemini / Claude / Argon 分组）以及每个任务的实时上下文窗口占用（支持在气泡顶部切换「全部 / 额度 / 上下文」，点击任务可固定追踪，右键菜单可随时开关「显示反重力任务上下文」）。无需安装 `antigravity-usage`，也无需登录 Google。刷新间隔可在 `%APPDATA%\Whale Usage\settings.json` 里修改 `antigravityQuotaIntervalSec`。
   - **外部命令 / 标准本地 JSON（可选兜底）**：仍可安装 `npm i -g antigravity-usage` 作为兜底（`antigravityQuotaCommand` 可改），或由你自己的脚本直接写入 `~/.gemini/antigravity/whale/usage.json`：

     ```json
     {
       "updatedAt": 1760000000000,
       "activeModel": "Gemini 4 Neon (High)",
       "groups": [
         {
           "id": "gemini_pro",
           "label": "Gemini Pro",
           "limits": [{ "kind": "five_hour", "percentUsed": 25, "resetsAt": "2026-11-21T05:00:00.000Z" }]
         },
         {
           "id": "claude",
           "label": "Claude",
           "limits": [{ "kind": "five_hour", "percentUsed": 60, "resetsAt": "2026-11-21T04:00:00.000Z" }]
         }
       ]
     }
     ```
3. **安装 Antigravity 插件（可选，用于模型兜底 + 等我回答/每轮结束提醒）**：把仓库里的 `antigravity-plugin/` 文件夹复制到 `~/.gemini/config/plugins/whale-usage-antigravity/`（或在工作区 `.agents/plugins/` 下）即可。

- 运行日志在 `%APPDATA%\Whale Usage\logs\main.log`，托盘菜单「打开日志文件夹」可以直接打开。出问题时请附上这个文件。

### 从源码运行

需要 Node.js 20 以上。

```bash
npm install
npm start
```

打包：`npm run dist`，产物在 `dist/`。国内网络下载 Electron 慢，可以先设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

右键菜单的样式和 [Claude 自动审批](https://github.com/tiger-git2022/claude-auto-pass) 的 Windows 版一致：Windows 11 亚克力背景、圆角、Fluent 图标，跟随系统深浅色；方向键可以选择，Esc 关闭。

### 形象素材

自带两个形象，在菜单里切换：

- **探头**：来自 [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)。按原仓库 `PROVENANCE.md` 的说明，图片素材不在 MIT 许可范围内，只是原样提供。
- **笑脸**：由一张鲸鱼娘二创图抠图、裁剪而来，程序图标也用它。

如果你是权利人并希望移除，请开 issue。菜单里「用自己的图片…」可以换成任意图片（建议正方形、透明背景的 PNG，右侧和下方裁掉的「探头」构图效果最好）。

## English

A desktop pet that sits next to the Claude and Antigravity desktop apps and shows your subscription usage as percent used: for **Claude**, the **blue** number is the 5-hour window and the **purple** one the weekly window; for **Antigravity**, it automatically switches to the quota group matching your selected model (Gemini Pro / Flash / Claude / GPT). Numbers turn orange at 70% and red at 90%, and a bubble pops up at 80% or 95%. Click the character for progress bars and reset times.

> An unofficial personal tool, not affiliated with Anthropic or Google.

### Install

1. **The desktop app**: download an exe from the link above.
2. **The `whale-usage-bridge` plugin** in Claude, which hands the usage to the app. In the Claude desktop app: **+** next to the prompt box → **Plugins** → **Add marketplace** `tiger-git2022/whale-usage`, then add `whale-usage-bridge`. In a terminal: `/plugin install whale-usage-bridge --marketplace tiger-git2022/whale-usage`.

Send Claude a message and the usage appears.

If adding the marketplace says it cannot connect, Claude cannot reach GitHub: it fetches plugins with git, which ignores the system proxy. With a proxy running, point git at it for GitHub (use your proxy's port): `git config --global http.https://github.com.proxy http://127.0.0.1:7890`.

### Usage from every conversation (optional)

The plugin only sees Claude Code conversations; usage from Chat, Cowork, the web or the phone shows up the next time a Claude Code reply arrives. To see it right away, choose 登录 claude.ai，读取全部额度… in the menu and sign in once in the claude.ai window that opens (email sign-in is the safe choice; Google may refuse an embedded window). The app then asks claude.ai for the usage every minute and merges it with the plugin's numbers, keeping the higher reading within a window. The sign-in lives in the app's own browser storage (`%APPDATA%\Whale Usage\Partitions\claude-ai`); nothing is read from the Claude app and no password passes through the app's code. When claude.ai's Cloudflare check expires the menu says 暂时读不到; clicking it reopens the window, which closes itself once the check passes.

### Position

By default the character stands on the top-right corner of Claude's input box (menu: 贴着输入框) and moves with it as the prompt grows, attachments are added or panes are split (it takes the rightmost box). The box is found through Windows UI Automation by a hidden PowerShell process. Where there is no input box, such as Claude's settings, it falls back to the window's bottom-right corner. Dragging the character keeps it where you drop it, measured from the box.

### Reminders

Both have their own switch in the right-click menu; their sounds follow the 音效 (sound) switch. While the character is hidden (Claude in the background) the bubble cannot be seen, but the sound still plays.

- **Waiting for you (等我回答或批准时提醒)**: when Claude asks you a question, waits for a permission or a plan approval, the character chimes and shows an orange-edged bubble until you answer. It says how many other sessions are waiting too. Click the bubble to put it away until the next wait.
- **End of turn (每轮结束提示用了多少额度)**: when a turn ends, the character chimes and shows how much it used, such as a blue `+2%` (5-hour) and a purple `+1%` (weekly). Usage is reported in whole percents; a turn that moved neither shows and plays nothing. The bubble stays for 20 seconds, stays put while the pointer is on it, and goes away on a click. Only Claude Code conversations count; the plugin cannot see Chat or Cowork conversations.

Both need plugin 0.2.0 or later; if you installed the plugin before, update `whale-usage-bridge` in Claude's plugin settings.

### Download and updates

- Every push to `main` is built by GitHub Actions and published as a new [release](https://github.com/tiger-git2022/whale-usage/releases). Versions are `vX.Y.Z`: fixes and small changes raise Z, new features raise Y, big changes raise X. Earlier releases stay (before November 2026 they were named like `v0.1.0-t013`), and each lists the changes since the one before.
- The app checks at start and every 6 hours. A new release is downloaded in the background; the app then quits, replaces its exe and starts again, in a few seconds, with a notification. 自动更新 in the menu turns this off; 检查更新 updates right away.
- The check reads the `update.json` attached to the latest release and falls back to the GitHub API, so the API's 60 requests an hour limit does not apply.

### How it works

- `plugin/`: after each Claude Code response, the plugin writes the reported rate-limit usage to `~/.claude/whale/usage.json`, and whether each session is waiting for you and how much its last turn used to `~/.claude/whale/sessions/<session id>.json`, through the official plugin API, without reading any credentials or recording the conversation.
- `antigravity-plugin/`: native Antigravity lifecycle hooks plugin (`plugin.json` + `hooks.json`). Copy it to `~/.gemini/config/plugins/whale-usage-antigravity/` to sync the active `modelName`, waiting prompts (`ask_question`), and finished turns into `~/.gemini/antigravity/whale/`. For live quotas and per-task context windows, the app reads Antigravity 2.0's own `language_server.exe` RPC directly (weekly + 5-hour pools and per-trajectory context usage/limits via `hub_<port>.json`; no CLI or Google login needed); `antigravity-usage` and standard multi-group JSON at `~/.gemini/antigravity/whale/usage.json` remain optional fallbacks.
- `src/`: the Electron app follows whichever of Claude or Antigravity 2.0 is in front (or lock to one in the menu), sits on the input box, reads Antigravity's active model label, and switches quota groups accordingly.
- The run log is at `%APPDATA%\Whale Usage\logs\main.log` (menu: 打开日志文件夹). Attach it when reporting a problem.
- Right-click the character or the tray icon for the menu, styled like the Windows tray menu of [Claude Auto Pass](https://github.com/tiger-git2022/claude-auto-pass): Windows 11 acrylic, rounded corners, Fluent icons, light or dark with Windows.

### Artwork

Two characters come with the app, switched in the menu: 探头 from [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) (per its `PROVENANCE.md`, provided as-is and not covered by its MIT license), and 笑脸, cut out of a fan illustration. Rights holders can open an issue to have one removed.

## License

The code is MIT licensed, see [LICENSE](LICENSE). The images in `skins/` and `assets/` are not covered by it.
