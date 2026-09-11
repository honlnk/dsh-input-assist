// gen-dict 生成器单测：解析校验规则 + 生成物与 data/ 同步守卫。
// 同步守卫同时防“改了 data/ 忘跑 gendict”与“手改 generated.ts”两种漂移。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePhrases, parseRules, generate } from '../scripts/gen-dict.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p) => readFileSync(join(here, p), 'utf8')

test('parsePhrases：合法行式词库（注释/空行/trim）', () => {
	const phrases = parsePhrases('# 注释\n\n  迫不急待 => 迫不及待  \n帐号 => 账号\n')
	assert.deepEqual(phrases, [
		['迫不急待', '迫不及待'],
		['帐号', '账号'],
	])
})

test('parsePhrases：非法形态一律抛错并带行号', () => {
	const bad = [
		['迫不急待 迫不及待', '缺 =>'],
		['=> 正词', '错词为空'],
		['两 个字 => 词', '错词含空白'],
		['错词 =>', '正词为空'],
		['错词 => 两个 词', '正词含空白'],
		['迫不急待 => 迫不急待', '自映射'],
		['帐号 => 账号\n帐号 => 帐号', '重复错词'],
	]
	for (const [text, why] of bad) {
		assert.throws(() => parsePhrases(text), Error, `应抛错：${why}`)
	}
})

test('parseRules：组号越界/坏正则/flags 缺 g 抛错', () => {
	assert.throws(() => parseRules([{ pattern: '登陆(系统)', fix: '登录$2', reason: 'x' }]), /越界/)
	assert.throws(() => parseRules([{ pattern: '(', fix: 'x', reason: 'x' }]), /合法正则/)
	assert.throws(() => parseRules([{ pattern: 'x', flags: 'i', fix: 'x', reason: 'x' }]), /必须含 g/)
	assert.throws(() => parseRules([{ pattern: 'x', flags: 'zz', fix: 'x', reason: 'x' }]), /gimsuy/)
	assert.throws(() => parseRules([{ pattern: 'x', fix: 'x' }]), /reason/)
	assert.throws(() => parseRules([]), /非空数组/)
	// 可选组未匹配 → 模板合法（$1 允许，运行期解析为空串）
	const ok = parseRules([{ pattern: '必需(要)?(做)', fix: '必须$1$2', reason: 'x' }])
	assert.equal(ok[0].fixTemplate, '必须$1$2')
	// 非捕获组不计入组号
	assert.doesNotThrow(() => parseRules([{ pattern: '渡过(?=(?:假期))', fix: '度过', reason: 'x' }]))
	assert.throws(() => parseRules([{ pattern: '渡过(?=(?:假期))', fix: '度过$1', reason: 'x' }]), /越界/)
})

test('generate：输出形状（头注释/导出/闭括号）与幂等', () => {
	const out1 = generate([['帐号', '账号']], [{ regex: '/好象/g', fixTemplate: '好像', reason: 'r' }])
	const out2 = generate([['帐号', '账号']], [{ regex: '/好象/g', fixTemplate: '好像', reason: 'r' }])
	assert.equal(out1, out2)
	assert.ok(out1.includes('勿手改'))
	assert.ok(out1.includes("'帐号': '账号',"))
	assert.ok(out1.includes('regex: /好象/g'))
	assert.ok(out1.trimEnd().endsWith(']'))
})

test('同步守卫：data/ 当前内容重新生成 == 入库的 generated.ts', () => {
	const phrases = parsePhrases(read('../data/zh-wrong-phrases.txt'))
	const rules = parseRules(JSON.parse(read('../data/zh-context-rules.json')))
	assert.ok(phrases.length > 200, `词库条数异常：${phrases.length}`)
	assert.equal(rules.length, 8)
	assert.equal(generate(phrases, rules), read('../src/proofread-dict-data.generated.ts'))
})
