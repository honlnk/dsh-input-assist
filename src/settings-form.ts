// 设置卡片表单的纯逻辑（无 React 依赖）：字段清单、暂存编辑、解析校验。
// 由 tsdown 打进 client bundle；测试经 bundle 导出口守卫（与词典同路）。
// 数字字段的 0..60000 整数边界与 host 侧 clampNumber 钳制保持一致。

import type { InputAssistConfig } from './config.js'

export type SettingsFieldKind = 'toggle' | 'string' | 'number'

export interface SettingsFieldSpec {
	key: keyof InputAssistConfig
	kind: SettingsFieldKind
	group: 'completion' | 'proofread'
	/** 文本字段是否允许留空（仅 API Key——空值意为回退凭证链）。 */
	allowEmpty?: boolean
	/** 渲染为密码框（值仍明文存 settings.yaml，仅显示层遮蔽）。 */
	password?: boolean
	/** 模型名字段：输入框挂 datalist 下拉建议 + 拉取按钮。 */
	model?: boolean
}

/** 卡片展示的字段与分组（数组顺序即渲染顺序）。 */
export const SETTINGS_FIELDS: readonly SettingsFieldSpec[] = [
	{ key: 'completionEnabled', kind: 'toggle', group: 'completion' },
	{ key: 'completionBaseUrl', kind: 'string', group: 'completion' },
	{ key: 'completionApiKey', kind: 'string', group: 'completion', allowEmpty: true, password: true },
	{ key: 'completionModel', kind: 'string', group: 'completion', model: true },
	{ key: 'completionDebounceMs', kind: 'number', group: 'completion' },
	{ key: 'completionMaxTokens', kind: 'number', group: 'completion' },
	{ key: 'proofreadEnabled', kind: 'toggle', group: 'proofread' },
	{ key: 'proofreadUseLlm', kind: 'toggle', group: 'proofread' },
	{ key: 'proofreadModel', kind: 'string', group: 'proofread', model: true },
	{ key: 'proofreadDebounceMs', kind: 'number', group: 'proofread' },
	{ key: 'proofreadDictDebounceMs', kind: 'number', group: 'proofread' },
]

/** 暂存编辑：toggle 存 boolean，文本/数字存原始输入串（保存时才解析）。 */
export type StagedEdits = Partial<Record<keyof InputAssistConfig, string | boolean>>

export function stageValue(staged: StagedEdits, key: keyof InputAssistConfig, value: string | boolean): StagedEdits {
	return { ...staged, [key]: value }
}

export function unstageValue(staged: StagedEdits, key: keyof InputAssistConfig): StagedEdits {
	const next = { ...staged }
	delete next[key]
	return next
}

export function isFieldStaged(spec: SettingsFieldSpec, staged: StagedEdits): boolean {
	return Object.prototype.hasOwnProperty.call(staged, spec.key)
}

/** 文本框显示值：暂存串优先，否则当前配置值。 */
export function fieldText(spec: SettingsFieldSpec, staged: StagedEdits, current: InputAssistConfig): string {
	const s = staged[spec.key]
	if (spec.kind !== 'toggle' && typeof s === 'string') return s
	return String(current[spec.key])
}

/** 开关显示值：暂存布尔优先，否则当前配置值。 */
export function fieldChecked(spec: SettingsFieldSpec, staged: StagedEdits, current: InputAssistConfig): boolean {
	const s = staged[spec.key]
	if (spec.kind === 'toggle' && typeof s === 'boolean') return s
	return current[spec.key] === true
}

export interface StagedPatchResult {
	patch: Partial<InputAssistConfig>
	/** 解析失败的字段（数字非 0..60000 整数、必填文本为空）。 */
	invalid: Array<keyof InputAssistConfig>
}

