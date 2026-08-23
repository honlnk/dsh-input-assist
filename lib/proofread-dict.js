// Chinese typo dictionary scanner — the offline, high-precision layer.
//
// Design (mirrors pycorrector's confusion-set approach, curated by hand):
//   1. WRONG_PHRASES — whole wrong words / idioms mapping to their standard
//      forms. Only unambiguous entries are included: if a "wrong" form could
//      ever be legitimate in other contexts, it is excluded. That keeps the
//      offline layer at effectively zero false positives.
//   2. CONTEXT_RULES — confusions that are only wrong in a specific context
//      (登陆账号→登录账号, 带口罩→戴口罩 …) expressed as anchored regexes.
// Context-dependent pairs (在/再, 的/得/地, 像/象 …) are deliberately NOT
// listed here — they cannot be decided without a sentence, so they are left
// to the LLM layer (proofread-llm.js).
// All offsets refer to the ORIGINAL text: scan targets are masked with
// same-length placeholders (code spans, fenced blocks, URLs) so indices stay
// valid without ever flagging content inside them.

/** Unambiguous wrong→right word map (common miswritten idioms and words). */
export const WRONG_PHRASES = {
	// —— 成语 / 固定词组常见误写 ——
	'迫不急待': '迫不及待',
	'一如继往': '一如既往',
	'甘败下风': '甘拜下风',
	'自抱自弃': '自暴自弃',
	'走头无路': '走投无路',
	'穿流不息': '川流不息',
	'名付其实': '名副其实',
	'名幅其实': '名副其实',
	'世外桃园': '世外桃源',
	'磬竹难书': '罄竹难书',
	'一股作气': '一鼓作气',
	'悬梁刺骨': '悬梁刺股',
	'食不裹腹': '食不果腹',
	'再接再励': '再接再厉',
	'变本加利': '变本加厉',
	'谈笑风声': '谈笑风生',
	'鬼鬼崇崇': '鬼鬼祟祟',
	'振耳欲聋': '震耳欲聋',
	'试目以待': '拭目以待',
	'出其制胜': '出奇制胜',
	'好高鹜远': '好高骛远',
	'趋之若骛': '趋之若鹜',
	'烂竽充数': '滥竽充数',
	'滥芋充数': '滥竽充数',
	'病入膏盲': '病入膏肓',
	'针贬时弊': '针砭时弊',
	'草管人命': '草菅人命',
	'残无人道': '惨无人道',
	'精兵减政': '精兵简政',
	'集思广义': '集思广益',
	'妄自非薄': '妄自菲薄',
	'心恢意冷': '心灰意冷',
	'万念具灰': '万念俱灰',
	'与时具进': '与时俱进',
	'不落巢臼': '不落窠臼',
	'一愁莫展': '一筹莫展',
	'相辅相承': '相辅相成',
	'哀声叹气': '唉声叹气',
	'按步就班': '按部就班',
	'暗然失色': '黯然失色',
	'白壁无瑕': '白璧无瑕',
	'白壁无暇': '白璧无瑕',
	'白璧无暇': '白璧无瑕',
	'百战不怠': '百战不殆',
	'搬门弄斧': '班门弄斧',
	'半途而费': '半途而废',
	'卑恭屈膝': '卑躬屈膝',
	'悲欢离和': '悲欢离合',
	'变换莫测': '变幻莫测',
	'彬彬有理': '彬彬有礼',
	'不加思索': '不假思索',
	'不径而走': '不胫而走',
	'不醒人事': '不省人事',
	'惨绝人圜': '惨绝人寰',
	'苍海一粟': '沧海一粟',
	'老声常谈': '老生常谈',
	'陈词烂调': '陈词滥调',
	'张慌失措': '张皇失措',
	'融汇贯通': '融会贯通',
	'良晨美景': '良辰美景',
	'火中取粟': '火中取栗',
	'礼上往来': '礼尚往来',
	'立杆见影': '立竿见影',
	'两全齐美': '两全其美',
	'留芳百世': '流芳百世',
	'流言非语': '流言蜚语',
	'戳力同心': '戮力同心',
	'貌和神离': '貌合神离',
	'美仑美奂': '美轮美奂',
	'沤心沥血': '呕心沥血',
	'旁证博引': '旁征博引',
	'披星带月': '披星戴月',
	'破斧沉舟': '破釜沉舟',
	'前扑后继': '前仆后继',
	'山青水秀': '山清水秀',
	'申张正义': '伸张正义',
	'事得其反': '适得其反',
	'括不知耻': '恬不知耻',
	'挺而走险': '铤而走险',
	'同仇敌概': '同仇敌忾',
	'万事具备': '万事俱备',
	'妄费心机': '枉费心机',
	'委屈求全': '委曲求全',
	'无耻烂言': '无耻谰言',
	'相形见拙': '相形见绌',
	'消声匿迹': '销声匿迹',
	'修养生息': '休养生息',
	'一踏糊涂': '一塌糊涂',
	'一蹋糊涂': '一塌糊涂',
	'以身做则': '以身作则',
	'义愤填赝': '义愤填膺',
	'英雄倍出': '英雄辈出',
	'人才倍出': '人才辈出',
	'脑羞成怒': '恼羞成怒',
	'竭泽而鱼': '竭泽而渔',
	'渊远流长': '源远流长',
	'张灯结采': '张灯结彩',
	'枝离破碎': '支离破碎',
	'趋炎赴势': '趋炎附势',
	'熟手无策': '束手无策',
	'死心踏地': '死心塌地',
	'提心掉胆': '提心吊胆',
	'天翻地复': '天翻地覆',
	'无精打彩': '无精打采',
	'兴高彩烈': '兴高采烈',
	'修茸一新': '修葺一新',
	'言简意骇': '言简意赅',
	'一枕黄梁': '一枕黄粱',
	'以逸代劳': '以逸待劳',
	'义气用事': '意气用事',
	'应接不瑕': '应接不暇',
	'目不瑕接': '目不暇接',
	'闻名暇迩': '闻名遐迩',
	'有持无恐': '有恃无恐',
	'原型毕露': '原形毕露',
	'怨天由人': '怨天尤人',
	'语无论次': '语无伦次',
	'奴颜卑膝': '奴颜婢膝',
	'披荆斩刺': '披荆斩棘',
	'疚由自取': '咎由自取',
	'按耐不住': '按捺不住',
	'必竟': '毕竟',
	'家俱': '家具',
	'按装': '安装',
	'过份': '过分',
	'安份': '安分',
	'繁锁': '繁琐',
	'震摄': '震慑',
	'威摄': '威慑',
	'震憾': '震撼',
	'憾动': '撼动',
	'遗撼': '遗憾',
	'脉博': '脉搏',
	'竟争': '竞争',
	'竟赛': '竞赛',
	'布署': '部署',
	'防碍': '妨碍',
	'防害': '妨害',
	'诚垦': '诚恳',
	'驰聘': '驰骋',
	'重迭': '重叠',
	'幅射': '辐射',
	'复盖': '覆盖',
	'重蹈复辙': '重蹈覆辙',
	'换然一新': '焕然一新',
	'焕然冰释': '涣然冰释',
	'慌谬': '荒谬',
	'大慨': '大概',
	'感概': '感慨',
	'慷概': '慷慨',
	'气慨': '气概',
	'竹杆': '竹竿',
	'告磬': '告罄',
	'售磬': '售罄',
	'怂勇': '怂恿',
	'蕴酿': '酝酿',
	'车箱': '车厢',
	'一箱情愿': '一厢情愿',
	'好象': '像', // 见 CONTEXT_RULES 注：整词替换不可行，单独处理
	'就象': '就像',
	'摄象': '摄像',
	'录象': '录像',
	'糟殃': '遭殃',
	'蹧蹋': '糟蹋',
	'糟塌': '糟蹋',
	'帐号': '账号',
	'帐户': '账户',
	'帐单': '账单',
	'峻工': '竣工',
	'决择': '抉择',
	'浩翰': '浩瀚',
	'待慢': '怠慢',
	'逮扑': '逮捕',
	'治逾': '治愈',
	'愈和': '愈合',
	'偶而': '偶尔',
	'即然': '既然',
	'既使': '即使',
	'以经': '已经',
	'因该': '应该',
	'贴子': '帖子',
	'等侯': '等候',
	'澈底': '彻底',
	'清彻': '清澈',
	'冒然': '贸然',
	'松驰': '松弛',
	'偿试': '尝试',
	'尊照': '遵照',
	'暴光': '曝光',
	'爆光': '曝光',
	'潜移墨化': '潜移默化',
	'曲指可数': '屈指可数',
	'全神灌注': '全神贯注',
	'融恰': '融洽',
	'杀戳': '杀戮',
	'萤光': '荧光',
	'蜂涌而至': '蜂拥而至',
	'声名雀起': '声名鹊起',
	'肆无忌弹': '肆无忌惮',
	'随声附合': '随声附和',
	'题纲': '提纲',
	'迁徒': '迁徙',
	'宣宾夺主': '喧宾夺主',
	'学以至用': '学以致用',
	'遗笑大方': '贻笑大方',
	'真知卓见': '真知灼见',
	'直接了当': '直截了当',
	'中流抵柱': '中流砥柱',
	'诛连': '株连',
	'珠联壁合': '珠联璧合',
	'综合症': '综合征',
	'座佑铭': '座右铭',
	'蓬璧生辉': '蓬荜生辉',
	'大厅广众': '大庭广众',
	'眼花撩乱': '眼花缭乱',
	'斩新': '崭新',
	'朝气篷勃': '朝气蓬勃',
	'膨涨': '膨胀',
	'心浮气燥': '心浮气躁',
	'浮燥': '浮躁',
	'暴燥': '暴躁',
	'急燥': '急躁',
	'烦燥': '烦躁',
	'枯躁': '枯燥',
	'密秘': '秘密',
	'秘决': '秘诀',
	'决窍': '诀窍',
	'水蒸汽': '水蒸气',
	'苍桑': '沧桑',
}

