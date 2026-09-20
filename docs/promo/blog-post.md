# 博客长文：dsh-input-assist 构建记

> 发布目标：blog.honlnk.com（`/ai/tools/dsh-input-assist-build-log` 或类似路径）。定位：与已有的用户视角功能文（`/ai/tools/dsh-input-assist`）互补，这篇是**工程构建记**——一个独立开发者如何在 dsh 的插件契约上做出 Copilot 式输入体验，以及每一步的取舍与坑。GIF 录好后插入占位处。

---

## 一个人，两周，给智能体输入框装上 Tab 补全：dsh-input-assist 构建记

我此前写过一篇用户视角的功能介绍（[在这里](https://blog.honlnk.com/ai/tools/dsh-input-assist)）。这篇是另一面：作为开发者的完整构建记——为什么敢做、dsh 的插件体系长什么样、四个最难的工程问题怎么解的、以及上游一个 developer preview 框架两周内两次破坏性变更时怎么办。所有细节在 [仓库的 17 篇开发文档](https://github.com/honlnk/dsh-input-assist/tree/main/docs) 里都有更硬核的版本，这里是给工程师读的故事线。

### 起点：一个空白格

Claude Code、Codex、Cursor、VS Code Chat，所有智能体的输入框都没有补全。原因我在上一篇文章里拆过四个（「打字不是瓶颈」的误判、开放域补全接受率的错误迁移、FIM 延迟成本、中文 IME 硬骨头），结论是：这不是技术不可行，是没人做。

我手里恰好有两块拼图：一是 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness)——DeepSeek 开源的智能体框架，「一切皆插件」，输入框有公开的扩展插槽；二是我此前在另一个项目 NovAI 里完整做过对话输入框的 AI 补全，代码可平移。2026-08-23 立项调研，两周后的今天它迭代到了 v0.7.1：ghost text 流式补全、双层中英错别字检查、自定义词库、设置页图形化配置、116 项测试、双 npm 包自动发布。

<!-- GIF 占位：中文 15 秒演示 -->

### dsh 插件体系：一个插件，两半生命

dsh 的插件是**双侧**的。host 半边跑在 Node（cordis 框架），能开 RPC 端点、发网络请求、读配置；浏览器半边跑在 Web UI 里，通过插槽（slot）系统挂进界面——`input.right`（输入框右侧按钮）、`input.dock`（输入框下dock条）、`input.overlay`（浮层）、`settings.plugin.item`（设置页卡片）都是现成的座位。两半之间靠 RPC 通信。

这个分层直接决定了架构：**API key、FIM 调用全在 host 半边**（浏览器永远见不到密钥）；**渲染、词典扫描、防抖全在浏览器半边**（省一次 RPC 往返，本地扫描 200ms 出结果）。立项时我列了 M0–M4 五个里程碑（脚手架 → 补全 MVP → 错字检查 → 打磨 → 发布），事后看这个节奏基本守住了，唯一大改的是打磨阶段：原计划 ghost text 是「可关闭的增强」，做着做着发现它才是本体验的核心，建议条方案直接废弃。

### 战役一：ghost text——在别人的输入框里画字

ghost text 的本质是**视觉欺骗**：用户的输入框原地不动，你在它上面叠一层透明镜像，把「已输入内容 + 灰色建议」完整重画一遍，让灰色部分看起来「长」在光标后面。难点全在毫米级对齐：字体、行高、内边距、换行位置、滚动位置，任何一项差一像素，ghost 就会漂。

第一版对着 textarea 做，配合镜像层滚动同步，一个下午调平。然后 dsh 0.1.5-rc.2 来了：官方把 composer 从 textarea 换成了 **Lexical contenteditable**。contenteditable 没有统一的 value，文本散落在多个块级节点里，光标是 DOM Range 不是数字偏移——我的定位逻辑全部失效，症状是「ghost 无声不弹」。

