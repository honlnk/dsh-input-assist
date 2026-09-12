import { test } from 'node:test'
import assert from 'node:assert/strict'
import { linkedTimeoutSignal } from '../src/abort.ts'

test('外部信号 abort 时联动信号随之 abort', () => {
	const external = new AbortController()
	const linked = linkedTimeoutSignal(5000, external.signal)
	assert.equal(linked.signal.aborted, false)
	external.abort()
	assert.equal(linked.signal.aborted, true)
	linked.dispose()
})

test('已 abort 的外部信号立即联动（不依赖事件回放）', () => {
	const external = new AbortController()
	external.abort()
	const linked = linkedTimeoutSignal(5000, external.signal)
	assert.equal(linked.signal.aborted, true)
	linked.dispose()
})

test('超时到期联动信号 abort', async () => {
	const linked = linkedTimeoutSignal(10)
	await new Promise((resolve) => setTimeout(resolve, 40))
	assert.equal(linked.signal.aborted, true)
	linked.dispose()
})

test('dispose 清掉超时计时器：之后不再 abort，也无监听残留', async () => {
	const linked = linkedTimeoutSignal(10)
	linked.dispose()
	await new Promise((resolve) => setTimeout(resolve, 40))
	assert.equal(linked.signal.aborted, false)

	const external = new AbortController()
	const linked2 = linkedTimeoutSignal(5000, external.signal)
	linked2.dispose()
	external.abort()
	// dispose 已摘掉外部监听，联动信号不应再被触发
	assert.equal(linked2.signal.aborted, false)
})
