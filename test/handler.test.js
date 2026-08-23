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
	assert.equal(res.value.completionModel, 'deepseek-chat')
	assert.equal(res.value.completionEnabled, true)
})

test('config.set 只接受白名单键并做类型清洗', async () => {
	const handler = makeHandler()
	const res = await handler('config.set', {
		completionEnabled: false,
		completionDebounceMs: '300',
		proofreadModel: 42, // 类型不符应被丢弃
		hackKey: 'x',
	})
	assert.equal(res.ok, true)
	assert.equal(res.value.completionEnabled, false)
	assert.equal(res.value.completionDebounceMs, 300)
	assert.equal(res.value.proofreadModel, 'deepseek-chat')
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
