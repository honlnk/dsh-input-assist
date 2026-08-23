// Shared constants & config shape — imported by both the host half
// (src/index.ts) and the browser half (src/client.ts, bundled by tsdown).

export const NS = 'input-assist'
export const CHANNEL = '/input-assist'

export interface InputAssistConfig {
	completionEnabled: boolean
	completionBaseUrl: string
	completionApiKey: string
	completionModel: string
	completionDebounceMs: number
	completionMaxTokens: number
	proofreadEnabled: boolean
	proofreadUseLlm: boolean
	proofreadModel: string
	proofreadDebounceMs: number
	proofreadDictDebounceMs: number
}

/** Defaults mirrored by the host-side schema; also the client's fallback when
 *  the settings service is absent or unreachable. */
export const DEFAULT_CONFIG: InputAssistConfig = {
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
