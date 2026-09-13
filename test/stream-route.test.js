import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request as httpRequest } from 'node:http'
import { createStreamFetchHandler, createWebServerStreamRoute, DEFAULT_CONFIG, STREAM_PATH } from '../lib/index.js'

// 隔离真实 ~/.dsh，避免本机凭证文件影响测试（与 handler.test.js 同路）
const savedKey = process.env.DEEPSEEK_API_KEY
const savedHome = process.env.DSH_HOME
delete process.env.DEEPSEEK_API_KEY
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'ia-stream-home-'))
test.after(() => {
	if (savedKey === undefined) delete process.env.DEEPSEEK_API_KEY
	else process.env.DEEPSEEK_API_KEY = savedKey
	if (savedHome === undefined) delete process.env.DSH_HOME
	else process.env.DSH_HOME = savedHome
})

assert.equal(STREAM_PATH, '/api/input-assist/stream')

const makeRoute = (config = {}) => {
	const current = { ...DEFAULT_CONFIG, completionApiKey: 'sk-test', ...config }
	const inflight = new Map()
	const handler = createStreamFetchHandler({ getConfig: () => ({ ...current }), inflight })
	return { handler, inflight }
}

const post = (body, signal) =>
	new Request(`http://127.0.0.1:3080${STREAM_PATH}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
		...(signal !== undefined ? { signal } : {}),
	})

/** 读尽 SSE 响应 → 帧对象列表。 */
const readFrames = async (res) => {
	assert.equal(res.headers.get('content-type'), 'text/event-stream')
	const text = await res.text()
	return text
		.split('\n\n')
		.filter((frame) => frame.trim() !== '')
		.map((frame) => JSON.parse(frame.replace(/^data: /, '')))
}

/** 上游 SSE 桩：chunks 逐个 enqueue；onStarted 后由用例控制后续。 */
const upstreamSse = (chunks, { onStarted } = {}) => {
	const saved = globalThis.fetch
	const calls = []
	globalThis.fetch = async (_url, init) => {
		calls.push({ init })
		const stream = new ReadableStream({
			start(controller) {
				const encoder = new TextEncoder()
				const abort = () => controller.error(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
				if (init.signal.aborted) abort()
				else init.signal.addEventListener('abort', abort)
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
				if (onStarted === undefined) controller.close()
				else onStarted(controller)
			},
		})
		return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body: stream }
	}
	return { restore: () => { globalThis.fetch = saved }, calls }
}

test('流式路由：delta 帧逐个转发，done 帧为 host 侧归一化全文', async () => {
	const { restore, calls } = upstreamSse([
		'data: {"choices":[{"text":"\\n"}]}\n\n',
		'data: {"choices":[{"text":"好的"}]}\n\n',
		'data: {"choices":[{"text":" "}]}\n\n',
		'data: [DONE]\n\n',
	])
	const { handler } = makeRoute()
	try {
		const res = await handler(post({ prefix: '你好', suffix: '！', requestId: 'c1-x' }))
		const frames = await readFrames(res)
		assert.deepEqual(frames, [
			{ delta: '\n' },
			{ delta: '好的' },
			{ delta: ' ' },
			{ done: '好的' }, // 归一化：去首部换行与尾部空白（前缀是中文）
		])
		// 上游请求体带 stream:true 与既有字段
		const body = JSON.parse(calls[0].init.body)
		assert.equal(body.stream, true)
		assert.equal(body.prompt, '你好')
		assert.equal(body.suffix, '！')
	} finally {
		restore()
	}
})

test('流式路由：未配置 apiKey 前置失败，非 2xx JSON reason（不走传输层错误枚举）', async () => {
	const { handler } = makeRoute({ completionApiKey: '' })
	const res = await handler(post({ prefix: '帮我写', suffix: '' }))
	assert.equal(res.ok, false)
	assert.equal(res.status, 503)
	assert.deepEqual(await res.json(), { reason: 'no-api-key' })
})

test('流式路由：prompt 过短 / 开关关闭早退为单 done 空帧', async () => {
	const { handler } = makeRoute()
	const short = await handler(post({ prefix: '你', suffix: '' }))
	assert.deepEqual(await readFrames(short), [{ done: '' }])
	const off = makeRoute({ completionEnabled: false })
	const res = await off.handler(post({ prefix: '你好呀', suffix: '' }))
	assert.deepEqual(await readFrames(res), [{ done: '' }])
})

test('流式路由：非 POST 方法 405', async () => {
	const { handler } = makeRoute()
	const res = await handler(new Request(`http://127.0.0.1:3080${STREAM_PATH}`, { method: 'GET' }))
	assert.equal(res.status, 405)
	assert.deepEqual(await res.json(), { reason: 'method-not-allowed' })
})

