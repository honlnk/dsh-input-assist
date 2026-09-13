// 在途取消（v0.5）：把「外部取消信号 + 每调用超时」联动成一个喂给 fetch 的
// signal。不用 AbortSignal.any，手工联动兼容更老的 Node 运行时。调用方在
// settle 后必须 dispose（清计时器、摘外部监听）。

export interface LinkedTimeoutSignal {
	signal: AbortSignal
	/** 调用 settle 后调用：清超时计时器并摘掉外部信号监听。 */
	dispose: () => void
}

export function linkedTimeoutSignal(timeoutMs: number, external?: AbortSignal): LinkedTimeoutSignal {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), Math.max(0, timeoutMs))
	const onExternalAbort = (): void => {
		controller.abort()
	}
	if (external !== undefined) {
		if (external.aborted) controller.abort()
		else external.addEventListener('abort', onExternalAbort, { once: true })
	}
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer)
			external?.removeEventListener('abort', onExternalAbort)
		},
	}
}

// 流式专用：空闲超时而非总时长超时——每收到一个上游 chunk 调 reset()
// 重开计时器，连续 idleMs 无数据才到点。外部取消信号联动方式同上；
// 调用方在 settle 后必须 dispose。
export interface ResettableIdleSignal {
	signal: AbortSignal
	/** 每收到上游数据后调用：重开空闲计时器。 */
	reset: () => void
	/** settle 后调用：清计时器并摘掉外部信号监听。 */
	dispose: () => void
}

export function resettableIdleSignal(idleMs: number, external?: AbortSignal): ResettableIdleSignal {
	const controller = new AbortController()
	let timer: ReturnType<typeof setTimeout> | undefined
	const arm = (): void => {
		if (timer !== undefined) clearTimeout(timer)
		timer = setTimeout(() => controller.abort(), Math.max(0, idleMs))
	}
	const onExternalAbort = (): void => {
		controller.abort()
	}
	if (external !== undefined) {
		if (external.aborted) controller.abort()
		else external.addEventListener('abort', onExternalAbort, { once: true })
	}
	arm()
	return {
		signal: controller.signal,
		reset: arm,
		dispose: () => {
			if (timer !== undefined) clearTimeout(timer)
			timer = undefined
			external?.removeEventListener('abort', onExternalAbort)
		},
	}
}