// “好象”→“像” 这类替换会改变句义，必须按整词上下文处理而非词典直换：
// 从词典里移除，改走 CONTEXT_RULES。
delete WRONG_PHRASES['好象']

/**
 * Context-gated confusions: wrong only in the matched collocation.
 * Each rule: global regex + fix(m) building the replacement for m[0].
 */
export const CONTEXT_RULES = [
	{
		regex: /登陆(系统|网站|网页|账号|账户|帐号|平台|页面|界面|邮箱|后台)/g,
		fix: (m) => `登录${m[1]}`,
		reason: '进入系统/账号用「登录」',
	},
	{
		regex: /带(口罩|眼镜|帽子|手表|围巾|耳机|手套|领带)/g,
		fix: (m) => `戴${m[1]}`,
		reason: '穿戴用「戴」',
	},
	{
		regex: /(寻人|寻物|招聘|征文|遗失|招领|更正)启示/g,
		fix: (m) => `${m[1]}启事`,
		reason: '公告文体用「启事」',
	},
	{
		regex: /渡过(?=[^，。！？；\n]{0,8}(?:假期|时光|岁月|日子|周末|童年|青春|晚年|节日|假日))/g,
		fix: () => '度过',
		reason: '经历时间用「度过」',
	},
	{
		regex: /截止(今天|明天|昨天|目前|现在|本周|本月|本年|此时)/g,
		fix: (m) => `截至${m[1]}`,
		reason: '“截至”后接时间点',
	},
	{
		regex: /必需(要)?(做|去|先|完成|配合|遵守|坚持|努力|学习|经过|通过)/g,
		fix: (m) => `必须${m[1] ?? ''}${m[2]}`,
		reason: '后接动词用「必须」',
	},
	{
		regex: /([得地])不能自己/g,
		fix: (m) => `${m[1]}不能自已`,
		reason: '情绪不能自制用「自已」（yǐ）',
	},
	{
		// “好象”整词替换为“好像”，仅在后面不接“形/征/棋/牙”等名词时
		regex: /好象(?!形|征|棋|牙|限)/g,
		fix: () => '好像',
		reason: '表示“如同”用「好像」',
	},
]

