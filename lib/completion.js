// FIM (Fill-In-the-Middle) completion client — ported from NovAI's
// completion-client.ts, simplified to a single non-streaming request for v1.
// The endpoint is the legacy completions protocol (NOT /chat/completions):
// DeepSeek serves FIM at {baseUrl}/completions where baseUrl defaults to
// https://api.deepseek.com/beta. NovAI's streaming-delta quirks do not apply
// here (no SSE in v1), but the response shape guard below keeps the
// text / message.content / delta.content triple read — proxies have been
// observed rewriting legacy completions into chat-shaped payloads.

/** Read the completion text out of a legacy-completions response body. */
export function extractCompletionText(data) {
	if (data === null || typeof data !== 'object') return ''
	const choice = Array.isArray(data.choices) ? data.choices[0] : undefined
	if (choice === null || typeof choice !== 'object') return ''
	const text = choice.text ?? choice.message?.content ?? choice.delta?.content ?? ''
	return typeof text === 'string' ? text : ''
}

/**
 * Normalize a raw FIM continuation into a suggestion.
 * Leading newlines are always dropped (stop tokens should have cut them, but
 * gateways sometimes eat the stop list). Leading spaces depend on what the
 * prefix ends with: after whitespace or CJK text they are noise, after a
 * Latin word character a single space is meaningful (“ world”), so collapse
 * 2+ spaces to one and keep the single one.
 * @param {string} text
 * @param {number} [maxLength=200]
 * @param {string} [prefix=''] text before the caret, for the space decision
 */
export function normalizeSuggestion(text, maxLength = 200, prefix = '') {
	let out = String(text ?? '')
	out = out.replace(/^[\r\n]+/, '')
	out = out.replace(/\s+$/, '')
	const prev = prefix.slice(-1)
	const cjk = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/
	if (prev === '' || /\s/.test(prev) || cjk.test(prev)) {
		out = out.replace(/^[ \t]+/, '')
	} else {
		out = out.replace(/^[ \t]{2,}/, ' ')
	}
	if (out.length > maxLength) out = out.slice(0, maxLength)
	return out
}

/**
 * Request one FIM completion.
 * @param {object} args
 * @param {string} args.baseUrl    FIM base (default https://api.deepseek.com/beta)
 * @param {string} args.apiKey
 * @param {string} args.model
 * @param {string} args.prompt     Text before the caret.
 * @param {string} args.suffix     Text after the caret ('' allowed).
 * @param {number} [args.maxTokens=64]
 * @param {number} [args.timeoutMs=8000]
 * @returns {Promise<string>} normalized suggestion text
 */
export async function requestFimCompletion({
	baseUrl,
	apiKey,
	model,
	prompt,
	suffix,
	maxTokens = 64,
	timeoutMs = 8000,
}) {
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
	const data = await res.json()
	return normalizeSuggestion(extractCompletionText(data), 200, prompt)
}
