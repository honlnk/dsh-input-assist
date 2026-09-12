// 设置卡片守卫（v5.1）：两路验证 ——
//   1. 纯表单逻辑（src/settings-form.ts，tsdown 打进 lib/client.js）经假
//      ModuleLoader 取回：字段清单完整性、暂存优先级、解析与校验边界
//   2. apply() 对 settings.plugin.item 的注册断言（key=命名空间、inject
//      形状、原有 conversation.input.* 四个座位不受影响）

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const clientSource = readFileSync(join(here, '../lib/client.js'), 'utf8')

function loadBundleExports() {
	let captured = null
	globalThis.window = { __ModuleLoader__: { load: (def) => { captured = def } } }
	// eslint-disable-next-line no-new-func
	new Function(clientSource)()
	assert.ok(captured !== null, 'ModuleLoader.load 未被调用')
	const reactStub = {
		createElement: () => null,
		useEffect: () => {},
		useLayoutEffect: () => {},
		useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
		useId: () => 'r1',
		useRef: (v) => ({ current: v }),
	}
	const runtimeStub = {
		createSnapshotStore: (init) => ({
			getSnapshot: () => init,
			set: () => {},
			subscribe: () => () => {},
		}),
	}
	return captured.factory((id) => {
		if (id === 'react') return reactStub
		if (id === '@deepseek-ai/dsh-client-runtime/client') return runtimeStub
		throw new Error(`unexpected require: ${id}`)
	})
}

const api = loadBundleExports()

// —— 字段清单：11 项配置全部上卡片，分组正确 ——
test('SETTINGS_FIELDS 覆盖全部配置键且分组齐全', () => {
	assert.equal(api.SETTINGS_FIELDS.length, 11)
	const keys = api.SETTINGS_FIELDS.map((f) => f.key)
	assert.deepEqual([...keys].sort(), Object.keys(DEFAULT_CONFIG).sort())
	for (const f of api.SETTINGS_FIELDS) {
		assert.ok(f.group === 'completion' || f.group === 'proofread', `bad group: ${f.key}`)
	}
	assert.ok(api.SETTINGS_FIELDS.some((f) => f.key === 'completionApiKey' && f.password === true))
	// 模型字段挂下拉建议
	const modelFields = api.SETTINGS_FIELDS.filter((f) => f.model === true).map((f) => f.key)
	assert.deepEqual(modelFields, ['completionModel', 'proofreadModel'])
})

// —— 暂存优先级与撤销 ——
test('fieldText/fieldChecked 暂存值优先于当前配置，unstage 撤销', () => {
	const spec = { key: 'completionModel', kind: 'string', group: 'completion' }
	assert.equal(api.fieldText(spec, { completionModel: 'deepseek-reasoner' }, DEFAULT_CONFIG), 'deepseek-reasoner')
	assert.equal(api.fieldText(spec, {}, DEFAULT_CONFIG), DEFAULT_CONFIG.completionModel)
	const toggle = { key: 'proofreadUseLlm', kind: 'toggle', group: 'proofread' }
	assert.equal(api.fieldChecked(toggle, { proofreadUseLlm: false }, DEFAULT_CONFIG), false)
	assert.equal(api.fieldChecked(toggle, {}, DEFAULT_CONFIG), DEFAULT_CONFIG.proofreadUseLlm)
	let staged = api.stageValue({}, 'completionModel', 'x')
	assert.equal(api.isFieldStaged(spec, staged), true)
	staged = api.unstageValue(staged, 'completionModel')
	assert.equal(api.isFieldStaged(spec, staged), false)
	assert.equal(staged.completionModel, undefined)
})

// —— 解析：合法补丁（trim / 数字转换 / 布尔直通 / apiKey 允许空）——
test('parseStagedPatch 产出合法补丁', () => {
	const { patch, invalid } = api.parseStagedPatch({
		completionModel: '  deepseek-reasoner  ',
		completionDebounceMs: '1200',
		proofreadUseLlm: false,
		completionApiKey: '',
	})
	assert.deepEqual(patch, {
		completionModel: 'deepseek-reasoner',
		completionDebounceMs: 1200,
		proofreadUseLlm: false,
		completionApiKey: '',
	})
	assert.deepEqual(invalid, [])
})

