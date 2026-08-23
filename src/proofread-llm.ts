// LLM typo-check layer — the context-aware half of proofreading.
//
// The offline dictionary (proofread-dict.ts) only catches unambiguous
// miswrites; context-dependent confusions (在/再, 的/得/地, 以为/已为 …)
// need a sentence model. pycorrector solves this with Kenlm/MacBERT; here a
// small chat model plays that role: strict Chinese prompt, temperature 0,
// JSON-mode output. The model only nominates {orig, fix, reason} — the host
// re-locates `orig` in the text itself, so a hallucinated offset can never
// corrupt a click-to-fix edit.

import type { TypoIssue } from './proofread-dict.js'

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

/** What the model nominates; offsets are computed by us, never by the model. */
export interface RawIssue {
	orig: string
	fix: string
	reason: string
}

/**
 * Robustly parse the model output into a raw issue list.
 * Accepts: bare array, {"issues": [...]}, ```json fences, prose-wrapped JSON.
 */
export function parseIssuesJson(content: string): RawIssue[] {
	const raw = String(content ?? '').trim()
	if (raw === '') return []
	const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
	const candidates = [fenced ? fenced[1] : null, raw].filter(Boolean) as string[]
	for (const candidate of candidates) {
		const text = candidate.trim()
		try {
			const parsed: unknown = JSON.parse(text)
			const list = Array.isArray(parsed) ? parsed : (parsed as { issues?: unknown })?.issues
			if (Array.isArray(list)) return list.filter(isShapedIssue)
		} catch {
			// fall through to bracket extraction
		}
		// last resort: first '[' … last ']' / first '{' … last '}'
		for (const [open, close] of [['[', ']'], ['{', '}']] as const) {
			const start = text.indexOf(open)
			const end = text.lastIndexOf(close)
			if (start !== -1 && end > start) {
				try {
					const parsed: unknown = JSON.parse(text.slice(start, end + 1))
					const list = Array.isArray(parsed) ? parsed : (parsed as { issues?: unknown })?.issues
					if (Array.isArray(list)) return list.filter(isShapedIssue)
				} catch {
					/* try next */
				}
			}
		}
	}
	return []
}

function isShapedIssue(item: unknown): item is RawIssue {
	if (item === null || typeof item !== 'object') return false
	const v = item as Record<string, unknown>
	return (
		typeof v.orig === 'string' &&
		typeof v.fix === 'string' &&
		v.orig.length >= 1 &&
		v.orig.length <= 10 &&
		v.orig !== v.fix &&
		!v.orig.includes('\n') &&
		!v.fix.includes('\n')
	)
}

/**
 * Locate raw model issues in the text: the host (not the model) computes
 * offsets, dropping anything not found verbatim.
 */
export function locateIssues(rawIssues: RawIssue[], text: string, limit = 6): TypoIssue[] {
	const source = String(text ?? '')
	const out: TypoIssue[] = []
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

export interface LlmProofreadArgs {
	/** FIM base (…/beta is stripped for chat) */
	baseUrl: string
	apiKey: string
	model: string
	text: string
	timeoutMs?: number
}

/** Run the LLM typo check. */
export async function llmProofread({ baseUrl, apiKey, model, text, timeoutMs = 12000 }: LlmProofreadArgs): Promise<RawIssue[]> {
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
	const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
	const content = data?.choices?.[0]?.message?.content ?? ''
	return parseIssuesJson(content)
}

/**
 * Merge local (dictionary) and LLM issues: local wins on overlap, sorted,
 * capped. Also used by the browser half (bundled) to stack LLM results on
 * top of the locally-scanned dictionary marks.
 */
export function mergeIssues(local: TypoIssue[], llm: TypoIssue[], limit = 8): TypoIssue[] {
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
