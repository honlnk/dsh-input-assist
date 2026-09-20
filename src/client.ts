// dsh-input-assist — browser half (client half).
// 布局参考 dsh-composer-enter（双侧插件的浏览器侧接线）与 dsh-voice-input
// （inputActions.setDraft 写草稿）。UI 座位全部 additive：
//   conversation.input.overlay — 仅补全错误提示（建议本体由镜像层 ghost text 渲染）
//   conversation.input.dock    — 错别字导航条（上一个/下一个/修正/标记正确/忽略）
//   conversation.input.right   — 「补 / 校」两个功能开关
//   settings.plugin.item       — 设置页卡片（Settings → Plugins → 插件配置，
//                                keyed by 命名空间；宿主 ui-settings-plugins
//                                渲染卡片列表 = Host 已服务命名空间 ∩ 注册 key）
//   镜像层（body 挂载）— 文中红字标注错字 + 光标后灰色 ghost 建议（NovAI 同款）
//
// 补全交互（v3 ghost text）：
//   建议以灰字内联在光标后；Tab 逐词采纳（Intl.Segmenter 中文分词）、
//   Shift+Tab 全量采纳、Esc 关闭；逐词采纳期间不重调度（justAccepted 守卫），
//   吃光后自动再请求一轮。IME 组合期一律放行。
//   在途取消（v0.5）：重新输入重调度 / Esc / 关开关时发 cancel RPC 让
//   host 断开未完成的请求（序号守卫只丢结果，cancel 才省 token）。
//   流式渐进渲染（v0.6）：默认直连 host 的 /api/input-assist/stream
//   （connection.fetch 流式路由），SSE 帧驱动 ghost 逐字渐显；Tab 流中
//   采纳不断流（剩余建议继续被在途 delta 追加）；host 旧版本无该路由
//   （404）或配置关闭时自动走 RPC 整段返回。
//
// 错别字交互（v2）：
//   检出后导航条出现，当前选中的错字在文本中加重高亮（红字 + 底色），
//   其余错字红色波浪线；「修正」只替换当前选中的一条（绝不全量替换）；
//   「标记正确」把该处加入本次输入的忽略名单；快捷键：
//     Ctrl+Shift+,  上一个      Ctrl+Shift+.  下一个
//     Ctrl+Shift+F  修正当前    Ctrl+Shift+G  标记正确
//     Esc           忽略本次（建议条可见时优先关闭建议条）
//   所有快捷键仅在输入框聚焦且有检出时接管；IME 组合期一律放行。
//
// TS 化（v4）：词典层不再内嵌 DICT-SHARED 代码块，直接 import 共享模块，
// 由 tsdown 打包进 lib/client.js（ModuleLoader 壳由 tsdown banner/footer 提供）。

import * as react from 'react'
import { createSnapshotStore, type SnapshotStore } from './snapshot-store.js'
import { NS, CHANNEL, DEFAULT_CONFIG, type InputAssistConfig } from './config.js'
import { scanLocalTypos, scanWithDict, mergeDicts, BUILTIN_DICT, parseDictText, type TypoIssue } from './proofread-dict.js'
import { loadUserDictText, saveUserDictText, type DictStorage } from './user-dict.js'
import { mergeIssues } from './proofread-llm.js'
import {
	SETTINGS_FIELDS,
	stageValue,
	unstageValue,
	isFieldStaged,
	fieldText,
	fieldChecked,
	parseStagedPatch,
	checkUserDictPairs,
	parseUserDictPairs,
	serializeUserDictPairs,
	importUserDictText,
	mergeUserDictPairs,
	exportUserDictText,
	USER_DICT_MAX_ENTRIES,
	USER_DICT_MAX_WORD_LEN,
	type StagedEdits,
	type UserDictPair,
	type UserDictPairIssueCode,
} from './settings-form.js'
import { moveItem, snapshotRows, applyFlip, startRowDrag } from './flip-list.js'

// 测试出口：bundle 内的词典扫描与设置表单行为守卫（test/*.test.js 经
// ModuleLoader 壳取回），宿主运行时只消费 apply/inject，不受影响。
export { scanLocalTypos }
export { scanWithDict, mergeDicts, BUILTIN_DICT, parseDictText }
export { loadUserDictText, saveUserDictText }
export { scanWithUserDict }
export { SETTINGS_FIELDS, stageValue, unstageValue, isFieldStaged, fieldText, fieldChecked, parseStagedPatch }
export { checkUserDictPairs, parseUserDictPairs, serializeUserDictPairs, importUserDictText, mergeUserDictPairs, exportUserDictText, USER_DICT_MAX_ENTRIES, USER_DICT_MAX_WORD_LEN }
export { parseStreamFrames }

export const inject = ['slots', 'locale', 'connection', 'remote']

// ———— 宿主服务与插槽 props 的结构类型（窄化自宿主运行时，仅声明本插件用到的面）————

interface RpcErrorBody {
	code: string
	message: string
	details?: unknown
}
type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcErrorBody }

interface CompleteResult {
	text?: string
	reason?: string
}
interface ProofreadResult {
	issues?: TypoIssue[]
}
interface ModelsResult {
	models?: string[]
	reason?: string
	message?: string
}

interface ConnectionService {
	rpc: {
		call<T = unknown>(channel: string, endpoint: string, payload: unknown): Promise<RpcResult<T> | undefined>
	}
}

interface InjectedPayload {
	hooks?: Record<string, unknown>
	api?: object
}
interface SlotRegistration {
	name: string
	/** list 插座用 id 排序导航；keyed 插座（settings.plugin.item）用 key 且无序。 */
	id?: string
	key?: string
	order?: number
	locale: string
	inject?: () => InjectedPayload
}
interface SlotsService {
	inject(slot: string, register: () => unknown): void
	register(meta: SlotRegistration, component: react.ComponentType<any>): unknown
}
interface LocaleService {
	register(ns: string, dicts: Record<string, Record<string, string>>): void | (() => void)
}
interface RemoteService {
	$on(event: string, cb: (ns: string) => void): void | (() => void)
}
interface PluginContext {
	get(name: string): unknown
	effect(fn: () => void | (() => void), name: string): void
}

// ———— store 状态形状 ————

interface InputState {
	draft: string
	draftRev: number
}
type UseStore<T> = <R>(selector: (state: T) => R) => R
interface InputActions {
	setDraft(text: string): void
}
type Translate = (key: string) => string

interface IgnoredIssue {
	offset: number
	orig: string
}

interface AssistState {
	suggestion: string
	sugRev: number
	sugDraft: string
	sugCaret: number
	fetching: boolean
	dictIssues: TypoIssue[]
	llmIssues: TypoIssue[]
	issueRev: number
	issueIndex: number
	ignored: IgnoredIssue[]
	checking: boolean
	error: string
	errorRev: number
	dismissedRev: number
}

interface TypoApi {
	navMove(delta: number): void
	navFixCurrent(): void
	navMarkCorrect(): void
	dismissIssues(): void
}
type ToggleKey = 'completionEnabled' | 'proofreadEnabled'
interface ToggleApi {
	toggle(key: ToggleKey): void
}

interface SlotProps {
	useInput?: UseStore<InputState>
	inputActions?: InputActions
	useAssist?: UseStore<AssistState>
	useConfig?: UseStore<InputAssistConfig>
	t: Translate
	api?: TypoApi & ToggleApi
}

declare global {
	interface Window {
		__iaDebug?: Record<string, unknown>
		__iaApi?: TypoApi
	}
}

const identity = <T,>(v: T): T => v
const isObj = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === 'object' && !Array.isArray(v)
const escHtml = (s: unknown): string =>
	String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Tab 逐词采纳：每次只吞建议的下一个分词单位（NovAI 同款逻辑）。
// 纯空白段随下一个实质段一起吞（保英文词间空格）；首个实质段是标点
// 时与下一个词合并（避免标点单独占一次 Tab）。Intl.Segmenter 缺失时
// 降级按单个字符。
const zhSegmenter: Intl.Segmenter | null =
	typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
		? new Intl.Segmenter('zh', { granularity: 'word' })
		: null
const nextSegment = (text: string): string => {
	if (text === '') return ''
	if (zhSegmenter === null) return text.slice(0, 1)
	const segs = [...zhSegmenter.segment(text)]
	if (segs.length === 0) return ''
	let end = segs[0].segment.length
	let i = 0
	while (i < segs.length && segs[i].isWordLike === false && segs[i].segment.trim() === '') {
		i += 1 // 跳过开头空白，连同下一个实质段一起吞
	}
	if (i > 0 && i < segs.length) end = segs[i].index + segs[i].segment.length
	else if (i === 0 && segs[0].isWordLike === false && segs.length > 1) {
		end = segs[1].index + segs[1].segment.length // 标点并入下一词
	}
	return text.slice(0, end)
}

