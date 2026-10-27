# 给 Claude 的说明 / Notes for Claude

这是 Tiger 的 Whale Usage：贴在 Claude 桌面 App 旁、显示 Claude 订阅额度的 Electron 桌宠，加上把额度写到本地文件的 Claude Code 插件（`plugin/`）。发布方式照 [tiger-git2022/ehviewer-onedrive](https://github.com/tiger-git2022/ehviewer-onedrive)。

- **用中文回复**仓库作者。
- **提交和 PR 标题**写成「中文 / English」，PR 正文中文在前。发布说明直接列出这些标题。
- **自动合并**：自己开的 PR，只要 CI 通过（或没有要跑的检查）、没有冲突、审查意见都已处理，就直接合并，不用再问。用 squash 合并，标题保留「中文 / English (#编号)」。只有需要作者拍板的设计问题，或者不打算按审查意见修改的，才先问再合并。
- **合并后检查发布**：推到 `main` 会由 `.github/workflows/build.yml` 发布带编号的版本（`v<package.json 版本>-tN`）。合并后确认这次发布成功；失败就修好再推。
- `main` 以外的分支可以手动触发 `build.yml` 来完整打包和跑测试，这种运行不会发布。
- 改了版本比较规则要同时改 `src/version.js` 和工作流里的版本计算，并更新 `test/version.test.js`。
- 插件名不能以 `claude-` 开头（官方保留）。改插件后用 `claude plugin validate .` 检查。
