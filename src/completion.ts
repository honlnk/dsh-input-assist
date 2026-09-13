// FIM (Fill-In-the-Middle) completion client — ported from NovAI's
// completion-client.ts: requestFimCompletion is the non-streaming form,
// streamFimCompletion the SSE streaming form (v0.6 渐进渲染).
// The endpoint is the legacy completions protocol (NOT /chat/completions):
// DeepSeek serves FIM at {baseUrl}/completions where baseUrl defaults to
// https://api.deepseek.com/beta. The response shape guards keep the
// text / message.content / delta.content triple read — proxies have been
// observed rewriting legacy completions into chat-shaped payloads.

// 注：本模块会被 node --test 直接按 .ts 加载（类型剥离），跨模块值引用
// 必须写 .ts 指定符；构建侧 tsdown/rolldown 同样原生解析。
import { linkedTimeoutSignal, resettableIdleSignal } from './abort.ts'

/** Read the completion text out of a legacy-completions response body. */
export function extractCompletionText(data: unknown): string {
	if (data === null || typeof data !== 'object') return ''
	const choice = (data as { choices?: unknown }).choices
	const first = Array.isArray(choice) ? choice[0] : undefined
	if (first === null || typeof first !== 'object') return ''
	const c = first as { text?: unknown; message?: { content?: unknown }; delta?: { content?: unknown } }
	const text = c.text ?? c.message?.content ?? c.delta?.content ?? ''
	return typeof text === 'string' ? text : ''
}

/**
 * Normalize a raw FIM continuation into a suggestion.
 * Leading newlines are always dropped (stop tokens should have cut them, but
 * gateways sometimes eat the stop list). Leading spaces depend on what the
 * prefix ends with: after whitespace or CJK text they are noise, after a
 * Latin word character a single space is meaningful (“ world”), so collapse
 * 2+ spaces to one and keep the single one.
 */
export function normalizeSuggestion(text: string, maxLength = 200, prefix = ''): string {
	let out = String(text ?? '')
	out = out.replace(/^[\r\n]+/, '')
	out = out.replace(/\s+$/, '')
	const prev = prefix.slice(-1)
	const cjk = /[㐀-鿿　-〿＀-￯]/
	if (prev === '' || /\s/.test(prev) || cjk.test(prev)) {
		out = out.replace(/^[ \t]+/, '')
	} else {
		out = out.replace(/^[ \t]{2,}/, ' ')
	}
	if (out.length > maxLength) out = out.slice(0, maxLength)
	return out
}

export interface FimRequestArgs {
	/** FIM base (default https://api.deepseek.com/beta) */
	baseUrl: string
	apiKey: string
	model: string
	/** Text before the caret. */
	prompt: string
	/** Text after the caret ('' allowed). */
	suffix: string
	maxTokens?: number
	/** External cancel signal (host cancel RPC); the timeout still applies on top. */
	signal?: AbortSignal
	timeoutMs?: number
}

/** Request one FIM completion; returns the normalized suggestion text. */
export async function requestFimCompletion({
	baseUrl,
	apiKey,
	model,
	prompt,
	suffix,
	maxTokens = 64,
	timeoutMs = 8000,
	signal,
}: FimRequestArgs): Promise<string> {
	const base = String(baseUrl || 'https://api.deepseek.com/beta').replace(/\/+$/, '')
	const linked = linkedTimeoutSignal(timeoutMs, signal)
	try {
		const res = await fetch(`${base}/completions`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				prompt,
				suffix: suffix || '',
				stream: false,
				max_tokens: maxTokens,
				temperature: 0.2,
				stop: ['\n'],
			}),
			signal: linked.signal,
		})
		if (!res.ok) {
			const body = await res.text().catch(() => '')
			const clip = body.length > 300 ? `${body.slice(0, 300)}…` : body
			throw new Error(`FIM HTTP ${res.status}: ${clip}`)
		}
		const data: unknown = await res.json()
		return normalizeSuggestion(extractCompletionText(data), 200, prompt)
	} finally {
		linked.dispose()
	}
}

export interface FimStreamArgs {
	baseUrl: string
	apiKey: string
	model: string
	/** Text before the caret. */
	prompt: string
	/** Text after the caret ('' allowed). */
	suffix: string
	maxTokens?: number
	/** External cancel signal (host cancel RPC / client disconnect). */
	signal?: AbortSignal
	/** Called once per non-empty delta chunk. */
	onDelta?: (text: string) => void
	/** Idle timeout between upstream chunks (reset on every chunk); default 10s. */
	idleMs?: number
}

