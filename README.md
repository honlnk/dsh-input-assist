# dsh-input-assist

DeepSeek Harness（dsh）输入助手插件：

- **输入补全** — 打字时防抖调用 DeepSeek FIM 接口（`/beta/completions`），输入框上方出现建议条，`Tab` 采纳、`Esc` 关闭
- **错别字检查** — 双层检测：本地高精度词典（约 150 条错词 + 上下文规则，离线零误报）+ LLM 上下文校对（在/再、的/得/地等词典查不了的错误）。**文中红字标注**（红色波浪线，当前项高亮，点红字选中），导航条逐条修正，绝不全量替换

## 错别字快捷键（仅输入框聚焦且有检出时生效）

| 动作 | 快捷键 |
| --- | --- |
| 下一个 / 上一个错字 | `Ctrl+Shift+.` / `Ctrl+Shift+,` |
| 修正当前选中项 | `Ctrl+Shift+F` |
| 标记该处为正确输入（不替换） | `Ctrl+Shift+G` |
| 本次输入不再提醒 | `Esc` |

## 快速开始

```shell
# 安装到 dsh web profile（已在本机执行过）
dsh plugin --profile web add /Users/honlnk/project/dsh-input-assist
dsh --profile web          # 启动，打开 http://127.0.0.1:3080
```

API key 三选一（补全与 LLM 检查层需要；词典层无需任何配置）：

1. 什么都不做——插件自动复用 dsh 已保存的 `DEEPSEEK_API_KEY`（`.credentials.yaml`）或环境变量
2. `~/.dsh/settings.yaml` 里写 `input-assist.completionApiKey: sk-…`
3. 环境变量 `DEEPSEEK_API_KEY=sk-… dsh web`

## 配置（settings.yaml → `input-assist`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `completionEnabled` | `true` | 输入补全开关（输入框「补」按钮同效） |
| `completionBaseUrl` | `https://api.deepseek.com/beta` | FIM 端点（OpenAI 兼容可换） |
| `completionApiKey` | `''` | 留空则走凭证回退 |
| `completionModel` | `deepseek-chat` | 补全模型 |
| `completionDebounceMs` | `600` | 输入停顿多久后请求 |
| `completionMaxTokens` | `64` | 建议长度上限 |
| `proofreadEnabled` | `true` | 错别字检查开关（「校」按钮同效） |
| `proofreadUseLlm` | `true` | 是否叠加 LLM 检查层 |
| `proofreadModel` | `deepseek-chat` | LLM 检查模型 |
| `proofreadDebounceMs` | `1000` | 检查防抖 |

## 测试

```shell
npm install --legacy-peer-deps
npm install -D @deepseek-ai/cordis@^4.0.1 --legacy-peer-deps   # 测试用 peer 依赖
node --test test/     # 28 个用例
```

## 文档

- [docs/调研与技术方案.md](./docs/调研与技术方案.md) — 立项文档：调研结论、架构、插槽契约、里程碑
- [docs/开发记录-v1.md](./docs/开发记录-v1.md) — v1 实施记录、验证结果、踩坑清单（RPC 错误码枚举、IAB 点击问题等）
- [docs/开发记录-v2.md](./docs/开发记录-v2.md) — v2 错别字改版：红字镜像层、导航交互、快捷键冲突排查与验证状态

## 架构一览

```
浏览器半边（lib/client.js）                    host 半边（lib/index.js）
  input.overlay  建议条 ⇥Tab/Esc          loopback    settings 命名空间 input-assist
  input.dock     错别字面板+修正      ───RPC /input-assist───▶  complete   → FIM /beta/completions
  input.right    补/校 开关                             proofread → 词典层 + LLM 层
  useInput 读草稿 · inputActions.setDraft 写回
```

## 状态

- [x] 调研与可行性（2026-08-23）
- [x] M0 双侧插件脚手架
- [x] M1 补全建议条（Tab 采纳 / Esc 关闭 / IME 安全）
- [x] M2 错别字检查（词典 + LLM 双层，点击修正）
- [x] v2 错别字改版（文中红字标注、逐条导航、标记正确、快捷键）
- [ ] M2.5 真实 key 联调 + 真实 Chrome 中验证点击/快捷键手感
- [ ] M3 ghost text / 逐段接受 / 流式 / 设置 UI
- [ ] M4 发布（npm + dsh-plugin topic）

## 卸载

```shell
dsh plugin --profile web remove dsh-input-assist
```
