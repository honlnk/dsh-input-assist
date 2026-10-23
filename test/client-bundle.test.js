// Client bundle guard (TS 化后取代 dict-sync 测试):词典曾以 DICT-SHARED
// 标记块在 host/browser 两份拷贝间逐字同步;现在单一源在 src/proofread-dict.ts,
// 由 tsdown 打进 lib/client.js。本测试用假 ModuleLoader + 假 react 真正执行
// bundle 产物,验证:
//   1. ModuleLoader 壳完整(banner/footer,CJS exports 形状)
//   2. react 保持外部依赖(require 宿主种子,未被打包);snapshot store 已收编
//      进 bundle(0.1.5 起 dsh-client-runtime 消亡,不再有第二个 external)
//   3. 词典数据确实进了 bundle 且行为正确(错词/上下文规则/掩码)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const clientSource = readFileSync(join(here, '../lib/client.js'), 'utf8')

// —— 壳完整性 ——
test('bundle 被 ModuleLoader 壳包裹且不再有 DICT-SHARED 标记', () => {
	assert.ok(clientSource.startsWith('window.__ModuleLoader__.load('), 'missing ModuleLoader banner')
	assert.ok(clientSource.includes('return module.exports;}});'), 'missing ModuleLoader footer')
	assert.ok(!clientSource.includes('DICT-SHARED'), 'stale DICT-SHARED marker from the pre-TS era')
})

test('react 是唯一外部依赖，snapshot store 已打进 bundle', () => {
	assert.ok(clientSource.includes('require("react")'))
	assert.ok(!clientSource.includes('require("@deepseek-ai/dsh-client-runtime/client")'), 'dsh-client-runtime 已于 0.1.5 消亡，不应再被 require')
	assert.ok(!clientSource.includes('createElementWithValidation'), 'react 本体不应被打进来')
})

// —— 用假宿主执行 bundle,拿回 exports ——
function loadBundleExports() {
	let captured = null
	globalThis.window = {
		__ModuleLoader__: { load: (def) => { captured = def } },
	}
	// eslint-disable-next-line no-new-func
	new Function(clientSource)()
	assert.ok(captured !== null, 'ModuleLoader.load 未被调用')
	const reactStub = { createElement: () => null, useEffect: () => {} }
	return captured.factory((id) => {
		if (id === 'react') return reactStub
		throw new Error(`unexpected require: ${id}`)
	})
}

test('exports 形状：apply/inject/scanLocalTypos', () => {
	const api = loadBundleExports()
	assert.equal(typeof api.apply, 'function')
	assert.deepEqual(api.inject, ['slots', 'locale', 'connection', 'remote'])
	assert.equal(typeof api.scanLocalTypos, 'function')
	assert.equal(typeof api.scanWithUserDict, 'function')
	assert.equal(typeof api.loadUserDictText, 'function')
	assert.equal(typeof api.saveUserDictText, 'function')
})

// —— 用户自定义词库端到端（localStorage 值 → 合并 → 扫描，全在 bundle 内） ——
test('用户词库：新增/覆盖/自映射禁用，经 bundle 完整链路生效', () => {
	const api = loadBundleExports()
	const userText = ['新错词 => 新正词', '帐号 => 账户', '迫不急待 => 迫不急待'].join('\n')
	const hits = (text) => api.scanWithUserDict(text, userText).map((i) => `${i.orig}→${i.fix}`)
	// 新增词
	assert.deepEqual(hits('这里有个新错词'), ['新错词→新正词'])
	// 覆盖内置同错词的目标词
	assert.deepEqual(hits('这个帐号被盗了'), ['帐号→账户'])
	// 自映射禁用内置「迫不急待」；未禁用的内置词照常
	assert.deepEqual(hits('他迫不急待，一如继往'), ['一如继往→一如既往'])
	// 空用户词库 = 纯内置
	assert.deepEqual(api.scanWithUserDict('他迫不急待地想知道结果', '').map((i) => i.orig), ['迫不急待'])
})

