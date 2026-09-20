# Discussions #6313 改帖文案

> 用法：**编辑原帖**（不要发新帖）——GitHub 支持编辑，URL: https://github.com/deepseek-ai/deepseek-harness/discussions/6313 。先换标题，再替换正文，GIF 录好后把两处占位符换成动图链接；然后在帖下补一条「新增动态演示」评论（文案在最后），评论会把帖子顶回最近排序，是合规的二次曝光。
>
> 现标题（功能罗列式）：《DSH | dsh-input-assist | 输入补全（ghost text）+ 中英混排错别字检查 + 自定义词库》

## 新标题（主推）

```
DSH | dsh-input-assist | 你的智能体输入框还停在上个时代——Copilot 式补全 + 错别字检查
```

备选（若想更克制）：

```
DSH | dsh-input-assist | 给输入框装上 Tab 补全：ghost text + 中英错别字检查
```

## 新正文（直接替换原帖 body）

<!-- GIF 占位：打字 → ghost 流式渐显 → Tab 逐词采纳，约 15 秒 -->

```markdown
> **非官方社区项目，由社区成员独立开发和维护。**
> **Unofficial community plugin, independently developed and maintained.**

Claude Code、Codex、Cursor、VS Code Chat——你每天给智能体打几百字指令，但没有一家的输入框有补全。这个插件把输入框带到这个时代该有的样子：**打字，停顿，灰色的建议出现在光标后；Tab 一个词一个词地采纳**。中文还有错别字检查：在/再、的/得/地、`recieve→receive`，红波浪线标在文中，点击即修。

<!-- GIF：中文场景——打字 → ghost 流式渐显 → Tab 逐词采纳 → 一次错别字标红与快捷修正（约 15 秒） -->

## 它做什么 / What it does

**输入补全（ghost text）**
- 停笔 800ms 后调用 DeepSeek FIM 接口，灰色建议**内联在光标后**（Copilot 同款，非悬浮条）
- 流式渐进渲染：建议随生成**逐字渐显**（SSE），首 token 即上屏，`Tab` 可在生成中途采纳
- `Tab` 逐词采纳（中文按词切分）、`Shift+Tab` 全量采纳、`Esc` 关闭；IME 组合期一律放行
- 重新输入 / `Esc` / 关开关会**真正取消在途请求**——迟到响应不复活、不白烧 token

**中英混排错别字检查（两层）**
- 词典层：228 条中文错词 + 211 条英文错拼/专名（`recieve→receive`、`defualt→default`、`github→GitHub`）+ 上下文规则，**浏览器本地 200ms 即时标红、零成本**
- LLM 层：在/再、的/得/地及英文拼写的上下文校对，800ms 与补全同节奏
- 英文只查全小写独立词：驼峰、snake_case、`obj.method` 这类标识符一律不查
- 文中红波浪线标注，点红字选中；导航条逐条修正（绝不全量替换）
- 代码块/URL 里的内容永不标记

**自定义词库（仅本浏览器）**
- 设置卡片里成对编辑：错词 => 正词，中英文皆可，覆盖内置项或禁用某个内置词
- 导入/导出 `.txt`（`错词 => 正词` 一行一条），换浏览器/换机器随身带

An inline ghost-text completion + bilingual typo checker for the dsh composer: FIM suggestions stream in right after your cursor (SSE progressive render, `Tab` accepts word by word, in-flight requests truly cancelled), errors from a 100%-local dictionary layer plus an optional LLM pass get red underlines in the text with per-item click-to-fix — and a per-browser custom dictionary on top.

<!-- GIF：English scenario — same script, ~15s -->

## 安装 / Install

```shell
dsh plugin --profile web add dsh-input-assist   # 或 @honlnk/dsh-input-assist
dsh --profile web
```

API key 三选一：什么都不做（自动复用 dsh 已存的 `DEEPSEEK_API_KEY`）／设置页卡片里填／`settings.yaml` 配置。词典层无需任何配置、离线可用。

当前版本 **0.7.1**：兼容 dsh **0.1.5-rc.2**（官方 latest，含 contenteditable 新输入框）与 0.1.1 旧运行时（网络层自动降级，无需配置）。

项目地址：https://github.com/honlnk/dsh-input-assist （TypeScript、116 项测试、详细开发文档）——欢迎 issue / PR / 此帖回帖反馈。
```

## 编辑后补的「二次曝光」评论

```
新增动态演示：ghost text 流式渐显 + Tab 逐词采纳 + 错别字标红修正（正文 GIF 已更新）。另：v0.7.1 已适配 0.1.5-rc.2 的 contenteditable 新输入框，旧运行时自动兼容。

Live demos added to the post above — streaming ghost text with word-by-word Tab accept, and typo underline + quick fix. v0.7.1 also supports the 0.1.5-rc.2 contenteditable composer, with automatic fallback for the 0.1.1 runtime.
```
