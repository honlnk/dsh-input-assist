// dsh-input-assist — host half (Node).
// 1) Registers the user-settings namespace `input-assist` (persisted to
//    <dsh home>/settings.yaml by the host settings service; external file
//    edits hot-publish to the browser via settings/document-updated).
// 2) Owns the loopback RPC channel /input-assist:
//      config.get / config.set — read / merge-persist the namespace
//      complete                — DeepSeek FIM proxy (non-streaming)
//      proofread               — LLM check (the offline dictionary layer runs
//                                browser-side; pass llmOnly: true to skip the
//                                host-side scan kept for legacy callers)
//      cancel                  — abort an in-flight complete/proofread by
//                                requestId (browser reschedules / Esc / toggle)
// 3) Registers the streaming completion route /api/input-assist/stream via
//    connection.fetch (v0.6 渐进渲染): SSE frames {delta}/{done}/{error};
//    shares the inflight registry so cancel covers streaming too.
//    All outbound API calls happen host-side: no browser CORS concerns, and
//    the API key never crosses into page storage.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { requestFimCompletion, streamFimCompletion, normalizeSuggestion, listModels } from './completion.js'
import { scanLocalTypos } from './proofread-dict.js'
import { llmProofread, locateIssues, mergeIssues } from './proofread-llm.js'
import { CHANNEL, DEFAULT_CONFIG, NS } from './config.js'
import type { InputAssistConfig } from './config.js'
import type { TypoIssue } from './proofread-dict.js'

const ConfigSchema = z.object({
	completionEnabled: z.boolean().default(DEFAULT_CONFIG.completionEnabled),
	completionBaseUrl: z.string().default(DEFAULT_CONFIG.completionBaseUrl),
	completionApiKey: z.string().default(DEFAULT_CONFIG.completionApiKey),
	completionModel: z.string().default(DEFAULT_CONFIG.completionModel),
	completionDebounceMs: z.number().default(DEFAULT_CONFIG.completionDebounceMs),
	completionMaxTokens: z.number().default(DEFAULT_CONFIG.completionMaxTokens),
	completionStream: z.boolean().default(DEFAULT_CONFIG.completionStream),
	proofreadEnabled: z.boolean().default(DEFAULT_CONFIG.proofreadEnabled),
	proofreadUseLlm: z.boolean().default(DEFAULT_CONFIG.proofreadUseLlm),
	proofreadModel: z.string().default(DEFAULT_CONFIG.proofreadModel),
	proofreadDebounceMs: z.number().default(DEFAULT_CONFIG.proofreadDebounceMs),
	proofreadDictDebounceMs: z.number().default(DEFAULT_CONFIG.proofreadDictDebounceMs),
})

/** config.set whitelist: key → primitive type check (schema coerces rest). */
const CONFIG_TYPES: Record<keyof InputAssistConfig, 'boolean' | 'string' | 'number'> = {
	completionEnabled: 'boolean',
	completionBaseUrl: 'string',
	completionApiKey: 'string',
	completionModel: 'string',
	completionDebounceMs: 'number',
	completionMaxTokens: 'number',
	completionStream: 'boolean',
	proofreadEnabled: 'boolean',
	proofreadUseLlm: 'boolean',
	proofreadModel: 'string',
	proofreadDebounceMs: 'number',
	proofreadDictDebounceMs: 'number',
}

// 注意：RPC 传输层会用 schema 校验响应，error.code 必须取自传输层枚举
// （bad-request / cancelled / internal …），自定义 code 会让整个响应被拒。
type RpcError = { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }
type RpcOk<T> = { ok: true; value: T }
export type RpcResult<T> = RpcOk<T> | RpcError

const rpcError = (message: string): RpcError => ({ ok: false, error: { code: 'internal', message, details: {} } })

// 客户端主动取消（cancel 端点断开了在途请求）。'cancelled' 在传输层错误码
// 枚举内（见上注），浏览器侧据此静默收场、不弹错误条。
const rpcCancelled = (): RpcError => ({ ok: false, error: { code: 'cancelled', message: 'request cancelled by client', details: {} } })

/**
 * Resolve the effective API key: the plugin's own setting first, then the
 * DEEPSEEK_API_KEY environment variable, then the dsh credential document
 * ($DSH_HOME/.credentials.yaml → refs.DEEPSEEK_API_KEY). Users who already
 * configured DeepSeek in dsh need no second key.
 */