const CSS = [
	'.ia_bar{display:flex;align-items:center;gap:8px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;max-width:100%}',
	'.ia_err{color:var(--dsw-alias-label-tertiary)}',
	// —— 错别字导航条 ——
	'.ia_nav{position:relative;z-index:30;pointer-events:auto;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:5px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:20px}',
	'.ia_navTitle{display:flex;align-items:center;gap:5px;color:var(--dsw-alias-label-primary);font-weight:500;white-space:nowrap}',
	'.ia_navDot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-accent-danger,#e5484d)}',
	'.ia_navPos{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}',
	'.ia_navDetail{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;white-space:nowrap}',
	'.ia_navOrig{color:var(--dsw-alias-accent-danger,#e5484d);text-decoration:line-through}',
	'.ia_navArrow{color:var(--dsw-alias-label-tertiary)}',
	'.ia_navFixWord{color:var(--dsw-alias-label-primary);font-weight:500}',
	'.ia_navReason{color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis}',
	'.ia_spacer{flex:1}',
	'.ia_btn{cursor:pointer;pointer-events:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;padding:1px 8px;white-space:nowrap}',
	'.ia_btn:hover{background:var(--dsw-interactive-bg-hover)}',
	'.ia_btnPrimary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
	'.ia_btnIcon{cursor:pointer;pointer-events:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;padding:1px 7px;white-space:nowrap}',
	'.ia_btnIcon:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-interactive-bg-hover)}',
	'.ia_btnGhost{cursor:pointer;pointer-events:auto;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;padding:1px 6px;white-space:nowrap}',
	'.ia_btnGhost:hover{color:var(--dsw-alias-label-primary)}',
	// —— 补/校开关：无边框幽灵样式；选中=蓝色圆底白字（#679EFE 实测与发送
	// 按钮同色；--dsw-alias-brand-primary 在深色主题是近白色，不能用），
	// 悬停=文字变白+浅灰底，两态刻意不同避免混淆 ——
	'.ia_toggles{display:flex;align-items:center;gap:2px}',
	'.ia_toggle{cursor:pointer;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;padding:2px 8px;opacity:.65;transition:color .15s,background-color .15s,opacity .15s}',
	'.ia_toggle:hover{color:#fff;opacity:1;background:var(--dsw-interactive-bg-hover)}',
	'.ia_toggle.ia_on{color:#fff;opacity:1;background:#679efe}',
	'.ia_toggle.ia_on:hover{background:#679efe;filter:brightness(.92)}',
	// —— ghost 快捷键提示（dock 槽位，输入框外、纯文字无边框）——
	// dock 容器是 flex 布局，flex:none + 固定行高防止行高被压扁
	'.ia_ghosthint{flex:none;align-self:center;min-height:18px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px;padding:0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
	// —— 文中红字镜像层 ——
	'.ia_mirror{position:fixed;pointer-events:none;overflow:hidden;white-space:pre-wrap;word-break:break-word;color:transparent;z-index:5;margin:0;border:0}',
	'.ia_typo{color:var(--dsw-alias-accent-danger,#e5484d);text-decoration:underline wavy var(--dsw-alias-accent-danger,#e5484d) 1px;text-underline-offset:3px;pointer-events:auto;cursor:pointer;border-radius:2px}',
	'.ia_typoCur{background:color-mix(in srgb,var(--dsw-alias-accent-danger,#e5484d) 18%,transparent)}',
	// —— ghost text（内联补全，NovAI 风格）——
	'.ia_ghost{color:var(--dsw-alias-label-tertiary)}',
	// —— 设置页卡片（Settings → Plugins → 插件配置；与官方卡片同列表，
	// 尺寸/字号/圆角/箭头全部对齐官方 PluginCard 的编译后 CSS，观感一致）——
	'.ia_scard{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);list-style:none;transition:border-color .16s,background .16s}',
	'.ia_scard:hover{border-color:var(--dsw-alias-label-dimmed)}',
	'.ia_scard.ia_open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}',
	'.ia_scardHead{appearance:none;display:flex;align-items:center;gap:12px;width:100%;box-sizing:border-box;padding:14px 16px;border:0;border-radius:12px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
	'.ia_scardHead:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
	'.ia_scardText{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}',
	'.ia_scardName{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}',
	'.ia_scardDesc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
	'.ia_scardPending{flex:none;white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}',
	'.ia_scardChev{flex:none;display:flex;color:var(--dsw-alias-label-tertiary);transition:transform .16s}',
	'.ia_scardChev.ia_open{transform:rotate(180deg)}',
	'.ia_scardBody{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:12px 0 8px;display:flex;flex-direction:column;gap:12px}',
	'.ia_sgroup{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;line-height:1.5}',
	'.ia_srows{display:flex;flex-direction:column;gap:12px}',
	'.ia_srow{display:flex;align-items:center;gap:10px}',
	'.ia_srowText{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}',
	'.ia_srowLabel{display:flex;align-items:center;gap:5px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}',
	'.ia_srowHint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}',
	'.ia_sdot{width:6px;height:6px;border-radius:50%;background:#679efe;flex:none}',
	'.ia_sInput{width:200px;max-width:42%;flex:none;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5;padding:5px 10px}',
	'.ia_sInput:focus{outline:none;border-color:#679efe}',
	'.ia_sInput.ia_sNum{width:96px;text-align:right;font-variant-numeric:tabular-nums}',
	'.ia_sInput.ia_bad,.ia_sInput.ia_bad:focus{border-color:var(--dsw-alias-accent-danger,#e5484d)}',
	'.ia_sbad{flex:none;color:var(--dsw-alias-accent-danger,#e5484d);font-size:11px;line-height:1.5}',
	'.ia_sSwitch{position:relative;flex:none;width:34px;height:20px;padding:0;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-module-platform);transition:background-color .15s,border-color .15s}',
	'.ia_sSwitch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:left .15s,background-color .15s}',
	'.ia_sSwitch[aria-checked="true"]{background:#679efe;border-color:#679efe}',
	'.ia_sSwitch[aria-checked="true"]::after{left:16px;background:#fff}',
	'.ia_sReset{cursor:pointer;flex:none;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;line-height:1.5;padding:0 4px}',
	'.ia_sReset:hover{color:var(--dsw-alias-label-primary)}',
	// —— 模型组合框：输入框 + 同款方块下拉按钮 + 自定义面板 ——
	'.ia_scombo{position:relative;flex:none;display:flex;gap:6px}',
	'.ia_scombo .ia_sInput{width:172px;max-width:none}',
	'.ia_sToggleBtn{flex:none;width:34px;height:32px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);cursor:pointer;transition:border-color .15s,color .15s}',
	'.ia_sToggleBtn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
	'.ia_sToggleBtn:disabled{opacity:.4;cursor:default}',
	'.ia_sToggleBtn .ia_scardChev{display:flex;transition:transform .16s}',
	'.ia_sToggleBtn .ia_scardChev.ia_open{transform:rotate(180deg)}',
	'.ia_sMenu{position:absolute;top:calc(100% + 4px);right:0;z-index:40;width:252px;max-height:248px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-3);box-shadow:0 8px 24px rgba(0,0,0,.25);padding:4px}',
	'.ia_sMenuHead{display:flex;align-items:center;padding:4px 8px 6px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}',
	'.ia_sMenuEmpty{padding:10px 8px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}',
	'.ia_sOpt{display:flex;width:100%;box-sizing:border-box;align-items:center;justify-content:space-between;gap:8px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:13px;line-height:1.5;padding:6px 8px;text-align:left}',
	'.ia_sOpt:hover{background:var(--dsw-interactive-bg-hover)}',
	'.ia_sOpt.ia_sel{color:#679efe}',
	'.ia_sOptCheck{flex:none;display:flex}',
	'.ia_smodelsNote{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}',
	// —— 自定义词库区块（仅本浏览器）：成对词条列表 + 拖拽排序 ——
	'.ia_suserdict{gap:8px}',
	'.ia_sgroupRow{display:flex;align-items:baseline;justify-content:space-between;gap:8px}',
	'.ia_udMeta{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400;line-height:1.5;white-space:nowrap}',
	'.ia_udHead{display:flex;align-items:center;flex-wrap:wrap;gap:8px;white-space:nowrap}',
	'.ia_udTools{display:flex;gap:6px}',
	'.ia_udTool{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;line-height:1.5;padding:2px 8px;box-sizing:border-box;transition:color .15s,border-color .15s}',
	'.ia_udTool:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
	'.ia_udTool:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}',
	'.ia_udFile{display:none}',
	'.ia_udNote{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.6}',
	'.ia_udList{display:flex;flex-direction:column;gap:8px}',
	'.ia_udRow{display:flex;align-items:center;flex-wrap:wrap;gap:8px;transition:transform .18s cubic-bezier(.2,.8,.2,1),opacity .14s}',
	'.ia_udRow.ia_udDrag{transition:none;position:relative;z-index:20;background:var(--dsw-alias-bg-layer-3);border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.3);pointer-events:none}',
	'.ia_udRow.ia_udOut{opacity:0;transform:translateX(14px);pointer-events:none}',
	'body.ia_udDragging{cursor:grabbing;user-select:none}',
	'.ia_udGrip{flex:none;width:20px;height:26px;display:flex;align-items:center;justify-content:center;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:14px;line-height:1;cursor:grab;touch-action:none;border-radius:4px}',
	'.ia_udGrip:hover{color:var(--dsw-alias-label-primary)}',
	'.ia_udGrip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}',
	'.ia_udIn{flex:1 1 0;min-width:0;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5;padding:5px 10px}',
	'.ia_udIn:focus{outline:none;border-color:#679efe}',
	'.ia_udIn.ia_bad,.ia_udIn.ia_bad:focus{border-color:var(--dsw-alias-accent-danger,#e5484d)}',
	'.ia_udArrow{flex:none;color:var(--dsw-alias-label-tertiary)}',
	'.ia_udDel{flex:none;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-tertiary);font:inherit;font-size:15px;line-height:1;width:32px;height:32px;padding:0;box-sizing:border-box;display:flex;align-items:center;justify-content:center}',
	'.ia_udDel:hover{color:var(--dsw-alias-accent-danger,#e5484d);border-color:var(--dsw-alias-accent-danger,#e5484d)}',
	'.ia_udErr{flex-basis:100%;margin:-3px 0 0 28px;color:var(--dsw-alias-accent-danger,#e5484d);font-size:11px;line-height:1.5}',
	'.ia_udAdd{width:100%;box-sizing:border-box;cursor:pointer;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:1.5;padding:5px 10px;transition:color .15s,border-color .15s}',
	'.ia_udAdd:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
	'.ia_udEmpty{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6;padding:2px 0}',
	'.ia_scardFoot{border-top:1px solid var(--dsw-alias-border-l2);display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 0 4px}',
	'.ia_sfailed{min-width:0;flex:1;margin:0;color:var(--dsw-alias-label-error);font-size:12px;line-height:1.5}',
	'.ia_sDiscard,.ia_sSave{appearance:none;cursor:pointer;font:inherit;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}',
	'.ia_sDiscard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent}',
	'.ia_sDiscard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
	'.ia_sSave{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}',
	'.ia_sDiscard:disabled,.ia_sSave:disabled{opacity:.4;cursor:default}',
	'.ia_sDiscard:focus-visible,.ia_sSave:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
].join('')
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify('dsh-input-assist/ui.css') + ']') === null) {
	const tag = document.createElement('style')
	tag.dataset.plugin = 'dsh-input-assist'
	tag.dataset.pluginCss = 'dsh-input-assist/ui.css'
	tag.textContent = CSS
	document.head.appendChild(tag)
}

// —— 状态与 RPC（apply 内创建，组件经 hooks 注入共享）——
let assistStore!: SnapshotStore<AssistState>
let configStore!: SnapshotStore<InputAssistConfig>
let connectionRef: ConnectionService | null = null
let inputActionsRef: InputActions | null = null
let mirrorEl: HTMLDivElement | null = null

const setAssist = (patch: Partial<AssistState>): void => {
	assistStore.set({ ...assistStore.getSnapshot(), ...patch })
}

// RPC 双路（dsh 0.1.5 迁移）：优先打 host 侧 connection.fetch 精确路由
// （/api/input-assist/rpc，body {endpoint,payload} → RpcResult JSON）；404
// （老运行时没有该路由）自动回退 cordis rpc.call 原通道，两端运行时都通。
const rpc = async <T = unknown,>(endpoint: string, payload: unknown): Promise<RpcResult<T> | undefined> => {
	try {
		const res = await fetch('/api/input-assist/rpc', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ endpoint, payload }),
		})
		if (res.ok) return (await res.json()) as RpcResult<T>
		if (res.status !== 404) return undefined
	} catch (_err) {
		/* 网络层失败 → 回退 rpc.call 再试一次 */
	}
	return connectionRef!.rpc.call<T>(CHANNEL, endpoint, payload)
}

const loadConfig = async (): Promise<void> => {
	try {
		const res = await rpc<Partial<InputAssistConfig>>('config.get', {})
		if (res !== undefined && res.ok === true && isObj(res.value)) {
			configStore.set({ ...configStore.getSnapshot(), ...res.value })
		}
	} catch (_err) {
		/* 宿主未就绪时保持默认 */
	}
}

// 乐观更新后写宿主；成功返回 true。失败时回读宿主真值撤销乐观值
// （开关按钮与设置卡片共用此路，卡片的“保存失败”提示据此显示）。
const persistConfig = async (patch: Partial<InputAssistConfig>): Promise<boolean> => {
	configStore.set({ ...configStore.getSnapshot(), ...patch })
	try {
		const res = await rpc<Partial<InputAssistConfig>>('config.set', patch)
		if (res !== undefined && res.ok === true && isObj(res.value)) {
			configStore.set({ ...configStore.getSnapshot(), ...res.value })
			return true
		}
	} catch (_err) {
		/* 网络层失败走下面的回读 */
	}
	await loadConfig()
	return false
}

const debug = (patch: Record<string, unknown>): void => {
	try {
		window.__iaDebug = { ...(window.__iaDebug ?? {}), ...patch }
	} catch (_err) {
		/* 无 window 环境 */
	}
}

// —— 调度：三路独立防抖，结果带 rev 戳防陈旧 ——
//   dict 层本地扫描（proofreadDictDebounceMs，默认 200ms，零成本即时标红）
//   completion / LLM 校对统一 800ms，两个 AI 请求几乎同时发出同时回来
//   重调度 / Esc / 关开关时对在途 AI 请求发 cancel：序号守卫只管过期结果
//   不显示，cancel 才真正断开连接（否则服务端照常生成、照常计费）
let completionTimer: ReturnType<typeof setTimeout> | undefined
let dictTimer: ReturnType<typeof setTimeout> | undefined
let llmTimer: ReturnType<typeof setTimeout> | undefined
let completionSeq = 0
let dictSeq = 0
let llmSeq = 0

// —— 在途取消（v0.5）——
// 每次出站 complete/proofread 带上 requestId，host 侧登记 AbortController；
// 结果不再需要时发 cancel 端点断开。多标签页共用同一 host 实例，
// requestId 带随机段保证跨标签页不撞号（自增序号仅便于日志辨认）。
let requestSeq = 0
let completionReqId = ''
let llmReqId = ''
// 补全本轮是否在排队（防抖定时器待发）：Esc/关开关要连排队轮一起作废，
// 只取消已发出的请求会漏掉防抖窗口——请求随后照发，ghost 仍会迟到上屏。
let completionTimerPending = false

// —— 流式渐进渲染（v0.6）——
// 浏览器直连 host 的 /api/input-assist/stream（connection.fetch 流式路由），
// SSE 帧驱动 ghost 渐显。streamRouteDown：host 是不带该路由的旧版本
// （fetch 回 404），此后本轮会话直接走 RPC 非流式（重载页面重新探测）。
let completionStreamCtrl: AbortController | null = null
let streamRouteDown = false
// 当前流内簿记：累积文本 streamAccumulated 与已被 Tab 采纳的字符数
// streamAccepted——流中按 Tab 后剩余建议 = accumulated.slice(accepted)，
// 在途 delta 持续追加到末尾（NovAI 同款语义：采纳不掐流）
let streamAccumulated = ''
let streamAccepted = 0

const nextRequestId = (kind: 'c' | 'l'): string => {
	requestSeq += 1
	const rand =
		typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
			? crypto.randomUUID()
			: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
	return `${kind}${requestSeq}-${rand}`
}

// 尽力而为：host 是不带 cancel 的旧版本、或网络瞬断，都静默放过
const cancelRpc = (requestId: string): void => {
	if (requestId === '' || connectionRef === null) return
	void rpc('cancel', { requestId }).catch(() => {})
}

/** 本轮补全是否仍可能产出建议（排队或请求在途）。 */
const completionRoundActive = (): boolean => completionTimerPending || completionReqId !== ''

/** 彻底作废本轮补全：清排队定时器、断在途请求（RPC 与流式两路）、作废迟到响应。 */
const abortCompletionRound = (): void => {
	clearTimeout(completionTimer)
	completionTimerPending = false
	completionSeq += 1
	if (completionReqId !== '') {
		cancelRpc(completionReqId)
		completionReqId = ''
	}
	if (completionStreamCtrl !== null) {
		completionStreamCtrl.abort()
		completionStreamCtrl = null
	}
	setAssist({ suggestion: '', fetching: false, sugRev: -1 })
}

// 最近一次草稿（rescanDict 用：用户词库保存后按新词库立即重扫，不等防抖）
let lastDraft = ''
let lastDraftRev = -1

// —— 用户词库（浏览器 localStorage，仅本机） ——
// 每轮防抖现读现解析：千行级文本解析 <1ms，不值得做缓存（慢了再加 memo）。
const dictStorage = (): DictStorage | undefined => {
	try {
		return typeof localStorage !== 'undefined' ? localStorage : undefined
	} catch {
		return undefined
	}
}

