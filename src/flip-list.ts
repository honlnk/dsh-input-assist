// 成对词条列表的拖拽排序 + FLIP 位移动画。纯 DOM 模块（无 React 依赖）：
// 落位动画依赖「DOM 已按新序提交、浏览器尚未绘制」的时机，由调用方在
// useLayoutEffect 里调 applyFlip 完成（因此无需 flushSync / react-dom）。
//
// 行元素约定：同一容器内的兄弟节点、带 data-flip-id（值用于跨快照对位，
// 与渲染顺序解耦，React 按 key 复用节点后仍能对上旧位置）。

/** 数组项搬运（纯函数）：from 处的项移到 to，其余顺延。 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
	if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list]
	const out = [...list]
	const [item] = out.splice(from, 1)
	out.splice(to, 0, item)
	return out
}

const rowsOf = (container: HTMLElement): HTMLElement[] =>
	Array.from(container.querySelectorAll<HTMLElement>('[data-flip-id]'))

/** 行快照：data-flip-id → 当前视觉 top（getBoundingClientRect，含进行中的
 *  transform，因此拖拽中途的快照也是真实视觉位）。 */
export function snapshotRows(container: HTMLElement): Map<string, number> {
	const tops = new Map<string, number>()
	for (const row of rowsOf(container)) tops.set(row.dataset.flipId ?? '', row.getBoundingClientRect().top)
	return tops
}

/**
 * FLIP 落位：在状态提交后的 useLayoutEffect 里调用。先清内联位移量出
 * 新自然位，再把受影响的行瞬时摆回旧位、放开过渡滑到自然位。新增行
 * 无旧位则原地出现。transform 过渡由样式表提供（.ia_udRow），这里只借
 * 内联样式做起始位的瞬时摆放。
 */
export function applyFlip(container: HTMLElement, before: Map<string, number>): void {
	const rows = rowsOf(container)
	for (const row of rows) {
		row.style.transition = 'none'
		row.style.transform = ''
	}
	const moving: HTMLElement[] = []
	for (const row of rows) {
		const old = before.get(row.dataset.flipId ?? '')
		if (old === undefined) continue
		const delta = old - row.getBoundingClientRect().top
		if (delta >= 1 || delta <= -1) {
			row.style.transform = `translateY(${delta}px)`
			moving.push(row)
		}
	}
	if (moving.length === 0) {
		for (const row of rows) row.style.transition = ''
		return
	}
	void container.offsetHeight // 起始位先生效，再放过渡
	for (const row of rows) row.style.transition = ''
	for (const row of moving) row.style.transform = ''
}

/** grip 的 pointerdown 事件（React 合成事件即可，只取这几个原生字段）。 */
export interface RowDragEvent {
	button?: number
	pointerId?: number
	clientY: number
	currentTarget: EventTarget & HTMLElement
	preventDefault(): void
}

export interface RowDragOptions {
	event: RowDragEvent
	row: HTMLElement
	container: HTMLElement
	/** 松手时回调最终位序（from === to 表示原地放下，调用方仍应走一次
	 *  flipCommit 让拖拽行平滑滑回原位）。 */
	onDrop: (from: number, to: number) => void
}

/**
 * 指针拖拽排序：拖拽行实时跟手（无过渡），其余行按让位方向平移
 * （有过渡，丝滑）；松手交回调用方做 FLIP 落位。位移量基于 offsetTop
 * 快照（不受 transform 影响），行高不一时也成立；目标位序 = 拖拽行
 * 中心越过多少个其他行的中点。
 */
export function startRowDrag(opts: RowDragOptions): void {
	const { event, row, container, onDrop } = opts
	if (event.button !== 0) return
	const rows = rowsOf(container)
	const from = rows.indexOf(row)
	if (from === -1) return
	const mids = rows.map((r) => r.offsetTop + r.offsetHeight / 2)
	const dragH = row.offsetHeight
	const gapVal = parseFloat(getComputedStyle(container).gap)
	const gap = Number.isFinite(gapVal) ? gapVal : 8
	const startY = event.clientY
	let to = from
	event.preventDefault() // 阻止文本选择/原生拖拽
	try {
		event.currentTarget.setPointerCapture(event.pointerId ?? -1)
	} catch {
		/* 捕获失败也能工作：监听挂在 window 上 */
	}
	row.classList.add('ia_udDrag')
	document.body.classList.add('ia_udDragging')
	const apply = (clientY: number): void => {
		const delta = clientY - startY
		row.style.transform = `translateY(${delta}px)`
		const center = mids[from] + delta
		let k = 0
		for (let i = 0; i < rows.length; i += 1) {
			if (i !== from && mids[i] < center) k += 1
		}
		to = k
		for (let i = 0; i < rows.length; i += 1) {
			if (i === from) continue
			let shift = 0
			if (to < from && i >= to && i < from) shift = dragH + gap
			else if (to > from && i > from && i <= to) shift = -(dragH + gap)
			rows[i].style.transform = shift === 0 ? '' : `translateY(${shift}px)`
		}
	}
	const onMove = (ev: PointerEvent): void => {
		apply(ev.clientY)
	}
	const finish = (): void => {
		window.removeEventListener('pointermove', onMove)
		window.removeEventListener('pointerup', finish)
		window.removeEventListener('pointercancel', finish)
		row.classList.remove('ia_udDrag')
		document.body.classList.remove('ia_udDragging')
		onDrop(from, to)
	}
	window.addEventListener('pointermove', onMove)
	window.addEventListener('pointerup', finish)
	window.addEventListener('pointercancel', finish)
}