export function resolveApiKey(config: Pick<InputAssistConfig, 'completionApiKey'>): string {
	if (typeof config.completionApiKey === 'string' && config.completionApiKey !== '') return config.completionApiKey
	if (typeof process.env.DEEPSEEK_API_KEY === 'string' && process.env.DEEPSEEK_API_KEY !== '') {
		return process.env.DEEPSEEK_API_KEY
	}
	try {
		const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
		const doc = readFileSync(join(home, '.credentials.yaml'), 'utf8')
		const m = doc.match(/^\s*DEEPSEEK_API_KEY:\s*["']?([^"'\s]+)["']?\s*$/m)
		if (m !== null) return m[1]
	} catch {
		/* no credential document */
	}
	return ''
}

const clampNumber = (value: unknown, min: number, max: number, fallback: number): number => {
	const n = Number(value)
	if (!Number.isFinite(n)) return fallback
	return Math.min(max, Math.max(min, Math.round(n)))
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === 'object' && !Array.isArray(v)

export interface HandlerDeps {
	/** resolved config (schema defaults merged) */
	getConfig: () => InputAssistConfig
	/** merge-persist */
	updateConfig: (patch: Partial<InputAssistConfig>) => Promise<void>
	/** 在途注册表；与流式路由共享（apply 里传同一份），缺省自建（旧行为）。 */
	inflight?: Map<string, AbortController>
}

export interface CompleteValue {
	text: string
	reason?: string
}

export interface ProofreadValue {
	issues: TypoIssue[]
}

export interface ModelsValue {
	models: string[]
	/** '' on success; 'no-api-key' / 'fetch-failed' otherwise. */
	reason?: string
	/** Short failure detail for the fetch-failed case. */
	message?: string
}

/**
 * Build the RPC handler. Pure dependency injection so tests can drive every
 * endpoint without a real cordis context.
 */
export function createHandler({ getConfig, updateConfig, inflight: shared }: HandlerDeps) {
	// 在途 complete/proofread 请求注册表：key 为客户端生成的 requestId，
	// 请求 settle 后自动摘除，cancel 端点按 id 断开。多标签页共用同一
	// host 实例，故必须按请求粒度取消而非“取消全部”。不带 requestId 的
	// 旧客户端不注册，行为与旧版一致（只剩超时兜底）。流式路由
	// （createStreamFetchHandler）共享同一张表：cancel 端点一视同仁。
	const inflight = shared ?? new Map<string, AbortController>()
	return async function handler(endpoint: string, payload: unknown): Promise<RpcResult<unknown>> {
		if (endpoint === 'config.get') {
			return { ok: true, value: getConfig() }
		}
		if (endpoint === 'config.set') {
			const patch = isPlainObject(payload) ? payload : {}
			const clean: Partial<InputAssistConfig> = {}
			for (const [key, type] of Object.entries(CONFIG_TYPES) as [keyof InputAssistConfig, 'boolean' | 'string' | 'number'][]) {
				if (!(key in patch)) continue
				const value = patch[key]
				if (type === 'boolean' && typeof value === 'boolean') (clean as Record<string, unknown>)[key] = value
				else if (type === 'string' && typeof value === 'string') (clean as Record<string, unknown>)[key] = value
				else if (type === 'number') (clean as Record<string, unknown>)[key] = clampNumber(value, 0, 60000, DEFAULT_CONFIG[key] as number)
			}
			try {
				await updateConfig(clean)
			} catch (error) {
				return rpcError(error instanceof Error ? error.message : String(error))
			}
			return { ok: true, value: getConfig() }
		}
		if (endpoint === 'complete') {
			const cfg = getConfig()
			if (!cfg.completionEnabled) return { ok: true, value: { text: '' } satisfies CompleteValue }
			const apiKey = resolveApiKey(cfg)
			if (!apiKey) return { ok: true, value: { text: '', reason: 'no-api-key' } satisfies CompleteValue }
			const body = isPlainObject(payload) ? payload : {}
			const prompt = typeof body.prefix === 'string' ? body.prefix.slice(-2000) : ''
			const suffix = typeof body.suffix === 'string' ? body.suffix.slice(0, 500) : ''
			if (prompt.trim().length < 2) return { ok: true, value: { text: '' } satisfies CompleteValue }
			const requestId = typeof body.requestId === 'string' ? body.requestId : ''
			const cancelSignal = new AbortController()
			if (requestId !== '') inflight.set(requestId, cancelSignal)
			try {
				const text = await requestFimCompletion({
					baseUrl: cfg.completionBaseUrl,
					apiKey,
					model: cfg.completionModel,
					prompt,
					suffix,
					maxTokens: clampNumber(cfg.completionMaxTokens, 8, 512, DEFAULT_CONFIG.completionMaxTokens),
					signal: cancelSignal.signal,
				})
				return { ok: true, value: { text } satisfies CompleteValue }
			} catch (error) {
				if (cancelSignal.signal.aborted) return rpcCancelled()
				return rpcError(error instanceof Error ? error.message : String(error))
			} finally {
				if (requestId !== '') inflight.delete(requestId)
			}
		}
		if (endpoint === 'proofread') {
			const cfg = getConfig()
			const body = isPlainObject(payload) ? payload : {}
			const text = typeof body.text === 'string' ? body.text.slice(0, 2000) : ''
			if (text.length === 0) return { ok: true, value: { issues: [] } satisfies ProofreadValue }
			// Layer 1 — offline dictionary. v3 起词典层已在浏览器本地运行，
			// 客户端带 llmOnly: true 时这里跳过，避免重复劳动（保留本层仅为
			// 兼容直连 host 的旧客户端/脚本）。
			const local = cfg.proofreadEnabled === false || body.llmOnly === true ? [] : scanLocalTypos(text)
			// Layer 2 — LLM: context-aware confusions the dictionary can't decide.
			let llmIssues: ReturnType<typeof locateIssues> = []
			if (cfg.proofreadEnabled !== false && cfg.proofreadUseLlm !== false) {
				const apiKey = resolveApiKey(cfg)
				if (apiKey) {
					const requestId = typeof body.requestId === 'string' ? body.requestId : ''
					const cancelSignal = new AbortController()
					if (requestId !== '') inflight.set(requestId, cancelSignal)
					try {
						const raw = await llmProofread({
							baseUrl: cfg.completionBaseUrl,
							apiKey,
							model: cfg.proofreadModel,
							text,
							signal: cancelSignal.signal,
						})
						llmIssues = locateIssues(raw, text)
					} catch {
						// 客户端主动取消：整单以 cancelled 收场（词典层结果一并放弃，
						// 现网客户端总带 llmOnly，词典层本就为空）
						if (cancelSignal.signal.aborted) return rpcCancelled()
						// 其他 LLM 层失败不影响词典层结果
					} finally {
						if (requestId !== '') inflight.delete(requestId)
					}
				}
			}
			return { ok: true, value: { issues: mergeIssues(local, llmIssues) } satisfies ProofreadValue }
		}
		if (endpoint === 'cancel') {
			const body = isPlainObject(payload) ? payload : {}
			const requestId = typeof body.requestId === 'string' ? body.requestId : ''
			if (requestId === '') return rpcError('cancel: requestId required')
			const controller = inflight.get(requestId)
			if (controller !== undefined) controller.abort()
			// 未知 id（已 settle / 从未注册 / 旧请求）幂等返回 false，不报错
			return { ok: true, value: { cancelled: controller !== undefined } }
		}
		if (endpoint === 'models.list') {
			// OpenAI 兼容目录接口（GET {platform}/models）：失败一律 ok+reason
			// 返回空列表（UI 退回手填），不走 transport 错误码。
			const cfg = getConfig()
			const apiKey = resolveApiKey(cfg)
			if (!apiKey) return { ok: true, value: { models: [], reason: 'no-api-key' } satisfies ModelsValue }
			try {
				const models = await listModels({ baseUrl: cfg.completionBaseUrl, apiKey })
				return { ok: true, value: { models } satisfies ModelsValue }
			} catch (error) {
				return {
					ok: true,
					value: {
						models: [],
						reason: 'fetch-failed',
						message: error instanceof Error ? error.message.slice(0, 200) : String(error),
					} satisfies ModelsValue,
				}
			}
		}
		return rpcError(`unknown endpoint ${String(endpoint)}`)
	}
}

/** Settings scope shape returned by the host settings service. */
interface SettingsScope {
	get(): InputAssistConfig
	update(patch: Partial<InputAssistConfig>): Promise<void>
}

// —— 流式渐进渲染（v0.6）——
// cordis RPC 是一次性返回值（响应整体 buffer 成单个 JSON），没有插件可用的
// 推送面；流式走 connection.fetch 的 Exact Fetch 路由（官方先例
// session-log-export 的流式 ZIP 同款）：自动继承 Host/Origin/cookie 鉴权
// 栅栏，http-bridge 逐块背压流出，gzip 中间件显式豁免 text/event-stream。
export const STREAM_PATH = '/api/input-assist/stream'

const sseFrame = (payload: Record<string, string>): string => `data: ${JSON.stringify(payload)}\n\n`

export interface StreamFetchDeps {
	getConfig: () => InputAssistConfig
	/** 与 RPC handler 共享的在途注册表：cancel 端点按 requestId 断开流。 */
	inflight: Map<string, AbortController>
}

/**
 * Build the /api/input-assist/stream fetch-route handler. Wire protocol is
 * SSE frames: {"delta":"…"} per chunk, {"done":"<normalized full text>"} on
 * success (normalization stays host-side — single source of truth), and
 * {"error":"…"} on failure after streaming started. Pre-stream failures
 * (no-api-key) answer a plain non-2xx JSON {reason} so the browser can reuse
 * the RPC error path. Cancellation is dual-path: the browser aborting its
 * fetch shows up as request.signal abort here, and the existing cancel RPC
 * aborts through the shared inflight registry — both propagate upstream.
 */
export function createStreamFetchHandler({ getConfig, inflight }: StreamFetchDeps) {
	return async (request: Request): Promise<Response> => {
		if (request.method !== 'POST') {
			return new Response(JSON.stringify({ reason: 'method-not-allowed' }), {
				status: 405,
				headers: { 'content-type': 'application/json' },
			})
		}
		let body: Record<string, unknown> = {}
		try {
			const parsed: unknown = await request.json()
			if (isPlainObject(parsed)) body = parsed
		} catch {
			/* 坏 body 按空处理，走下面的早退分支 */
		}
		const cfg = getConfig()
		if (!cfg.completionEnabled) return new Response(sseFrame({ done: '' }), {
			headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
		})
		const prompt = typeof body.prefix === 'string' ? body.prefix.slice(-2000) : ''
		const suffix = typeof body.suffix === 'string' ? body.suffix.slice(0, 500) : ''
		if (prompt.trim().length < 2) {
			return new Response(sseFrame({ done: '' }), {
				headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
			})
		}
		const apiKey = resolveApiKey(cfg)
		if (apiKey === '') {
			return new Response(JSON.stringify({ reason: 'no-api-key' }), {
				status: 503,
				headers: { 'content-type': 'application/json' },
			})
		}
		const requestId = typeof body.requestId === 'string' ? body.requestId : ''
		const cancelSignal = new AbortController()
		if (requestId !== '') inflight.set(requestId, cancelSignal)
		// 客户端断开（浏览器 abort fetch）：传导到上游请求
		request.signal.addEventListener('abort', () => cancelSignal.abort(), { once: true })
		if (request.signal.aborted) cancelSignal.abort()

		const encoder = new TextEncoder()
		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				const write = (payload: Record<string, string>): void => {
					try {
						controller.enqueue(encoder.encode(sseFrame(payload)))
					} catch {
						/* 客户端已断开 */
					}
				}
				try {
					const text = await streamFimCompletion({
						baseUrl: cfg.completionBaseUrl,
						apiKey,
						model: cfg.completionModel,
						prompt,
						suffix,
						maxTokens: clampNumber(cfg.completionMaxTokens, 8, 512, DEFAULT_CONFIG.completionMaxTokens),
						signal: cancelSignal.signal,
						onDelta: (delta) => write({ delta }),
					})
					write({ done: normalizeSuggestion(text, 200, prompt) })
				} catch (error) {
					// 外部取消（cancel RPC / 客户端断开）：静默收场，不写错误帧
					if (!cancelSignal.signal.aborted) {
						write({ error: error instanceof Error ? error.message : String(error) })
					}
				} finally {
					if (requestId !== '') inflight.delete(requestId)
					try {
						controller.close()
					} catch {
						/* already closed */
					}
				}
			},
		})
		return new Response(stream, {
			headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
		})
	}
}