/** 内置 + 用户词库合并扫描（亦为 bundle 测试出口：端到端验证合并语义）。 */
const scanWithUserDict = (text: string, userDictText: string): TypoIssue[] =>
	scanWithDict(text, mergeDicts(BUILTIN_DICT, parseDictText(userDictText).phrases))

/** 用户词库保存后立即重扫当前草稿；复位会话级忽略（dismiss），保留逐条“标记正确”。 */
const rescanDict = (): void => {
	dictSeq += 1 // 使在途防抖结果作废
	setAssist({
		dictIssues: scanWithUserDict(lastDraft, loadUserDictText(dictStorage())),
		issueRev: lastDraftRev,
		issueIndex: 0,
		dismissedRev: -1,
	})
}

// —— 输入框定位（双运行时）——
// dsh 0.1.5+：composer 是 Lexical contenteditable（data-composer-card 卡片
// 内 role=textbox 的 [data-composer-input] div，@ 引用渲染为 chip 节点）；
// ≤0.1.1-rc.2：普通 textarea。文本真值一律以 input store 的 draft 为准
// （Lexical DOM 的 textContent 与 chip 序列化对不齐），DOM 只负责元素
// 定位与光标偏移。
type ComposerEl = HTMLTextAreaElement | HTMLDivElement

const BLOCK_TAGS = ['P', 'DIV', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'PRE']
const isBlockElement = (node: Node): boolean =>
	node.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.includes((node as Element).tagName)

const findComposer = (): ComposerEl | null => {
	const div = document.querySelector<HTMLDivElement>('[data-composer-card] [data-composer-input][contenteditable="true"]')
	if (div !== null) return div
	const ta = document.querySelector('[data-composer-card] textarea')
	return ta instanceof HTMLTextAreaElement ? ta : null
}

const composerCaret = (): number | null => {
	const el = findComposer()
	if (el === null) return null
	if (el instanceof HTMLTextAreaElement) return typeof el.selectionStart === 'number' ? el.selectionStart : null
	// contenteditable：anchor 所在块之前的文本长度 + 块间换行数 + 块内偏移，
	// 与 draft 的 \n 分行约定对齐（chip 内文本按显示文本近似；偏移超界时
	// 由调用方回退 draft.length）
	const sel = window.getSelection()
	if (sel === null || sel.rangeCount === 0 || sel.anchorNode === null || !el.contains(sel.anchorNode)) return null
	const anchorNode = sel.anchorNode
	const anchorOffset = sel.anchorOffset
	const blocks = Array.from(el.children).filter((n) => isBlockElement(n)) as HTMLElement[]
	const roots: HTMLElement[] = blocks.length > 0 ? blocks : [el]
	let base = 0
	for (const block of roots) {
		let inner: number | null = null
		let acc = 0
		const walk = (node: Node): void => {
			if (inner !== null) return
			if (node === anchorNode) {
				const len = node.nodeType === Node.TEXT_NODE ? (node.textContent?.length ?? 0) : node.childNodes.length
				inner = Math.min(anchorOffset, len)
				return
			}
			if (node.nodeType === Node.TEXT_NODE) acc += node.textContent?.length ?? 0
			else Array.from(node.childNodes).forEach(walk)
		}
		walk(block)
		if (inner !== null) return base + inner // 走查长度天然 ≤ DOM 文本长度，无需外部钳制
		base += acc + 1 // 块内文本长度 + 块间换行
	}
	return null // anchor 不在任何块内（如 root 自身）：调用方回退末尾
}

/** 光标所在行以 / 或 @ 开头（斜杠菜单、@ 引用）时不触发补全。 */
const lineStartsWithTrigger = (draft: string, caret: number): boolean => {
	const before = draft.slice(0, caret)
	const line = before.slice(before.lastIndexOf('\n') + 1).trimStart()
	return line.startsWith('/') || line.startsWith('@')
}

// —— 错别字导航：有效检出 = 位置仍对得上当前草稿 且 未被标记正确 ——
const effectiveIssues = (): TypoIssue[] => {
	const a = assistStore.getSnapshot()
	const merged = mergeIssues(a.dictIssues, a.llmIssues)
	if (merged.length === 0) return []
	const text = lastDraft
	if (text === '') return []
	const ignored = Array.isArray(a.ignored) ? a.ignored : []
	return merged.filter(
		(it) =>
			text.slice(it.offset, it.offset + it.orig.length) === it.orig &&
			!ignored.some((g) => g.offset === it.offset && g.orig === it.orig),
	)
}

const navActive = (): boolean => {
	const a = assistStore.getSnapshot()
	return configStore.getSnapshot().proofreadEnabled && a.dismissedRev !== a.issueRev && effectiveIssues().length > 0
}

const navMove = (delta: number): void => {
	const eff = effectiveIssues()
	if (eff.length === 0) return
	const a = assistStore.getSnapshot()
	const cur = typeof a.issueIndex === 'number' ? a.issueIndex : 0
	setAssist({ issueIndex: (cur + delta + eff.length) % eff.length })
}

const navFixCurrent = (): void => {
	const eff = effectiveIssues()
	if (eff.length === 0) return
	const a = assistStore.getSnapshot()
	const issue = eff[Math.min(typeof a.issueIndex === 'number' ? a.issueIndex : 0, eff.length - 1)]
	const text = lastDraft
	if (text.slice(issue.offset, issue.offset + issue.orig.length) !== issue.orig) return // 位置已失效
	if (inputActionsRef !== null && typeof inputActionsRef.setDraft === 'function') {
		inputActionsRef.setDraft(text.slice(0, issue.offset) + issue.fix + text.slice(issue.offset + issue.orig.length))
	} else {
		// 旧运行时无 setDraft 时的 execCommand 兜底只对 textarea 成立；
		// contenteditable 依赖 Lexical 选中态，该路径不可靠，直接跳过
		const ta = findComposer()
		if (!(ta instanceof HTMLTextAreaElement)) return
		ta.focus()
		ta.setSelectionRange(issue.offset, issue.offset + issue.orig.length)
		try {
			document.execCommand('insertText', false, issue.fix)
		} catch (_err) {
			/* 静默 */
		}
	}
	setAssist({ issueIndex: 0 })
}

const navMarkCorrect = (): void => {
	const eff = effectiveIssues()
	if (eff.length === 0) return
	const a = assistStore.getSnapshot()
	const issue = eff[Math.min(typeof a.issueIndex === 'number' ? a.issueIndex : 0, eff.length - 1)]
	setAssist({
		ignored: [...(Array.isArray(a.ignored) ? a.ignored : []), { offset: issue.offset, orig: issue.orig }],
		issueIndex: 0,
	})
}

// —— 文中红字镜像层 ——
const mirrorStyleProps = [
	'fontFamily',
	'fontSize',
	'fontWeight',
	'fontStyle',
	'letterSpacing',
	'lineHeight',
	'textRendering',
	'textTransform',
	'tabSize',
	'paddingTop',
	'paddingRight',
	'paddingBottom',
	'paddingLeft',
	'overflowWrap',
	'wordBreak',
] as const

const copyMirrorMetrics = (ta: HTMLElement, el: HTMLDivElement): void => {
	const cs = getComputedStyle(ta)
	for (const prop of mirrorStyleProps) el.style[prop] = cs[prop]
	el.style.boxSizing = 'border-box'
	const rect = ta.getBoundingClientRect()
	el.style.left = `${rect.left + ta.clientLeft}px`
	el.style.top = `${rect.top + ta.clientTop}px`
	el.style.width = `${ta.clientWidth}px`
	el.style.height = `${ta.clientHeight}px`
	el.scrollTop = ta.scrollTop
	el.scrollLeft = ta.scrollLeft
}

const ensureMirror = (): HTMLDivElement => {
	if (mirrorEl !== null) return mirrorEl
	mirrorEl = document.createElement('div')
	mirrorEl.className = 'ia_mirror'
	mirrorEl.setAttribute('data-input-assist', 'mirror')
	mirrorEl.addEventListener('click', (e) => {
		const span = e.target instanceof Element ? e.target.closest('.ia_typo') : null
		if (span === null) return
		const off = Number(span.getAttribute('data-ia-off'))
		const eff = effectiveIssues()
		const idx = eff.findIndex((it) => it.offset === off)
		if (idx !== -1) setAssist({ issueIndex: idx })
	})
	document.body.appendChild(mirrorEl)
	return mirrorEl
}

// —— 镜像层：错别字红字 + ghost text 共用 ——
// textarea 自己渲染真实文字（正常色）；镜像层把已输入文字渲染为透明
// span 仅撑布局（错别字处叠红字、末尾叠灰色 ghost 建议），与 NovAI
// 的 GhostTextOverlay 同构：已输入部分 invisible 占位，建议自然落在
// 光标后。ghost 插在文本末尾而非真实光标处——textarea 有建议时用户
// 光标恒在末尾（点击中间会丢建议），且 suffix 场景 v1 不支持。
const ghostVisible = (): boolean => {
	const a = assistStore.getSnapshot()
	const cfg = configStore.getSnapshot()
	// 建议是否仍对应当前草稿：contenteditable 时代以 input store 的 draft
	// 为真值（DOM textContent 与 chip 序列化不对齐，不能作比较基准）
	return cfg.completionEnabled && a.suggestion !== '' && findComposer() !== null && a.sugDraft === lastDraft
}

const syncMirror = (): void => {
	if (typeof document === 'undefined') return
	const ta = findComposer()
	const typos = ta !== null && navActive()
	const ghost = ta !== null && ghostVisible()
	if (!typos && !ghost) {
		if (mirrorEl !== null) mirrorEl.style.display = 'none'
		return
	}
	if (ta === null) return
	const el = ensureMirror()
	el.style.display = 'block'
	copyMirrorMetrics(ta, el)
	const eff = typos ? effectiveIssues() : []
	const a = assistStore.getSnapshot()
	const curIdx = Math.min(typeof a.issueIndex === 'number' ? a.issueIndex : 0, eff.length - 1)
	const text = lastDraft
	let html = ''
	let pos = 0
	for (let i = 0; i < eff.length; i += 1) {
		const it = eff[i]
		if (it.offset > pos) html += escHtml(text.slice(pos, it.offset))
		html += `<span class="ia_typo${i === curIdx ? ' ia_typoCur' : ''}" data-ia-off="${it.offset}">${escHtml(text.slice(it.offset, it.offset + it.orig.length))}</span>`
		pos = it.offset + it.orig.length
	}
	html += escHtml(text.slice(pos))
	if (ghost) html += `<span class="ia_ghost">${escHtml(a.suggestion)}</span>`
	el.innerHTML = html
	el.scrollTop = ta.scrollTop
	el.scrollLeft = ta.scrollLeft
}

// —— dock 槽位行宽对齐 ——
// dock 容器比输入卡片每侧宽约 16px（宿主布局内边距差异），导致导航条
// 两边超出卡片边缘。运行时量卡片矩形，给带 data-ia-dockrow 的行元素
// 补上对应左右外边距；窗口/侧栏尺寸变化时随 onViewportChange 重算。
const syncDockRows = (): void => {
	if (typeof document === 'undefined') return
	const card = document.querySelector('[data-composer-card]')
	const rows = document.querySelectorAll<HTMLElement>('[data-ia-dockrow]')
	if (card === null || rows.length === 0) return
	const cr = card.getBoundingClientRect()
	for (const row of rows) {
		// 宿主插槽可能包了 display:contents 的中间层（矩形宽度为 0），
		// 向上找第一个有真实宽度的祖先作为参照系
		let holder = row.parentElement
		while (holder !== null && holder.getBoundingClientRect().width === 0) {
			holder = holder.parentElement
		}
		if (holder === null) continue
		const hr = holder.getBoundingClientRect()
		const left = Math.max(0, Math.round(cr.left - hr.left))
		const right = Math.max(0, Math.round(hr.right - cr.right))
		row.style.marginLeft = `${left}px`
		row.style.marginRight = `${right}px`
	}
}

// —— 流式消费（v0.6）——
// host 的流式路由帧协议：data:{"delta":"…"} 增量 / data:{"done":"全文"}
// 终态（host 侧已归一化）/ data:{"error":"…"} 失败；流关闭即结束。
const STREAM_ENDPOINT = '/api/input-assist/stream'

interface StreamFrameView {
	/** 完整帧里的 data 载荷（原始字符串，未 JSON.parse）。 */
	payloads: string[]
	/** 不完整尾部（跨网络分片缓冲，拼进下一轮）。 */
	rest: string
}

/** SSE 文本 → 完整帧载荷列表 + 残余。纯函数，亦为 bundle 测试出口。 */
function parseStreamFrames(buffer: string): StreamFrameView {
	const frames = buffer.replace(/\r\n/g, '\n').split('\n\n')
	const rest = frames.pop() ?? ''
	const payloads: string[] = []
	for (const frame of frames) {
		for (const raw of frame.split('\n')) {
			const line = raw.trim()
			if (!line.startsWith('data:')) continue
			const payload = line.slice(5).trim()
			if (payload !== '') payloads.push(payload)
		}
	}
	return { payloads, rest }
}

