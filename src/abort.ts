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