/** Minimal shape of the host services this plugin consumes. */
interface ConnectionService {
	rpc: {
		handle(
			channel: string,
			handler: (endpoint: string, payload: unknown) => Promise<RpcResult<unknown>>,
			options: { authority: string },
		): () => void
	}
	/** Exact Fetch routes under /api (streaming-friendly); absent on older dsh builds. */
	fetch?: {
		register(route: {
			path: string
			methods: ('GET' | 'HEAD' | 'POST')[]
			requestBody?: 'buffered' | 'streaming'
			fetch: (request: Request) => Promise<Response>
		}): () => void
	}
}

/** Minimal shape of the webServer service (exact routes; SSE-friendly). */
interface WebServerService {
	register(route: {
		kind: 'exact' | 'prefix'
		path: string
		handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
	}): () => void
}

// —— 老运行时兜底（connection.fetch 缺席，如 dsh 0.1.1-rc.2）：webServer
// exact 路由 + node:http ↔ fetch 适配（client-hmr 的 /plugins/events SSE
// 同款；exact 表先于 connection 的 /api prefix 表命中）。webServer 路由不在
// connection 的鉴权栅栏内，自接 Host/Origin 栅栏：放行同源浏览器请求与无
// Origin 的本机客户端，拦跨站驱动式 POST（跨源也读不到响应，无 CORS 头）。
const sameOriginOrLocal = (req: IncomingMessage): boolean => {
	const origin = req.headers.origin
	if (origin === undefined) return true
	const host = req.headers.host ?? ''
	try {
		return new URL(String(origin)).host === host
	} catch {
		return false
	}
}