interface StreamFinishers {
	/** 成功：写入最终建议（含 sugRev/sugDraft 上下文）。 */
	ok: (text: string) => void
	/** 前置失败（no-api-key 等_reason 语义）。 */
	reason: (reason: string) => void
	/** 网络层错误（错误条）。 */
	error: (message: string) => void
}

/**
 * 走 host 流式路由请求一轮补全。返回 false 仅当路由不存在（404，host
 * 是旧版本）——调用方置 streamRouteDown 并降级走 RPC 非流式。取消语义：
 * 本模块任何一处 abort（重调度/Esc/关开关）都会 abort ctrl，此处静默
 * 收场；host 侧同时经 cancel RPC / 连接断开两路掐断上游。
 */
const runCompletionStream = async (
	reqId: string,
	cSeq: number,
	rev: number,
	draft: string,
	caret: number,
	finish: StreamFinishers,
): Promise<boolean> => {
	const ctrl = new AbortController()
	completionStreamCtrl = ctrl
	streamAccumulated = ''
	streamAccepted = 0
	let sawAny = false
	try {
		const res = await fetch(STREAM_ENDPOINT, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				prefix: draft.slice(0, caret),
				suffix: draft.slice(caret),
				requestId: reqId,
			}),
			signal: ctrl.signal,
		})
		if (res.status === 404) {
			streamRouteDown = true
			return false
		}
		if (!res.ok || res.body === null) {
			// 前置失败：host 以 JSON {reason} 回应（no-api-key 等）
			let reason = `completion stream HTTP ${res.status}`
			try {
				const j: unknown = await res.json()
				if (isObj(j) && typeof j.reason === 'string' && j.reason !== '') reason = j.reason
			} catch {
				/* 保持 HTTP 状态文案 */
			}
			if (cSeq === completionSeq) finish.reason(reason)
			return true
		}
		const reader = res.body.getReader()
		const decoder = new TextDecoder('utf-8')
		let buffer = ''
		let doneText: string | null = null
		let errorMessage = ''
		// rAF 合帧渲染：自制 store 没有 Vue 式批处理，每个 delta 直写会
		// 触发一整次镜像层重建；flush 在帧回调里一次性取「当下」的
		// accumulated/accepted 切片（Tab 同步改 accepted，帧回调自然读到新值）
		let flushScheduled = false
		let contextWritten = false
		const flush = (): void => {
			flushScheduled = false
			if (cSeq !== completionSeq) return
			const text = streamAccumulated.slice(streamAccepted)
			if (text === '') return
			if (!contextWritten) {
				contextWritten = true
				setAssist({ suggestion: text, sugRev: rev, sugDraft: draft, sugCaret: caret, fetching: true })
			} else {
				setAssist({ suggestion: text, fetching: true })
			}
		}
		const scheduleFlush = (): void => {
			if (flushScheduled) return
			flushScheduled = true
			const run = (): void => {
				flushScheduled = false
				flush()
			}
			if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
			else setTimeout(run, 16)
		}
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			const parsed = parseStreamFrames(buffer + decoder.decode(value, { stream: true }))
			buffer = parsed.rest
			for (const payload of parsed.payloads) {
				let frame: unknown
				try {
					frame = JSON.parse(payload)
				} catch {
					continue
				}
				if (!isObj(frame)) continue
				if (typeof frame.delta === 'string' && frame.delta !== '') {
					sawAny = true
					streamAccumulated += frame.delta
					if (cSeq === completionSeq) scheduleFlush()
				} else if (typeof frame.done === 'string') {
					doneText = frame.done
				} else if (typeof frame.error === 'string' && frame.error !== '') {
					errorMessage = frame.error
				}
			}
			if (doneText !== null || errorMessage !== '') break
		}
		if (cSeq !== completionSeq) return true
		if (errorMessage !== '' && !sawAny && streamAccepted === 0) {
			// 空手失败走错误条（与 RPC 失败同路）
			finish.error(errorMessage)
			return true
		}
		if (streamAccepted === 0 && doneText !== null) {
			finish.ok(doneText)
		} else {
			// Tab 采纳过 / 流中断无 done / 出错但有部分内容：本地切片收尾，
			// 保留 Tab 写入的 sugDraft/sugRev 上下文（不回写请求时的旧值）
			const source = doneText ?? streamAccumulated
			const remainder = source.slice(streamAccepted).replace(/\s+$/, '')
			if (remainder === '') setAssist({ suggestion: '', fetching: false, sugRev: -1 })
			else setAssist({ suggestion: remainder, fetching: false })
		}
		return true
	} catch (err) {
		if (ctrl.signal.aborted) return true // 自己断的（重调度/Esc/关开关）：静默
		if (cSeq === completionSeq) finish.error(err instanceof Error ? err.message : String(err))
		return true
	} finally {
		if (completionStreamCtrl === ctrl) completionStreamCtrl = null
	}
}

function onDraftChanged(draft: string, rev: number): void {
	const cfg = configStore.getSnapshot()
	const caret = composerCaret() ?? draft.length
	lastDraft = draft
	lastDraftRev = rev
	const completionActive =
		cfg.completionEnabled && draft.trim().length >= 2 && !lineStartsWithTrigger(draft, caret)
	debug({ onDraftChanged: true, draftLen: draft.length, rev, completionActive })

	// 逐词采纳部分接受时：草稿变化源于我们自己，保留剩余建议且不重调度
	// （避免 ghost 闪烁）；建议已吃光时正常调度，立刻续出下一段（NovAI 同款）
	const justAccepted =
		assistStore.getSnapshot().suggestion !== '' && assistStore.getSnapshot().sugDraft === draft

	clearTimeout(completionTimer)
	completionTimerPending = false
	if (!justAccepted) {
		cancelRpc(completionReqId)
		completionReqId = ''
		if (completionStreamCtrl !== null) {
			completionStreamCtrl.abort()
			completionStreamCtrl = null
		}
		completionSeq += 1
	}
	// justAccepted 时本轮继续：流式在途请求不断（剩余建议靠在途 delta 追加，
	// NovAI 同款语义），也不作废序号——序号一变流式守卫会整体失效
	const cSeq = completionSeq
	if (!completionActive) {
		setAssist({ suggestion: '', fetching: false, sugRev: -1 })
	} else if (!justAccepted) {
		completionTimer = setTimeout(async () => {
			completionTimerPending = false
			const reqId = nextRequestId('c')
			completionReqId = reqId
			debug({ completionReqId: reqId }) // 调试探针：请求在途窗口可观测（控制台/__iaDebug）
			setAssist({ fetching: true })
			const finishOk = (text: string): void => {
				setAssist({
					suggestion: text,
					sugRev: rev,
					sugDraft: draft,
					sugCaret: caret,
					fetching: false,
					error: '',
					errorRev: -1,
				})
			}
			const finishReason = (reason: string): void => {
				setAssist({ suggestion: '', fetching: false, error: reason, errorRev: rev })
			}
			const finishError = (message: string): void => {
				setAssist({ suggestion: '', fetching: false, error: message, errorRev: rev })
			}
			// —— 流式路径（默认开）：host 旧版本无路由时 fetch 回 404，
			//    runCompletionStream 置 streamRouteDown 并返回 false，本次降级 RPC ——
			if (cfg.completionStream && !streamRouteDown) {
				const handled = await runCompletionStream(reqId, cSeq, rev, draft, caret, {
					ok: finishOk,
					reason: finishReason,
					error: finishError,
				})
				if (handled) {
					if (completionReqId === reqId) completionReqId = ''
					return
				}
			}
			try {
				const res = await rpc<CompleteResult>('complete', {
					prefix: draft.slice(0, caret),
					suffix: draft.slice(caret),
					requestId: reqId,
				})
				debug({ completionRes: res })
				if (cSeq !== completionSeq) return
				if (res !== undefined && res.ok === true) {
					const reason = res.value?.reason ?? ''
					setAssist({
						suggestion: reason === '' && typeof res.value?.text === 'string' ? res.value.text : '',
						sugRev: rev,
						sugDraft: draft,
						sugCaret: caret,
						fetching: false,
						error: reason,
						errorRev: reason === '' ? -1 : rev,
					})
				} else if (res !== undefined && res.ok === false && res.error.code === 'cancelled') {
					// 主动取消（Esc / 关开关 / 取消竞态）：静默，不写状态不弹错误条
				} else {
					finishError(res !== undefined && res.ok === false ? res.error.message : 'completion failed')
				}
			} catch (err) {
				debug({ completionErr: err instanceof Error ? err.message : String(err) })
				if (cSeq === completionSeq) setAssist({ suggestion: '', fetching: false })
			} finally {
				if (completionReqId === reqId) completionReqId = ''
			}
		}, cfg.completionDebounceMs)
		completionTimerPending = true
	}

	// —— 错别字：两层拆分 ——
	//   词典层：浏览器本地扫描，200ms 防抖，即时标红、零成本、不发 RPC
	//   LLM 层：host 侧请求，800ms 防抖（与补全同节奏），结果叠加到词典之上
	const proofActive = cfg.proofreadEnabled && draft.trim().length >= 4
	clearTimeout(dictTimer)
	clearTimeout(llmTimer)
	cancelRpc(llmReqId)
	llmReqId = ''
	dictSeq += 1
	llmSeq += 1
	const dSeq = dictSeq
	const pSeq = llmSeq
	if (!proofActive) {
		setAssist({ dictIssues: [], llmIssues: [], checking: false, issueIndex: 0, ignored: [] })
	} else {
		dictTimer = setTimeout(() => {
			if (dSeq !== dictSeq) return
			setAssist({ dictIssues: scanWithUserDict(draft, loadUserDictText(dictStorage())), issueRev: rev, issueIndex: 0 })
		}, cfg.proofreadDictDebounceMs)
		if (cfg.proofreadUseLlm !== false) {
			llmTimer = setTimeout(async () => {
				const reqId = nextRequestId('l')
				llmReqId = reqId
				setAssist({ checking: true })
				try {
					const res = await rpc<ProofreadResult>('proofread', { text: draft, llmOnly: true, requestId: reqId })
					debug({ proofRes: res })
					if (pSeq !== llmSeq) return
					if (res !== undefined && res.ok === false && res.error.code === 'cancelled') return
					setAssist({
						llmIssues: res !== undefined && res.ok === true && Array.isArray(res.value?.issues) ? res.value.issues : [],
						issueRev: rev,
						checking: false,
					})
				} catch (_err) {
					if (pSeq === llmSeq) setAssist({ checking: false })
				} finally {
					if (llmReqId === reqId) llmReqId = ''
				}
			}, cfg.proofreadDebounceMs)
		} else {
			setAssist({ llmIssues: [] })
		}
	}
}

// —— 组件 ——
// ghost text 模式下建议本体由镜像层渲染（灰色内联在光标后），这里只剩
// 错误提示条（如 no-api-key）；建议可见时输入框零浮层（NovAI 同款）。
function SuggestBar(props: SlotProps): react.ReactElement | null {
	const { useInput, inputActions, useAssist, useConfig, t } = props
	if (typeof useInput !== 'function' || typeof useAssist !== 'function' || typeof useConfig !== 'function') return null
	const draft = useInput((s) => s.draft)
	const rev = useInput((s) => s.draftRev)
	const assist = useAssist(identity)
	const cfg = useConfig(identity)
	if (inputActions !== undefined && inputActions !== null) inputActionsRef = inputActions
	react.useEffect(() => {
		onDraftChanged(draft, rev)
	}, [draft, rev])
	const visible = assist.suggestion !== '' && assist.sugRev === rev
	// 建议可见性变化时同步镜像层（ghost 出现/消失都走这里）；
	// completionEnabled 开关变化也要重同步（关掉时摘掉残留 ghost）
	react.useEffect(() => {
		syncMirror()
	}, [visible, assist.suggestion, draft, cfg.completionEnabled])
	if (!cfg.completionEnabled) return null
	const showError = assist.error !== '' && assist.errorRev === rev
	if (!showError) return null
	const msg = assist.error === 'no-api-key' ? t('error.noApiKey') : String(assist.error).slice(0, 90)
	return react.createElement(
		'div',
		{ className: 'ia_bar', 'data-input-assist': 'suggest' },
		react.createElement('span', { key: 'err', className: 'ia_err' }, 'input-assist: ' + msg),
	)
}

