import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanLocalTypos, maskForScan, WRONG_PHRASES } from '../src/proofread-dict.ts'

test('词典本身不包含自映射与非词条', () => {
	for (const [wrong, right] of Object.entries(WRONG_PHRASES)) {
		assert.ok(wrong !== right, `自映射词条：${wrong}`)
		assert.ok(wrong.length >= 2 || wrong.length === 2, `词条长度异常：${wrong}`)
	}
})

test('检出常见成语误写并给出正确 offset', () => {
	const issues = scanLocalTypos('他迫不急待地想知道结果')
	assert.equal(issues.length, 1)
	assert.equal(issues[0].orig, '迫不急待')
	assert.equal(issues[0].fix, '迫不及待')
	assert.equal(issues[0].offset, 1)
	assert.equal(issues[0].source, 'dict')
})

test('检出高频词误写', () => {
	for (const [text, orig, fix] of [
		['我因该早点回家的', '因该', '应该'],
		['这个帐号被盗了', '帐号', '账号'],
		['他竟然放弃了', null, null], // 竟然是正确写法
	]) {
		const issues = scanLocalTypos(text)
		if (orig === null) {
			assert.equal(issues.length, 0, `误报：${text}`)
		} else {
			assert.ok(issues.some((i) => i.orig === orig && i.fix === fix), `未检出：${text}`)
		}
	}
})

test('同一错误多次出现全部检出', () => {
	const issues = scanLocalTypos('帐号丢了，帐号又找回来了')
	const hits = issues.filter((i) => i.orig === '帐号')
	assert.equal(hits.length, 2)
	assert.equal(hits[0].offset, 0)
	assert.equal(hits[1].offset, 5)
})

test('上下文规则：登录/穿戴/启事/度过/截至/必须/不能自已', () => {
	const cases = [
		['请登陆系统查看账单', '登陆系统', '登录系统'],
		['出门记得带口罩', '带口罩', '戴口罩'],
		['寻物启示写错了', '寻物启示', '寻物启事'],
		['我们渡过了愉快的假期', '渡过', '度过'],
		['截止目前一切正常', '截止目前', '截至目前'],
		['你必需先完成作业', '必需先', '必须先'],
		['他激动得不能自己', '得不能自己', '得不能自已'],
	]
	for (const [text, orig, fix] of cases) {
		const issues = scanLocalTypos(text)
		const hit = issues.find((i) => i.orig === orig)
		assert.ok(hit !== undefined, `规则未命中：${text}`)
		assert.equal(hit.fix, fix)
	}
})

test('上下文规则的正确用法不误报', () => {
	const clean = [
		'部队登陆作战了', // 登陆本身合法
		'他带我回家', // 带本身合法
		'登录系统后请修改密码',
		'戴口罩出门',
		'不能自己做决定', // 无“得/地”前缀不命中
		'截止日期是明天', // 截止日期为正确搭配
		'生活必需品要带够', // 必需+名词合法
	]
	for (const text of clean) {
		assert.equal(scanLocalTypos(text).length, 0, `误报：${text}`)
	}
})

test('“好象”只在比喻用法检出，象形等名词不误报', () => {
	assert.equal(scanLocalTypos('天气好象不错')[0]?.fix, '好像')
	assert.equal(scanLocalTypos('研究好象形文字的学者').length, 0)
})

test('代码与 URL 区域被屏蔽', () => {
	const masked = maskForScan('看 `ls 竟争` 和 https://x.com/帐号/1 以及\n```\n帐号\n```\n结束')
	assert.equal(masked.length, '看 `ls 竟争` 和 https://x.com/帐号/1 以及\n```\n帐号\n```\n结束'.length)
	const issues = scanLocalTypos('竟争很激烈，`竟争`在代码里，https://a.com/帐号 也是')
	// 只检出正文里的 1 处“竟争”，代码与 URL 内不检出
	const hits = issues.filter((i) => i.orig === '竟争' || i.orig === '帐号')
	assert.equal(hits.length, 1)
	assert.equal(hits[0].offset, 0)
})

test('正确文本长段落零误报', () => {
	const clean = [
		'他迫不及待地打开了账号设置，再接再厉完成了登录系统的改造。',
		'雾气是水蒸气，他戴着口罩扛着摄像机，好像一切都很顺利。',
		'截至今天，他们竟然一次也没有迟到，真让人感动。',
		'这篇文章言简意赅、名副其实，读起来让人心旷神怡。',
	].join('')
	assert.equal(scanLocalTypos(clean).length, 0)
})

test('重叠命中保留更长匹配', () => {
	// “心浮气燥”同时含“浮燥”，应只报长的
	const issues = scanLocalTypos('他显得心浮气燥')
	assert.equal(issues.filter((i) => i.orig.includes('燥')).length, 1)
	assert.equal(issues[0].orig, '心浮气燥')
})
