// Chinese typo dictionary scanner — the offline, high-precision layer.
//
// Design (mirrors pycorrector's confusion-set approach, curated by hand):
//   1. WRONG_PHRASES — whole wrong words / idioms mapping to their standard
//      forms. Only unambiguous entries are included: if a "wrong" form could
//      ever be legitimate in other contexts, it is excluded. That keeps the
//      offline layer at effectively zero false positives.
//   2. CONTEXT_RULES — confusions that are only wrong in a specific context
//      (登陆账号→登录账号, 带口罩→戴口罩 …) expressed as anchored regexes.
// Context-dependent pairs (在/再, 的/得/地, 像/象 …) are deliberately NOT
// listed here — they cannot be decided without a sentence, so they are left
// to the LLM layer (proofread-llm.ts).
// All offsets refer to the ORIGINAL text: scan targets are masked with
// same-length placeholders (code spans, fenced blocks, URLs) so indices stay
// valid without ever flagging content inside them.
//
// Data lives in data/ (zh-wrong-phrases.txt + zh-context-rules.json) and is
// assembled by scripts/gen-dict.mjs into proofread-dict-data.generated.ts —
// a zero-dependency data module. Single source for BOTH sides: the host
// imports this module directly, and the browser half bundles it via tsdown.
// This file keeps only type/parse/merge/scan logic; scanLocalTypos() is the
// builtin-dict thin wrapper (host fallback path & existing tests).

import {
	WRONG_PHRASES,
	EN_PHRASES,
	CONTEXT_RULE_SPECS,
} from './proofread-dict-data.generated.ts'

export { WRONG_PHRASES }

/** A located typo: offsets refer to the original (unmasked) text. */
export interface TypoIssue {
	orig: string
	fix: string
	offset: number
	reason: string
	source: 'dict' | 'llm'
}

export interface ContextRule {
	regex: RegExp
	fix: (m: RegExpExecArray) => string
	reason: string
}

/** Replacement template: $1/$2 → capture groups; groups that did not
 *  participate in the match (optional groups) resolve to ''. */
export function applyTemplate(tpl: string, m: RegExpExecArray): string {
	return tpl.replace(/\$(\d+)/g, (_, d: string) => m[Number(d)] ?? '')
}

/** A scan-ready dictionary: Chinese word map + English token map + context rules. */
export interface DictBundle {
	phrases: Record<string, string>
	/** 英文表：全小写独立词 → 正确拼法/官方大小写（词边界匹配）。 */
	enPhrases: Record<string, string>
	rules: readonly ContextRule[]
}

function buildBuiltinRules(specs: readonly { regex: RegExp; fixTemplate: string; reason: string }[]): ContextRule[] {
	return specs.map((s) => ({
		regex: s.regex,
		fix: (m: RegExpExecArray) => applyTemplate(s.fixTemplate, m),
		reason: s.reason,
	}))
}

/** Builtin dictionary (data/ via gen-dict). Shared by both halves. */
export const BUILTIN_DICT: DictBundle = {
	phrases: WRONG_PHRASES,
	enPhrases: EN_PHRASES,
	rules: buildBuiltinRules(CONTEXT_RULE_SPECS),
}

/** One unparsable line in a line-format dictionary text. 1-based line no. */
export interface DictParseError {
	line: number
	message: string
}

/**
 * Parse line-format dictionary text — the shared syntax of the builtin
 * zh-wrong-phrases.txt and the user dictionary:
 * `错词 => 正词` per line, `#` comments, blank lines ignored.
 * Bad lines are collected into errors (never thrown) so callers can choose
 * between build-time fail-fast (gen-dict) and UI-style per-line reporting.
 * Unlike the builtin file, self-mapping (`错词 => 错词`) IS accepted here:
 * in a user dictionary it means "never flag this word again" (disable).
 */
export function parseDictText(text: string): { phrases: Record<string, string>; errors: DictParseError[] } {
	const phrases: Record<string, string> = {}
	const errors: DictParseError[] = []
	const lines = String(text ?? '').split(/\r?\n/)
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim()
		if (line === '' || line.startsWith('#')) continue
		const idx = line.indexOf('=>')
		if (idx === -1) {
			errors.push({ line: i + 1, message: '缺少「=>」分隔符' })
			continue
		}
		const wrong = line.slice(0, idx).trim()
		const right = line.slice(idx + 2).trim()
		if (wrong === '' || /\s/.test(wrong)) {
			errors.push({ line: i + 1, message: '错词为空或含空白' })
			continue
		}
		if (right === '' || /\s/.test(right)) {
			errors.push({ line: i + 1, message: '正词为空或含空白' })
			continue
		}
		phrases[wrong] = right
	}
	return { phrases, errors }
}

