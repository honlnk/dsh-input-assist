import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
	extractCompletionText,
	normalizeSuggestion,
	platformBaseUrl,
	listModels,
} from '../src/completion.ts'

test('legacy completions 响应三种字段形态都能读取', () => {
	assert.equal(extractCompletionText({ choices: [{ text: '你好' }] }), '你好')
	assert.equal(extractCompletionText({ choices: [{ message: { content: 'A' } }] }), 'A')
	assert.equal(extractCompletionText({ choices: [{ delta: { content: 'B' } }] }), 'B')
	assert.equal(extractCompletionText({}), '')
	assert.equal(extractCompletionText(null), '')
})

test('normalizeSuggestion 去掉首部换行与尾部空白', () => {
	assert.equal(normalizeSuggestion('\n\n  好的主意 \n'), '好的主意')
	assert.equal(normalizeSuggestion(undefined), '')
	// 中间空白保留
	assert.equal(normalizeSuggestion('继续 写 下去\n'), '继续 写 下去')
	// 前缀为拉丁词时保留单个前导空格（英文单词补全场景）
	assert.equal(normalizeSuggestion(' world', 200, 'hello'), ' world')
	assert.equal(normalizeSuggestion('  world', 200, 'hello'), ' world')
	// 前缀为中文/空白时前导空格是噪声
	assert.equal(normalizeSuggestion(' 世界', 200, '你好'), '世界')
	assert.equal(normalizeSuggestion(' 世界', 200, 'a '), '世界')
})

test('normalizeSuggestion 截断超长建议', () => {
	const long = '字'.repeat(500)
	assert.equal(normalizeSuggestion(long).length, 200)
})

test('platformBaseUrl 剥掉 FIM 尾段得到平台基址', () => {
	assert.equal(platformBaseUrl('https://api.deepseek.com/beta'), 'https://api.deepseek.com')
	assert.equal(platformBaseUrl('https://api.deepseek.com/beta/'), 'https://api.deepseek.com')
	assert.equal(platformBaseUrl('https://api.deepseek.com'), 'https://api.deepseek.com')
	assert.equal(platformBaseUrl('https://proxy.example.com/v1'), 'https://proxy.example.com')
	assert.equal(platformBaseUrl(''), 'https://api.deepseek.com')
})

test('listModels 解析 OpenAI 目录响应并去重排序', async () => {
	const calls = []
	const saved = globalThis.fetch
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), auth: init.headers.authorization })
		return { ok: true, json: async () => ({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }, { id: 'deepseek-flash' }, { owner: 'x' }] }) }
	}
	try {
		const models = await listModels({ baseUrl: 'https://api.deepseek.com/beta', apiKey: 'sk-test' })
		assert.deepEqual(models, ['deepseek-flash', 'deepseek-v4-pro'])
		assert.equal(calls.length, 1)
		assert.equal(calls[0].url, 'https://api.deepseek.com/models')
		assert.equal(calls[0].auth, 'Bearer sk-test')
	} finally {
		globalThis.fetch = saved
	}
})

test('listModels 非 ok / 畸形响应分别抛错与返回空', async () => {
	const saved = globalThis.fetch
	globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => '' })
	await assert.rejects(() => listModels({ baseUrl: '', apiKey: 'k' }), /HTTP 401/)
	globalThis.fetch = async () => ({ ok: true, json: async () => ({ unexpected: true }) })
	assert.deepEqual(await listModels({ baseUrl: '', apiKey: 'k' }), [])
	globalThis.fetch = saved
})