/**
 * Mask code fences, inline code spans, and URLs with same-length
 * placeholders so scanners never flag inside them and offsets stay valid.
 * @param {string} text
 * @returns {string} same-length masked text
 */
export function maskForScan(text) {
	let out = String(text ?? '')
	const maskRange = (start, end) => {
		out = out.slice(0, start) + '\u0000'.repeat(end - start) + out.slice(end)
	}
	// fenced code blocks
	const fence = /```[\s\S]*?(```|$)/g
	let m
	while ((m = fence.exec(out)) !== null) maskRange(m.index, m.index + m[0].length)
	// inline code spans
	const inline = /`[^`\n]*`/g
	while ((m = inline.exec(out)) !== null) maskRange(m.index, m.index + m[0].length)
	// URLs
	const url = /https?:\/\/[^\s`]+/g
	while ((m = url.exec(out)) !== null) maskRange(m.index, m.index + m[0].length)
	return out
}

/**
 * Scan text with the offline dictionary.
 * @param {string} text
 * @param {number} [limit=8]
 * @returns {{orig: string, fix: string, offset: number, reason: string, source: 'dict'}[]}
 * sorted by offset, overlap-deduplicated (longer match wins), capped.
 */
export function scanLocalTypos(text, limit = 8) {
	const source = String(text ?? '')
	if (source.length === 0) return []
	const masked = maskForScan(source)
	const found = []
	for (const [wrong, right] of Object.entries(WRONG_PHRASES)) {
		let idx = masked.indexOf(wrong)
		while (idx !== -1) {
			found.push({
				orig: wrong,
				fix: right,
				offset: idx,
				reason: `通常为「${right}」的误写`,
				source: 'dict',
			})
			idx = masked.indexOf(wrong, idx + wrong.length)
		}
	}
	for (const rule of CONTEXT_RULES) {
		rule.regex.lastIndex = 0
		let m
		while ((m = rule.regex.exec(masked)) !== null) {
			if (m[0].includes('\u0000')) continue
			found.push({ orig: m[0], fix: rule.fix(m), offset: m.index, reason: rule.reason, source: 'dict' })
		}
	}
	// overlap dedupe: earlier offset first, longer match wins over shorter
	found.sort((a, b) => a.offset - b.offset || b.orig.length - a.orig.length)
	const out = []
	let covered = -1
	for (const item of found) {
		if (item.offset < covered) continue
		if (out.length >= limit) break
		out.push(item)
		covered = item.offset + item.orig.length
	}
	return out
}
