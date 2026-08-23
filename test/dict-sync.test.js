// Dict sync guard: the typo dictionary lives in lib/proofread-dict.js (host
// side) and is embedded verbatim into lib/client.js (browser side, between
// the DICT-SHARED markers). Both copies must never drift — this test compares
// data + behavior of the two, so editing one without the other fails loudly.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
	WRONG_PHRASES,
	CONTEXT_RULES,
	scanLocalTypos,
} from '../lib/proofread-dict.js'

const here = dirname(fileURLToPath(import.meta.url))
const clientSource = readFileSync(join(here, '../lib/client.js'), 'utf8')

function extractSharedBlock(source) {
	const begin = source.indexOf('DICT-SHARED-BEGIN')
	const end = source.indexOf('DICT-SHARED-END')
	assert.notEqual(begin, -1, 'client.js is missing DICT-SHARED-BEGIN marker')
	assert.notEqual(end, -1, 'client.js is missing DICT-SHARED-END marker')
	const startLine = source.indexOf('\n', begin) + 1
	return source.slice(startLine, source.lastIndexOf('\n', end))
}

// Evaluate the embedded block as plain script and grab its bindings.
function loadClientDict() {
	const block = extractSharedBlock(clientSource)
	const factory = new Function(
		`${block}\nreturn { WRONG_PHRASES, CONTEXT_RULES, maskForScan, scanLocalTypos };`,
	)
	return factory()
}

test('client embeds the same WRONG_PHRASES map', () => {
	const client = loadClientDict()
	assert.deepStrictEqual(client.WRONG_PHRASES, WRONG_PHRASES)
})

test('client embeds the same CONTEXT_RULES (regex + reason)', () => {
	const client = loadClientDict()
	assert.equal(client.CONTEXT_RULES.length, CONTEXT_RULES.length)
	for (let i = 0; i < CONTEXT_RULES.length; i += 1) {
		assert.deepStrictEqual(
			client.CONTEXT_RULES[i].regex.source,
			CONTEXT_RULES[i].regex.source,
			`rule #${i} regex drifted`,
		)
		assert.equal(client.CONTEXT_RULES[i].regex.flags, CONTEXT_RULES[i].regex.flags)
		assert.equal(client.CONTEXT_RULES[i].reason, CONTEXT_RULES[i].reason)
	}
})

test('both scanners agree on dictionary hits', () => {
	const client = loadClientDict()
	const samples = [
		'我迫不急待地想看看这个结果',
		'他的帐号和帐户都登不上去',
		'再接再励，一如继往地努力',
		'大厅广众之下出丑，真是遗笑大方',
		'最近心浮气燥，急燥又暴燥',
	]
	for (const sample of samples) {
		assert.deepStrictEqual(client.scanLocalTypos(sample), scanLocalTypos(sample), `drift on: ${sample}`)
	}
})

test('both scanners agree on context-rule hits', () => {
	const client = loadClientDict()
	const samples = [
		'请登陆系统后再操作',
		'出门记得带口罩和带眼镜',
		'贴一张寻人启示',
		'我们一起渡过假期',
		'截止今天还没有回复',
		'你必需做完作业',
		'他激动得不能自己',
		'今天好象要下雨',
		'好象形论述不涉及', // 不接替换的负例
	]
	for (const sample of samples) {
		assert.deepStrictEqual(client.scanLocalTypos(sample), scanLocalTypos(sample), `drift on: ${sample}`)
	}
})

test('both scanners agree on masking (code spans, fences, URLs)', () => {
	const client = loadClientDict()
	const samples = [
		'`迫不急待` 这个成语常被写错，但行内代码里的不能标',
		'```\n迫不急待\n```\n围栏代码块里的迫不急待也不能标，外面的迫不急待要标',
		'见 https://example.com/迫不急待 链接里的不算，句末的迫不急待要算',
		'干净的句子没有错字。',
		'',
	]
	for (const sample of samples) {
		assert.deepStrictEqual(client.scanLocalTypos(sample), scanLocalTypos(sample), `drift on masked sample`)
	}
})
