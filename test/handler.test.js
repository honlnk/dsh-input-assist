import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHandler, DEFAULT_CONFIG, resolveApiKey } from '../lib/index.js'

// 隔离真实 ~/.dsh，避免本机凭证文件影响测试
const savedKey = process.env.DEEPSEEK_API_KEY
const savedHome = process.env.DSH_HOME
delete process.env.DEEPSEEK_API_KEY
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'ia-test-home-'))
test.after(() => {
	if (savedKey === undefined) delete process.env.DEEPSEEK_API_KEY
	else process.env.DEEPSEEK_API_KEY = savedKey
	if (savedHome === undefined) delete process.env.DSH_HOME
	else process.env.DSH_HOME = savedHome
})

const makeHandler = (config = {}) => {
	let current = { ...DEFAULT_CONFIG, ...config }
	return createHandler({
		getConfig: () => ({ ...current }),
		updateConfig: async (patch) => {
			current = { ...current, ...patch }
		},
	})
}

test('config.get 返回默认配置', async () => {
	const handler = makeHandler()
	const res = await handler('config.get', {})
	assert.equal(res.ok, true)
	assert.equal(res.value.completionModel, 'deepseek-flash')
	assert.equal(res.value.completionEnabled, true)
	assert.equal(res.value.completionStream, true)
})

test('config.set 只接受白名单键并做类型清洗', async () => {
	const handler = makeHandler()
	const res = await handler('config.set', {
		completionEnabled: false,
		completionDebounceMs: '300',
		completionStream: false,
		proofreadModel: 42, // 类型不符应被丢弃
		hackKey: 'x',
	})
	assert.equal(res.ok, true)
	assert.equal(res.value.completionEnabled, false)
	assert.equal(res.value.completionDebounceMs, 300)
	assert.equal(res.value.completionStream, false)
	assert.equal(res.value.proofreadModel, 'deepseek-flash')
	assert.ok(!('hackKey' in res.value))
})

test('complete：未配置 apiKey 以 reason 标识（避免触发传输层错误枚举校验）', async () => {
	const handler = makeHandler()
	const res = await handler('complete', { prefix: '帮我写', suffix: '' })
	assert.equal(res.ok, true)
	assert.equal(res.value.text, '')
	assert.equal(res.value.reason, 'no-api-key')
})

test('complete：功能关闭时静默返回空', async () => {
	const handler = makeHandler({ completionEnabled: false })
	const res = await handler('complete', { prefix: '帮我写', suffix: '' })
	assert.equal(res.ok, true)
	assert.equal(res.value.text, '')
})

test('proofread：无 apiKey 时词典层照常工作', async () => {
	const handler = makeHandler()
	const res = await handler('proofread', { text: '他迫不急待地想回家，帐号也忘了' })
	assert.equal(res.ok, true)
	const origs = res.value.issues.map((i) => i.orig)
	assert.ok(origs.includes('迫不急待'))
	assert.ok(origs.includes('帐号'))
})

test('proofread：llmOnly 跳过 host 侧词典扫描（v3 起词典在浏览器本地跑）', async () => {
	const handler = makeHandler()
	const res = await handler('proofread', { text: '他迫不急待地想回家', llmOnly: true })
	assert.equal(res.ok, true)
	// 无 apiKey → LLM 层为空；词典层被 llmOnly 跳过 → 应为空
	assert.equal(res.value.issues.length, 0)
})

test('proofread：新默认值（补全/LLM 800ms、词典 200ms）', async () => {
	assert.equal(DEFAULT_CONFIG.completionDebounceMs, 800)
	assert.equal(DEFAULT_CONFIG.proofreadDebounceMs, 800)
	assert.equal(DEFAULT_CONFIG.proofreadDictDebounceMs, 200)
	const handler = makeHandler()
	const res = await handler('config.get', {})
	assert.equal(res.value.proofreadDictDebounceMs, 200)
})

test('proofread：功能关闭返回空', async () => {
	const handler = makeHandler({ proofreadEnabled: false })
	const res = await handler('proofread', { text: '他迫不急待地想回家' })
	assert.equal(res.ok, true)
	assert.equal(res.value.issues.length, 0)
})

test('未知端点报 internal（code 受传输层枚举限制）', async () => {
	const handler = makeHandler()
	const res = await handler('nope', {})
	assert.equal(res.ok, false)
	assert.equal(res.error.code, 'internal')
	assert.ok(res.error.message.includes('nope'))
})

test('resolveApiKey：环境变量回退', () => {
	process.env.DEEPSEEK_API_KEY = 'sk-env-fallback'
	assert.equal(resolveApiKey({ completionApiKey: '' }), 'sk-env-fallback')
	assert.equal(resolveApiKey({ completionApiKey: 'sk-own' }), 'sk-own')
	delete process.env.DEEPSEEK_API_KEY
})

