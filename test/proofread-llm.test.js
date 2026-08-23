import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseIssuesJson, locateIssues, mergeIssues } from '../src/proofread-llm.ts'

test('解析 ```json 围栏输出', () => {
	const raw = '```json\n{"issues":[{"orig":"在说","fix":"再说","reason":"时间副词"}]}\n```'
	const issues = parseIssuesJson(raw)
	assert.equal(issues.length, 1)
	assert.equal(issues[0].orig, '在说')
	assert.equal(issues[0].fix, '再说')
})

test('解析散文包裹的 JSON', () => {
	const issues = parseIssuesJson('好的，检查结果如下：{"issues":[]} 请查收。')
	assert.equal(issues.length, 0)
})

test('解析裸数组输出', () => {
	const issues = parseIssuesJson('[{"orig":"以经","fix":"已经","reason":""}]')
	assert.equal(issues.length, 1)
})

test('非 JSON 输出返回空数组', () => {
	assert.equal(parseIssuesJson('抱歉，我无法处理').length, 0)
	assert.equal(parseIssuesJson('').length, 0)
})

test('畸形条目被过滤（自映射/超长/换行/缺字段）', () => {
	const issues = parseIssuesJson(JSON.stringify({
		issues: [
			{ orig: '一样', fix: '一样', reason: 'x' },
			{ orig: '这一段实在太长了根本不该被当作错别字', fix: '短', reason: 'x' },
			{ orig: '带\n换行', fix: 'x', reason: 'x' },
			{ orig: '好的', fix: 123, reason: 'x' },
			{ orig: '真错', fix: '真确', reason: 'x' },
		],
	}))
	assert.equal(issues.length, 1)
	assert.equal(issues[0].orig, '真错')
})

test('locateIssues 由宿主定位 offset，找不到的丢弃', () => {
	const text = '我在说一下情况'
	const out = locateIssues([
		{ orig: '在说', fix: '再说', reason: 'r' },
		{ orig: '不存在的片段', fix: 'x', reason: 'r' },
	], text)
	assert.equal(out.length, 1)
	assert.equal(out[0].offset, 1)
	assert.equal(out[0].source, 'llm')
	assert.equal(text.slice(out[0].offset, out[0].offset + out[0].orig.length), '在说')
})

test('mergeIssues：LLM 结果与词典重叠时词典优先', () => {
	const local = [{ orig: '因该', fix: '应该', offset: 2, reason: 'r', source: 'dict' }]
	const llm = [
		{ orig: '因该', fix: '应该', offset: 2, reason: 'r', source: 'llm' },
		{ orig: '在说', fix: '再说', offset: 0, reason: 'r', source: 'llm' },
	]
	const merged = mergeIssues(local, llm)
	assert.equal(merged.length, 2)
	assert.equal(merged[0].orig, '在说')
	assert.equal(merged[1].source, 'dict')
})