// —— 校验：数字须为 0–60000 整数（与 host 钳制一致），必填文本非空 ——
test('parseStagedPatch 拒绝非法数字与空必填文本', () => {
	const bad = api.parseStagedPatch({
		completionDebounceMs: '-5',
		completionMaxTokens: '12.5',
		proofreadDebounceMs: '',
		proofreadDictDebounceMs: '70000',
		completionBaseUrl: '   ',
		proofreadModel: '',
	})
	assert.deepEqual(bad.patch, {})
	assert.deepEqual([...bad.invalid].sort(), [
		'completionBaseUrl',
		'completionDebounceMs',
		'completionMaxTokens',
		'proofreadDebounceMs',
		'proofreadDictDebounceMs',
		'proofreadModel',
	])
	// 边界值合法
	const edge = api.parseStagedPatch({ completionDebounceMs: '0', proofreadDebounceMs: '60000' })
	assert.deepEqual(edge.patch, { completionDebounceMs: 0, proofreadDebounceMs: 60000 })
	assert.deepEqual(edge.invalid, [])
})

// —— 用户词库区块：成对词条列表的解析 / 序列化 / 逐行校验 ——
test('parseUserDictPairs：注释空行跳过，顺序保留，非法行静默丢弃', () => {
	const pairs = api.parseUserDictPairs('# 注释\n\n新错词 => 新正词\nalot => a lot\n没有分隔符\n=> 空错词\n')
	assert.deepEqual(pairs, [
		{ wrong: '新错词', right: '新正词' },
		{ wrong: 'alot', right: 'a lot' },
	])
	assert.deepEqual(api.parseUserDictPairs(''), [])
})

test('serializeUserDictPairs：trim、跳过两侧全空行，与解析互逆', () => {
	assert.equal(
		api.serializeUserDictPairs([
			{ wrong: ' 帐号 ', right: '账户' },
			{ wrong: '', right: '' },
			{ wrong: 'alot', right: ' a lot ' },
		]),
		'帐号 => 账户\nalot => a lot',
	)
	// 往返稳定
	const text = 'a => b\nc => d'
	assert.equal(api.serializeUserDictPairs(api.parseUserDictPairs(text)), text)
})

test('checkUserDictPairs：逐行错误码（blank/wrongSpace/rightSpace/tooLong/dup）', () => {
	const ok = api.checkUserDictPairs([
		{ wrong: '新错词', right: '新正词' },
		{ wrong: '', right: '' },
	])
	assert.equal(ok.entries, 1)
	assert.deepEqual(ok.issues, [])
	assert.equal(ok.ok, true)

	const bad = api.checkUserDictPairs([
		{ wrong: '只填一边', right: '' }, // blank
		{ wrong: '两 个 词', right: '正词' }, // wrongSpace
		{ wrong: 'a', right: '两  个 空格' }, // rightSpace
		{ wrong: '一二三四五六七八九十一二三四五六七', right: '目标' }, // tooLong
		{ wrong: '重复词', right: '甲' },
		{ wrong: '重复词', right: '乙' }, // dup（第二处报）
	])
	assert.equal(bad.ok, false)
	assert.deepEqual(bad.issues, [
		{ row: 0, code: 'blank' },
		{ row: 1, code: 'wrongSpace' },
		{ row: 2, code: 'rightSpace' },
		{ row: 3, code: 'tooLong' },
		{ row: 5, code: 'dup' },
	])
})

test('checkUserDictPairs：词条数上限（超限置 overflow，错误挂区块级）', () => {
	assert.equal(api.USER_DICT_MAX_ENTRIES, 2000)
	assert.equal(api.USER_DICT_MAX_WORD_LEN, 16)
	const many = Array.from({ length: api.USER_DICT_MAX_ENTRIES + 1 }, (_, i) => ({ wrong: `错词${i}`, right: `正词${i}` }))
	const res = api.checkUserDictPairs(many)
	assert.equal(res.overflow, true)
	assert.equal(res.ok, false)
	assert.deepEqual(res.issues, [])
})

// —— 导入/导出：导入计数、合并语义、导出回环 ——
test('importUserDictText：词条与被忽略行分开计数，注释空行不算忽略', () => {
	const res = api.importUserDictText('# 注释\n\n帐号 => 账号\n没有分隔符\n=> 空错词\nalot => a lot\n')
	assert.deepEqual(res.pairs, [
		{ wrong: '帐号', right: '账号' },
		{ wrong: 'alot', right: 'a lot' },
	])
	assert.equal(res.ignored, 2)
	assert.deepEqual(api.importUserDictText(''), { pairs: [], ignored: 0 })
})