test('流式路由：cancel 端点语义——共享 inflight 表 abort 即断上游，流静默收场无 error 帧', async () => {
	const { restore, calls } = upstreamSse(['data: {"choices":[{"text":"首段"}]}\n\n'], {
		onStarted: () => {
			/* 发出一段后挂起（模拟慢速生成） */
		},
	})
	const { handler, inflight } = makeRoute()
	try {
		const res = await handler(post({ prefix: '你好', suffix: '', requestId: 'c9-cancel' }))
		assert.equal(inflight.has('c9-cancel'), true)
		const reader = res.body.getReader()
		const decoder = new TextDecoder()
		const first = await reader.read()
		assert.equal(first.done, false)
		assert.equal(decoder.decode(first.value, { stream: true }), 'data: {"delta":"首段"}\n\n')
		// RPC cancel 端点的动作：按 requestId abort 注册表里的 controller
		inflight.get('c9-cancel').abort()
		const tail = await reader.read()
		assert.equal(tail.done, true) // 无 error 帧，直接关流
		assert.equal(inflight.has('c9-cancel'), false) // settle 后摘除
		assert.equal(calls[0].init.signal.aborted, true) // 上游连接被断开
	} finally {
		restore()
	}
})

test('流式路由：客户端断开（request.signal abort）同样传导到上游', async () => {
	const { restore, calls } = upstreamSse(['data: {"choices":[{"text":"首段"}]}\n\n'], {
		onStarted: () => {
			/* 挂起 */
		},
	})
	const { handler, inflight } = makeRoute()
	const reqCtrl = new AbortController()
	try {
		const res = await handler(post({ prefix: '你好', suffix: '', requestId: 'c8-disc' }, reqCtrl.signal))
		const reader = res.body.getReader()
		const first = await reader.read()
		assert.equal(first.done, false)
		reqCtrl.abort() // 浏览器侧 abort fetch → request.signal
		const tail = await reader.read()
		assert.equal(tail.done, true)
		assert.equal(calls[0].init.signal.aborted, true)
	} finally {
		restore()
	}
})

test('流式路由：不带 requestId 的调用不注册 inflight（旧客户端兼容）', async () => {
	const { restore } = upstreamSse(['data: {"choices":[{"text":"OK"}]}\n\ndata: [DONE]\n\n'])
	const { handler, inflight } = makeRoute()
	try {
		const res = await handler(post({ prefix: '你好', suffix: '' }))
		const frames = await readFrames(res)
		assert.deepEqual(frames, [{ delta: 'OK' }, { done: 'OK' }])
		assert.equal(inflight.size, 0)
	} finally {
		restore()
	}
})

// —— webServer 兜底桥（老运行时：connection.fetch 缺席走 node:http 适配）——
// 用真实 node:http 服务器验证：本测试内的 globalThis.fetch 已被上游桩占用，
// 客户端一律用 node:http。
const httpCall = (port, { method = 'POST', headers = {}, body = '' } = {}) =>
	new Promise((resolve, reject) => {
		const req = httpRequest(
			{ host: '127.0.0.1', port, path: STREAM_PATH, method, headers },
			(res) => {
				const chunks = []
				res.on('data', (c) => chunks.push(c))
				res.on('end', () =>
					resolve({ status: res.statusCode, contentType: res.headers['content-type'] ?? '', text: Buffer.concat(chunks).toString('utf8') }),
				)
			},
		)
		req.on('error', reject)
		req.end(body)
	})

test('webServer 兜底桥：本机无 Origin 放行流出 SSE 帧，跨源 403，GET 405', async () => {
	const { restore } = upstreamSse(['data: {"choices":[{"text":"好"}]}\n\ndata: [DONE]\n\n'])
	const { handler } = makeRoute()
	const server = createServer(createWebServerStreamRoute(handler))
	try {
		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
		const port = server.address().port
		// 无 Origin（curl 等本机客户端）→ 200，SSE 帧经适配器流出
		const local = await httpCall(port, { body: JSON.stringify({ prefix: '你好', suffix: '', requestId: 'w1' }) })
		assert.equal(local.status, 200)
		assert.equal(local.contentType, 'text/event-stream')
		assert.match(local.text, /"delta":"好"/)
		assert.match(local.text, /"done":"好"/)
		// 跨源浏览器请求 → 403（拦驱动式 POST）
		const cross = await httpCall(port, { headers: { origin: 'http://evil.example' }, body: '{}' })
		assert.equal(cross.status, 403)
		// 同源浏览器请求 → 放行（Origin 与 Host 一致）
		const same = await httpCall(port, { headers: { origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ prefix: '你好', suffix: '' }) })
		assert.equal(same.status, 200)
		// GET → 405（透传给 fetch handler 的方法校验）
		const get = await httpCall(port, { method: 'GET' })
		assert.equal(get.status, 405)
	} finally {
		restore()
		await new Promise((resolve) => server.close(resolve))
	}
})
