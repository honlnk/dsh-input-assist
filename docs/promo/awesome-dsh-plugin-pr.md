# awesome-dsh-plugin 收录 PR 材料

> 用法：fork `awesome-dsh-plugin/awesome-dsh-plugin`，新建文件 `data/plugins/honlnk__dsh-input-assist.yml`（内容见下），提 PR（标题见下）。README 由脚本生成、不要手改；只提交这一个 YAML 文件即可。GIF 录好后可在 PR 描述里附上链接（列表正文不放图，但评审时有用）。
>
> 已核对收录要求（2026-09-20）：✅ `dsh.bundle` manifest 在 package.json（含 `bundle.patch`）；✅ 真实可用代码；✅ 仓库创建于 2026-08-23（满 1 天）；✅ 活跃维护（近期提交 0.7.1）；✅ 已挂 `dsh-plugin` topic。

## 要提交的文件：`data/plugins/honlnk__dsh-input-assist.yml`

```yaml
url: https://github.com/honlnk/dsh-input-assist
name: honlnk/dsh-input-assist
category: ui
description:
  en: 'Ghost-text completion for the composer: FIM suggestions stream in inline after a typing pause (SSE, first token rendered immediately), Tab accepts one word at a time and Shift+Tab takes all, in-flight requests are truly cancelled on retyping or Esc. Plus two-layer typo checking: a browser-local dictionary scan (Chinese wrong phrases, English misspellings and proper-noun capitalization, user-defined per-browser entries) with a debounced LLM context pass, underlined in red in the text with per-item navigation and click-to-fix.'
  zh: '输入框 ghost 补全：停笔后 FIM 建议内联流式渐显（SSE，首 token 即上屏），Tab 逐词采纳、Shift+Tab 全量，重新输入或 Esc 会真正取消在途请求；错别字双层检查：浏览器本地词典扫描（中文错词、英文错拼与专名大小写、本浏览器自定义词条）叠加防抖 LLM 上下文校对，文中红波浪线标注、逐条导航、点击修正。'
```

要点自查：`category: ui`（对应 UI Enhancements）；描述只陈述功能、无营销词、以句号结尾；英文描述含 `: `（"Ghost-text completion for the composer: FIM..."）所以整段加了单引号——这是 contributing.md 明确要求的坑。

## PR 标题

```
Add honlnk/dsh-input-assist
```

## PR 描述

```markdown
Adds `data/plugins/honlnk__dsh-input-assist.yml`.

**dsh-input-assist** is an input assistant for the dsh Web UI composer:

- **Ghost-text completion** — DeepSeek FIM (`/beta/completions`) suggestions render inline after the cursor, streamed progressively over SSE; `Tab` accepts word by word (Chinese segmented via `Intl.Segmenter`), `Shift+Tab` accepts all, `Esc` dismisses; retyping or toggling off truly cancels in-flight requests.
- **Typo checking, two layers** — a dictionary layer that runs entirely in the browser (228 Chinese wrong phrases, 211 English misspellings / proper-noun capitalizations, context rules, 200 ms debounce, zero cost) plus a debounced LLM context pass for mixed Chinese/English (在/再, 的/得/地, spelling). Errors get a red underline in the text with per-item navigation and click-to-fix — never a bulk replace. Users can maintain a per-browser custom dictionary (import/export as plain-text `wrong => right`).
- Everything is configurable from a settings-page card (official `settings.plugin.item` slot), including model selection with catalog fetching from the API.

Install (verified on dsh 0.1.5-rc.2, also compatible with the 0.1.1 runtime):

    dsh plugin --profile web add dsh-input-assist

Checklist against contributing.md:
- [x] `dsh.bundle` manifest declared in package.json (with `bundle.patch`)
- [x] Real, working code (v0.7.1, 116 tests, TypeScript strict)
- [x] Repo created 2026-08-23 (older than 1 day)
- [x] Actively maintained
- [x] `dsh-plugin` topic added
- [x] Description states what the plugin does, no superlatives
```
