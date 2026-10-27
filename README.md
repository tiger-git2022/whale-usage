# Whale Usage

一个贴在 Claude 桌面 App 旁边的小桌宠，实时显示你的 Claude 订阅额度：

- **蓝色**数字：5 小时窗口已用百分比
- **紫色**数字：本周窗口已用百分比
- 用到 70% 变橙，90% 变红；跨过 80% / 95% 时会自动弹出气泡提醒

点一下形象可以看详细信息（进度条、重置倒计时、更新时间）。

> 这是个人做的非官方小工具，和 Anthropic 没有关系。

## 它是怎么工作的

由两部分组成：

1. **`whale-usage-bridge` 插件（mod）**：装在 Claude Code 里。每次 Claude 回复后，Claude Code 会报告当前的额度，插件把它写进 `~/.claude/whale/usage.json`。用的是官方插件接口，不读取任何登录凭证。
2. **Whale Usage 桌面程序（exe）**：读取这个文件并显示出来。它会找到 Claude 的窗口，贴在窗口上跟着移动；Claude 不在前台或被最小化时自动隐藏。

所以额度只在你使用 Claude Code（桌面 App 的 Code 标签页或终端）时刷新，不用的时候显示最后一次的数字和重置倒计时。

## 安装

### 1. 安装插件

在 Claude 桌面 App 里：点输入框旁边的 **+** → **Plugins** → **Add marketplace**，填 `tiger-git2022/whale-usage`，然后在列表里添加 `whale-usage-bridge`。

或者在终端的 Claude Code 里：

```
/plugin install whale-usage-bridge --marketplace tiger-git2022/whale-usage
```

### 2. 运行桌面程序

到 [Releases](https://github.com/tiger-git2022/whale-usage/releases) 下载：

- `WhaleUsage-x.y.z-portable.exe`：免安装，双击就能运行
- `WhaleUsage-x.y.z-setup.exe`：安装版，会建开始菜单项

装好以后，在 Claude 里发一条消息，额度就会出现。

## 使用

| 操作 | 效果 |
| --- | --- |
| 单击形象 | 打开 / 关闭额度气泡 |
| 按住拖动 | 移动位置，会记住它相对 Claude 窗口的位置；靠近窗口左右边缘会自动吸附 |
| 在形象上滚动滚轮 | 放大 / 缩小 |
| 托盘图标右键 | 显示时机、大小、音效、开机自启、更换形象、重置位置、退出 |

## 从源码运行

需要 Node.js 20 以上。

```bash
npm install
npm start
```

打包成 exe：

```bash
npm run dist
```

产物在 `dist/` 目录。在国内网络下，Electron 下载慢可以先设置镜像：

```bash
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

## 形象素材

默认形象来自 [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)。按原仓库 `PROVENANCE.md` 的说明，图片素材不在 MIT 许可范围内，只是原样提供。如果你是权利人并希望移除，请开 issue。

托盘菜单里的"更换形象…"可以换成任意图片（建议正方形、透明背景的 PNG）。

## 许可

代码以 MIT 许可发布，见 [LICENSE](LICENSE)。`skins/` 和 `build/icon.png` 中的图片不在此许可范围内。