/** Read the delta text out of one SSE completion chunk (text primary, delta.content fallback). */
export function extractFimDeltaText(payload: unknown): string {
	if (payload === null || typeof payload !== 'object') return ''
	const choice = (payload as { choices?: unknown }).choices
	const first = Array.isArray(choice) ? choice[0] : undefined
	if (first === null || typeof first !== 'object') return ''
	const c = first as { text?: unknown; delta?: { content?: unknown } }
	if (typeof c.text === 'string') return c.text
	const d = c.delta?.content
	return typeof d === 'string' ? d : ''
}

/**
 * Request one FIM completion in streaming mode (NovAI streamFimCompletion
 * port): POST {base}/completions with stream:true, parse the SSE body and
 * call onDelta per chunk; resolves with the accumulated raw text (no
 * normalization — the caller owns that). Idle timeout between chunks, not
 * a total cap: every received chunk re-arms the timer, so a slow but steady
 * stream is never cut. If the endpoint ignores the stream flag and answers
 * plain JSON, the whole body is read and emitted as a single delta
 * (graceful degrade for OpenAI-compatible gateways).
 */
export async function streamFimCompletion({
	baseUrl,
	apiKey,
	model,
	prompt,
	suffix,
	maxTokens = 64,
	signal,
	onDelta,
	idleMs = 10000,
}: FimStreamArgs): Promise<string> {
	const base = String(baseUrl || 'https://api.deepseek.com/beta').replace(/\/+$/, '')
	const idle = resettableIdleSignal(idleMs, signal)
	try {
		const res = await fetch(`${base}/completions`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				prompt,
				suffix: suffix || '',
				stream: true,
				max_tokens: maxTokens,
				temperature: 0.2,
				stop: ['\n'],
			}),
			signal: idle.signal,
		})
		if (!res.ok) {
			const body = await res.text().catch(() => '')
			const clip = body.length > 300 ? `${body.slice(0, 300)}…` : body
			throw new Error(`FIM HTTP ${res.status}: ${clip}`)
		}
		const contentType = res.headers.get('content-type') ?? ''
		// 网关忽略 stream 参数仍回整段 JSON：整读降级为单次增量
		if (!contentType.includes('text/event-stream') || res.body === null) {
			const data: unknown = await res.json()
			const text = extractCompletionText(data)
			if (text !== '') onDelta?.(text)
			return text
		}
		const reader = res.body.getReader()
		const decoder = new TextDecoder('utf-8')
		let buffer = ''
		let content = ''
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			idle.reset()
			// 两级跨 chunk 缓冲：TextDecoder stream:true 防多字节字符截断；
			// 残段留在 buffer 防一个 JSON 行被网络分片切开。CRLF 规整后按空行切事件。
			buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n')
			const events = buffer.split('\n\n')
			buffer = events.pop() ?? ''
			for (const event of events) {
				for (const raw of event.split('\n')) {
					const line = raw.trim()
					if (!line.startsWith('data:')) continue
					const data = line.slice(5).trim()
					if (data === '' || data === '[DONE]') continue
					try {
						const deltaText = extractFimDeltaText(JSON.parse(data))
						if (deltaText !== '') {
							content += deltaText
							onDelta?.(deltaText)
						}
					} catch {
						/* 单行 JSON 解析失败静默跳过 */
					}
				}
			}
		}
		return content
	} finally {
		idle.dispose()
	}
}

/**
 * Strip the FIM-only tail (/beta, /v1) from a completion base to get the
 * platform base that serves the OpenAI-compatible GET /models — DeepSeek
 * serves FIM at /beta/completions but the model directory at /models.
 */
export function platformBaseUrl(baseUrl: string): string {
	const base = String(baseUrl || 'https://api.deepseek.com/beta').replace(/\/+$/, '')
	return base.replace(/\/(beta|v1)$/, '')
}

export interface ListModelsArgs {
	/** FIM base (the /beta tail is stripped internally). */
	baseUrl: string
	apiKey: string
	timeoutMs?: number
}

/** GET {platform}/models (OpenAI-compatible directory); sorted unique ids. */
export async function listModels({ baseUrl, apiKey, timeoutMs = 8000 }: ListModelsArgs): Promise<string[]> {
	const res = await fetch(`${platformBaseUrl(baseUrl)}/models`, {
		headers: { authorization: `Bearer ${apiKey}` },
		signal: AbortSignal.timeout(timeoutMs),
	})
	if (!res.ok) throw new Error(`models HTTP ${res.status}`)
	const data: unknown = await res.json()
	const list = (data as { data?: unknown }).data
	if (!Array.isArray(list)) return []
	const ids = list.flatMap((entry) => {
		const id = (entry as { id?: unknown } | null)?.id
		return typeof id === 'string' && id !== '' ? [id] : []
	})
	return [...new Set(ids)].sort()
}
