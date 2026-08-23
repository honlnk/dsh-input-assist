// dsh-input-assist — host half (Node).
// 1) Registers the user-settings namespace `input-assist` (persisted to
//    <dsh home>/settings.yaml by the host settings service; external file
//    edits hot-publish to the browser via settings/document-updated).
// 2) Owns the loopback RPC channel /input-assist:
//      config.get / config.set — read / merge-persist the namespace
//      complete                — DeepSeek FIM proxy (non-streaming)
//      proofread               — LLM check (the offline dictionary layer runs
//                                browser-side; pass llmOnly: true to skip the
//                                host-side scan kept for legacy callers)
//    All outbound API calls happen host-side: no browser CORS concerns, and
//    the API key never crosses into page storage.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { requestFimCompletion } from './completion.js'
import { scanLocalTypos } from './proofread-dict.js'
import { llmProofread, locateIssues, mergeIssues } from './proofread-llm.js'
import { CHANNEL, DEFAULT_CONFIG, NS } from './config.js'
import type { InputAssistConfig } from './config.js'
import type { TypoIssue } from './proofread-dict.js'

const ConfigSchema = z.object({
	completionEnabled: z.boolean().default(DEFAULT_CONFIG.completionEnabled),
	completionBaseUrl: z.string().default(DEFAULT_CONFIG.completionBaseUrl),
	completionApiKey: z.string().default(DEFAULT_CONFIG.completionApiKey),
	completionModel: z.string().default(DEFAULT_CONFIG.completionModel),
	completionDebounceMs: z.number().default(DEFAULT_CONFIG.completionDebounceMs),
	completionMaxTokens: z.number().default(DEFAULT_CONFIG.completionMaxTokens),
	proofreadEnabled: z.boolean().default(DEFAULT_CONFIG.proofreadEnabled),
	proofreadUseLlm: z.boolean().default(DEFAULT_CONFIG.proofreadUseLlm),
	proofreadModel: z.string().default(DEFAULT_CONFIG.proofreadModel),
	proofreadDebounceMs: z.number().default(DEFAULT_CONFIG.proofreadDebounceMs),
	proofreadDictDebounceMs: z.number().default(DEFAULT_CONFIG.proofreadDictDebounceMs),
})

/** config.set whitelist: key → primitive type check (schema coerces rest). */
const CONFIG_TYPES: Record<keyof InputAssistConfig, 'boolean' | 'string' | 'number'> = {
	completionEnabled: 'boolean',
	completionBaseUrl: 'string',
	completionApiKey: 'string',
	completionModel: 'string',
	completionDebounceMs: 'number',
	completionMaxTokens: 'number',
	proofreadEnabled: 'boolean',
	proofreadUseLlm: 'boolean',
	proofreadModel: 'string',
	proofreadDebounceMs: 'number',
	proofreadDictDebounceMs: 'number',
}

// 注意：RPC 传输层会用 schema 校验响应，error.code 必须取自传输层枚举
// （bad-request / cancelled / internal …），自定义 code 会让整个响应被拒。
type RpcError = { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }
type RpcOk<T> = { ok: true; value: T }
export type RpcResult<T> = RpcOk<T> | RpcError

const rpcError = (message: string): RpcError => ({ ok: false, error: { code: 'internal', message, details: {} } })

/**
 * Resolve the effective API key: the plugin's own setting first, then the
 * DEEPSEEK_API_KEY environment variable, then the dsh credential document
 * ($DSH_HOME/.credentials.yaml → refs.DEEPSEEK_API_KEY). Users who already
 * configured DeepSeek in dsh need no second key.
 */
export function resolveApiKey(config: Pick<InputAssistConfig, 'completionApiKey'>): string {
	if (typeof config.completionApiKey === 'string' && config.completionApiKey !== '') return config.completionApiKey
	if (typeof process.env.DEEPSEEK_API_KEY === 'string' && process.env.DEEPSEEK_API_KEY !== '') {
		return process.env.DEEPSEEK_API_KEY
	}
	try {
		const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
		const doc = readFileSync(join(home, '.credentials.yaml'), 'utf8')
		const m = doc.match(/^\s*DEEPSEEK_API_KEY:\s*["']?([^"'\s]+)["']?\s*$/m)
		if (m !== null) return m[1]
	} catch {
		/* no credential document */
	}
	return ''
}