test('用户词库 storage 封装经 bundle 可用（假 storage 注入）', () => {
	const api = loadBundleExports()
	const s = { getItem: () => null, setItem: () => {} }
	let saved = ''
	const store = { getItem: () => 'x => y', setItem: (k, v) => { saved = v } }
	assert.equal(api.loadUserDictText(store), 'x => y')
	assert.equal(api.loadUserDictText(undefined), '')
	assert.equal(api.saveUserDictText(store, 'a => b'), true)
	assert.equal(saved, 'a => b')
	assert.equal(api.saveUserDictText(null, 'a => b'), false)
	assert.equal(api.loadUserDictText(s), '')
})

// —— bundle 内词典行为（单源，直接断言期望值）——
const bundleScan = (text) => loadBundleExports().scanLocalTypos(text)

test('data/ 词库条目端到端进 bundle 并可检出（data → gen-dict → bundle 链路）', () => {
	// 取 data/zh-wrong-phrases.txt 的第一条真实词条，构造包含句验证 bundle 能检出
	const first = readFileSync(join(here, '../data/zh-wrong-phrases.txt'), 'utf8')
		.split(/\r?\n/)
		.find((l) => l.trim() !== '' && !l.trim().startsWith('#'))
	const [wrong, right] = first.split('=>').map((s) => s.trim())
	const issues = bundleScan(`这句话里出现了${wrong}这个错词`)
	assert.equal(issues.length, 1)
	assert.equal(issues[0].orig, wrong)
	assert.equal(issues[0].fix, right)
})

test('data/ 英文错拼条目端到端进 bundle（词边界匹配生效）', () => {
	const first = readFileSync(join(here, '../data/en-wrong-spellings.txt'), 'utf8')
		.split(/\r?\n/)
		.find((l) => l.trim() !== '' && !l.trim().startsWith('#'))
	const [wrong, right] = first.split('=>').map((s) => s.trim())
	const issues = bundleScan(`plain word ${wrong} here, but camel${wrong}Case not flagged`)
	const hits = issues.filter((i) => i.orig === wrong)
	assert.equal(hits.length, 1)
	assert.equal(hits[0].fix, right)
})

test('词典命中：错词映射与 offset', () => {
	const issues = bundleScan('我迫不急待地想看看这个结果')
	assert.equal(issues.length, 1)
	assert.equal(issues[0].orig, '迫不急待')
	assert.equal(issues[0].fix, '迫不及待')
	assert.equal(issues[0].offset, 1)
	assert.equal(issues[0].source, 'dict')
})

test('词典命中：多错词与排序去重', () => {
	const origs = bundleScan('他的帐号和帐户都登不上去,再接再励,一如继往').map((i) => i.orig)
	assert.deepEqual(origs, ['帐号', '帐户', '再接再励', '一如继往'])
})

test('上下文规则命中', () => {
	const hits = (text) => bundleScan(text).map((i) => `${i.orig}→${i.fix}`)
	assert.deepEqual(hits('请登陆系统后再操作'), ['登陆系统→登录系统'])
	assert.deepEqual(hits('出门记得带口罩'), ['带口罩→戴口罩'])
	assert.deepEqual(hits('贴一张寻人启示'), ['寻人启示→寻人启事'])
	assert.deepEqual(hits('我们一起渡过假期'), ['渡过→度过'])
	assert.deepEqual(hits('截止今天还没有回复'), ['截止今天→截至今天'])
	assert.deepEqual(hits('他激动得不能自己'), ['得不能自己→得不能自已'])
	assert.deepEqual(hits('今天好象要下雨'), ['好象→好像'])
	assert.deepEqual(hits('好象形论述不涉及'), []) // 负例：接“形”不替换
})