修法是写一个 `findComposer` 双运行时探测：旧运行时走 textarea 路径，新运行时对 contenteditable 做块级遍历，把光标前的文本拼回来。镜像层、Tab 采纳、键盘拦截全链路跟着重接。这次适配的完整排查过程写在 [docs/17](https://github.com/honlnk/dsh-input-assist/blob/main/docs/17-输入框contenteditable适配.md)。

教训：**DOM 叠加类功能对宿主实现细节的依赖是刚性的**，缓解办法只有两个——把「找到输入框」收敛成唯一的探测模块（宿主再换实现只改一处），以及真机回归（我后来把无头浏览器实测写进了验收流程）。

### 战役二：流式——请求响应式的 RPC 里塞 SSE

补全要「逐字渐显」，就得把 FIM 接口的 SSE 流转发进浏览器。但 dsh 的 RPC 通道是请求/响应式的，没有事件推送。首版我妥协了：host 收完整个响应再一次性返回，能用，但没有灵魂。

解法绕开 RPC：dsh 0.1.5 的 webServer 注入让 host 半边可以直接注册 HTTP 路由，于是开了两条通道——`POST /api/input-assist/stream` 直连浏览器，host 侧把 FIM 的 SSE 解析成自己的帧协议（`{delta}` / `{done}` / `{error}`）回写；浏览器侧用 fetch 读流，每帧驱动一次 ghost 渐显。旧运行时（0.1.1）没有 webServer，就自动降级回非流式 RPC——**同一份插件，两条网络路径，按运行时探测选择**。

帧协议自己定义而不是透传 SSE，是为了把「传输层」和「渲染层」解耦：渲染只认帧，不关心帧从哪来。后来加「在途取消」时这个设计直接受益——cancel 是一个 RPC，stream 是一条 fetch，两路统一用 requestId 关联，迟到的响应带着过期 requestId，直接丢弃。

### 战役三：中文 IME——Tab 不是你的 Tab

英文世界的补全直接拿 Tab 采纳，中文世界 Tab 是**候选词确认键**。拦截时机错一毫秒，用户打「你好」就会变成选中第一个候选。

规则最后收敛成三条：**组合期（compositionstart 到 compositionend 之间）任何按键不拦截、不渲染、不请求**；建议只在组合结束并停笔 800ms 后出现；逐词采纳用 `Intl.Segmenter('zh')` 分词而不是按空格切。另有一条隐性规则：Esc 关建议必须和「取消本次输入提醒」共存，键位语义按上下文分派。这些全部在真实 Chrome 里手动验收过（docs 里有验收记录），自动化测试测不出 IME 时序，这一块只能人肉。

### 战役四：词典层——把错别字检查做成零成本

错别字检查最初的设想是纯 LLM，跑下来发现不对：大部分错误是**高确定性、低上下文依赖**的（「迫不急待」、「recieve」），为它们烧一次 LLM 调用既慢又贵。于是拆成两层：

- **词典层，浏览器本地**：228 条中文错词 + 211 条英文错拼/专名大小写 + 8 条上下文规则，200ms 防抖即时标红，离线、零成本。英文用词边界匹配——驼峰、snake_case、`obj.method` 一律不查，否则写代码的人会被误报到崩溃。
- **LLM 层，只管词典管不了的**：在/再、的/得/地这类需要上下文的，800ms 防抖，与补全同节奏发出。

词库数据以纯文本存在 `data/` 下（`错词 => 正词` 一行一条），构建时由生成器解析校验产出 TS 模块，CI 用 `gendict + git diff` 守卫——**改词库就是改文本文件**，不懂代码也能提 PR。用户自定义词库走浏览器 localStorage，与内置词库合并扫描，同名覆盖、自映射禁用，`.txt` 导入导出。

### 工程底座：为什么敢说「稳」

- **TypeScript strict 全量**，host/浏览器两半共享类型定义（RPC 请求响应、配置 schema、帧协议）
- **tsdown 双入口构建**：host 产物是 cordis loader 直接 import 的 ESM；浏览器产物是 CJS 且自动包 `window.__ModuleLoader__.load` 壳，react 等宿主依赖保持 external——两种加载器、一份源码
- **116 项测试**，其中最有价值的一类是「bundle 真执行」：用假 ModuleLoader 真正加载构建产物跑断言，词库 data → 生成器 → bundle 全链路都在守卫范围内；发布流程里类型检查在 `npm test` 第一道就拦截
- **发布全自动**：推 `v*` tag，CI 测试通过后用 npm Trusted Publishing（OIDC，免 token）双名各发一份（`dsh-input-assist` + `@honlnk/dsh-input-assist`），GitHub Pages 官网同管线部署

### 追着 developer preview 跑

dsh 还在 developer preview，契约说变就变。项目周期内遇到两次大的：0.1.5-rc.2 的 webServer 注入 / client-runtime 消亡 / RPC over fetch（三处变更一次适配，docs/16），和 composer 换 Lexical（docs/17）。策略是立项时就定下的：**只用 additive 插槽和公开契约，不用任何替换式座位**——所以每次上游变更，我改的都是自己的适配层，从来没有和宿主抢过同一个座位。兼容目标定在「官方 latest + 上一代」双运行时，探测降级，用户无感。

### 现实一课：做完 ≠ 被看见

最后说个和技术无关的数字：这个项目目前 **0 star**。功能完整、测试齐全、文档 17 篇，发过一次官方 Discussions 帖，换来 2 个赞。我正在按一份推广计划补课（GIF 演示、awesome 目录收录、社区铺开），这篇构建记本身也是其中一环。

如果这篇里有哪段让你想过「我也想在 XX 上做这个」——dsh-input-assist 的思路、协议和坑全部开源在 [github.com/honlnk/dsh-input-assist](https://github.com/honlnk/dsh-input-assist)，MIT，欢迎直接搬。输入框是 agent 时代的新地址栏，这个格子不该一直空着。
