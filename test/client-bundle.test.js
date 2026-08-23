// Client bundle guard (TS 化后取代 dict-sync 测试):词典曾以 DICT-SHARED
// 标记块在 host/browser 两份拷贝间逐字同步;现在单一源在 src/proofread-dict.ts,
// 由 tsdown 打进 lib/client.js。本测试用假 ModuleLoader + 假 react/runtime
// 真正执行 bundle 产物,验证:
//   1. ModuleLoader 壳完整(banner/footer,CJS exports 形状)
//   2. react / dsh-client-runtime 保持外部依赖(require 宿主种子,未被打包)
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

test('react / dsh-client-runtime 是外部依赖而非打包内容', () => {
	assert.ok(clientSource.includes('require("react")'))
	assert.ok(clientSource.includes('require("@deepseek-ai/dsh-client-runtime/client")'))
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
	const runtimeStub = {
		createSnapshotStore: (init) => ({
			getSnapshot: () => init,
			set: () => {},
			subscribe: () => () => {},
		}),
	}
	return captured.factory((id) => {
		if (id === 'react') return reactStub
		if (id === '@deepseek-ai/dsh-client-runtime/client') return runtimeStub
		throw new Error(`unexpected require: ${id}`)
	})
}

test('exports 形状：apply/inject/scanLocalTypos', () => {
	const api = loadBundleExports()
	assert.equal(typeof api.apply, 'function')
	assert.deepEqual(api.inject, ['slots', 'locale', 'connection', 'remote'])
	assert.equal(typeof api.scanLocalTypos, 'function')
})

// —— bundle 内词典行为（单源，直接断言期望值）——
const bundleScan = (text) => loadBundleExports().scanLocalTypos(text)

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
