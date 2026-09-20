# V2EX「分享创造」帖

> 发布目标：V2EX /go/create 节点。标题用下面第一行；正文精简，导流 GitHub 与博客。GIF 录好后替换占位。

## 标题

```
给 DeepSeek Harness 的输入框加上了 Copilot 式补全和中文错别字检查
```

## 正文

```markdown
用 Claude Code / Codex 这类智能体的时候一直觉得奇怪：代码编辑器里习以为常的 Tab 补全，为什么智能体的输入框一个都没有？每天重复打的「跑一下测试」「继续」「这个文件改成……」，全得手敲。

于是给 DeepSeek Harness（dsh）写了个插件 dsh-input-assist，两条命令装上：

    dsh plugin --profile web add dsh-input-assist
    dsh --profile web

三块功能：

1. **Ghost text 补全**——停笔 800ms，灰色建议内联在光标后，SSE 流式逐字渐显；Tab 逐词采纳（中文按词切分）、Shift+Tab 全量。底层是 DeepSeek FIM 接口，IME 组合期绝对安静。重新输入或 Esc 会真正取消在途请求，不白烧 token。
2. **错别字检查**——词典层浏览器本地跑（228 中文错词 + 211 英文错拼，200ms 标红、零成本），LLM 层管在/再、的/得/地这类上下文错误。红波浪线标在文中，导航条逐条修正，绝不全量替换。
3. **自定义词库**——设置页成对编辑，.txt 导入导出，只存本浏览器。

<!-- GIF 占位：15 秒中文演示 -->

中间趟了不少坑：中文 IME 下 Tab 是候选词确认键，不能乱拦；dsh 0.1.5 把输入框换成了 contenteditable，镜像层整套重做。过程写了 17 篇开发文档，都在仓库里。

GitHub：https://github.com/honlnk/dsh-input-assist （TypeScript，116 项测试，MIT）
官网：https://honlnk.github.io/dsh-input-assist/
构建记：https://blog.honlnk.com/ai/tools/dsh-input-assist

欢迎拍砖。
```
