# Discord harness 频道发帖文案

> 用法：DeepSeek 服务器 → `harness` 论坛频道 → 右上「新帖」，标签选 **Show and tell**；标题用第一行；**两个 GIF 直接作为文件附件上传**（Discord 会内联自动播放，别贴外链）；正文粘贴下面的代码块内容。
>
> 另外频道里有官方帖「Plugin Requirements」（anweat 在征集插件想法），建议先去那条回一帖——直接回答他的问题并顺势亮出插件，比纯广告自然。

## 标题

```
Your agent's input box is still from 2015 — I gave dsh a Copilot-style one (ghost text + typo checking)
```

## 正文（Discord markdown，直接粘贴）

```markdown
Type, pause, and a gray ghost suggestion appears **inline right after your cursor** — streaming token by token (SSE). `Tab` accepts one word at a time, `Shift+Tab` takes all. Plus bilingual typo checking: a 100%-local dictionary layer (Chinese wrong phrases, English misspellings like `recieve → receive`) underlines errors in red inside the text, with per-item navigation and one-key fix. No bulk replace, ever.

Both GIFs attached (Chinese & English scenario).

Install:

dsh plugin --profile web add dsh-input-assist

Highlights:

• **Ghost-text completion** — DeepSeek FIM `/beta/completions`, first token rendered immediately, word-by-word accept (Chinese segmented via Intl.Segmenter), IME-safe, in-flight requests truly cancelled on retyping/Esc
• **Two-layer typo check** — local dictionary (200ms, offline, zero cost) + optional debounced LLM context pass (在/再, 的/得/地, spelling); identifiers like camelCase or obj.method never flagged; code blocks and URLs never touched
• **Settings card** in the official Plugins settings, model catalog fetched from the API, per-browser custom dictionary with .txt import/export

Repo (TypeScript strict, 116 tests, bilingual README, 17 dev-docs): https://github.com/honlnk/dsh-input-assist

Works on dsh 0.1.5-rc.2 (contenteditable composer) and falls back automatically on 0.1.1. Happy to answer questions here — 中文用户也可以到 GitHub Discussions 找我：https://github.com/deepseek-ai/deepseek-harness/discussions/6313
```

## 「Plugin Requirements」官方帖的回帖文案

```markdown
An input assistant for the composer already exists 🙂 — ghost-text completion (FIM, streaming, Tab to accept word-by-word) + bilingual typo checking with a local dictionary layer. If "make typing prompts faster" is on anyone's wishlist, try: dsh plugin --profile web add dsh-input-assist — repo: https://github.com/honlnk/dsh-input-assist
```
