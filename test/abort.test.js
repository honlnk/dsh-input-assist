import { test } from 'node:test'
import assert from 'node:assert/strict'
import { linkedTimeoutSignal, resettableIdleSignal } from '../src/abort.ts'

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

// —— resettableIdleSignal（流式空闲超时）——

test('空闲信号：持续 reset 不到期，停止 reset 后到期', async () => {
	const idle = resettableIdleSignal(60)
	for (let i = 0; i < 5; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 30))
		idle.reset() // 每 30ms 有数据，60ms 空闲窗口永不到期
		assert.equal(idle.signal.aborted, false)
	}
	await new Promise((resolve) => setTimeout(resolve, 90))
	assert.equal(idle.signal.aborted, true)
	idle.dispose()
})

test('空闲信号：外部 abort 联动；已 abort 的外部信号立即联动', () => {
	const external = new AbortController()
	const idle = resettableIdleSignal(5000, external.signal)
	assert.equal(idle.signal.aborted, false)
	external.abort()
	assert.equal(idle.signal.aborted, true)
	idle.dispose()

	const aborted = new AbortController()
	aborted.abort()
	const idle2 = resettableIdleSignal(5000, aborted.signal)
	assert.equal(idle2.signal.aborted, true)
	idle2.dispose()
})

test('空闲信号：dispose 后计时器与外部监听均摘除', async () => {
	const external = new AbortController()
	const idle = resettableIdleSignal(20, external.signal)
	idle.dispose()
	await new Promise((resolve) => setTimeout(resolve, 60))
	assert.equal(idle.signal.aborted, false)
	external.abort()
	assert.equal(idle.signal.aborted, false) // 监听已摘，不再联动
})