/** 暂存编辑 → 待写入补丁；无效字段只进 invalid 不进 patch。 */
export function parseStagedPatch(staged: StagedEdits): StagedPatchResult {
	const patch: Partial<InputAssistConfig> = {}
	const invalid: Array<keyof InputAssistConfig> = []
	const specByKey = new Map(SETTINGS_FIELDS.map((f) => [f.key, f]))
	for (const key of Object.keys(staged) as Array<keyof InputAssistConfig>) {
		const spec = specByKey.get(key)
		if (spec === undefined) continue
		const value = staged[key]
		if (spec.kind === 'toggle') {
			if (typeof value === 'boolean') (patch as Record<string, unknown>)[key] = value
		} else if (spec.kind === 'string') {
			if (typeof value !== 'string') continue
			const text = value.trim()
			if (text === '' && spec.allowEmpty !== true) invalid.push(key)
			else (patch as Record<string, unknown>)[key] = text
		} else {
			const text = typeof value === 'string' ? value.trim() : ''
			const n = Number(text)
			if (text !== '' && Number.isInteger(n) && n >= 0 && n <= 60000) {
				(patch as Record<string, unknown>)[key] = n
			} else {
				invalid.push(key)
			}
		}
	}
	return { patch, invalid }
}

// —— 用户自定义词库区块（仅本浏览器，localStorage；独立于上方配置暂存流） ——
// UI 是成对词条列表（错词/正词两列输入框），存储仍是行式文本
// （`错词 => 正词`，与导入导出、扫描路径 parseDictText 共用同一格式）。

export const USER_DICT_MAX_ENTRIES = 2000
export const USER_DICT_MAX_WORD_LEN = 16

/** 一行词条（id 由组件分配，供 React key 与 FLIP 行定位；纯逻辑忽略）。 */
export interface UserDictPair {
	wrong: string
	right: string
}

export type UserDictPairIssueCode = 'blank' | 'wrongSpace' | 'rightSpace' | 'tooLong' | 'dup'

export interface UserDictPairsCheck {
	/** 去空行后的有效词条数。 */
	entries: number
	/** 行号 → 首个命中的错误码（一行只报一个，就近修复）。 */
	issues: Array<{ row: number; code: UserDictPairIssueCode }>
	/** 词条数超上限（与 issues 分开，错误文案挂在区块级而非行级）。 */
	overflow: boolean
	ok: boolean
}

/** 已存文本 → 有序词条对：注释/空行跳过；非法行静默丢弃（保存时已校验过，只可能是手改 localStorage）。 */
export function parseUserDictPairs(text: string): UserDictPair[] {
	const out: UserDictPair[] = []
	for (const raw of String(text ?? '').split(/\r?\n/)) {
		const line = raw.trim()
		if (line === '' || line.startsWith('#')) continue
		const idx = line.indexOf('=>')
		if (idx === -1) continue
		const wrong = line.slice(0, idx).trim()
		const right = line.slice(idx + 2).trim()
		if (wrong === '' || right === '' || /\s/.test(wrong) || /\s{2,}/.test(right)) continue
		out.push({ wrong, right })
	}
	return out
}

/** 词条对 → 存储文本：两侧全空的行跳过，其余 trim 后成行（保持列表顺序）。 */
export function serializeUserDictPairs(pairs: readonly UserDictPair[]): string {
	return pairs
		.map((p) => ({ wrong: p.wrong.trim(), right: p.right.trim() }))
		.filter((p) => p.wrong !== '' || p.right !== '')
		.map((p) => `${p.wrong} => ${p.right}`)
		.join('\n')
}

/** 列表校验：按 trim 后的值检查（与保存时序列化的内容一致）。 */
export function checkUserDictPairs(pairs: readonly UserDictPair[]): UserDictPairsCheck {
	const issues: UserDictPairsCheck['issues'] = []
	const seen = new Map<string, number>()
	let entries = 0
	for (let i = 0; i < pairs.length; i += 1) {
		const wrong = pairs[i].wrong.trim()
		const right = pairs[i].right.trim()
		if (wrong === '' && right === '') continue
		if (wrong === '' || right === '') {
			issues.push({ row: i, code: 'blank' })
			continue
		}
		if (/\s/.test(wrong)) issues.push({ row: i, code: 'wrongSpace' })
		else if (wrong.length > USER_DICT_MAX_WORD_LEN) issues.push({ row: i, code: 'tooLong' })
		else if (/\s{2,}/.test(right)) issues.push({ row: i, code: 'rightSpace' })
		else if (seen.has(wrong)) issues.push({ row: i, code: 'dup' })
		if (!/\s/.test(wrong) && wrong.length <= USER_DICT_MAX_WORD_LEN && !seen.has(wrong)) seen.set(wrong, i)
		entries += 1
	}
	const overflow = entries > USER_DICT_MAX_ENTRIES
	return { entries, issues, overflow, ok: issues.length === 0 && !overflow }
}
