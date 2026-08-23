import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractCompletionText, normalizeSuggestion } from '../lib/completion.js'

test('legacy completions 响应三种字段形态都能读取', () => {
	assert.equal(extractCompletionText({ choices: [{ text: '你好' }] }), '你好')
	assert.equal(extractCompletionText({ choices: [{ message: { content: 'A' } }] }), 'A')
	assert.equal(extractCompletionText({ choices: [{ delta: { content: 'B' } }] }), 'B')
	assert.equal(extractCompletionText({}), '')
	assert.equal(extractCompletionText(null), '')
})

test('normalizeSuggestion 去掉首部换行与尾部空白', () => {
	assert.equal(normalizeSuggestion('\n\n  好的主意 \n'), '好的主意')
	assert.equal(normalizeSuggestion(undefined), '')
	// 中间空白保留
	assert.equal(normalizeSuggestion('继续 写 下去\n'), '继续 写 下去')
	// 前缀为拉丁词时保留单个前导空格（英文单词补全场景）
	assert.equal(normalizeSuggestion(' world', 200, 'hello'), ' world')
	assert.equal(normalizeSuggestion('  world', 200, 'hello'), ' world')
	// 前缀为中文/空白时前导空格是噪声
	assert.equal(normalizeSuggestion(' 世界', 200, '你好'), '世界')
	assert.equal(normalizeSuggestion(' 世界', 200, 'a '), '世界')
})

test('normalizeSuggestion 截断超长建议', () => {
	const long = '字'.repeat(500)
	assert.equal(normalizeSuggestion(long).length, 200)
})
