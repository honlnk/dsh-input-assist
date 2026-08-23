// dsh-input-assist — host half (Node).
// 1) Registers the user-settings namespace `input-assist` (persisted to
//    <dsh home>/settings.yaml by the host settings service; external file
//    edits hot-publish to the browser via settings/document-updated).
// 2) Owns the loopback RPC channel /input-assist:
//      config.get / config.set — read / merge-persist the namespace
//      complete                — DeepSeek FIM proxy (non-streaming v1)
//      proofread               — optional LLM check (v3+: the offline
//                                dictionary layer runs browser-side; pass
//                                llmOnly: true to skip the host-side scan)
//    All outbound API calls happen host-side: no browser CORS concerns, and
//    the API key never crosses into page storage.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { requestFimCompletion } from './completion.js'
import { scanLocalTypos } from './proofread-dict.js'
import { llmProofread, locateIssues, mergeIssues } from './proofread-llm.js'

const NS = 'input-assist'
const CHANNEL = '/input-assist'

/** Defaults mirrored by the schema; also the fallback when the optional
 *  settings service is absent. */
export const DEFAULT_CONFIG = {
	completionEnabled: true,
	completionBaseUrl: 'https://api.deepseek.com/beta',
	completionApiKey: '',
	completionModel: 'deepseek-chat',
	completionDebounceMs: 800,
	completionMaxTokens: 64,
	proofreadEnabled: true,
	proofreadUseLlm: true,
	proofreadModel: 'deepseek-chat',
	proofreadDebounceMs: 800,
	proofreadDictDebounceMs: 200,
}

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
const CONFIG_TYPES = {
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
const rpcError = (message) => ({ ok: false, error: { code: 'internal', message, details: {} } })

/**
 * Resolve the effective API key: the plugin's own setting first, then the
 * DEEPSEEK_API_KEY environment variable, then the dsh credential document
 * ($DSH_HOME/.credentials.yaml → refs.DEEPSEEK_API_KEY). Users who already
 * configured DeepSeek in dsh need no second key.
 */
export function resolveApiKey(config) {
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
const clampNumber = (value, min, max, fallback) => {
	const n = Number(value)
	if (!Number.isFinite(n)) return fallback
	return Math.min(max, Math.max(min, Math.round(n)))
}
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * Build the RPC handler. Pure dependency injection so tests can drive every
 * endpoint without a real cordis context.
 * @param {object} deps
 * @param {() => object} deps.getConfig resolved config (schema defaults merged)
 * @param {(patch: object) => Promise<void>} deps.updateConfig merge-persist
 */
export function createHandler({ getConfig, updateConfig }) {
	return async function handler(endpoint, payload) {
		if (endpoint === 'config.get') {
			return { ok: true, value: getConfig() }
		}
		if (endpoint === 'config.set') {
			const patch = isPlainObject(payload) ? payload : {}
			const clean = {}
			for (const [key, type] of Object.entries(CONFIG_TYPES)) {
				if (!(key in patch)) continue
				const value = patch[key]
				if (type === 'boolean' && typeof value === 'boolean') clean[key] = value
				else if (type === 'string' && typeof value === 'string') clean[key] = value
				else if (type === 'number') clean[key] = clampNumber(value, 0, 60000, DEFAULT_CONFIG[key])
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
			if (!cfg.completionEnabled) return { ok: true, value: { text: '' } }
			const apiKey = resolveApiKey(cfg)
			if (!apiKey) return { ok: true, value: { text: '', reason: 'no-api-key' } }
			const body = isPlainObject(payload) ? payload : {}
			const prompt = typeof body.prefix === 'string' ? body.prefix.slice(-2000) : ''
			const suffix = typeof body.suffix === 'string' ? body.suffix.slice(0, 500) : ''
			if (prompt.trim().length < 2) return { ok: true, value: { text: '' } }
			try {
				const text = await requestFimCompletion({
					baseUrl: cfg.completionBaseUrl,
					apiKey,
					model: cfg.completionModel,
					prompt,
					suffix,
					maxTokens: clampNumber(cfg.completionMaxTokens, 8, 512, DEFAULT_CONFIG.completionMaxTokens),
				})
				return { ok: true, value: { text } }
			} catch (error) {
				return rpcError(error instanceof Error ? error.message : String(error))
			}
		}
		if (endpoint === 'proofread') {
			const cfg = getConfig()
			const body = isPlainObject(payload) ? payload : {}
			const text = typeof body.text === 'string' ? body.text.slice(0, 2000) : ''
			if (text.length === 0) return { ok: true, value: { issues: [] } }
			// Layer 1 — offline dictionary. v3 起词典层已在浏览器本地运行，
			// 客户端带 llmOnly: true 时这里跳过，避免重复劳动（保留本层仅为
			// 兼容直连 host 的旧客户端/脚本）。
			const local = cfg.proofreadEnabled === false || body.llmOnly === true ? [] : scanLocalTypos(text)
			// Layer 2 — LLM: context-aware confusions the dictionary can't decide.
			let llmIssues = []
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
			return { ok: true, value: { issues: mergeIssues(local, llmIssues) } }
		}
		return rpcError(`unknown endpoint ${String(endpoint)}`)
	}
}

/** Cordis entry: settings namespace + loopback RPC registration. */
function apply(ctx) {
	let scope = undefined
	ctx.inject(['settings'], (settingsCtx) => {
		scope = settingsCtx.settings.register(settingsNamespace(NS), ConfigSchema)
	})

	const connection = ctx.get('connection')
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

export { apply, NS, CHANNEL }
export default { apply }