function TypoNav(props: SlotProps): react.ReactElement | null {
	const { useInput, inputActions, useAssist, useConfig, t, api } = props
	if (typeof useAssist !== 'function' || typeof useConfig !== 'function') return null
	const assist = useAssist(identity)
	const cfg = useConfig(identity)
	const draft = typeof useInput === 'function' ? useInput((s) => s.draft) : ''
	if (inputActions !== undefined && inputActions !== null) inputActionsRef = inputActions
	// 以草稿文本为准计算有效检出（词典层+LLM 层合并后，位置失配/已标记正确的剔除）
	const issues = mergeIssues(assist.dictIssues, assist.llmIssues)
	const ignored = Array.isArray(assist.ignored) ? assist.ignored : []
	const eff =
		draft === ''
			? []
			: issues.filter(
					(it) =>
						draft.slice(it.offset, it.offset + it.orig.length) === it.orig &&
						!ignored.some((g) => g.offset === it.offset && g.orig === it.orig),
				)
	const dismissed = assist.dismissedRev === assist.issueRev
	const show = cfg.proofreadEnabled && !dismissed && eff.length > 0
	// 渲染后同步镜像层（草稿/检出/选中项/忽略变化都会走到这里）
	react.useEffect(() => {
		syncMirror()
		syncDockRows()
		return () => {
			if (mirrorEl !== null) mirrorEl.style.display = 'none'
		}
	}, [draft, assist.dictIssues, assist.llmIssues, assist.issueIndex, assist.ignored, dismissed, cfg.proofreadEnabled])
	if (!show) return null
	const curIdx = Math.min(typeof assist.issueIndex === 'number' ? assist.issueIndex : 0, eff.length - 1)
	const cur = eff[curIdx]
	const btn = (key: string, label: string, title: string, className: string, onClick: () => void) =>
		react.createElement('button', { type: 'button', key, className, title, onClick }, label)
	return react.createElement(
		'div',
		{ className: 'ia_nav', 'data-input-assist': 'proofread', 'data-ia-dockrow': '' },
		react.createElement(
			'span',
			{ key: 'title', className: 'ia_navTitle' },
			react.createElement('span', { className: 'ia_navDot' }),
			t('proofread.title'),
		),
		btn('prev', '‹', t('proofread.prevHint'), 'ia_btnIcon', () => api?.navMove?.(-1)),
		react.createElement('span', { key: 'pos', className: 'ia_navPos' }, `${curIdx + 1}/${eff.length}`),
		btn('next', '›', t('proofread.nextHint'), 'ia_btnIcon', () => api?.navMove?.(1)),
		react.createElement(
			'span',
			{ key: 'detail', className: 'ia_navDetail' },
			react.createElement('span', { className: 'ia_navOrig' }, cur.orig),
			react.createElement('span', { className: 'ia_navArrow' }, '→'),
			react.createElement('span', { className: 'ia_navFixWord' }, cur.fix),
			cur.reason ? react.createElement('span', { className: 'ia_navReason' }, cur.reason) : null,
		),
		react.createElement('span', { key: 'spacer', className: 'ia_spacer' }),
		btn('fix', t('proofread.fix'), t('proofread.fixHint'), 'ia_btn ia_btnPrimary', () => api?.navFixCurrent?.()),
		btn('correct', t('proofread.markCorrect'), t('proofread.markCorrectHint'), 'ia_btn', () => api?.navMarkCorrect?.()),
		btn('dismiss', t('proofread.dismiss'), t('proofread.dismissHint'), 'ia_btnGhost', () => api?.dismissIssues?.()),
	)
}

// ghost 可见时的一行纯文字快捷键提示，放在 dock 槽位（输入框外），
// 与错别字导航条同位不同行；输入框内保持完全干净（NovAI 观感）。
function GhostHint(props: SlotProps): react.ReactElement | null {
	const { useInput, useAssist, useConfig, t } = props
	if (typeof useAssist !== 'function' || typeof useInput !== 'function' || typeof useConfig !== 'function') return null
	const assist = useAssist(identity)
	const cfg = useConfig(identity)
	const draft = useInput((s) => s.draft)
	// 与镜像层 ghostVisible 同一判据（按草稿文本而非 rev），保证提示与灰字同显同隐
	const visible = cfg.completionEnabled && assist.suggestion !== '' && assist.sugDraft === draft
	react.useEffect(() => {
		syncDockRows()
	}, [visible])
	if (!visible) return null
	return react.createElement(
		'div',
		{ className: 'ia_ghosthint', 'data-input-assist': 'ghosthint', 'data-ia-dockrow': '' },
		t('suggest.hint'),
	)
}

function ToggleControl({ useConfig, t, api }: SlotProps): react.ReactElement | null {
	if (typeof useConfig !== 'function') return null
	const cfg = useConfig(identity)
	const btn = (key: ToggleKey, label: string, titleKey: string) =>
		react.createElement(
			'button',
			{
				type: 'button',
				key,
				className: cfg[key] ? 'ia_toggle ia_on' : 'ia_toggle',
				title: t(titleKey),
				onClick: () => api?.toggle(key),
			},
			label,
		)
	return react.createElement(
		'div',
		{ className: 'ia_toggles', 'data-input-assist': 'toggle' },
		btn('completionEnabled', '补', 'toggle.completion'),
		btn('proofreadEnabled', '校', 'toggle.proofread'),
	)
}

// —— 自定义词库列表行：id 仅供 React key 与 FLIP 行定位（模块级自增，
// 组件重挂载也不撞号）；纯逻辑（解析/校验/序列化）在 settings-form.ts ——
interface UserDictRow extends UserDictPair {
	id: number
}
let udRowSeq = 0
const nextRowId = (): number => (udRowSeq += 1)
const withRowIds = (pairs: readonly UserDictPair[]): UserDictRow[] => pairs.map((p) => ({ ...p, id: nextRowId() }))

// —— 设置页卡片（v5.1）——
// 暂存编辑（staged）+ 统一保存/放弃，与官方兄弟卡片（Bash/AgentLoop/
// WebSearch）交互同构：折叠卡片头（名称+描述+未保存标记），展开后分组
// 字段行，底部一对放弃/保存（配置与自定义词库共用，各自独立报告失败）；
// 数字与必填文本本地校验，无效字段标红禁存。
interface SettingsCardProps {
	useConfig?: UseStore<InputAssistConfig>
	t: Translate
	api?: {
		save(patch: Partial<InputAssistConfig>): Promise<boolean>
		fetchModels(): Promise<RpcResult<ModelsResult> | undefined>
	}
}