/**
 * Merge a user word map over a bundle: same-wrong-word entries override the
 * builtin ones; self-mappings survive here and are skipped at scan time
 * (that is how a user disables a builtin entry). Latin-only lowercase keys
 * route into the English token table, everything else into the Chinese one —
 * so user dictionaries natively support `teh => that`-style entries too.
 */
export function mergeDicts(builtin: DictBundle, user?: Record<string, string>): DictBundle {
	if (user === undefined) return builtin
	const phrases: Record<string, string> = { ...builtin.phrases }
	const enPhrases: Record<string, string> = { ...builtin.enPhrases }
	for (const [wrong, right] of Object.entries(user)) {
		if (/^[a-z]+$/.test(wrong)) enPhrases[wrong] = right
		else phrases[wrong] = right
	}
	return { phrases, enPhrases, rules: builtin.rules }
}

/**
 * Mask code fences, inline code spans, and URLs with same-length
 * placeholders so scanners never flag inside them and offsets stay valid.
 * @param {string} text
 * @returns {string} same-length masked text
 */
export function maskForScan(text: string): string {
	let out = String(text ?? '')
	const maskRange = (start: number, end: number) => {
		out = out.slice(0, start) + '\u0000'.repeat(end - start) + out.slice(end)
	}
	// fenced code blocks
	const fence = /```[\s\S]*?(```|$)/g
	let m
	while ((m = fence.exec(out)) !== null) maskRange(m.index, m.index + m[0].length)
	// inline code spans
	const inline = /`[^`\n]*`/g
	while ((m = inline.exec(out)) !== null) maskRange(m.index, m.index + m[0].length)
	// URLs
	const url = /https?:\/\/[^\s`]+/g
	while ((m = url.exec(out)) !== null) maskRange(m.index, m.index + m[0].length)
	return out
}

/**
 * English token: a run of lowercase letters whose neighbours are NOT
 * word characters or dots. This deliberately skips camelCase / snake_case /
 * dotted identifiers (myRecieveFunc, user_recieve, obj.recieve, node.js) and
 * any capitalised form — only plain lowercase prose words are checked, which
 * is what keeps the zero-false-positive bar. Must run on the masked text.
 */
const EN_TOKEN = /(?<![\w.])[a-z]+(?![\w.])/g

/**
 * Core scan against an explicit dictionary bundle.
 * @param {string} text
 * @param {DictBundle} dict
 * @param {number} [limit=8]
 * @returns {TypoIssue[]} sorted by offset, overlap-deduplicated
 * (longer match wins), capped. Self-mapping entries are skipped.
 */
export function scanWithDict(text: string, dict: DictBundle, limit = 8): TypoIssue[] {
	const source = String(text ?? '')
	if (source.length === 0) return []
	const masked = maskForScan(source)
	const found: TypoIssue[] = []
	for (const [wrong, right] of Object.entries(dict.phrases)) {
		if (wrong === right) continue // user "disable" marker
		let idx = masked.indexOf(wrong)
		while (idx !== -1) {
			found.push({
				orig: wrong,
				fix: right,
				offset: idx,
				reason: `通常为「${right}」的误写`,
				source: 'dict',
			})
			idx = masked.indexOf(wrong, idx + wrong.length)
		}
	}
	const enMap = new Map(Object.entries(dict.enPhrases))
	if (enMap.size > 0) {
		EN_TOKEN.lastIndex = 0
		let m
		while ((m = EN_TOKEN.exec(masked)) !== null) {
			const fix = enMap.get(m[0])
			if (fix !== undefined && fix !== m[0]) {
				found.push({
					orig: m[0],
					fix,
					offset: m.index,
					reason: `应为「${fix}」`,
					source: 'dict',
				})
			}
		}
	}
	for (const rule of dict.rules) {
		rule.regex.lastIndex = 0
		let m
		while ((m = rule.regex.exec(masked)) !== null) {
			if (m[0].includes('\u0000')) continue
			found.push({ orig: m[0], fix: rule.fix(m), offset: m.index, reason: rule.reason, source: 'dict' })
		}
	}
	// overlap dedupe: earlier offset first, longer match wins over shorter
	found.sort((a, b) => a.offset - b.offset || b.orig.length - a.orig.length)
	const out = []
	let covered = -1
	for (const item of found) {
		if (item.offset < covered) continue
		if (out.length >= limit) break
		out.push(item)
		covered = item.offset + item.orig.length
	}
	return out
}

/**
 * Scan text with the builtin dictionary (backward-compatible entry point:
 * host fallback path + existing tests; the browser half passes a merged
 * bundle into scanWithDict directly).
 * @param {string} text
 * @param {number} [limit=8]
 */
export function scanLocalTypos(text: string, limit = 8): TypoIssue[] {
	return scanWithDict(text, BUILTIN_DICT, limit)
}
