# dsh-input-assist

DeepSeek Harness（dsh）输入助手插件：

- **输入补全（ghost text）** — 打字停顿后调用 DeepSeek FIM 接口（`/beta/completions`），灰色建议**内联在光标后**（NovAI 同款：镜像层透明占位 + 灰字），`Tab` 逐词采纳、`Shift+Tab` 全量采纳、`Esc` 关闭
- **错别字检查** — 双层检测：**词典层在浏览器本地运行**（约 150 条错词 + 上下文规则，200ms 即时标红、离线零成本）+ LLM 上下文校对（在/再、的/得/地等，800ms 防抖与补全同节奏）。**文中红字标注**（红色波浪线，当前项高亮，点红字选中），导航条逐条修正，绝不全量替换

## 补全快捷键（建议灰字出现时生效）

| 动作 | 快捷键 |
| --- | --- |
| 采纳一词（中文按词切分） | `Tab` |
| 全量采纳 | `Shift+Tab` |
| 关闭建议 | `Esc` |

快捷键说明会在建议出现时显示在输入框**外侧**的 dock 行（与错别字导航条同位），输入框内无任何浮层。

## 错别字快捷键（仅输入框聚焦且有检出时生效）

| 动作 | 快捷键 |
| --- | --- |
| 下一个 / 上一个错字 | `Ctrl+Shift+.` / `Ctrl+Shift+,` |
| 修正当前选中项 | `Ctrl+Shift+F` |
| 标记该处为正确输入（不替换） | `Ctrl+Shift+G` |
| 本次输入不再提醒 | `Esc` |

## 快速开始

```shell
dsh plugin --profile web add dsh-input-assist   # 或 @honlnk/dsh-input-assist，内容完全相同
dsh --profile web          # 启动，打开 http://127.0.0.1:3080
```

本地开发（从源码装）：

```shell
git clone https://github.com/honlnk/dsh-input-assist && cd dsh-input-assist
npm install && npm run build
dsh plugin --profile web add "$PWD"
```

官网（功能演示 + 安装指引）：https://honlnk.github.io/dsh-input-assist/

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
| `completionDebounceMs` | `800` | 停笔多久后请求建议（与 LLM 校对同节奏） |
| `completionMaxTokens` | `64` | 建议长度上限 |
| `proofreadEnabled` | `true` | 错别字检查开关（「校」按钮同效） |
| `proofreadUseLlm` | `true` | 是否叠加 LLM 检查层（关掉则完全不花钱） |
| `proofreadModel` | `deepseek-chat` | LLM 检查模型 |
| `proofreadDebounceMs` | `800` | LLM 层防抖（与补全同节奏，两路同时返回） |
| `proofreadDictDebounceMs` | `200` | 词典层防抖（浏览器本地扫描，零成本） |

## 开发与测试

源码在 `src/*.ts`（TypeScript strict 模式），构建用 [tsdown](https://tsdown.dev) 双入口：

- `src/index.ts` → `lib/index.js`（ESM + `.d.ts`，host 半边，cordis loader 直接 import）
- `src/client.ts` → `lib/client.js`（CJS，banner/footer 自动包 `window.__ModuleLoader__.load` 壳，react / dsh-client-runtime 保持外部依赖，词典等本地模块打包进 bundle）

```shell
npm install
npm run build   # tsc 类型检查由 tsdown 内置完成；产物落 lib/
npm test        # 先 build，再跑 node --test（单测指向 src/*.ts，产物守卫指向 lib/client.js）
```

词典曾以 DICT-SHARED 标记块在两侧逐字同步，TS 化后单一源 `src/proofread-dict.ts` 由构建器打进两侧，`test/client-bundle.test.js` 用假 ModuleLoader 真正执行 bundle 产物做守卫。

## 文档

- [docs/调研与技术方案.md](./docs/调研与技术方案.md) — 立项文档：调研结论、架构、插槽契约、里程碑
- [docs/开发记录-v1.md](./docs/开发记录-v1.md) — v1 实施记录、验证结果、踩坑清单（RPC 错误码枚举、IAB 点击问题等）
- [docs/开发记录-v2.md](./docs/开发记录-v2.md) — v2 错别字改版：红字镜像层、导航交互、快捷键冲突排查与验证状态
- [docs/开发记录-v3.md](./docs/开发记录-v3.md) — v3 NovAI 化改版：ghost text、逐词采纳、词典层下沉浏览器、双层防抖拆分
- [docs/开发记录-v4.md](./docs/开发记录-v4.md) — v4 TypeScript 重构：tsdown 双入口构建、词典单源化、产物守卫测试

## 架构一览

```
浏览器半边（lib/client.js，tsdown 从 src/client.ts 打包）   host 半边（lib/index.js）
  input.overlay  仅错误提示（无浮层）     loopback    settings 命名空间 input-assist
  input.dock     错别字面板+修正      ───RPC /input-assist───▶  complete   → FIM /beta/completions
  input.right    补/校 开关                             proofread → LLM 层（llmOnly）
  useInput 读草稿 · inputActions.setDraft 写回
  镜像层（body 挂载）：文中红字 + 光标后灰色 ghost 建议
  词典层本地运行（单源 src/proofread-dict.ts，构建时打进 client bundle）
```

## 状态

- [x] 调研与可行性（2026-08-23）
- [x] M0 双侧插件脚手架
- [x] M1 补全建议条（Tab 采纳 / Esc 关闭 / IME 安全）
- [x] M2 错别字检查（词典 + LLM 双层，点击修正）
- [x] v2 错别字改版（文中红字标注、逐条导航、标记正确、快捷键）
- [x] v3 NovAI 化改版（ghost text 内联建议、Tab 逐词采纳、词典层下沉浏览器 200ms、LLM/补全统一 800ms）
- [x] v4 TypeScript 重构（src/ 全量 TS、tsdown 双入口构建、词典单源化、37 测试）
- [x] v5 CI/CD + 发布（双名 npm 包、Trusted Publishing 免 token、GitHub Pages 官网）
- [ ] M2.5 真实 Chrome 中验证点击/快捷键手感
- [ ] M3 流式 / 设置 UI

## 发布流程（v5 起）

推 `v*` tag 自动触发（版本号须与 package.json 一致）：

- **Release npm** — 测试通过后双名各发一份：`dsh-input-assist`（裸名）+ `@honlnk/dsh-input-assist`（scope 镜像），内容相同。认证走 npm Trusted Publishing（OIDC），无需 NPM_TOKEN；已发布的名字自动跳过（幂等）。
- **Deploy Pages** — `docs/` 下的站点文件部署到 GitHub Pages。

前置（一次性）：npmjs.com 上为**两个包名**各配置一条 Trusted Publisher（repo `honlnk/dsh-input-assist`、workflow `release-npm.yml`、environment 留空）；GitHub Settings → Pages → Source 选 "GitHub Actions"。

```shell
git tag v0.1.0 && git push origin v0.1.0   # 即发布
```

## 卸载

```shell
dsh plugin --profile web remove dsh-input-assist
```
