import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
	extractCompletionText,
	extractFimDeltaText,
	normalizeSuggestion,
	platformBaseUrl,
	listModels,
	requestFimCompletion,
	streamFimCompletion,
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

// —— streamFimCompletion（SSE 流式，v0.6）——
// SSE 响应桩：chunks 逐个 enqueue（可为字符串或 Uint8Array，模拟网络分片）；
// abortSignal 断开时 error 流体（贴近真实 undici：fetch signal abort 会
// 让 body reader 的 pending read() 以 AbortError 拒绝）
const sseFetch = (chunks, { contentType = 'text/event-stream', onStarted } = {}) => {
	const saved = globalThis.fetch
	const calls = []
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), init })
		const stream = new ReadableStream({
			start(controller) {
				const encoder = new TextEncoder()
				const abort = () => controller.error(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
				if (init.signal.aborted) abort()
				else init.signal.addEventListener('abort', abort)
				for (const chunk of chunks) {
					controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
				}
				if (onStarted === undefined) controller.close()
				else onStarted(controller)
			},
		})
		return { ok: true, status: 200, headers: new Headers({ 'content-type': contentType }), body: stream }
	}
	return { restore: () => { globalThis.fetch = saved }, calls }
}

test('streamFimCompletion：SSE 主路径累积文本并按序回调 delta，[DONE] 跳过', async () => {
	const { restore } = sseFetch([
		'data: {"choices":[{"text":"你"}]}\n\n',
		'data: {"choices":[{"text":"好"}]}\n\ndata: [DONE]\n\n',
	])
	const deltas = []
	try {
		const text = await streamFimCompletion({
			baseUrl: 'https://x.example/beta', apiKey: 'k', model: 'm',
			prompt: '你好', suffix: '', onDelta: (d) => deltas.push(d),
		})
		assert.equal(text, '你好')
		assert.deepEqual(deltas, ['你', '好'])
	} finally {
		restore()
	}
})

test('streamFimCompletion：delta.content 兜底，text 与其并存时 text 优先', async () => {
	const { restore } = sseFetch([
		'data: {"choices":[{"delta":{"content":"A"}}]}\n\n',
		'data: {"choices":[{"text":"B","delta":{"content":"IGNORED"}}]}\n\n',
	])
	try {
		const text = await streamFimCompletion({ baseUrl: '', apiKey: 'k', model: 'm', prompt: 'p', suffix: '' })
		assert.equal(text, 'AB')
		assert.equal(extractFimDeltaText({ choices: [{ delta: { content: 'x' } }] }), 'x')
		assert.equal(extractFimDeltaText({ choices: [{ text: 'y', delta: { content: 'x' } }] }), 'y')
		assert.equal(extractFimDeltaText({}), '')
	} finally {
		restore()
	}
})

test('streamFimCompletion：请求体 stream:true 与既有字段；CRLF 行尾可解析', async () => {
	const { restore, calls } = sseFetch(['data: {"choices":[{"text":"A"}]}\r\n\r\ndata: [DONE]\r\n\r\n'])
	try {
		await streamFimCompletion({ baseUrl: 'https://x.example/beta', apiKey: 'sk', model: 'm', prompt: '你好，', suffix: '吗' })
		const body = JSON.parse(calls[0].init.body)
		assert.equal(calls[0].url, 'https://x.example/beta/completions')
		assert.equal(body.stream, true)
		assert.equal(body.prompt, '你好，')
		assert.equal(body.suffix, '吗')
		assert.equal(body.max_tokens, 64)
		assert.deepEqual(body.stop, ['\n'])
	} finally {
		restore()
	}
})

test('streamFimCompletion：同一 JSON 行被网络分片切开（含多字节字符字节级切断）仍完整解析', async () => {
	const encoder = new TextEncoder()
	const line = 'data: {"choices":[{"text":"世界A"}]}\n\n'
	const bytes = encoder.encode(line)
	// 字节级三段切：3 切在「世」的 UTF-8 三字节中间
	const { restore } = sseFetch([bytes.slice(0, 14), bytes.slice(14, 17), bytes.slice(17), encoder.encode('data: [DONE]\n\n')])
	const deltas = []
	try {
		const text = await streamFimCompletion({ baseUrl: '', apiKey: 'k', model: 'm', prompt: 'p', suffix: '', onDelta: (d) => deltas.push(d) })
		assert.equal(text, '世界A')
		assert.deepEqual(deltas, ['世界A'])
	} finally {
		restore()
	}
})

test('streamFimCompletion：相邻 chunk 空闲超时以 AbortError 拒绝', async () => {
	const { restore } = sseFetch(['data: {"choices":[{"text":"首"}]}\n\n'], {
		onStarted: () => {
			/* 发出首个 chunk 后不再有数据也不关闭 */
		},
	})
	try {
		await assert.rejects(
			streamFimCompletion({ baseUrl: '', apiKey: 'k', model: 'm', prompt: 'p', suffix: '', idleMs: 40 }),
			(err) => err instanceof Error && err.name === 'AbortError',
		)
	} finally {
		restore()
	}
})

test('streamFimCompletion：外部信号流中 abort，已收 delta 已回调、promise 拒绝', async () => {
	const external = new AbortController()
	const { restore } = sseFetch(['data: {"choices":[{"text":"前段"}]}\n\n'], {
		onStarted: () => setTimeout(() => external.abort(), 20),
	})
	const deltas = []
	try {
		await assert.rejects(
			streamFimCompletion({ baseUrl: '', apiKey: 'k', model: 'm', prompt: 'p', suffix: '', signal: external.signal, onDelta: (d) => deltas.push(d) }),
			(err) => err instanceof Error && err.name === 'AbortError',
		)
		assert.deepEqual(deltas, ['前段'])
	} finally {
		restore()
	}
})

test('streamFimCompletion：非 SSE 响应（网关忽略 stream）整读 JSON 单次 delta 降级', async () => {
	const saved = globalThis.fetch
	globalThis.fetch = async () => ({
		ok: true,
		status: 200,
		headers: new Headers({ 'content-type': 'application/json' }),
		json: async () => ({ choices: [{ text: '整段返回' }] }),
	})
	const deltas = []
	try {
		const text = await streamFimCompletion({ baseUrl: '', apiKey: 'k', model: 'm', prompt: 'p', suffix: '', onDelta: (d) => deltas.push(d) })
		assert.equal(text, '整段返回')
		assert.deepEqual(deltas, ['整段返回'])
	} finally {
		globalThis.fetch = saved
	}
})

test('streamFimCompletion：HTTP 错误读 body 抛错（与非流式同文案）', async () => {
	const saved = globalThis.fetch
	globalThis.fetch = async () => ({ ok: false, status: 402, headers: new Headers(), text: async () => 'Insufficient Balance' })
	try {
		await assert.rejects(
			streamFimCompletion({ baseUrl: '', apiKey: 'k', model: 'm', prompt: 'p', suffix: '' }),
			/FIM HTTP 402: Insufficient Balance/,
		)
	} finally {
		globalThis.fetch = saved
	}
})
