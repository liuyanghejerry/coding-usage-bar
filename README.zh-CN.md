# Coding Usage Bar

[English](README.md) · [简体中文](README.zh-CN.md)

**在 macOS 菜单栏（SwiftBar）或 Linux GNOME 顶栏（Argos）监控 Claude Code、Codex 和其他 AI 编程套餐用量。**

![Coding Usage Bar 在 macOS 菜单栏展示多个 AI 编程 Provider 的套餐用量](docs/assets/hero.png)

Coding Usage Bar 同时支持 Claude Code、OpenAI Codex、GLM（智谱 AI）、DeepSeek、MiniMax 和 Kimi（Moonshot AI）。它不只展示百分比，还会结合短周期和周额度判断当前节奏是偏慢、正常、偏快，还是已经接近限额。

Claude Code 与 Codex 的数据直接读取它们在本机产生的文件，不需要额外登录，也不会上传使用记录。GLM、DeepSeek 和 MiniMax 的 API Key 只保存在 `~/.coding-usage-bar/config.json`，并直接请求对应 Provider 的额度接口。Kimi 的 Key 优先读 `~/.coding-usage-bar/config.json`，未配置时回退到 `~/.config/claude-lanes/config.env` 中指向 kimi.com 的 lane。

## 真实 SwiftBar 菜单

菜单栏标题与下拉面板均截自正在运行的 SwiftBar 插件，仅叠加纯色桌面背景；动画复现菜单的展开与收起，不修改截图中的用量数据。

<p align="center">
  <img src="docs/assets/demo.gif" alt="打开 Coding Usage Bar 的真实 SwiftBar 菜单，查看 Codex、Claude、GLM、DeepSeek、MiniMax 和 Kimi 用量" width="800">
</p>

## 快速开始

```bash
npx coding-usage-bar install
coding-usage-bar doctor
coding-usage-bar status
```

安装器会创建：

- `~/.coding-usage-bar/app` 稳定运行副本
- `~/.local/bin/coding-usage-bar` 命令入口
- 每 5 分钟采集一次用量的后台任务（macOS 用 launchd，Linux 用 systemd user timer）
- 菜单栏插件（macOS 写入 SwiftBar 插件目录；Linux 写入 `~/.config/argos/coding-usage-bar.1m.js`）

安装结束时会自动验收菜单栏是否就绪，最后一行出现 `Menu bar ready` 即表示图标已出现在菜单栏右上角。

## Linux（Ubuntu / GNOME）

Linux 上菜单栏宿主是 [Argos](https://github.com/p-e-w/argos)（GNOME Shell 版的 BitBar/SwiftBar），调度用 systemd user timer，无需 root。

- 现代 GNOME 无法自动安装 Argos；如果 `coding-usage-bar install` 提示缺失，请手动安装：
  ```bash
  git clone https://github.com/p-e-w/argos ~/.local/share/gnome-shell/extensions/argos@pew.worldwidemann.com
  gnome-extensions enable argos@pew.worldwidemann.com   # Wayland 需重新登录后执行
  ```
  然后执行 `coding-usage-bar doctor --fix`。
- Linux 下拉菜单渲染为紧凑文本行（Pango 着色进度条），不烘焙字形、不生成 PNG 卡片；通知走 `notify-send`。
- 下拉菜单使用日本传统色，详细建议收进 `Details` 子菜单；顶栏空间有限时，可点击 `Title` 行切换 Full/Single/Icon 模式。
- 守护进程状态：`systemctl --user status coding-usage-bar.timer`。

## 常见问题

**安装后菜单栏没有图标？**

1. 执行 `coding-usage-bar doctor --fix`：自动重启 SwiftBar、补装菜单栏插件、补加 SwiftBar 登录项、补采 status 数据。
2. macOS 可能把菜单栏图标折叠隐藏了：系统设置 → 控制中心 → 菜单栏，检查隐藏区。
3. 如果 macOS 弹过 System Events 的"自动化"权限框且被拒绝，SwiftBar 将无法开机自启：在 系统设置 → 隐私与安全性 → 自动化 中放行，再执行一次 `coding-usage-bar install`。

## 核心特点

- 一个菜单栏同时查看多个 AI 编程 Provider
- 按账户实际下发的滚动窗口分析使用节奏；部分 Codex 账户当前只提供 7d
- Tibo Reset 追踪：接入 [Codex Resets](https://codex-resets.com) 公共 API，追踪社区所称的 "Tibo Reset"（Thibault Sottiaux 宣布的 Codex 配额重置）。预告、执行和 watch 出现/升级时发送醒目的专用通知，菜单栏 Codex 段显示标记点，下拉卡片显示进展；文案统一用 "Tibo Reset"，避免与 5h/7d 窗口自动重置混淆
- 下拉卡片同时展示启动卷磁盘余量（75% 变黄、90% 变红并提示清理），`status` 命令输出同一读数
- Claude Code、Codex 本地优先，不依赖额外遥测服务
- 展示层只读稳定的 `status.json`，不会在打开菜单时临时访问数据源
- 接近限额或燃烧节奏异常时发送系统通知

完整命令、Provider 配置和实现边界请查看[英文 README](README.md)。

交互式安装结束后，工具可能询问是否为 GitHub 仓库加 Star。该提示默认选择 No（`[y/N]`），只有用户明确输入 `y`/`yes` 且本机 GitHub CLI 已登录时才会修改远端账户状态。

## 开发验证

```bash
npm ci
npm test
npm run build
npm pack
```

## License

[MIT](LICENSE)

各 Provider 名称与商标归其权利人所有。本项目独立开发，与 Anthropic、OpenAI、智谱 AI、DeepSeek、MiniMax、Moonshot AI 无隶属或背书关系。Provider 标识仅用于识别，不适用项目 MIT License，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