const clampNumber = (value: unknown, min: number, max: number, fallback: number): number => {
	const n = Number(value)
	if (!Number.isFinite(n)) return fallback
	return Math.min(max, Math.max(min, Math.round(n)))
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === 'object' && !Array.isArray(v)

export interface HandlerDeps {
	/** resolved config (schema defaults merged) */
	getConfig: () => InputAssistConfig
	/** merge-persist */
	updateConfig: (patch: Partial<InputAssistConfig>) => Promise<void>
}

export interface CompleteValue {
	text: string
	reason?: string
}

export interface ProofreadValue {
	issues: TypoIssue[]
}

/**
 * Build the RPC handler. Pure dependency injection so tests can drive every
 * endpoint without a real cordis context.
 */
export function createHandler({ getConfig, updateConfig }: HandlerDeps) {
	return async function handler(endpoint: string, payload: unknown): Promise<RpcResult<unknown>> {
		if (endpoint === 'config.get') {
			return { ok: true, value: getConfig() }
		}
		if (endpoint === 'config.set') {
			const patch = isPlainObject(payload) ? payload : {}
			const clean: Partial<InputAssistConfig> = {}
			for (const [key, type] of Object.entries(CONFIG_TYPES) as [keyof InputAssistConfig, 'boolean' | 'string' | 'number'][]) {
				if (!(key in patch)) continue
				const value = patch[key]
				if (type === 'boolean' && typeof value === 'boolean') (clean as Record<string, unknown>)[key] = value
				else if (type === 'string' && typeof value === 'string') (clean as Record<string, unknown>)[key] = value
				else if (type === 'number') (clean as Record<string, unknown>)[key] = clampNumber(value, 0, 60000, DEFAULT_CONFIG[key] as number)
			}
			try {
				await updateConfig(clean)
			} catch (error) {
				return rpcError(error instanceof Error ? error.message : String(error))
			}
			return { ok: true, value: getConfig() }
		}
		if (endpoint === 'complete') {
			const cfg = getConfig()
			if (!cfg.completionEnabled) return { ok: true, value: { text: '' } satisfies CompleteValue }
			const apiKey = resolveApiKey(cfg)
			if (!apiKey) return { ok: true, value: { text: '', reason: 'no-api-key' } satisfies CompleteValue }
			const body = isPlainObject(payload) ? payload : {}
			const prompt = typeof body.prefix === 'string' ? body.prefix.slice(-2000) : ''
			const suffix = typeof body.suffix === 'string' ? body.suffix.slice(0, 500) : ''
			if (prompt.trim().length < 2) return { ok: true, value: { text: '' } satisfies CompleteValue }
			try {
				const text = await requestFimCompletion({
					baseUrl: cfg.completionBaseUrl,
					apiKey,
					model: cfg.completionModel,
					prompt,
					suffix,
					maxTokens: clampNumber(cfg.completionMaxTokens, 8, 512, DEFAULT_CONFIG.completionMaxTokens),
				})
				return { ok: true, value: { text } satisfies CompleteValue }
			} catch (error) {
				return rpcError(error instanceof Error ? error.message : String(error))
			}
		}
		if (endpoint === 'proofread') {
			const cfg = getConfig()
			const body = isPlainObject(payload) ? payload : {}
			const text = typeof body.text === 'string' ? body.text.slice(0, 2000) : ''
			if (text.length === 0) return { ok: true, value: { issues: [] } satisfies ProofreadValue }
			// Layer 1 — offline dictionary. v3 起词典层已在浏览器本地运行，
			// 客户端带 llmOnly: true 时这里跳过，避免重复劳动（保留本层仅为
			// 兼容直连 host 的旧客户端/脚本）。
			const local = cfg.proofreadEnabled === false || body.llmOnly === true ? [] : scanLocalTypos(text)
			// Layer 2 — LLM: context-aware confusions the dictionary can't decide.
			let llmIssues: ReturnType<typeof locateIssues> = []
			if (cfg.proofreadEnabled !== false && cfg.proofreadUseLlm !== false) {
				const apiKey = resolveApiKey(cfg)
				if (apiKey) {
					try {
						const raw = await llmProofread({
							baseUrl: cfg.completionBaseUrl,
							apiKey,
							model: cfg.proofreadModel,
							text,
						})
						llmIssues = locateIssues(raw, text)
					} catch {
						// LLM 层失败不影响词典层结果
					}
				}
			}
			return { ok: true, value: { issues: mergeIssues(local, llmIssues) } satisfies ProofreadValue }
		}
		return rpcError(`unknown endpoint ${String(endpoint)}`)
	}
}

/** Settings scope shape returned by the host settings service. */
interface SettingsScope {
	get(): InputAssistConfig
	update(patch: Partial<InputAssistConfig>): Promise<void>
}

/** Minimal shape of the host services this plugin consumes. */
interface ConnectionService {
	rpc: {
		handle(
			channel: string,
			handler: (endpoint: string, payload: unknown) => Promise<RpcResult<unknown>>,
			options: { authority: string },
		): () => void
	}
}

/** Cordis entry: settings namespace + loopback RPC registration. */
function apply(ctx: Context): void {
	let scope: SettingsScope | undefined = undefined
	ctx.inject(['settings'], (settingsCtx) => {
		scope = settingsCtx.settings.register(settingsNamespace(NS), ConfigSchema) as unknown as SettingsScope
	})

	const connection = ctx.get('connection') as ConnectionService | undefined
	if (connection === undefined) return

	const handler = createHandler({
		getConfig: () => scope?.get() ?? { ...DEFAULT_CONFIG },
		updateConfig: async (patch) => {
			if (scope === undefined) throw new Error('settings service unavailable')
			await scope.update(patch)
		},
	})

	ctx.effect(
		() => connection.rpc.handle(CHANNEL, handler, { authority: 'loopback' }),
		'input-assist: rpc channel',
	)
}

export { apply, NS, CHANNEL, DEFAULT_CONFIG }
export default { apply }