const bridgeNodeToFetchRequest = async (req: IncomingMessage, signal: AbortSignal): Promise<Request> => {
	const chunks: Buffer[] = []
	for await (const chunk of req) chunks.push(chunk as Buffer)
	const body = Buffer.concat(chunks)
	const method = req.method ?? 'POST'
	return new Request(`http://${req.headers.host ?? '127.0.0.1'}${req.url ?? '/'}`, {
		method,
		headers: req.headers as Record<string, string>,
		body: method === 'GET' || method === 'HEAD' ? undefined : body,
		signal,
	})
}

const writeFetchResponse = async (res: ServerResponse, response: Response): Promise<void> => {
	const headers: Record<string, string> = {}
	response.headers.forEach((value, key) => {
		headers[key] = value
	})
	res.writeHead(response.status, response.statusText || undefined, headers)
	if (response.body === null) {
		res.end()
		return
	}
	const reader = response.body.getReader()
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		if (!res.write(Buffer.from(value))) {
			await new Promise<void>((resolve) => {
				res.once('drain', resolve)
			})
		}
	}
	res.end()
}

/** 把 fetch 形态的流式 handler 适配成 webServer 的 (req, res) 处理器。 */
export function createWebServerStreamRoute(handler: (request: Request) => Promise<Response>) {
	return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		if (!sameOriginOrLocal(req)) {
			res.writeHead(403, { 'content-type': 'application/json' })
			res.end(JSON.stringify({ reason: 'cross-origin rejected' }))
			return
		}
		const abort = new AbortController()
		res.on('close', () => {
			if (!res.writableEnded) abort.abort() // 客户端断开 → request.signal
		})
		try {
			const request = await bridgeNodeToFetchRequest(req, abort.signal)
			const response = await handler(request)
			await writeFetchResponse(res, response)
		} catch {
			if (!res.headersSent) res.writeHead(500)
			res.end()
		}
	}
}