test('models.list：成功返回排序后的模型目录', async () => {
	const saved = globalThis.fetch
	let hit = ''
	globalThis.fetch = async (url) => {
		hit = String(url)
		return { ok: true, json: async () => ({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }) }
	}
	try {
		const handler = makeHandler({ completionApiKey: 'sk-test' })
		const res = await handler('models.list', {})
		assert.equal(res.ok, true)
		assert.deepEqual(res.value.models, ['deepseek-flash', 'deepseek-v4-pro'])
		assert.equal(res.value.reason, undefined)
		assert.equal(hit, 'https://api.deepseek.com/models') // /beta 尾段被剥掉
	} finally {
		globalThis.fetch = saved
	}
})

test('models.list：无 apiKey 以 reason 标识且不发请求', async () => {
	const saved = globalThis.fetch
	let called = false
	globalThis.fetch = async () => {
		called = true
		return { ok: true, json: async () => ({ data: [] }) }
	}
	try {
		const handler = makeHandler({ completionApiKey: '' })
		const res = await handler('models.list', {})
		assert.equal(res.ok, true)
		assert.deepEqual(res.value.models, [])
		assert.equal(res.value.reason, 'no-api-key')
		assert.equal(called, false)
	} finally {
		globalThis.fetch = saved
	}
})

test('models.list：拉取失败 ok 返回 reason 不走错误码', async () => {
	const saved = globalThis.fetch
	globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' })
	try {
		const handler = makeHandler({ completionApiKey: 'sk-test' })
		const res = await handler('models.list', {})
		assert.equal(res.ok, true)
		assert.deepEqual(res.value.models, [])
		assert.equal(res.value.reason, 'fetch-failed')
		assert.ok(res.value.message.includes('500'))
	} finally {
		globalThis.fetch = saved
	}
})

// —— 在途取消（v0.5）：requestId 注册 + cancel 端点 + cancelled 错误码 ——
// 仿真 fetch：挂起直到 signal abort，随后以 AbortError 拒绝（贴近真实 fetch）
const hangOnAbortFetch = () => {
	const saved = globalThis.fetch
	globalThis.fetch = (_url, init) =>
		new Promise((_resolve, reject) => {
			const abort = () => {
				const err = new Error('The operation was aborted')
				err.name = 'AbortError'
				reject(err)
			}
			if (init.signal.aborted) abort()
			else init.signal.addEventListener('abort', abort)
		})
	return () => {
		globalThis.fetch = saved
	}
}

test('complete：cancel 断开在途请求，整单以 cancelled 错误码收场', async () => {
	const restore = hangOnAbortFetch()
	try {
		const handler = makeHandler({ completionApiKey: 'sk-test' })
		const pending = handler('complete', { prefix: '帮我写一段', suffix: '', requestId: 'req-1' })
		const res = await handler('cancel', { requestId: 'req-1' })
		assert.equal(res.ok, true)
		assert.equal(res.value.cancelled, true)
		const done = await pending
		assert.equal(done.ok, false)
		assert.equal(done.error.code, 'cancelled')
		// settle 后注册表已摘除：再 cancel 同 id 幂等返回 false
		const again = await handler('cancel', { requestId: 'req-1' })
		assert.equal(again.ok, true)
		assert.equal(again.value.cancelled, false)
	} finally {
		restore()
	}
})

test('proofread：cancel 断开在途 LLM 请求并以 cancelled 收场', async () => {
	const restore = hangOnAbortFetch()
	try {
		const handler = makeHandler({ completionApiKey: 'sk-test' })
		const pending = handler('proofread', { text: '他迫不急待地想回家', llmOnly: true, requestId: 'req-2' })
		const res = await handler('cancel', { requestId: 'req-2' })
		assert.equal(res.ok, true)
		assert.equal(res.value.cancelled, true)
		const done = await pending
		assert.equal(done.ok, false)
		assert.equal(done.error.code, 'cancelled')
	} finally {
		restore()
	}
})

test('complete：不带 requestId（旧客户端）照常工作，不注册不受 cancel 影响', async () => {
	const saved = globalThis.fetch
	globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ text: '好的' }] }) })
	try {
		const handler = makeHandler({ completionApiKey: 'sk-test' })
		const done = await handler('complete', { prefix: '帮我写', suffix: '' })
		assert.equal(done.ok, true)
		assert.equal(done.value.text, '好的')
		const res = await handler('cancel', { requestId: 'whatever' })
		assert.equal(res.ok, true)
		assert.equal(res.value.cancelled, false)
	} finally {
		globalThis.fetch = saved
	}
})

test('cancel：缺 requestId 报 internal（code 受传输层枚举限制）', async () => {
	const handler = makeHandler()
	const res = await handler('cancel', {})
	assert.equal(res.ok, false)
	assert.equal(res.error.code, 'internal')
})
