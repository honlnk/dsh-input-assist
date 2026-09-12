# dsh-input-assist

DeepSeek Harness（dsh）输入助手插件：

- **输入补全（ghost text）** — 打字停顿后调用 DeepSeek FIM 接口（`/beta/completions`），灰色建议**内联在光标后**（NovAI 同款：镜像层透明占位 + 灰字），`Tab` 逐词采纳、`Shift+Tab` 全量采纳、`Esc` 关闭
- **错别字检查** — 双层检测：**词典层在浏览器本地运行**（228 条中文错词 + 211 条英文错拼/专名大小写 + 8 条上下文规则，词库数据在 `data/` 下纯文本维护，可叠加浏览器本地自定义词库；200ms 即时标红、离线零成本）+ LLM 上下文校对（中英混排：在/再、的/得/地及英文拼写，800ms 防抖与补全同节奏）。**文中红字标注**（红色波浪线，当前项高亮，点红字选中），导航条逐条修正，绝不全量替换

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
2. 设置页填：侧边栏底部齿轮 → **Plugins → 插件配置 → Input Assist** 卡片（推荐，全部配置图形化）
3. `~/.dsh/settings.yaml` 里写 `input-assist.completionApiKey: sk-…`，或环境变量 `DEEPSEEK_API_KEY=sk-… dsh web`

## 设置页卡片

所有配置都可在 dsh 设置界面图形化修改：侧边栏底部齿轮 → **Plugins → 插件配置**，找「输入助手」卡片展开即可。交互与官方兄弟卡片（Bash / Agent Loop / Web Search）同构：暂存编辑 → 统一「保存 / 放弃修改」，数字与必填文本本地校验，字段行带「未保存」蓝点与单项撤销（×）。卡片注册走官方 `settings.plugin.item` 插槽（keyed by 设置命名空间），无需新增任何服务依赖；设置文件外部修改仍会热同步进卡片。

模型字段支持**从 API 拉取目录**：点字段旁的 ▾ 方块按钮打开自定义下拉面板，每次打开都自动拉取最新目录，点选即填入；输入框始终是自由文本，任何 OpenAI 兼容端点的自定义模型名都可手填。拉取失败（未配 key、端点不可达）自动退回手填。默认模型已跟随官方迁移：`deepseek-chat` 于 2026-07-24 停用，现为 `deepseek-flash`（V4.1 Flash）。

## 自定义词库（仅本浏览器）

设置页卡片底部「**自定义词库（仅本浏览器）**」区块是一张成对词条列表：左列错词、右列正词，中英文皆可。点「＋ 添加词条」在末尾追加一对输入框，× 删除该行，拖拽行首把手调整顺序（或聚焦后 ↑/↓ 移动），增删与移动都有平滑动画：

- 与内置词库**合并**参与词典层本地扫描：同名错词覆盖内置项；错词与正词写成同一个词（自映射）= 不再检查该词（禁用内置词）；英文词条自动走词边界匹配（驼峰、snake_case、点号连接的标识符不会误报）
- 仅存本浏览器 localStorage（key `dsh-input-assist:user-dict:v1`，存储格式仍为 `错词 => 正词` 一行一条），**不随 settings.yaml 同步**
- 标题行有「**导入 / 导出 / 复制**」：导入选 `.txt` 文件（一行一条 `错词 => 正词`，与内置词库同格式、`#` 注释），同错词就地更新、其余追加进暂存列表，过目后仍要点保存；导出把当前列表（含未保存修改）下载为同格式 `.txt`，复制走剪贴板——换浏览器/换机器搬运全靠它们
- 上限 2000 条、单条错词 ≤ 16 字；校验问题（空词、连续空白、超长、重复）逐行内联提示，有问题不能保存；与其他设置的修改共用卡片底部的「放弃修改 / 保存」，保存成功后立即按新词库重新标红

## 配置（settings.yaml → `input-assist`，或设置页卡片图形化修改）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `completionEnabled` | `true` | 输入补全开关（输入框「补」按钮同效） |
| `completionBaseUrl` | `https://api.deepseek.com/beta` | FIM 端点（OpenAI 兼容可换） |
| `completionApiKey` | `''` | 留空则走凭证回退 |
| `completionModel` | `deepseek-flash` | 补全模型（输入框可下拉选择，⟳ 从 API 拉取目录） |
| `completionDebounceMs` | `800` | 停笔多久后请求建议（与 LLM 校对同节奏） |
| `completionMaxTokens` | `64` | 建议长度上限 |
| `proofreadEnabled` | `true` | 错别字检查开关（「校」按钮同效） |
| `proofreadUseLlm` | `true` | 是否叠加 LLM 检查层（关掉则完全不花钱） |
| `proofreadModel` | `deepseek-flash` | LLM 检查模型（同上，下拉选择） |
| `proofreadDebounceMs` | `800` | LLM 层防抖（与补全同节奏，两路同时返回） |
| `proofreadDictDebounceMs` | `200` | 词典层防抖（浏览器本地扫描，零成本） |

