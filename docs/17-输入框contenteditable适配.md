# 17 · 输入框 contenteditable 适配（dsh 0.1.5 浏览器侧补完）

> 2026-09-20。docs/16 完成了 dsh 0.1.5-rc.2 宿主半边的适配（RPC over fetch、
> 流式路由），但浏览器交互层标注「待日常使用回归」——本篇补上这一课：
> **0.1.5 把 composer 从 textarea 换成了 Lexical contenteditable**，插件的
> 渲染/光标/键盘链路全部落空。表现为：补全建议每次都正常返回（流式 200、
> 建议已写入 store），但 ghost 永远不显示——「无声不弹」。

## 根因与定位过程

- 症状：输入任何内容不出现灰色建议；「补/校」开关正常渲染。
- 定位（临时 debug 构建：客户端生命周期事件上报宿主落盘
  `~/.dsh/input-assist-debug.log`，事后已全部移除）：
  - `draft` 事件里 `ta:false` —— `findTextarea()` 找不到输入框；
  - 其余链路全绿：config-get ✓ / suggest-mount ✓ / stream-status 200 ✓ /
    finish-ok len 16 ✓（建议拿到了，只是画不出来）。
- 读 `@deepseek-ai/dsh-client-ui-conversation` 包源码证实：0.1.5 的
  composer 是 `ComposerContentEditable`（Lexical），渲染为
  `<div contenteditable role="textbox" data-composer-input>`，包在
  `[data-composer-card]` 卡片内；@ 引用渲染为 chip 节点。
  **textarea 已不存在**（仅 composer-blocked 的惰性兜底还在用）。

## 适配（src/client.ts，双运行时：0.1.5+ 与 ≤0.1.1 共存）

1. **`findComposer()`** 取代 `findTextarea()`：先找
   `[data-composer-card] [data-composer-input][contenteditable="true"]`，
   找不到回退旧 `textarea` 选择器。
2. **文本真值改用 input store 的 draft**（`lastDraft`）：Lexical DOM 的
   `textContent` 与 chip 序列化对不齐，不能作比较/渲染基准。镜像层
   渲染、`effectiveIssues` 位置校验、`navFixCurrent`、Tab 采纳全部改读
   `lastDraft`。
3. **`composerCaret()` 重写**：textarea 走 `selectionStart`；
   contenteditable 按块级段落（Lexical `<p>`）走查 Selection anchor，
   段间补换行，与 draft 的 `\n` 分行约定对齐。chip 内文本按显示文本
   近似（已知局限，见下）。
4. **键盘拦截**：目标判定从 `instanceof HTMLTextAreaElement` 扩展为
   「textarea 或 `isContentEditable` 后代」；Tab 采纳统一走
   `composerCaret() ?? lastDraft.length` 计算 caret，
   写入走 `inputActions.setDraft`（0.1.5 契约仍在，整串替换语义不变）；
   execCommand 兜底仅保留给旧运行时 textarea。
5. `copyMirrorMetrics` 参数放宽为 `HTMLElement`（字体/边距/滚动度量的
   复制对 contenteditable div 同样成立）。

适配过程中修掉一个自引入 bug：光标钳制基准用了尚未更新的 `lastDraft`
（首击时长度 0），导致 prefix 发空、宿主走「prompt 太短」早退分支回
`done:''`——钳制改为依赖 DOM 走查自身长度后修复。

## 验证（2026-09-20，本机 dsh 0.1.5-rc.2 + 无头浏览器实测）

- `npm test` 116/116 全绿。
- 真机浏览器：中文输入 → SSE 流式 ghost 灰字内联对齐渐显；
  Tab 逐词采纳写入成功且剩余建议续显（ZCode IAB 环境吞真实 Tab 键，
  以合成 keydown 验证拦截器路径）；「补/校」开关正常。
- 宿主 curl 冒烟：`/api/input-assist/stream` SSE 帧正常（docs/16 结论
  复验）。

## 已知局限

- 草稿含 @ 引用 chip 时，光标偏移与镜像层对齐按 chip 显示文本近似，
  ghost 位置可能有轻微偏移（纯文本草稿无影响）。
- 错别字红字镜像与 ghost 共用同一镜像层，已随本适配恢复；但本次验收
  以补全为主，错字交互仅回归了 LLM 层 RPC 链路。

## 前瞻

npm `latest` 即当前 0.1.5-rc.2；alpha 通道 0.1.6-alpha.2 已验证
composer 契约未变（仍是 contenteditable + `data-composer-input` +
`setDraft`），未来升级预计零适配。
