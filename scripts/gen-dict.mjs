// gen-dict: 构建期词库装配器。
// data/{zh-wrong-phrases,en-wrong-spellings,en-proper-nouns}.txt
//   + data/zh-context-rules.json
//   → src/proofread-dict-data.generated.ts（零依赖纯数据模块，双侧共用）
// 校验失败（坏行/坏正则/组号越界/重复错词/自映射/英文条目含大写）抛错、
// CLI 退出非零——构建期拦截，不静默。幂等：同输入同输出（按文件行序），
// CI 用 `npm run gendict && git diff --exit-code` 守卫生成物同步。
// 解析/校验/生成函数导出供 test/gen-dict.test.js 单测（import 不触发 main）。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const FILES = {
	zh: join(root, 'data/zh-wrong-phrases.txt'),
	enSpell: join(root, 'data/en-wrong-spellings.txt'),
	enProper: join(root, 'data/en-proper-nouns.txt'),
	rules: join(root, 'data/zh-context-rules.json'),
}
const OUT = join(root, 'src/proofread-dict-data.generated.ts')

// —— 解析行式词库（中/英文件同语法；这里 fail-fast，运行期容错收集） ——
// 英文条目额外要求：错拼为全小写 [a-z]+（扫描只匹配全小写独立词，
// 收录大写形式永远不会命中）；fix 非空、单行、长度 ≤ 24。
export function parsePhrases(text, fileName = 'zh-wrong-phrases.txt', { english = false } = {}) {
	const phrases = []
	const seen = new Map()
	const lines = String(text ?? '').split(/\r?\n/)
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim()
		if (line === '' || line.startsWith('#')) continue
		const idx = line.indexOf('=>')
		if (idx === -1) throw new Error(`${fileName}:${i + 1}: 缺少「=>」分隔符`)
		const wrong = line.slice(0, idx).trim()
		const right = line.slice(idx + 2).trim()
		if (wrong === '' || /\s/.test(wrong)) throw new Error(`${fileName}:${i + 1}: 错词为空或含空白：${line}`)
		// 英文正词允许「alot => a lot」这类含单个空格的修正；连续空格仍拒绝
		const badRight = right === '' || (!english && /\s/.test(right)) || /\s{2,}/.test(right)
		if (badRight) throw new Error(`${fileName}:${i + 1}: 正词为空或含空白：${line}`)
		if (wrong === right) throw new Error(`${fileName}:${i + 1}: 自映射条目：${wrong}（自映射是“禁用”语义，仅用户词库允许）`)
		if (english && !/^[a-z]+$/.test(wrong)) {
			throw new Error(`${fileName}:${i + 1}: 英文错拼须为全小写字母：${wrong}`)
		}
		if (english && right.length > 24) {
			throw new Error(`${fileName}:${i + 1}: 正词过长（>24 字符）：${right}`)
		}
		if (seen.has(wrong)) throw new Error(`${fileName}:${i + 1}: 重复错词：${wrong}（首见于第 ${seen.get(wrong)} 行）`)
		seen.set(wrong, i + 1)
		phrases.push([wrong, right])
	}
	return phrases
}

// —— 解析上下文规则 JSON ——
export function parseRules(list) {
	if (!Array.isArray(list) || list.length === 0) throw new Error('zh-context-rules.json: 应为非空数组')
	return list.map((r, i) => {
		const where = `zh-context-rules.json[${i}]`
		for (const key of ['pattern', 'fix', 'reason']) {
			if (typeof r[key] !== 'string' || r[key] === '') throw new Error(`${where}: 缺字段 ${key}`)
		}
		const flags = typeof r.flags === 'string' ? r.flags : 'g'
		if (!/^[gimsuy]*$/.test(flags) || !flags.includes('g')) throw new Error(`${where}: flags 只允许 gimsuy 且必须含 g：${flags}`)
		let regex
		try {
			regex = new RegExp(r.pattern, flags)
		} catch (e) {
			throw new Error(`${where}: pattern 不是合法正则：${e.message}`)
		}
		const captureCount = (r.pattern.replace(/\(\?:|\(\?<[=!]|\(\?[=!]/g, '').match(/\(/g) || []).length
		for (const m of r.fix.matchAll(/\$(\d+)/g)) {
			if (Number(m[1]) > captureCount) throw new Error(`${where}: fix 模板 $${m[1]} 越界（pattern 共 ${captureCount} 个捕获组）`)
		}
		return { regex: regex.toString(), fixTemplate: r.fix, reason: r.reason }
	})
}

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

/** phrases/rules/enPhrases → generated.ts 全文。稳定输出（幂等前提）。 */
export function generate(phrases, rules, enPhrases) {
	return (
		'// 由 scripts/gen-dict.mjs 从 data/ 生成，勿手改；重新生成：npm run gendict\n' +
		'// 源：data/zh-wrong-phrases.txt + en-wrong-spellings.txt + en-proper-nouns.txt\n' +
		'//     + data/zh-context-rules.json\n' +
		'// 零依赖纯数据模块：词表 + 正则字面量 + 替换模板（$1 → 捕获组），\n' +
		'// 运行期装配（fix 函数化、合并、扫描）在 src/proofread-dict.ts。\n\n' +
		`export const WRONG_PHRASES: Record<string, string> = {\n` +
		phrases.map(([w, r]) => `\t'${esc(w)}': '${esc(r)}',`).join('\n') +
		'\n}\n\n' +
		'export const EN_PHRASES: Record<string, string> = {\n' +
		enPhrases.map(([w, r]) => `\t'${esc(w)}': '${esc(r)}',`).join('\n') +
		'\n}\n\n' +
		'export interface ContextRuleSpec {\n' +
		'\t/** 全局正则（g 标志），锚定“仅在特定搭配中才算错”的上下文。 */\n' +
		'\tregex: RegExp\n' +
		'\t/** 替换模板：$1/$2 引用捕获组，未参与匹配的可选组替换为空串。 */\n' +
		'\tfixTemplate: string\n' +
		'\treason: string\n' +
		'}\n\n' +
		'export const CONTEXT_RULE_SPECS: ContextRuleSpec[] = [\n' +
		rules.map((r) => `\t{ regex: ${r.regex}, fixTemplate: '${esc(r.fixTemplate)}', reason: '${esc(r.reason)}' },`).join('\n') +
		'\n]\n'
	)
}

function main() {
	const phrases = parsePhrases(readFileSync(FILES.zh, 'utf8'))
	const enSpell = parsePhrases(readFileSync(FILES.enSpell, 'utf8'), 'en-wrong-spellings.txt', { english: true })
	const enProper = parsePhrases(readFileSync(FILES.enProper, 'utf8'), 'en-proper-nouns.txt', { english: true })
	// 跨英文文件查重（错拼词全局唯一）
	const enSeen = new Map(enSpell.map(([w], i) => [w, i + 1]))
	for (const [w] of enProper) {
		if (enSeen.has(w)) throw new Error(`en-proper-nouns.txt: 与 en-wrong-spellings.txt 重复错词：${w}`)
	}
	const rules = parseRules(JSON.parse(readFileSync(FILES.rules, 'utf8')))
	const enPhrases = [...enSpell, ...enProper]
	writeFileSync(OUT, generate(phrases, rules, enPhrases))
	console.log(
		`gen-dict: ${phrases.length} zh + ${enPhrases.length} en (${enSpell.length} spellings + ${enProper.length} proper nouns) + ${rules.length} rules -> ${OUT.replace(root + '/', '')}`,
	)
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
	try {
		main()
	} catch (e) {
		console.error(`gen-dict: ${e.message}`)
		process.exit(1)
	}
}