test('掩码：行内代码/围栏块/URL 内的错词不标，外面照标', () => {
	const hits = (text) => bundleScan(text).map((i) => i.orig)
	assert.deepEqual(hits('`迫不急待` 行内代码里的不标'), [])
	assert.deepEqual(hits('```\n迫不急待\n```\n围栏里的不标，句外的迫不急待要标'), ['迫不急待'])
	assert.deepEqual(hits('见 https://example.com/迫不急待 链接里的不算，句末的迫不急待要算'), ['迫不急待'])
	assert.deepEqual(hits('干净的句子没有错字。'), [])
	assert.deepEqual(hits(''), [])
})

// —— 镜像层 HTML 拼装（buildMirrorHtml：ghost 按光标偏移切进文本，
//    与错字 span 同款分段拼接；句中停笔灰字落在洞口而非全文末尾） ——
const typo = (offset, orig) => ({ offset, orig, fix: '正', reason: 'test', source: 'dict' })
const GHOST = '<span class="ia_ghost">XY</span>'

test('句中 ghost：按 caret 偏移切进文本中间', () => {
	const build = loadBundleExports().buildMirrorHtml
	assert.equal(build('ABCD', [], -1, 'XY', 2), `AB${GHOST}CD`)
	assert.equal(build('ABCD', [], -1, 'XY', 0), `${GHOST}ABCD`)
})

test('句末 ghost：caret 等于文本长度，越界钳到末尾', () => {
	const build = loadBundleExports().buildMirrorHtml
	assert.equal(build('ABC', [], -1, 'XY', 3), `ABC${GHOST}`)
	assert.equal(build('ABC', [], -1, 'XY', 99), `ABC${GHOST}`)
	assert.equal(build('ABC', [], -1, 'XY', -5), `${GHOST}ABC`)
	// 尾段为空（最后一个错字 span 之后）：from === to 也要发出 ghost
	assert.equal(
		build('ABC', [typo(1, 'BC')], -1, 'XY', 3),
		`A<span class="ia_typo" data-ia-off="1">BC</span>${GHOST}`,
	)
})

test('ghost 与错字 span 相邻：偏移在 span 前后分别落两侧', () => {
	const build = loadBundleExports().buildMirrorHtml
	const typoSpan = '<span class="ia_typo" data-ia-off="2">CD</span>'
	assert.equal(build('ABCD', [typo(2, 'CD')], -1, 'XY', 2), `AB${GHOST}${typoSpan}`)
	assert.equal(build('ABCD', [typo(2, 'CD')], -1, 'XY', 4), `AB${typoSpan}${GHOST}`)
})

test('ghost 偏移落在错字 span 内部：顺延到该 span 之后（不拆 span）', () => {
	const build = loadBundleExports().buildMirrorHtml
	assert.equal(
		build('ABCD', [typo(2, 'CD')], -1, 'XY', 3),
		`AB<span class="ia_typo" data-ia-off="2">CD</span>${GHOST}`,
	)
})

test('多行文本：\\n 原样保留，ghost 与错字按偏移拼接', () => {
	const build = loadBundleExports().buildMirrorHtml
	// 我(0)在(1)\n(2)他(3)再(4)在(5)：ghost 落第二行行首（offset 3），
	// 错字「再」在 4（当前项），\n 原样保留
	assert.equal(
		build('我在\n他再在', [typo(4, '再')], 0, 'XY', 3),
		`我在\n${GHOST}他<span class="ia_typo ia_typoCur" data-ia-off="4">再</span>在`,
	)
})

test('ghost 为空串：不产生 ia_ghost span（纯错字渲染不变）', () => {
	const build = loadBundleExports().buildMirrorHtml
	assert.equal(
		build('ABC', [typo(0, 'AB')], 0, '', 0),
		'<span class="ia_typo ia_typoCur" data-ia-off="0">AB</span>C',
	)
	assert.equal(build('ABC', [], -1, '', 2), 'ABC')
})

test('HTML 转义：文本与 ghost 均经 escHtml', () => {
	const build = loadBundleExports().buildMirrorHtml
	assert.equal(build('a<b', [], -1, '<x>&', 1), `a<span class="ia_ghost">&lt;x&gt;&amp;</span>&lt;b`)
})
