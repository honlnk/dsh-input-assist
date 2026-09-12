// 用户自定义词库：storage 封装 + 行式解析（容错版）+ 合并/禁用语义。
// 行式语法与内置 data/zh-wrong-phrases.txt 同源（构建期 fail-fast 版的
// 校验用例在 gen-dict.test.js；这里测运行期容错收集与合并扫描语义）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadUserDictText, saveUserDictText, USER_DICT_STORAGE_KEY } from '../src/user-dict.ts'
import { parseDictText, mergeDicts, scanWithDict, BUILTIN_DICT, scanLocalTypos } from '../src/proofread-dict.ts'

const fakeStorage = (throws = false) => {
	const map = new Map()
	return {
		getItem: (k) => {
			if (throws) throw new Error('SecurityError')
			return map.get(k) ?? null
		},
		setItem: (k, v) => {
			if (throws) throw new Error('QuotaExceededError')
			map.set(k, v)
		},
		_dump: () => map,
	}
}

test('loadUserDictText：正常读 / 未写返回空 / 抛错降级空 / 无 storage 降级空', () => {
	const s = fakeStorage()
	s.setItem(USER_DICT_STORAGE_KEY, '帐号 => 账号')
	assert.equal(loadUserDictText(s), '帐号 => 账号')
	assert.equal(loadUserDictText(fakeStorage()), '')
	assert.equal(loadUserDictText(fakeStorage(true)), '')
	assert.equal(loadUserDictText(undefined), '')
	assert.equal(loadUserDictText(null), '')
})

test('saveUserDictText：正常写 / 抛错返回 false / 无 storage 返回 false', () => {
	const s = fakeStorage()
	assert.equal(saveUserDictText(s, 'x => y'), true)
	assert.equal(s._dump().get(USER_DICT_STORAGE_KEY), 'x => y')
	assert.equal(saveUserDictText(fakeStorage(true), 'x => y'), false)
	assert.equal(saveUserDictText(undefined, 'x => y'), false)
})

test('parseDictText：容错收集错误行（不抛），合法行照常进词表', () => {
	const { phrases, errors } = parseDictText('# 注释\n\n自定义错词 => 正词\n没有分隔符的行\n=> 空错词\n')
	assert.deepEqual(phrases, { 自定义错词: '正词' })
	assert.equal(errors.length, 2)
	assert.deepEqual(errors[0], { line: 4, message: '缺少「=>」分隔符' })
	assert.deepEqual(errors[1], { line: 5, message: '错词为空或含空白' })
})

test('parseDictText：正词允许单个空格（alot => a lot），拒绝连续空白', () => {
	const { phrases, errors } = parseDictText('alot => a lot')
	assert.deepEqual(phrases, { alot: 'a lot' })
	assert.deepEqual(errors, [])
	assert.equal(parseDictText('a => b  c').errors[0].message, '正词为空或含连续空白')
	// 英文修正端到端：合并进 EN 表后可检出
	const dict = mergeDicts(BUILTIN_DICT, phrases)
	assert.ok(scanWithDict('i alot these', dict).some((i) => i.orig === 'alot' && i.fix === 'a lot'))
})

test('parseDictText：接受自映射（用户禁用语义），扫描时跳过', () => {
	const { phrases } = parseDictText('迫不急待 => 迫不急待')
	assert.deepEqual(phrases, { 迫不急待: '迫不急待' })
	const dict = mergeDicts(BUILTIN_DICT, phrases)
	// 内置「迫不急待→迫不及待」被自映射覆盖 → 不再检出
	assert.equal(scanWithDict('他迫不急待地想知道', dict).length, 0)
	// 未覆盖的内置词照常检出
	assert.ok(scanWithDict('这个帐号被盗了', dict).some((i) => i.orig === '帐号'))
})

test('mergeDicts：用户词覆盖同错词内置项，新增词照常检出', () => {
	const dict = mergeDicts(BUILTIN_DICT, parseDictText('新错词 => 新正词\n帐号 => 帐户名').phrases)
	const issues = scanWithDict('新错词和帐号都出现了', dict)
	const zh = issues.find((i) => i.orig === '新错词')
	assert.equal(zh?.fix, '新正词')
	assert.equal(issues.find((i) => i.orig === '帐号')?.fix, '帐户名')
	// 上下文规则不受用户词影响
	assert.equal(scanWithDict('请登陆系统', dict)[0]?.fix, '登录系统')
})

test('mergeDicts：不传用户词返回内置 bundle（同一引用）', () => {
	assert.equal(mergeDicts(BUILTIN_DICT), BUILTIN_DICT)
})

test('mergeDicts：英文用户词条分流进 enPhrases（自动获得词边界匹配）', () => {
	const dict = mergeDicts(BUILTIN_DICT, parseDictText('taht => that\n我的错词 => 我的正词').phrases)
	// 英文词条：独立词检出、驼峰不误报
	assert.deepEqual(scanWithDict('taht is fine, myTahtVar ok', dict).map((i) => i.orig), ['taht'])
	// 中文词条照常
	assert.ok(scanWithDict('这里有个我的错词', dict).some((i) => i.orig === '我的错词'))
	// 英文自映射禁用内置（teh => teh）
	const off = mergeDicts(BUILTIN_DICT, parseDictText('teh => teh').phrases)
	assert.equal(scanWithDict('teh word', off).length, 0)
})

test('scanWithDict 与 scanLocalTypos 对纯内置词行为一致', () => {
	for (const text of ['我迫不急待地想看看', '请登陆系统查看账单', '干净的句子。']) {
		assert.deepEqual(scanWithDict(text, BUILTIN_DICT), scanLocalTypos(text))
	}
})
