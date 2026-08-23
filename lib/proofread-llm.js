// LLM typo-check layer — the context-aware half of proofreading.
//
// The offline dictionary (proofread-dict.js) only catches unambiguous
// miswrites; context-dependent confusions (在/再, 的/得/地, 以为/已为 …)
// need a sentence model. pycorrector solves this with Kenlm/MacBERT; here a
// small chat model plays that role: strict Chinese prompt, temperature 0,
// JSON-mode output. The model only nominates {orig, fix, reason} — the host
// re-locates `orig` in the text itself, so a hallucinated offset can never
// corrupt a click-to-fix edit.

const SYSTEM_PROMPT = [
	'你是中文文本的错别字校对器。检查用户文本中的错别字，包括：',
	'同音字误用（如“在/再”“的/得/地”“已/以”）、形近字误用、常见词语误写、成语误写。',
	'要求：',
	'1. 只报告你非常有把握的错误；宁缺毋滥。',
	'2. 不要把专有名词、人名地名、书名引文、代码、网址、口语化表达、方言词标为错误。',
	'3. 只做最小改动：替换错误的字/词，不改写句子。',
	'4. 只输出 JSON，不要任何其他文字。格式：{"issues": [{"orig": "原文中连续出现的错误片段", "fix": "修正后的片段", "reason": "不超过15字的理由"}]}',
	'没有错误时输出 {"issues": []}。',
].join('\n')

/**
 * Robustly parse the model output into a raw issue list.
 * Accepts: bare array, {"issues": [...]}, ```json fences, prose-wrapped JSON.
 * @param {string} content
 * @returns {{orig: string, fix: string, reason: string}[]}
 */
export function parseIssuesJson(content) {
	const raw = String(content ?? '').trim()
	if (raw === '') return []
	const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
	const candidates = [fenced ? fenced[1] : null, raw].filter(Boolean)
	for (const candidate of candidates) {
		const text = candidate.trim()
		try {
			const parsed = JSON.parse(text)
			const list = Array.isArray(parsed) ? parsed : parsed?.issues
			if (Array.isArray(list)) return list.filter(isShapedIssue)
		} catch {
			// fall through to bracket extraction
		}
		// last resort: first '[' … last ']' / first '{' … last '}'
		for (const [open, close] of [['[', ']'], ['{', '}']]) {
			const start = text.indexOf(open)
			const end = text.lastIndexOf(close)
			if (start !== -1 && end > start) {
				try {
					const parsed = JSON.parse(text.slice(start, end + 1))
					const list = Array.isArray(parsed) ? parsed : parsed?.issues
					if (Array.isArray(list)) return list.filter(isShapedIssue)
				} catch {
					/* try next */
				}
			}
		}
	}
	return []
}

function isShapedIssue(item) {
	return (
		item !== null &&
		typeof item === 'object' &&
		typeof item.orig === 'string' &&
		typeof item.fix === 'string' &&
		item.orig.length >= 1 &&
		item.orig.length <= 10 &&
		item.orig !== item.fix &&
		!item.orig.includes('\n') &&
		!item.fix.includes('\n')
	)
}

/**
 * Locate raw model issues in the text: the host (not the model) computes
 * offsets, dropping anything not found verbatim.
 * @param {{orig:string, fix:string, reason:string}[]} rawIssues
 * @param {string} text
 * @param {number} [limit=6]
 * @returns {{orig:string, fix:string, offset:number, reason:string, source:'llm'}[]}
 */
export function locateIssues(rawIssues, text, limit = 6) {
	const source = String(text ?? '')
	const out = []
	let searchFrom = 0
	for (const item of rawIssues) {
		if (!isShapedIssue(item)) continue
		const idx = source.indexOf(item.orig, searchFrom)
		if (idx === -1) continue
		out.push({
			orig: item.orig,
			fix: item.fix,
			offset: idx,
			reason: typeof item.reason === 'string' && item.reason.trim() !== '' ? item.reason.trim().slice(0, 30) : '疑似错别字',
			source: 'llm',
		})
		searchFrom = idx + item.orig.length
		if (out.length >= limit) break
	}
	return out
}

/**
 * Run the LLM typo check.
 * @param {object} args
 * @param {string} args.baseUrl FIM base (…/beta is stripped for chat)
 * @param {string} args.apiKey
 * @param {string} args.model
 * @param {string} args.text
 * @param {number} [args.timeoutMs=12000]
 * @returns {Promise<{orig:string, fix:string, reason:string}[]>} raw issues
 */
export async function llmProofread({ baseUrl, apiKey, model, text, timeoutMs = 12000 }) {
	const base = String(baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '').replace(/\/beta$/, '')
	const res = await fetch(`${base}/chat/completions`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model,
			messages: [
				{ role: 'system', content: SYSTEM_PROMPT },
				{ role: 'user', content: text },
			],
			temperature: 0,
			max_tokens: 800,
			response_format: { type: 'json_object' },
		}),
		signal: AbortSignal.timeout(timeoutMs),
	})
	if (!res.ok) {
		const body = await res.text().catch(() => '')
		const clip = body.length > 300 ? `${body.slice(0, 300)}…` : body
		throw new Error(`proofread HTTP ${res.status}: ${clip}`)
	}
	const data = await res.json()
	const content = data?.choices?.[0]?.message?.content ?? ''
	return parseIssuesJson(content)
}

/**
 * Merge local (dictionary) and LLM issues: local wins on overlap, sorted,
 * capped.
 * @param {{offset:number, orig:string}[]} local
 * @param {{offset:number, orig:string}[]} llm
 * @param {number} [limit=8]
 */
export function mergeIssues(local, llm, limit = 8) {
	const out = [...local]
	for (const item of llm) {
		const s = item.offset
		const e = s + item.orig.length
		const clashes = out.some((it) => s < it.offset + it.orig.length && it.offset < e)
		if (!clashes) out.push(item)
	}
	out.sort((a, b) => a.offset - b.offset)
	return out.slice(0, limit)
}
