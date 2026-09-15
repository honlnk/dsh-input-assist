// 浏览器半边自带的极简 snapshot store。
//
// 0.1.1-rc.2 时代 createSnapshotStore 由 @deepseek-ai/dsh-client-runtime/client
// 作为宿主种子模块提供（tsdown external）；0.1.5 起该包拆分消亡（继任者
// dsh-client-store 不在 web-app 的 loader 行里，浏览器 ModuleLoader 不保证
// 提供）。我们只用到 getSnapshot/set/subscribe 三个方法（选择器 hook 由宿主
// ui-renderer 从 ObservableSnapshot 合成），故收编为本地实现打进 bundle，
// 不再依赖宿主 roster。结构满足 dsh 输入契约的 ObservableSnapshot/SnapshotStore。

/** 最小可观察快照源：Session 对象与 snapshot store 都满足它。 */
export interface ObservableSnapshot<T> {
	getSnapshot(): T
	subscribe(fn: () => void): () => void
}

/** 可写快照 store（同步通知；受控输入需要同 tick 回显）。 */
export interface SnapshotStore<T> extends ObservableSnapshot<T> {
	set(next: T): void
}

export function createSnapshotStore<T>(init: T): SnapshotStore<T> {
	let state = init
	const listeners = new Set<() => void>()
	return {
		getSnapshot: () => state,
		subscribe(fn) {
			listeners.add(fn)
			return () => {
				listeners.delete(fn)
			}
		},
		set(next) {
			state = next
			for (const fn of [...listeners]) fn()
		},
	}
}
