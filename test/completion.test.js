import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
	extractCompletionText,
	normalizeSuggestion,
	platformBaseUrl,
	listModels,
	requestFimCompletion,
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

// —— 在途取消：外部 signal 与超时联动（abort.ts 经 requestFimCompletion 端到端）——
// 仿真 fetch：持有 init.signal，abort 时以 AbortError 拒绝（贴近真实 fetch）
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

test('requestFimCompletion：外部信号 abort 后以 AbortError 拒绝（host 据此回 cancelled）', async () => {
	const restore = hangOnAbortFetch()
	try {
		const external = new AbortController()
		const pending = requestFimCompletion({
			baseUrl: 'https://x.example/v1',
			apiKey: 'k',
			model: 'm',
			prompt: '你好',
			suffix: '',
			signal: external.signal,
		})
		external.abort()
		await assert.rejects(pending, (err) => err instanceof Error && err.name === 'AbortError')
	} finally {
		restore()
	}
})

test('requestFimCompletion：未取消的外部信号不影响正常返回', async () => {
	const saved = globalThis.fetch
	globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ text: ' 世界' }] }) })
	try {
		const text = await requestFimCompletion({
			baseUrl: 'https://x.example/v1',
			apiKey: 'k',
			model: 'm',
			prompt: 'hello',
			suffix: '',
			signal: new AbortController().signal,
		})
		// 前缀 hello 以拉丁字母结尾：单个前导空格按语义保留
		assert.equal(text, ' 世界')
	} finally {
		globalThis.fetch = saved
	}
})

test('requestFimCompletion：外部 signal 已 abort 时立即拒绝（不发真请求）', async () => {
	const restore = hangOnAbortFetch()
	try {
		const external = new AbortController()
		external.abort()
		await assert.rejects(
			requestFimCompletion({ baseUrl: 'https://x.example', apiKey: 'k', model: 'm', prompt: '你好', suffix: '', signal: external.signal }),
			(err) => err instanceof Error && err.name === 'AbortError',
		)
	} finally {
		restore()
	}
})