function SettingsCard(props: SettingsCardProps): react.ReactElement | null {
	const { useConfig, t, api } = props
	if (typeof useConfig !== 'function' || api === undefined) return null
	const el = react.createElement
	const cfg = useConfig(identity)
	const [open, setOpen] = react.useState(false)
	const [staged, setStaged] = react.useState<StagedEdits>({})
	const [saving, setSaving] = react.useState(false)
	const [failed, setFailed] = react.useState(false)
	// 模型目录：两个模型字段共享；自定义下拉面板（点 ▾ 打开即拉最新目录，
	// 外点/Esc 关闭；失败退回手填，输入框始终是自由文本）
	const [models, setModels] = react.useState<string[]>([])
	const [modelsState, setModelsState] = react.useState<'idle' | 'fetching' | 'failed'>('idle')
	const [menuFor, setMenuFor] = react.useState<keyof InputAssistConfig | null>(null)
	const parsed = parseStagedPatch(staged)

	// —— 自定义词库（仅本浏览器）：成对词条列表，独立暂存流，目标 localStorage ——
	// userRows 为 null 表示未编辑（展示已存词条）；保存成功即重扫当前草稿
	const [userSavedPairs, setUserSavedPairs] = react.useState<UserDictRow[]>((): UserDictRow[] =>
		withRowIds(parseUserDictPairs(loadUserDictText(dictStorage()))),
	)
	const [userRows, setUserRows] = react.useState<UserDictRow[] | null>(null)
	const [userStoreFailed, setUserStoreFailed] = react.useState(false)
	const [pendingFocus, setPendingFocus] = react.useState<number | null>(null)
	const udListRef = react.useRef<HTMLDivElement | null>(null)
	const rows = userRows ?? userSavedPairs
	const userCheck = checkUserDictPairs(rows)
	// 空行（两侧全空）序列化时被跳过，但编辑器里存在即视为未保存：
	// 否则「放弃修改」会被禁用、空行只能手动删，保存后还会滞留
	const hasEmptyRow = rows.some((r) => r.wrong.trim() === '' && r.right.trim() === '')
	const userDirty =
		userRows !== null && (hasEmptyRow || serializeUserDictPairs(userRows) !== serializeUserDictPairs(userSavedPairs))
	const dirty = Object.keys(staged).length > 0 || userDirty
	const blocked = !dirty || parsed.invalid.length > 0 || !userCheck.ok || saving
	const onSaveUserDict = (): void => {
		if (!userDirty || !userCheck.ok) return
		// 空行不落库，保存后从编辑器一并清除
		const next = (userRows ?? []).filter((r) => r.wrong.trim() !== '' || r.right.trim() !== '')
		if (saveUserDictText(dictStorage(), serializeUserDictPairs(next))) {
			setUserSavedPairs(next)
			setUserRows(null)
			setUserStoreFailed(false)
			rescanDict()
		} else {
			setUserStoreFailed(true)
		}
	}
	const editUserRow = (id: number, patch: Partial<UserDictPair>): void => {
		setUserStoreFailed(false)
		setUserRows((prev) => (prev ?? userSavedPairs).map((r) => (r.id === id ? { ...r, ...patch } : r)))
	}
	const addUserRow = (): void => {
		setUserStoreFailed(false)
		const id = nextRowId()
		setUserRows((prev) => [...(prev ?? userSavedPairs), { id, wrong: '', right: '' }])
		setPendingFocus(id)
	}
	react.useEffect(() => {
		if (pendingFocus === null) return
		setPendingFocus(null)
		const input = udListRef.current?.querySelector<HTMLInputElement>(`[data-flip-id="${pendingFocus}"] input`)
		input?.focus()
	}, [pendingFocus])
	// FLIP 落位：提交前快照视觉位，在 useLayoutEffect（DOM 已更新、绘制前）
	// 应用反向位移再放过渡 —— 时机由 React 保证，不依赖 flushSync/react-dom
	const flipBefore = react.useRef<Map<string, number> | null>(null)
	const commitUserRows = (next: UserDictRow[]): void => {
		const container = udListRef.current
		flipBefore.current = container !== null ? snapshotRows(container) : null
		setUserRows(next)
	}
	react.useLayoutEffect(() => {
		const before = flipBefore.current
		if (before === null) return
		flipBefore.current = null
		const container = udListRef.current
		if (container !== null) applyFlip(container, before)
	}, [rows])
	const removeUserRow = (id: number): void => {
		setUserStoreFailed(false)
		const container = udListRef.current
		const rowEl = container !== null ? container.querySelector<HTMLElement>(`[data-flip-id="${id}"]`) : null
		if (container === null || rowEl === null) {
			setUserRows((prev) => (prev ?? userSavedPairs).filter((r) => r.id !== id))
			return
		}
		if (rowEl.classList.contains('ia_udOut')) return
		rowEl.classList.add('ia_udOut') // 先淡出，再 FLIP 收拢下方各行
		window.setTimeout(() => {
			commitUserRows((userRows ?? userSavedPairs).filter((r) => r.id !== id))
		}, 130)
	}
	// 拖拽/键盘搬运统一走 FLIP 落位（from===to 时也让拖拽行滑回原位）
	const moveUserRow = (from: number, to: number): void => {
		commitUserRows(moveItem(userRows ?? userSavedPairs, from, to))
	}

	// —— 导入/导出/复制（纯浏览器侧）：导出所见列表；导入只进暂存列表，
	// 仍要点保存才落 localStorage —— 与编辑流的校验/失败提示共用 ——

	// 瞬时结果提示（导入/复制成败反馈），数秒后自动消失
	const [udFlash, setUdFlash] = react.useState<string | null>(null)
	const udFlashTimer = react.useRef<number | null>(null)
	const flashUd = (text: string): void => {
		setUdFlash(text)
		if (udFlashTimer.current !== null) window.clearTimeout(udFlashTimer.current)
		udFlashTimer.current = window.setTimeout(() => {
			setUdFlash(null)
			udFlashTimer.current = null
		}, 3000)
	}
	react.useEffect(
		() => () => {
			if (udFlashTimer.current !== null) window.clearTimeout(udFlashTimer.current)
		},
		[],
	)
	const udFileRef = react.useRef<HTMLInputElement | null>(null)
	const exportUserDict = (): void => {
		const blob = new Blob([exportUserDictText(rows)], { type: 'text/plain;charset=utf-8' })
		const url = URL.createObjectURL(blob)
		const a = document.createElement('a')
		a.href = url
		a.download = 'dsh-input-assist-dict.txt'
		a.rel = 'noopener'
		document.body.appendChild(a)
		a.click()
		a.remove()
		window.setTimeout(() => URL.revokeObjectURL(url), 0)
	}
	const copyUserDict = async (): Promise<void> => {
		const entries = rows.filter((r) => r.wrong.trim() !== '' && r.right.trim() !== '').length
		try {
			await navigator.clipboard.writeText(exportUserDictText(rows))
			flashUd(`${t('settings.udCopied')} ${entries} ${t('settings.userDictUnit')}`)
		} catch {
			flashUd(t('settings.udCopyFailed'))
		}
	}
	const onImportPicked = (event: { target: EventTarget & { files: FileList | null; value: string } }): void => {
		const file = event.target.files !== null ? event.target.files[0] ?? null : null
		event.target.value = '' // 允许重复选择同一文件
		if (file === null) return
		void (async () => {
			if (file.size > 1024 * 1024) {
				flashUd(t('settings.udFileTooBig'))
				return
			}
			let text = ''
			try {
				text = await file.text()
			} catch {
				flashUd(t('settings.udImportFailed'))
				return
			}
			const imp = importUserDictText(text)
			const ignored = imp.ignored > 0 ? ` · ${t('settings.udIgnored')} ${imp.ignored} ${t('settings.udLines')}` : ''
			if (imp.pairs.length === 0) {
				flashUd(`${t('settings.udImportEmpty')}${ignored}`)
				return
			}
			const merged = mergeUserDictPairs(rows, imp.pairs)
			commitUserRows(
				merged.rows.map((r) => ({
					id: r.fromCurrent >= 0 ? rows[r.fromCurrent].id : nextRowId(),
					wrong: r.wrong,
					right: r.right,
				})),
			)
			setUserStoreFailed(false)
			flashUd(`${t('settings.udImportDone')}${t('settings.udAdded')} ${merged.added} · ${t('settings.udUpdated')} ${merged.updated}${ignored}`)
		})()
	}

	const fetchModelList = async (): Promise<void> => {
		if (api.fetchModels === undefined) return
		setModelsState('fetching')
		try {
			const res = await api.fetchModels()
			const value = res !== undefined && res.ok === true ? res.value : undefined
			const list = Array.isArray(value?.models) ? value.models.filter((m): m is string => typeof m === 'string') : []
			setModels(list)
			setModelsState(list.length > 0 ? 'idle' : 'failed')
		} catch (_err) {
			setModelsState('failed')
		}
	}
	const toggleMenu = (key: keyof InputAssistConfig): void => {
		setMenuFor((prev) => {
			const next = prev === key ? null : key
			// 每次打开都拉最新目录（旧列表先展示，回来后原地替换）
			if (next !== null) void fetchModelList()
			return next
		})
	}
	// 下拉面板：外点关闭、Esc 关闭（capture 监听只挂在面板打开期间）
	react.useEffect(() => {
		if (menuFor === null) return
		const onDown = (event: MouseEvent): void => {
			const target = event.target
			if (target instanceof Element && target.closest('.ia_scombo') === null) setMenuFor(null)
		}
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === 'Escape') setMenuFor(null)
		}
		document.addEventListener('mousedown', onDown, true)
		document.addEventListener('keydown', onKey, true)
		return () => {
			document.removeEventListener('mousedown', onDown, true)
			document.removeEventListener('keydown', onKey, true)
		}
	}, [menuFor])

	const edit = (key: keyof InputAssistConfig, value: string | boolean): void => {
		setFailed(false)
		setStaged((prev) => stageValue(prev, key, value))
	}
	// 统一保存：配置补丁走宿主 RPC，词库写 localStorage（两路独立报告失败）
	const onSave = async (): Promise<void> => {
		if (blocked) return
		setSaving(true)
		setFailed(false)
		if (Object.keys(staged).length > 0) {
			const ok = await api.save(parsed.patch)
			if (ok) setStaged({})
			else setFailed(true)
		}
		setSaving(false)
		onSaveUserDict()
	}

	const group = (id: 'completion' | 'proofread'): react.ReactElement =>
		el(
			'div',
			{ key: id },
			el('div', { className: 'ia_sgroup' }, t(id === 'completion' ? 'settings.groupCompletion' : 'settings.groupProofread')),
			el(
				'div',
				{ className: 'ia_srows' },
				SETTINGS_FIELDS.filter((f) => f.group === id).map((spec) => {
					const label = t(`settings.f.${spec.key}`)
					// t() 对缺失键回返键名本身：提示文案缺失时干脆不渲染该行
					const hintKey = `settings.h.${spec.key}`
					const hint = t(hintKey)
					const hintShown = hint !== '' && hint !== hintKey ? hint : ''
					const changed = isFieldStaged(spec, staged)
					const labelRow = el(
						'span',
						{ className: 'ia_srowLabel' },
						label,
						changed ? el('span', { key: 'dot', className: 'ia_sdot', title: t('settings.unsaved') }) : null,
					)
					const hintRow = hintShown === '' ? null : el('span', { className: 'ia_srowHint' }, hintShown)
					const resetBtn = changed
						? el('button', {
								type: 'button',
								key: 'reset',
								className: 'ia_sReset',
								title: t('settings.resetHint'),
								'aria-label': `${t('settings.resetHint')}: ${label}`,
								onClick: () => {
									setFailed(false)
									setStaged((prev) => unstageValue(prev, spec.key))
								},
							}, '×')
						: null
					if (spec.kind === 'toggle') {
						const checked = fieldChecked(spec, staged, cfg)
						return el(
							'div',
							{ key: spec.key, className: 'ia_srow' },
							el('div', { className: 'ia_srowText' }, labelRow, hintRow),
							el('button', {
								type: 'button',
								className: 'ia_sSwitch',
								role: 'switch',
								'aria-checked': checked ? 'true' : 'false',
								'aria-label': label,
								onClick: () => {
									edit(spec.key, !checked)
								},
							}),
							resetBtn,
						)
					}
					const bad = changed && parsed.invalid.includes(spec.key)
					const invalidText = t(spec.kind === 'number' ? 'settings.invalidNumber' : 'settings.invalidRequired')
					// 模型字段：输入框 + 同款方块 ▾ 按钮 + 自定义下拉面板
					if (spec.model === true) {
						const curVal = fieldText(spec, staged, cfg)
						const isOpen = menuFor === spec.key
						const options = models.map((m) =>
							el(
								'button',
								{
									type: 'button',
									key: m,
									role: 'option',
									className: `ia_sOpt${m === curVal ? ' ia_sel' : ''}`,
									'aria-selected': m === curVal ? 'true' : 'false',
									onClick: () => {
										edit(spec.key, m)
										setMenuFor(null)
									},
								},
								el('span', null, m),
								m === curVal
									? el('span', { key: 'check', className: 'ia_sOptCheck', 'aria-hidden': 'true' }, '✓')
									: null,
							),
						)
						const menu = el(
							'div',
							{ key: 'menu', className: 'ia_sMenu', role: 'listbox', 'aria-label': t('settings.pickModel') },
							el(
								'div',
								{ className: 'ia_sMenuHead' },
								modelsState === 'fetching' ? t('settings.fetchingModels') : `${models.length} ${t('settings.modelsUnit')}`,
							),
							models.length > 0
								? options
								: el('div', { className: 'ia_sMenuEmpty' }, modelsState === 'failed' ? t('settings.modelsFailed') : t('settings.fetchingModels')),
						)
						return el(
							'div',
							{ key: spec.key, className: 'ia_srow' },
							el('div', { className: 'ia_srowText' }, labelRow, hintRow),
							el(
								'div',
								{ key: 'combo', className: 'ia_scombo' },
								el('input', {
									className: `ia_sInput${bad ? ' ia_bad' : ''}`,
									type: 'text',
									value: curVal,
									'aria-label': label,
									'aria-invalid': bad ? 'true' : undefined,
									'aria-expanded': isOpen ? 'true' : 'false',
									'aria-haspopup': 'listbox',
									autoComplete: 'off',
									spellCheck: false,
									onChange: (event: { target: { value: string } }) => {
										edit(spec.key, event.target.value)
									},
								}),
								el(
									'button',
									{
										type: 'button',
										className: 'ia_sToggleBtn',
										'aria-label': t('settings.pickModel'),
										'aria-expanded': isOpen ? 'true' : 'false',
										'aria-haspopup': 'listbox',
										onClick: () => {
											toggleMenu(spec.key)
										},
									},
									el(
										'span',
										{ className: `ia_scardChev${isOpen ? ' ia_open' : ''}`, 'aria-hidden': 'true' },
										el('svg', {
											width: 14,
											height: 14,
											viewBox: '0 0 14 14',
											fill: 'none',
											xmlns: 'http://www.w3.org/2000/svg',
										}, el('path', {
											d: 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z',
											fill: 'currentColor',
										})),
									),
								),
								isOpen ? menu : null,
							),
							bad ? el('span', { key: 'bad', className: 'ia_sbad' }, invalidText) : null,
							// 模型行不放单行撤销（×）：选错再点一次下拉即可，整体撤销走「放弃修改」
						)
					}
					return el(
						'div',
						{ key: spec.key, className: 'ia_srow' },
						el('div', { className: 'ia_srowText' }, labelRow, hintRow),
						el('input', {
							className: `ia_sInput${spec.kind === 'number' ? ' ia_sNum' : ''}${bad ? ' ia_bad' : ''}`,
							type: spec.password === true ? 'password' : 'text',
							inputMode: spec.kind === 'number' ? 'numeric' : undefined,
							value: fieldText(spec, staged, cfg),
							'aria-label': label,
							'aria-invalid': bad ? 'true' : undefined,
							placeholder: spec.key === 'completionApiKey' ? t('settings.apiKeyPlaceholder') : undefined,
							autoComplete: 'off',
							spellCheck: false,
							onChange: (event: { target: { value: string } }) => {
								edit(spec.key, event.target.value)
							},
						}),
						bad ? el('span', { key: 'bad', className: 'ia_sbad' }, invalidText) : null,
						resetBtn,
					)
					}),
				),
			)

	const issueByRow = new Map(userCheck.issues.map((x) => [x.row, x.code]))
	const udErrText = (code: UserDictPairIssueCode): string => {
		if (code === 'blank') return t('settings.udErr.blank')
		if (code === 'wrongSpace') return t('settings.udErr.wrongSpace')
		if (code === 'rightSpace') return t('settings.udErr.rightSpace')
		if (code === 'dup') return t('settings.udErr.dup')
		return `${t('settings.udErr.tooLong')}（≤ ${USER_DICT_MAX_WORD_LEN}）`
	}
	const renderUserRow = (r: UserDictRow, i: number): react.ReactElement => {
		const code = issueByRow.get(i)
		const wrongBad = code !== undefined && code !== 'rightSpace'
		const rightBad = code === 'rightSpace' || code === 'blank'
		return el(
			'div',
			{ key: r.id, className: 'ia_udRow', 'data-flip-id': String(r.id), role: 'listitem' },
			el(
				'button',
				{
					type: 'button',
					className: 'ia_udGrip',
					title: t('settings.udDragHint'),
					'aria-label': `${t('settings.udDragHint')} ${i + 1}`,
					onPointerDown: (e: {
						button?: number
						pointerId?: number
						clientY: number
						currentTarget: EventTarget & HTMLElement
						preventDefault(): void
					}) => {
						const row = e.currentTarget.closest('[data-flip-id]')
						const container = udListRef.current
						if (row instanceof HTMLElement && container !== null) {
							startRowDrag({ event: e, row, container, onDrop: moveUserRow })
						}
					},
					onKeyDown: (e: { key: string; preventDefault(): void; currentTarget: EventTarget & HTMLElement }) => {
						if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
						e.preventDefault()
						const row = e.currentTarget.closest('[data-flip-id]')
						const container = udListRef.current
						if (!(row instanceof HTMLElement) || container === null) return
						const list = Array.from(container.querySelectorAll<HTMLElement>('[data-flip-id]'))
						const from = list.indexOf(row)
						const to = from + (e.key === 'ArrowDown' ? 1 : -1)
						if (to < 0 || to >= list.length) return
						moveUserRow(from, to)
					},
				},
				'⠿',
			),
			el('input', {
				type: 'text',
				className: `ia_udIn${wrongBad ? ' ia_bad' : ''}`,
				value: r.wrong,
				placeholder: t('settings.udWrongPh'),
				'aria-label': `${t('settings.udWrongPh')} ${i + 1}`,
				autoComplete: 'off',
				spellCheck: false,
				onChange: (event: { target: { value: string } }) => {
					editUserRow(r.id, { wrong: event.target.value })
				},
			}),
			el('span', { key: 'arrow', className: 'ia_udArrow', 'aria-hidden': 'true' }, '→'),
			el('input', {
				type: 'text',
				className: `ia_udIn${rightBad ? ' ia_bad' : ''}`,
				value: r.right,
				placeholder: t('settings.udRightPh'),
				'aria-label': `${t('settings.udRightPh')} ${i + 1}`,
				autoComplete: 'off',
				spellCheck: false,
				onChange: (event: { target: { value: string } }) => {
					editUserRow(r.id, { right: event.target.value })
				},
			}),
			el(
				'button',
				{
					type: 'button',
					className: 'ia_udDel',
					title: t('settings.udDelHint'),
					'aria-label': `${t('settings.udDelHint')} ${i + 1}`,
					onClick: () => removeUserRow(r.id),
				},
				'×',
			),
			code !== undefined ? el('div', { key: 'err', className: 'ia_udErr', role: 'alert' }, udErrText(code)) : null,
		)
	}

	return el(
		'li',
		{ className: `ia_scard${open ? ' ia_open' : ''}`, 'data-input-assist': 'settings-card' },
		el(
			'button',
			{
				type: 'button',
				className: 'ia_scardHead',
				'aria-expanded': open ? 'true' : 'false',
				'aria-label': `${t(open ? 'settings.collapse' : 'settings.expand')}: ${t('settings.title')}`,
				onClick: () => {
					setOpen(!open)
				},
			},
			el(
				'span',
				{ className: 'ia_scardText' },
				el('span', { className: 'ia_scardName' }, t('settings.title')),
				el('span', { className: 'ia_scardDesc' }, t('settings.description')),
			),
			dirty ? el('span', { key: 'pending', className: 'ia_scardPending' }, t('settings.unsaved')) : null,
			// 官方 IconChevronDownOutline14 原版 SVG（用户自官方页面拷贝，fill 填充式）
			el(
				'span',
				{ key: 'chev', className: `ia_scardChev${open ? ' ia_open' : ''}`, 'aria-hidden': 'true' },
				el('svg', {
					width: 14,
					height: 14,
					viewBox: '0 0 14 14',
					fill: 'none',
					xmlns: 'http://www.w3.org/2000/svg',
				}, el('path', {
					d: 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z',
					fill: 'currentColor',
				})),
			),
		),
			open
				? el(
						'div',
						{ className: 'ia_scardBody' },
						group('completion'),
						group('proofread'),
						el(
							'div',
							{ key: 'ud', className: 'ia_srows ia_suserdict' },
							el(
								'div',
								{ className: 'ia_sgroup ia_sgroupRow' },
								el('span', null, t('settings.userDictGroup')),
								el(
									'span',
									{ className: 'ia_udHead' },
									el(
										'span',
										{ className: 'ia_udMeta', 'data-ia-userdict-entries': userCheck.entries },
										`${userCheck.entries} ${t('settings.userDictUnit')}${userDirty ? ` · ${t('settings.unsaved')}` : ''}`,
									),
									el(
										'span',
										{ className: 'ia_udTools' },
										el(
											'button',
											{
												type: 'button',
												className: 'ia_udTool',
												title: t('settings.udImportHint'),
												onClick: () => {
													udFileRef.current?.click()
												},
											},
											t('settings.udImport'),
										),
										el(
											'button',
											{ type: 'button', className: 'ia_udTool', title: t('settings.udExportHint'), onClick: exportUserDict },
											t('settings.udExport'),
										),
										el(
											'button',
											{
												type: 'button',
												className: 'ia_udTool',
												title: t('settings.udCopyHint'),
												onClick: () => {
													void copyUserDict()
												},
											},
											t('settings.udCopy'),
										),
										el('input', {
											key: 'ud-file',
											type: 'file',
											accept: '.txt,text/plain',
											className: 'ia_udFile',
											'aria-hidden': 'true',
											tabIndex: -1,
											ref: (node: HTMLInputElement | null): void => {
												udFileRef.current = node
											},
											onChange: onImportPicked,
										}),
									),
								),
							),
							el('div', { key: 'ud-hint', className: 'ia_srowHint' }, t('settings.userDictHint')),
							udFlash !== null ? el('div', { key: 'ud-note', className: 'ia_udNote', role: 'status' }, udFlash) : null,
							el(
								'div',
								{
									key: 'ud-list',
									className: 'ia_udList',
									role: 'list',
									'aria-label': t('settings.userDictLabel'),
									ref: (node: HTMLDivElement | null): void => {
										udListRef.current = node
									},
								},
								rows.length === 0
									? el('div', { key: 'ud-empty', className: 'ia_udEmpty' }, t('settings.udEmpty'))
									: rows.map((r, i) => renderUserRow(r, i)),
							),
							el(
								'button',
								{ key: 'ud-add', type: 'button', className: 'ia_udAdd', onClick: addUserRow },
								`＋ ${t('settings.udAdd')}`,
							),
							userCheck.overflow
								? el(
										'p',
										{ key: 'ud-overflow', className: 'ia_sfailed', role: 'alert' },
										`${t('settings.udOverflow')}（≤ ${USER_DICT_MAX_ENTRIES}）`,
									)
								: null,
							userStoreFailed
								? el('p', { key: 'ud-storefail', className: 'ia_sfailed', role: 'status' }, t('settings.userDictStoreFailed'))
								: null,
						),
						modelsState === 'failed'
							? el('p', { key: 'modelsNote', className: 'ia_smodelsNote', role: 'status' }, t('settings.modelsFailed'))
							: null,
					el(
						'div',
						{ className: 'ia_scardFoot' },
						failed ? el('p', { key: 'failed', className: 'ia_sfailed', role: 'status' }, t('settings.saveFailed')) : null,
						el(
							'button',
							{
								type: 'button',
								className: 'ia_sDiscard',
								disabled: !dirty || saving,
								onClick: () => {
									setFailed(false)
									setStaged({})
									setUserRows(null)
									setUserStoreFailed(false)
								},
							},
							t('settings.discard'),
						),
						el(
							'button',
							{ type: 'button', className: 'ia_sSave', disabled: blocked, onClick: () => void onSave() },
							t(saving ? 'settings.saving' : 'settings.save'),
						),
					),
				)
			: null,
	)
}