test('mergeUserDictPairs：同错词就地更新、新词追加、导入内同名后者覆盖', () => {
	const merged = api.mergeUserDictPairs(
		[
			{ wrong: '帐号', right: '账号' },
			{ wrong: '', right: '' },
		],
		[
			{ wrong: '新词', right: '先到' },
			{ wrong: '帐号', right: '账户' },
			{ wrong: '新词', right: '后到' },
		],
	)
	assert.deepEqual(merged.rows, [
		{ wrong: '帐号', right: '账户', fromCurrent: 0 },
		{ wrong: '', right: '', fromCurrent: 1 },
		{ wrong: '新词', right: '后到', fromCurrent: -1 },
	])
	assert.equal(merged.added, 1)
	assert.equal(merged.updated, 1)
})

test('mergeUserDictPairs：半填行（只有错词）被导入补全，空行不被匹配', () => {
	const merged = api.mergeUserDictPairs([{ wrong: '半填', right: '' }], [{ wrong: '半填', right: '补全' }])
	assert.deepEqual(merged.rows, [{ wrong: '半填', right: '补全', fromCurrent: 0 }])
	assert.equal(merged.updated, 1)
	assert.equal(merged.added, 0)
})

test('exportUserDictText：注释头 + 有效词条，半填行不导出，解析回环', () => {
	const text = api.exportUserDictText([
		{ wrong: '帐号', right: '账号' },
		{ wrong: '', right: '' },
		{ wrong: '半', right: '' },
	])
	assert.ok(text.startsWith('#'))
	assert.ok(text.includes('帐号 => 账号'))
	assert.ok(!text.includes('半 =>'))
	const back = api.importUserDictText(text)
	assert.deepEqual(back.pairs, [{ wrong: '帐号', right: '账号' }])
	assert.equal(back.ignored, 0)
	// 空表也导出注释头（可再导入，等价无词库）
	assert.ok(api.exportUserDictText([]).startsWith('#'))
	// 全链路回环：导出 → 导入 → 并入空表 = 原有效词条
	const merged = api.mergeUserDictPairs([], back.pairs)
	assert.deepEqual(
		merged.rows.map(({ wrong, right }) => ({ wrong, right })),
		[{ wrong: '帐号', right: '账号' }],
	)
})

// —— apply() 注册断言 ——
test('apply() 注册 settings.plugin.item 卡片（key=input-assist）', () => {
	const registrations = []
	const services = {
		slots: {
			inject: (slot, register) => {
				registrations.push({ slot, entry: register() })
			},
			register: (meta, component) => ({ meta, component }),
		},
		locale: { register: () => () => {} },
		connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
		remote: { $on: () => () => {} },
	}
	api.apply({ get: (name) => services[name], effect: () => {} })

	const seats = registrations.filter((r) => r.slot === 'settings.plugin.item')
	assert.equal(seats.length, 1, 'settings.plugin.item 应回调注册恰好一次')
	const { meta, component } = seats[0].entry
	assert.equal(meta.key, 'input-assist')
	assert.equal(meta.locale, 'input-assist')
	assert.equal(typeof component, 'function')
	const injected = meta.inject()
	assert.equal(typeof injected.api.save, 'function')
	assert.equal(typeof injected.api.fetchModels, 'function')
	assert.equal(typeof injected.hooks.config, 'object')

	// 原有四个输入框座位不受影响
	const conv = registrations.filter((r) => r.slot.startsWith('conversation.input.'))
	assert.equal(conv.length, 4)
})

// —— 组件冒烟：缺 useConfig/api 时安全返回 null，完整 props 渲染不抛 ——
test('SettingsCard 冒烟：props 缺失返回 null，完整 props 不抛', async () => {
	const registrations = []
	const services = {
		slots: {
			inject: (slot, register) => {
				registrations.push({ slot, entry: register() })
			},
			register: (meta, component) => ({ meta, component }),
		},
		locale: { register: () => () => {} },
		connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
		remote: { $on: () => () => {} },
	}
	api.apply({ get: (name) => services[name], effect: () => {} })
	const card = registrations.find((r) => r.slot === 'settings.plugin.item').entry.component

	assert.equal(card({ t: (k) => k }), null)
	assert.equal(card({ useConfig: (sel) => sel(DEFAULT_CONFIG), t: (k) => k }), null)
	const rendered = card({
		useConfig: (sel) => sel(DEFAULT_CONFIG),
		t: (k) => k,
		api: { save: async () => true },
	})
	assert.equal(rendered, null) // react 桩 createElement 恒返 null；不抛即形状正确
})