/** Cordis entry: settings namespace + loopback RPC registration. */
function apply(ctx: Context): void {
	let scope: SettingsScope | undefined = undefined
	ctx.inject(['settings'], (settingsCtx) => {
		scope = settingsCtx.settings.register(settingsNamespace(NS), ConfigSchema) as unknown as SettingsScope
	})

	const connection = ctx.get('connection') as ConnectionService | undefined
	if (connection === undefined) return

	const getConfig = (): InputAssistConfig => scope?.get() ?? { ...DEFAULT_CONFIG }
	// RPC 与流式路由共享同一张在途注册表：cancel 端点对两者一视同仁
	const inflight = new Map<string, AbortController>()
	const handler = createHandler({
		getConfig,
		updateConfig: async (patch) => {
			if (scope === undefined) throw new Error('settings service unavailable')
			await scope.update(patch)
		},
		inflight,
	})

	ctx.effect(
		() => connection.rpc.handle(CHANNEL, handler, { authority: 'loopback' }),
		'input-assist: rpc channel',
	)

	// 流式路由：优先 connection.fetch（新运行时，自带 Host/Origin/cookie
	// 鉴权栅栏）；缺席时降级 webServer exact 路由（老运行时，自接栅栏）。
	// 两条都注册不上（极老运行时）则静默跳过——浏览器半边收到 404 会自动
	// 降级走 RPC 非流式路径。
	const streamFetch = createStreamFetchHandler({ getConfig, inflight })
	if (connection.fetch !== undefined) {
		ctx.effect(
			() =>
				connection.fetch!.register({
					path: STREAM_PATH,
					methods: ['POST'],
					requestBody: 'buffered',
					fetch: streamFetch,
				}),
			'input-assist: completion stream route',
		)
	} else {
		ctx.inject(['webServer'], (webCtx) => {
			const webServer = (webCtx as unknown as { webServer: WebServerService }).webServer
			ctx.effect(
				() =>
					webServer.register({
						kind: 'exact',
						path: STREAM_PATH,
						handler: createWebServerStreamRoute(streamFetch),
					}),
				'input-assist: completion stream route (webServer fallback)',
			)
		})
	}
}

export { apply, NS, CHANNEL, DEFAULT_CONFIG }
export default { apply }
