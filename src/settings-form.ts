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
