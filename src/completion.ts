// FIM (Fill-In-the-Middle) completion client — ported from NovAI's
// completion-client.ts, simplified to a single non-streaming request.
// The endpoint is the legacy completions protocol (NOT /chat/completions):
// DeepSeek serves FIM at {baseUrl}/completions where baseUrl defaults to
// https://api.deepseek.com/beta. The response shape guard below keeps the
// text / message.content / delta.content triple read — proxies have been
// observed rewriting legacy completions into chat-shaped payloads.

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
}: FimRequestArgs): Promise<string> {
	const base = String(baseUrl || 'https://api.deepseek.com/beta').replace(/\/+$/, '')
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
		signal: AbortSignal.timeout(timeoutMs),
	})
	if (!res.ok) {
		const body = await res.text().catch(() => '')
		const clip = body.length > 300 ? `${body.slice(0, 300)}…` : body
		throw new Error(`FIM HTTP ${res.status}: ${clip}`)
	}
	const data: unknown = await res.json()
	return normalizeSuggestion(extractCompletionText(data), 200, prompt)
}