export function apply(ctx: PluginContext): void {
	const slots = ctx.get('slots') as SlotsService | undefined
	const locale = ctx.get('locale') as LocaleService | undefined
	const connection = ctx.get('connection') as ConnectionService | undefined
	const remote = ctx.get('remote') as RemoteService | undefined
	if (slots === undefined || locale === undefined || connection === undefined) return
	connectionRef = connection

	assistStore = createSnapshotStore<AssistState>({
		suggestion: '',
		sugRev: -1,
		sugDraft: '',
		sugCaret: 0,
		fetching: false,
		dictIssues: [],
		llmIssues: [],
		issueRev: -1,
		issueIndex: 0,
		ignored: [],
		checking: false,
		error: '',
		errorRev: -1,
		dismissedRev: -1,
	})
	configStore = createSnapshotStore<InputAssistConfig>({ ...DEFAULT_CONFIG })

	ctx.effect(
		() =>
			locale.register(NS, {
				zh: {
					'toggle.completion': '输入补全开/关（建议出现时：Tab 采纳一词 · Shift+Tab 全量 · Esc 关闭）',
					'toggle.proofread': '错别字检查开/关',
					'suggest.hint': 'Tab 采纳一词 · Shift+Tab 全量采纳 · Esc 关闭',
					'error.noApiKey':
						'input-assist：未配置 API Key（settings.yaml → input-assist.completionApiKey，或 dsh 已保存的 DEEPSEEK_API_KEY）',
					'proofread.title': '疑似错别字',
					'proofread.fix': '修正',
					'proofread.fixHint': '修正当前选中项（Ctrl+Shift+F）',
					'proofread.markCorrect': '标记正确',
					'proofread.markCorrectHint': '本次输入中该处不算错误，不替换（Ctrl+Shift+G）',
					'proofread.dismiss': '忽略',
					'proofread.dismissHint': '本次输入不再提醒（Esc）',
					'proofread.prevHint': '上一个（Ctrl+Shift+,）',
					'proofread.nextHint': '下一个（Ctrl+Shift+.）',
					// —— 设置页卡片 ——
					'settings.title': '输入助手',
					'settings.description': '输入补全（ghost text）与错别字检查',
					'settings.unsaved': '未保存',
					'settings.expand': '展开',
					'settings.collapse': '收起',
					'settings.groupCompletion': '输入补全',
					'settings.groupProofread': '错别字检查',
					'settings.save': '保存',
					'settings.saving': '保存中…',
					'settings.discard': '放弃修改',
					'settings.saveFailed': '保存失败，请重试',
					'settings.invalidNumber': '需为 0–60000 的整数',
					'settings.invalidRequired': '不能为空',
					'settings.resetHint': '清除该项的未保存修改',
					'settings.apiKeyPlaceholder': '留空 = 复用 dsh 已存的 DEEPSEEK_API_KEY',
				'settings.pickModel': '选择模型',
					'settings.modelsUnit': '个可用模型',
					'settings.fetchingModels': '拉取中…',
					'settings.modelsFailed': '模型列表拉取失败（未配置 API Key 或端点不可达），可手动输入模型名',
					'settings.f.completionEnabled': '启用输入补全',
					'settings.h.completionEnabled': '停笔后显示灰色内联建议，Tab 逐词采纳（输入框「补」按钮同效）',
					'settings.f.completionBaseUrl': 'FIM 端点',
					'settings.h.completionBaseUrl': 'OpenAI 兼容端点，默认 DeepSeek beta',
					'settings.f.completionApiKey': 'API Key',
					'settings.h.completionApiKey': '优先于 dsh 已保存的 DEEPSEEK_API_KEY 与环境变量',
					'settings.f.completionModel': '补全模型',
					'settings.h.completionModel': 'FIM 请求使用的模型（/beta/completions）',
					'settings.f.completionDebounceMs': '补全防抖（毫秒）',
					'settings.h.completionDebounceMs': '停笔多久后请求建议',
					'settings.f.completionMaxTokens': '建议长度上限（token）',
					'settings.f.completionStream': '流式输出',
					'settings.h.completionStream': '建议随生成逐字渐显（SSE）；接口不支持流式时关闭，改整段返回',
					'settings.f.proofreadEnabled': '启用错别字检查',
					'settings.h.proofreadEnabled': '文中红字标注、导航条逐条修正（输入框「校」按钮同效）',
					'settings.f.proofreadUseLlm': '启用 LLM 检查层',
					'settings.h.proofreadUseLlm': '上下文校对（在/再、的/得/地）；关闭则仅词典层本地检查，零成本',
					'settings.f.proofreadModel': '检查模型',
					'settings.h.proofreadModel': 'LLM 上下文校对使用的模型（chat 接口）',
					'settings.f.proofreadDebounceMs': 'LLM 检查防抖（毫秒）',
					'settings.f.proofreadDictDebounceMs': '词典检查防抖（毫秒）',
					'settings.h.proofreadDictDebounceMs': '浏览器本地扫描，即时标红',
					// —— 自定义词库（仅本浏览器） ——
					'settings.userDictGroup': '自定义词库（仅本浏览器）',
					'settings.userDictHint':
						'左列错词、右列正词，中英文皆可；同名错词覆盖内置词，正词与错词相同则不再检查该词。只保存在本浏览器，不随 settings.yaml 同步，换浏览器用「导出 / 导入」搬运。',
					'settings.userDictLabel': '自定义词库列表',
					'settings.userDictUnit': '条',
					'settings.userDictStoreFailed': '无法写入本浏览器存储（可能处于隐私模式或存储已满），词库未保存',
					'settings.udAdd': '添加词条',
					'settings.udImport': '导入',
					'settings.udExport': '导出',
					'settings.udCopy': '复制',
					'settings.udImportHint': '从 .txt 文件导入：一行一条「错词 => 正词」，同名错词就地更新、其余追加，导入后仍需保存',
					'settings.udExportHint': '下载为 .txt 文件（与内置词库同格式，含当前未保存的修改）',
					'settings.udCopyHint': '复制全部词条到剪贴板（含当前未保存的修改）',
					'settings.udImportDone': '导入完成：',
					'settings.udAdded': '新增',
					'settings.udUpdated': '更新',
					'settings.udIgnored': '忽略',
					'settings.udLines': '行',
					'settings.udImportEmpty': '文件里没有可识别的词条（一行一条：错词 => 正词）',
					'settings.udImportFailed': '读取文件失败',
					'settings.udFileTooBig': '文件超过 1MB，已取消导入',
					'settings.udCopied': '已复制',
					'settings.udCopyFailed': '复制失败：浏览器未授权剪贴板',
					'settings.udEmpty': '还没有自定义词条',
					'settings.udWrongPh': '错词',
					'settings.udRightPh': '正词',
					'settings.udDelHint': '删除这一条',
					'settings.udDragHint': '拖动调整顺序（或聚焦后 ↑ ↓）',
					'settings.udErr.blank': '错词与正词需成对填写',
					'settings.udErr.wrongSpace': '错词不能含空白',
					'settings.udErr.rightSpace': '正词不能含连续空白',
					'settings.udErr.tooLong': '错词过长',
					'settings.udErr.dup': '错词与其他行重复',
					'settings.udOverflow': '词条数超过上限',
				},
				en: {
					'toggle.completion':
						'Toggle input completion (when a suggestion shows: Tab accept word · Shift+Tab accept all · Esc close)',
					'toggle.proofread': 'Toggle typo checking',
					'suggest.hint': 'Tab accept word · Shift+Tab accept all · Esc close',
					'error.noApiKey':
						'input-assist: API key missing (settings.yaml → input-assist.completionApiKey, or dsh-stored DEEPSEEK_API_KEY)',
					'proofread.title': 'Possible typos',
					'proofread.fix': 'Fix',
					'proofread.fixHint': 'Fix the selected occurrence only (Ctrl+Shift+F)',
					'proofread.markCorrect': 'Mark correct',
					'proofread.markCorrectHint': 'Treat this occurrence as correct for this draft (Ctrl+Shift+G)',
					'proofread.dismiss': 'Dismiss',
					'proofread.dismissHint': 'Stop reminding for this draft (Esc)',
					'proofread.prevHint': 'Previous (Ctrl+Shift+,)',
					'proofread.nextHint': 'Next (Ctrl+Shift+.)',
					// —— Settings card ——
					'settings.title': 'Input Assist',
					'settings.description': 'Inline completion (ghost text) & typo checking',
					'settings.unsaved': 'Unsaved',
					'settings.expand': 'Expand',
					'settings.collapse': 'Collapse',
					'settings.groupCompletion': 'Completion',
					'settings.groupProofread': 'Typo checking',
					'settings.save': 'Save',
					'settings.saving': 'Saving…',
					'settings.discard': 'Discard',
					'settings.saveFailed': 'Save failed, please retry',
					'settings.invalidNumber': 'Integer 0–60000 required',
					'settings.invalidRequired': 'Must not be empty',
					'settings.resetHint': 'Clear this pending edit',
					'settings.apiKeyPlaceholder': 'Empty = reuse dsh-stored DEEPSEEK_API_KEY',
				'settings.pickModel': 'Pick a model',
					'settings.modelsUnit': 'available models',
					'settings.fetchingModels': 'Fetching…',
					'settings.modelsFailed': 'Could not fetch the model list (missing API key or unreachable endpoint); type a name manually',
					'settings.f.completionEnabled': 'Enable completion',
					'settings.h.completionEnabled': 'Gray inline suggestion after a pause; Tab accepts a word (same as the “补” button)',
					'settings.f.completionBaseUrl': 'FIM endpoint',
					'settings.h.completionBaseUrl': 'OpenAI-compatible endpoint; defaults to DeepSeek beta',
					'settings.f.completionApiKey': 'API key',
					'settings.h.completionApiKey': 'Takes precedence over the dsh-stored DEEPSEEK_API_KEY and env var',
					'settings.f.completionModel': 'Completion model',
					'settings.h.completionModel': 'Model for FIM requests (/beta/completions)',
					'settings.f.completionDebounceMs': 'Completion debounce (ms)',
					'settings.h.completionDebounceMs': 'How long to wait after typing before requesting',
					'settings.f.completionMaxTokens': 'Suggestion length cap (tokens)',
					'settings.f.completionStream': 'Streaming output',
					'settings.h.completionStream': 'Show the suggestion progressively as it generates (SSE); turn off if the endpoint does not support streaming',
					'settings.f.proofreadEnabled': 'Enable typo checking',
					'settings.h.proofreadEnabled': 'In-text red marks with a fix navigator (same as the “校” button)',
					'settings.f.proofreadUseLlm': 'Enable LLM layer',
					'settings.h.proofreadUseLlm': 'Context-aware checks (在/再, 的/得/地); off = dictionary-only local scan, zero cost',
					'settings.f.proofreadModel': 'Checking model',
					'settings.h.proofreadModel': 'Model for LLM context checks (chat API)',
					'settings.f.proofreadDebounceMs': 'LLM debounce (ms)',
					'settings.f.proofreadDictDebounceMs': 'Dictionary debounce (ms)',
					'settings.h.proofreadDictDebounceMs': 'Browser-local scan, instant marks',
					// —— Custom dictionary (this browser only) ——
					'settings.userDictGroup': 'Custom dictionary (this browser only)',
					'settings.userDictHint':
						'Left: wrong word; right: correction — Chinese or English. Same-key entries override the builtin ones; mapping a word to itself stops checking it. Stored in this browser only (not synced via settings.yaml); use Export / Import to move it between browsers.',
					'settings.userDictLabel': 'Custom dictionary list',
					'settings.userDictUnit': 'entries',
					'settings.userDictStoreFailed': 'Cannot write to browser storage (private mode or quota exceeded); dictionary not saved',
					'settings.udAdd': 'Add entry',
					'settings.udImport': 'Import',
					'settings.udExport': 'Export',
					'settings.udCopy': 'Copy',
					'settings.udImportHint':
						'Import from a .txt file — one pair per line ("wrong => right"); same-key rows update in place, the rest append; still needs Save after import',
					'settings.udExportHint': 'Download as .txt (same format as builtin dicts; includes unsaved edits)',
					'settings.udCopyHint': 'Copy all entries to the clipboard (includes unsaved edits)',
					'settings.udImportDone': 'Imported: ',
					'settings.udAdded': 'added',
					'settings.udUpdated': 'updated',
					'settings.udIgnored': 'ignored',
					'settings.udLines': 'lines',
					'settings.udImportEmpty': 'No recognizable entries in the file (one pair per line: wrong => right)',
					'settings.udImportFailed': 'Could not read the file',
					'settings.udFileTooBig': 'File exceeds 1 MB; import cancelled',
					'settings.udCopied': 'Copied',
					'settings.udCopyFailed': 'Copy failed: clipboard unavailable',
					'settings.udEmpty': 'No custom entries yet',
					'settings.udWrongPh': 'wrong',
					'settings.udRightPh': 'correct',
					'settings.udDelHint': 'Remove this entry',
					'settings.udDragHint': 'Drag to reorder (or focus and use ↑ ↓)',
					'settings.udErr.blank': 'Fill in both the wrong word and the correction',
					'settings.udErr.wrongSpace': 'The wrong word must not contain whitespace',
					'settings.udErr.rightSpace': 'The correction must not contain double spaces',
					'settings.udErr.tooLong': 'Wrong word too long',
					'settings.udErr.dup': 'Duplicate wrong word in another row',
					'settings.udOverflow': 'Too many entries',
				},
			}),
		'input-assist: dictionaries',
	)

	const typoApi: TypoApi = {
		navMove,
		navFixCurrent,
		navMarkCorrect,
		dismissIssues: () => setAssist({ dismissedRev: assistStore.getSnapshot().issueRev }),
	}
	// 调试钩子：真实浏览器控制台可用 window.__iaApi.navMove(1) 等直接驱动
	try {
		window.__iaApi = typoApi
	} catch (_err) {
		/* 无 window 环境 */
	}

	slots.inject('conversation.input.overlay', () =>
		slots.register(
			{
				name: 'conversation.input.overlay',
				id: 'input-assist-suggest',
				order: 200,
				locale: NS,
				inject: () => ({ hooks: { assist: assistStore, config: configStore } }),
			},
			SuggestBar,
		),
	)

	slots.inject('conversation.input.dock', () =>
		slots.register(
			{
				name: 'conversation.input.dock',
				id: 'input-assist-ghosthint',
				order: 70,
				locale: NS,
				inject: () => ({ hooks: { assist: assistStore, config: configStore } }),
			},
			GhostHint,
		),
	)

	slots.inject('conversation.input.dock', () =>
		slots.register(
			{
				name: 'conversation.input.dock',
				id: 'input-assist-proofread',
				order: 80,
				locale: NS,
				inject: () => ({ hooks: { assist: assistStore, config: configStore }, api: typoApi }),
			},
			TypoNav,
		),
	)

	slots.inject('conversation.input.right', () =>
		slots.register(
			{
				name: 'conversation.input.right',
				id: 'input-assist-toggle',
				order: 40,
				locale: NS,
				inject: () => ({
					hooks: { config: configStore },
					api: { toggle: (key: ToggleKey) => persistConfig({ [key]: !configStore.getSnapshot()[key] }) },
				}),
			},
			ToggleControl,
		),
	)

	// 设置页卡片：宿主 ui-settings-plugins 在 Plugins → 插件配置 tab 按
	// key（= 设置命名空间）派发；keyed 注册不带 id/order。数据通路复用
	// 既有 /input-assist RPC（config.get 已在 apply 顶部加载，写走
	// persistConfig 的乐观更新 + 失败回读），不引入新服务依赖。
	slots.inject('settings.plugin.item', () =>
		slots.register(
			{
				name: 'settings.plugin.item',
				key: NS,
				locale: NS,
				inject: () => ({
					hooks: { config: configStore },
					api: {
						save: (patch: Partial<InputAssistConfig>) => persistConfig(patch),
						fetchModels: () => rpc<ModelsResult>('models.list', {}),
					},
				}),
			},
			SettingsCard,
		),
	)

	if (remote !== undefined) {
		ctx.effect(
			() =>
				remote.$on('settings/document-updated', (ns) => {
					if (ns === NS) loadConfig()
				}),
			'input-assist: settings document watcher',
		)
	}
	// 关开关（按钮 / 设置卡片 / settings.yaml 热同步，任一路径最终都写进
	// configStore）时：断开在途请求、作废迟到响应——关掉后 ghost 不复活、
	// 不弹错误条；重开时也不会冒出关掉前那一刻的旧建议。
	let lastCfg = configStore.getSnapshot()
	ctx.effect(
		() =>
			configStore.subscribe(() => {
				const cfg = configStore.getSnapshot()
			if (lastCfg.completionEnabled && !cfg.completionEnabled) {
				abortCompletionRound()
			}
			if (
				(lastCfg.proofreadEnabled && !cfg.proofreadEnabled) ||
				(lastCfg.proofreadUseLlm !== false && cfg.proofreadUseLlm === false)
			) {
				clearTimeout(llmTimer)
				cancelRpc(llmReqId)
				llmReqId = ''
				llmSeq += 1
			}
				lastCfg = cfg
			}),
		'input-assist: cancel on disable',
	)
	loadConfig()

	// 滚动/缩放时重同步镜像层与 dock 行宽（capture 捕获 textarea 滚动）
	const onViewportChange = (): void => {
		syncMirror()
		syncDockRows()
	}
	ctx.effect(() => {
		window.addEventListener('scroll', onViewportChange, true)
		window.addEventListener('resize', onViewportChange)
		return () => {
			window.removeEventListener('scroll', onViewportChange, true)
			window.removeEventListener('resize', onViewportChange)
			if (mirrorEl !== null) {
				mirrorEl.remove()
				mirrorEl = null
			}
		}
	}, 'input-assist: mirror viewport sync')

	// 键盘拦截（捕获阶段）：
	//   Tab/Esc        — 补全建议采纳/关闭（仅建议可见且对应当前草稿时）
	//   Ctrl+Shift 组合 — 错别字导航（仅输入框聚焦且有检出时）
	const onKeyDown = (e: KeyboardEvent): void => {
		if (e.isComposing || e.keyCode === 229) return // 输入法组合期放行
		if (e.ctrlKey || e.metaKey || e.altKey)
			debug({
				lastKey: {
					key: e.key,
					code: e.code,
					ctrl: e.ctrlKey,
					shift: e.shiftKey,
					alt: e.altKey,
					meta: e.metaKey,
					inComposer: e.target instanceof HTMLTextAreaElement,
				},
			})
		const target = e.target
		if (!(target instanceof HTMLElement)) return
		// 0.1.5+ 输入面是 contenteditable div（子节点也可能是事件目标，
		// isContentEditable 对其后代继承为 true）；旧运行时是 textarea
		const inTextarea = target instanceof HTMLTextAreaElement
		if (!inTextarea && !target.isContentEditable) return
		if (target.closest('[data-composer-card]') === null) return
		const assist = assistStore.getSnapshot()

		// —— 错别字导航快捷键 ——
		if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
			const key = e.key
			let handled = false
			if (key === ',' || key === '<') {
				if (navActive()) {
					navMove(-1)
					handled = true
				}
			} else if (key === '.' || key === '>') {
				if (navActive()) {
					navMove(1)
					handled = true
				}
			} else if (key === 'F' || key === 'f') {
				if (navActive()) {
					navFixCurrent()
					handled = true
				}
			} else if (key === 'G' || key === 'g') {
				if (navActive()) {
					navMarkCorrect()
					handled = true
				}
			}
			if (handled) {
				e.preventDefault()
				e.stopPropagation()
				return
			}
		}

		// —— 补全 Tab 逐词采纳 / Esc（建议优先）——
		if (assist.suggestion === '' || assist.sugDraft !== lastDraft) {
			if (e.key === 'Escape') {
				// 无可见建议时 Esc：忽略本次错别字提醒（如有检出）；
				// 补全本轮（排队或在途）一并作废——否则迟到响应会把 ghost 凭空弹出
				let handled = false
				if (navActive()) {
					// LLM 校对也在途的话同时断掉：用户已表态“本次不再提醒”
					cancelRpc(llmReqId)
					llmReqId = ''
					setAssist({ dismissedRev: assistStore.getSnapshot().issueRev })
					handled = true
				}
				if (completionRoundActive()) {
					abortCompletionRound()
					handled = true
				}
				if (handled) {
					e.preventDefault()
					e.stopPropagation()
				}
			}
			return
		}
		if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault()
			e.stopPropagation()
			// 逐词采纳：只吞下一个分词单位；Shift+Tab 全量采纳
			const chunk = e.shiftKey ? assist.suggestion : nextSegment(assist.suggestion)
			if (chunk === '') return
			// 流式在途：记下已采纳字符数，剩余建议 = accumulated.slice(accepted)，
			// 在途 delta 继续追加到末尾（显示可能落后一帧，前缀关系仍成立）
			if (completionStreamCtrl !== null) streamAccepted += chunk.length
			// 双运行时统一走 draft 真值 + composerCaret（textarea 的
			// selectionStart 与 contenteditable 的选区走查在这里合流）
			const caret = composerCaret() ?? lastDraft.length
			const next = lastDraft.slice(0, caret) + chunk + lastDraft.slice(caret)
			const rest = assist.suggestion.slice(chunk.length)
			if (inputActionsRef !== null && typeof inputActionsRef.setDraft === 'function') {
				inputActionsRef.setDraft(next)
			} else if (target instanceof HTMLTextAreaElement) {
				target.focus()
				try {
					document.execCommand('insertText', false, chunk)
				} catch (_err) {
					/* 静默 */
				}
			}
			if (rest === '') {
				// 吃光了：清建议；setDraft 触发的 onDraftChanged 会自动再调度一轮
				setAssist({ suggestion: '', fetching: false, sugRev: -1 })
			} else {
				// 剩余建议继续显示；onDraftChanged 里 justAccepted 守卫会跳过这次重调度
				setAssist({ suggestion: rest, sugDraft: next })
			}
			return
		}
		if (e.key === 'Escape') {
			e.preventDefault()
			e.stopPropagation()
			// 建议可见时 Esc：关建议并把本轮（排队/在途）彻底作废，
			// 迟到响应不会把 ghost 再弹回来
			abortCompletionRound()
		}
	}
	ctx.effect(() => {
		document.addEventListener('keydown', onKeyDown, true)
		return () => document.removeEventListener('keydown', onKeyDown, true)
	}, 'input-assist: keydown interceptor')
}