## 开发与测试

源码在 `src/*.ts`（TypeScript strict 模式），构建用 [tsdown](https://tsdown.dev) 双入口：

- `src/index.ts` → `lib/index.js`（ESM + `.d.ts`，host 半边，cordis loader 直接 import）
- `src/client.ts` → `lib/client.js`（CJS，banner/footer 自动包 `window.__ModuleLoader__.load` 壳，react / dsh-client-runtime 保持外部依赖，词典等本地模块打包进 bundle）

```shell
npm install
npm run build   # tsdown 双入口构建，产物落 lib/（不含 tsc 严格检查）
npm test        # build → tsc --noEmit → node --test（类型错在本地即拦截）
```

词库数据在 `data/` 下纯文本维护（`zh-wrong-phrases.txt` + `en-wrong-spellings.txt` + `en-proper-nouns.txt` 行式词库 + `zh-context-rules.json` 上下文规则），构建前由 `scripts/gen-dict.mjs` 解析校验并生成 `src/proofread-dict-data.generated.ts`（提交进 git，CI 用 `gendict + git diff` 守卫同步）——更新词库只改 data/ 文件，`npm run build` 自动生效。`test/client-bundle.test.js` 用假 ModuleLoader 真正执行 bundle 产物，验证 data → bundle 全链路；用户自定义词库（localStorage）在浏览器侧与内置词库合并扫描。

## 文档

- [docs/01-立项调研与技术方案.md](./docs/01-立项调研与技术方案.md) — 立项文档：调研结论、架构、插槽契约、里程碑
- [docs/02-首版实施-补全与错别字双层.md](./docs/02-首版实施-补全与错别字双层.md) — 首版实施记录、验证结果、踩坑清单（RPC 错误码枚举、IAB 点击问题等）
- [docs/03-错别字改版-文中红字与逐条导航.md](./docs/03-错别字改版-文中红字与逐条导航.md) — 错别字改版：红字镜像层、导航交互、快捷键冲突排查与验证状态
- [docs/04-内联补全改版-ghost-text与词典下沉.md](./docs/04-内联补全改版-ghost-text与词典下沉.md) — NovAI 化改版：ghost text、逐词采纳、词典层下沉浏览器、双层防抖拆分
- [docs/05-TypeScript重构与tsdown构建.md](./docs/05-TypeScript重构与tsdown构建.md) — TypeScript 重构：tsdown 双入口构建、词典单源化、产物守卫测试
- [docs/06-设置页卡片-插件配置图形化.md](./docs/06-设置页卡片-插件配置图形化.md) — 设置页卡片：settings.plugin.item 插槽调研与实现、暂存表单、守卫测试
- [docs/07-模型目录拉取与默认模型迁移.md](./docs/07-模型目录拉取与默认模型迁移.md) — 模型目录拉取：models.list RPC、datalist 组合框、默认模型迁移 deepseek-flash
- [docs/08-词库外置与自定义词库-开发计划.md](./docs/08-词库外置与自定义词库-开发计划.md) — 词库数据外置 + 用户自定义词库（localStorage）开发计划
- [docs/09-词库外置与自定义词库-实施记录.md](./docs/09-词库外置与自定义词库-实施记录.md) — 词库外置实施记录：data/ + gen-dict 生成器、合并扫描语义、设置卡片词库区块
- [docs/10-英文拼写检查-实施记录.md](./docs/10-英文拼写检查-实施记录.md) — 英文拼写检查实施记录：错拼/专名词典、词边界扫描、LLM 层中英混排
- [docs/11-自定义词库列表编辑器-实施记录.md](./docs/11-自定义词库列表编辑器-实施记录.md) — 自定义词库列表编辑器实施记录：pairs 编辑视图、拖拽 + FLIP 动画、按钮对合并
- [docs/12-在途请求取消-实施记录.md](./docs/12-在途请求取消-实施记录.md) — 在途请求取消实施记录：requestId + cancel 端点、cancelled 错误码、触发点与兼容性
- [docs/13-自定义词库导入导出-实施记录.md](./docs/13-自定义词库导入导出-实施记录.md) — 自定义词库导入/导出实施记录：.txt 同格式互导、合并语义、纯浏览器侧实现

## 架构一览

```
浏览器半边（lib/client.js，tsdown 从 src/client.ts 打包）   host 半边（lib/index.js）
  input.overlay  仅错误提示（无浮层）     loopback    settings 命名空间 input-assist
  input.dock     错别字面板+修正      ───RPC /input-assist───▶  complete   → FIM /beta/completions
  input.right    补/校 开关                             proofread → LLM 层（llmOnly）
                                                        cancel     → 断开在途请求（重调度/Esc/关开关）
  settings.plugin.item  设置页卡片（Plugins→插件配置）    config.get/set → 设置文档读写
  useInput 读草稿 · inputActions.setDraft 写回
  镜像层（body 挂载）：文中红字 + 光标后灰色 ghost 建议
  词典层本地运行（单源 src/proofread-dict.ts，构建时打进 client bundle）
```

## 状态

- [x] 调研与可行性（2026-08-23）
- [x] 首版实施：双侧插件脚手架 + 补全建议条 + 错别字检查（词典 + LLM 双层，点击修正）
- [x] 错别字改版（文中红字标注、逐条导航、标记正确、快捷键）
- [x] 内联补全改版（ghost text、Tab 逐词采纳、词典层下沉浏览器 200ms、LLM/补全统一 800ms）
- [x] TypeScript 重构（src/ 全量 TS、tsdown 双入口构建、词典单源化）
- [x] CI/CD 与发布（双名 npm 包、Trusted Publishing 免 token、GitHub Pages 官网）
- [x] 设置页卡片（Settings → Plugins → 插件配置：11 项配置暂存编辑、保存/放弃、本地校验）
- [x] 模型目录拉取（models.list RPC + 下拉建议组合箱；默认模型迁移 deepseek-flash）
- [x] 词库外置与自定义词库（data/ 纯文本词库 + gen-dict 生成器 + CI 同步守卫；浏览器 localStorage 自定义词库、设置卡片区块编辑）
- [x] 英文拼写检查（错拼 + 专名大小写词典、词边界扫描；LLM 层中英混排校对）
- [x] 真实 Chrome 手感验收：快捷键实测（2026-09-13 通过；点击、设置卡片、词库区块已于 2026-09-12 dsh 真机验证）
- [x] 在途请求取消（重新输入重调度 / Esc / 关开关即断开未完成的补全与 LLM 校对请求，迟到响应不复活、不白烧 token；2026-09-13 真机验证通过，含防抖窗口内 Esc）
- [x] 自定义词库导入/导出（.txt 同格式：导入合并进暂存列表、导出下载/复制到剪贴板；2026-09-13 真机验证通过）
- [ ] 流式渐进渲染（SSE 首 token 渐显；取消链路已就绪，见 docs/12）

## 发布流程

推 `v*` tag 自动触发（版本号须与 package.json 一致）：

- **Release npm** — 测试通过后双名各发一份：`dsh-input-assist`（裸名）+ `@honlnk/dsh-input-assist`（scope 镜像），内容相同。认证走 npm Trusted Publishing（OIDC），无需 NPM_TOKEN；已发布的名字自动跳过（幂等）。
- **Deploy Pages** — `docs/` 下的站点文件部署到 GitHub Pages。

前置（一次性）：npmjs.com 上为**两个包名**各配置一条 Trusted Publisher（repo `honlnk/dsh-input-assist`、workflow `release-npm.yml`、environment 留空）；GitHub Settings → Pages → Source 选 "GitHub Actions"。

```shell
git tag v0.1.0 && git push origin v0.1.0   # 即发布
```

## 社区

- [Show Your Plugins! 发布帖](https://github.com/deepseek-ai/deepseek-harness/discussions/6313) — dsh 上游讨论区的双语介绍帖，欢迎在这里反馈
- [博客：给 DeepSeek Harness 装上 Copilot 式输入体验](https://blog.honlnk.com/ai/tools/dsh-input-assist) — 用户视角的功能介绍
- 发现更多 dsh 插件：GitHub topic [`dsh-plugin`](https://github.com/topics/dsh-plugin)

## 卸载

```shell
dsh plugin --profile web remove dsh-input-assist
```
