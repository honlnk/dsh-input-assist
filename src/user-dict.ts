// 用户自定义词库：仅浏览器本地（localStorage），不进 settings.yaml、不走 RPC。
// 存储值是行式原始文本（与内置 data/zh-wrong-phrases.txt 同语法：
// `错词 => 正词`，# 注释、空行忽略）——与编辑框内容一一对应，
// 复制粘贴即是导入/导出，解析逻辑单一（proofread-dict.ts parseDictText）。
// 语义见 mergeDicts：同名错词覆盖内置；`错词 => 错词` 自映射 = 禁用该内置词。
// 所有读写 try/catch：隐私模式 / 配额满 / localStorage 被禁时整体降级为
// "无用户词库"，不影响补全与 LLM 校对。

/** 版本化 key：格式不兼容变更时递增，旧数据自然失效。 */
export const USER_DICT_STORAGE_KEY = 'dsh-input-assist:user-dict:v1'

/** 浏览器 Storage 的最小面（便于测试注入假实现）。 */
export interface DictStorage {
	getItem(key: string): string | null
	setItem(key: string, value: string): void
}

/** 读用户词库原始文本；storage 缺失或抛错一律返回 ''（等价无词库）。 */
export function loadUserDictText(storage: DictStorage | null | undefined): string {
	if (storage == null) return ''
	try {
		return storage.getItem(USER_DICT_STORAGE_KEY) ?? ''
	} catch {
		return ''
	}
}

/** 写入用户词库原始文本；返回是否成功（失败 = localStorage 不可写，UI 降级提示）。 */
export function saveUserDictText(storage: DictStorage | null | undefined, text: string): boolean {
	if (storage == null) return false
	try {
		storage.setItem(USER_DICT_STORAGE_KEY, text)
		return true
	} catch {
		return false
	}
}
