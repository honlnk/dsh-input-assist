// dsh-input-assist — browser half (client half).
// 布局参考 dsh-composer-enter（双侧插件的浏览器侧接线）与 dsh-voice-input
// （inputActions.setDraft 写草稿）。UI 座位全部 additive：
//   conversation.input.overlay — 仅补全错误提示（建议本体由镜像层 ghost text 渲染）
//   conversation.input.dock    — 错别字导航条（上一个/下一个/修正/标记正确/忽略）
//   conversation.input.right   — 「补 / 校」两个功能开关
//   镜像层（body 挂载）— 文中红字标注错字 + 光标后灰色 ghost 建议（NovAI 同款）
//
// 补全交互（v3 ghost text）：
//   建议以灰字内联在光标后；Tab 逐词采纳（Intl.Segmenter 中文分词）、
//   Shift+Tab 全量采纳、Esc 关闭；逐词采纳期间不重调度（justAccepted 守卫），
//   吃光后自动再请求一轮。IME 组合期一律放行。
//
// 错别字交互（v2）：
//   检出后导航条出现，当前选中的错字在文本中加重高亮（红字 + 底色），
//   其余错字红色波浪线；「修正」只替换当前选中的一条（绝不全量替换）；
//   「标记正确」把该处加入本次输入的忽略名单；快捷键：
//     Ctrl+Shift+,  上一个      Ctrl+Shift+.  下一个
//     Ctrl+Shift+F  修正当前    Ctrl+Shift+G  标记正确
//     Esc           忽略本次（建议条可见时优先关闭建议条）
//   所有快捷键仅在输入框聚焦且有检出时接管；IME 组合期一律放行。
window.__ModuleLoader__.load({
	id: "dsh-input-assist",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let runtimeClient = require("@deepseek-ai/dsh-client-runtime/client");

		const inject = ["slots", "locale", "connection", "remote"];

		const NS = "input-assist";
		const CHANNEL = "/input-assist";

		const DEFAULT_CONFIG = {
			completionEnabled: true,
			completionBaseUrl: "https://api.deepseek.com/beta",
			completionApiKey: "",
			completionModel: "deepseek-chat",
			completionDebounceMs: 800,
			completionMaxTokens: 64,
			proofreadEnabled: true,
			proofreadUseLlm: true,
			proofreadModel: "deepseek-chat",
			proofreadDebounceMs: 800,
			proofreadDictDebounceMs: 200,
		};

		const identity = (v) => v;
		const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
		const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

		// Tab 逐词采纳：每次只吞建议的下一个分词单位（NovAI 同款逻辑）。
		// 纯空白段随下一个实质段一起吞（保英文词间空格）；首个实质段是标点
		// 时与下一个词合并（避免标点单独占一次 Tab）。Intl.Segmenter 缺失时
		// 降级按单个字符。
		const zhSegmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
			? new Intl.Segmenter("zh", { granularity: "word" })
			: null;
		const nextSegment = (text) => {
			if (text === "") return "";
			if (zhSegmenter === null) return text.slice(0, 1);
			const segs = [...zhSegmenter.segment(text)];
			if (segs.length === 0) return "";
			let end = segs[0].segment.length;
			let i = 0;
			while (i < segs.length && segs[i].isWordLike === false && segs[i].segment.trim() === "") {
				i += 1; // 跳过开头空白，连同下一个实质段一起吞
			}
			if (i > 0 && i < segs.length) end = segs[i].index + segs[i].segment.length;
			else if (i === 0 && segs[0].isWordLike === false && segs.length > 1) {
				end = segs[1].index + segs[1].segment.length; // 标点并入下一词
			}
			return text.slice(0, end);
		};

		// ==== DICT-SHARED-BEGIN ====
		// 此标记区间内的代码会被原样内嵌进 lib/client.js（浏览器侧本地词典层），
		// 两端内容必须保持逐字一致；test/dict-sync.test.js 负责校验漂移。
		// 约束：不得使用 import/export / node 内置模块，保持纯 ES2020。
		/** Unambiguous wrong→right word map (common miswritten idioms and words). */
		const WRONG_PHRASES = {
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
		const CONTEXT_RULES = [
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
		function maskForScan(text) {
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
		function scanLocalTypos(text, limit = 8) {
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
		// ==== DICT-SHARED-END ====

		const CSS = [
			".ia_bar{display:flex;align-items:center;gap:8px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;max-width:100%}",
			".ia_err{color:var(--dsw-alias-label-tertiary)}",
			// —— 错别字导航条 ——
			".ia_nav{position:relative;z-index:30;pointer-events:auto;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:5px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:20px}",
			".ia_navTitle{display:flex;align-items:center;gap:5px;color:var(--dsw-alias-label-primary);font-weight:500;white-space:nowrap}",
			".ia_navDot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-accent-danger,#e5484d)}",
			".ia_navPos{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}",
			".ia_navDetail{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;white-space:nowrap}",
			".ia_navOrig{color:var(--dsw-alias-accent-danger,#e5484d);text-decoration:line-through}",
			".ia_navArrow{color:var(--dsw-alias-label-tertiary)}",
			".ia_navFixWord{color:var(--dsw-alias-label-primary);font-weight:500}",
			".ia_navReason{color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis}",
			".ia_spacer{flex:1}",
			".ia_btn{cursor:pointer;pointer-events:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;padding:1px 8px;white-space:nowrap}",
			".ia_btn:hover{background:var(--dsw-interactive-bg-hover)}",
			".ia_btnPrimary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}",
			".ia_btnIcon{cursor:pointer;pointer-events:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;padding:1px 7px;white-space:nowrap}",
			".ia_btnIcon:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-interactive-bg-hover)}",
			".ia_btnGhost{cursor:pointer;pointer-events:auto;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;padding:1px 6px;white-space:nowrap}",
			".ia_btnGhost:hover{color:var(--dsw-alias-label-primary)}",
			".ia_toggle{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;padding:1px 6px}",
			".ia_toggle:hover{color:var(--dsw-alias-label-primary)}",
			".ia_toggle.ia_on{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}",
			// —— 文中红字镜像层 ——
			".ia_mirror{position:fixed;pointer-events:none;overflow:hidden;white-space:pre-wrap;word-break:break-word;color:transparent;z-index:5;margin:0;border:0}",
			".ia_typo{color:var(--dsw-alias-accent-danger,#e5484d);text-decoration:underline wavy var(--dsw-alias-accent-danger,#e5484d) 1px;text-underline-offset:3px;pointer-events:auto;cursor:pointer;border-radius:2px}",
			".ia_typoCur{background:color-mix(in srgb,var(--dsw-alias-accent-danger,#e5484d) 18%,transparent)}",
			// —— ghost text（内联补全，NovAI 风格）——
			".ia_ghost{color:var(--dsw-alias-label-tertiary)}",
		].join("");
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify("dsh-input-assist/ui.css") + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-input-assist";
			tag.dataset.pluginCss = "dsh-input-assist/ui.css";
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// —— 状态与 RPC（apply 内创建，组件经 hooks 注入共享）——
		let assistStore = null;
		let configStore = null;
		let connectionRef = null;
		let inputActionsRef = null;
		let mirrorEl = null;

		const setAssist = (patch) => {
			assistStore.set({ ...assistStore.getSnapshot(), ...patch });
		};

		const rpc = (endpoint, payload) => connectionRef.rpc.call(CHANNEL, endpoint, payload);

		const loadConfig = async () => {
			try {
				const res = await rpc("config.get", {});
				if (res !== undefined && res.ok === true && isObj(res.value)) {
					configStore.set({ ...configStore.getSnapshot(), ...res.value });
				}
			} catch (_err) {
				/* 宿主未就绪时保持默认 */
			}
		};

		const persistConfig = async (patch) => {
			configStore.set({ ...configStore.getSnapshot(), ...patch });
			try {
				const res = await rpc("config.set", patch);
				if (res !== undefined && res.ok === true && isObj(res.value)) {
					configStore.set({ ...configStore.getSnapshot(), ...res.value });
				}
			} catch (_err) {
				/* 写失败保持乐观值 */
			}
		};

		const debug = (patch) => {
			try {
				window.__iaDebug = { ...(window.__iaDebug ?? {}), ...patch };
			} catch (_err) { /* 无 window 环境 */ }
		};

		// —— 调度：三路独立防抖，结果带 rev 戳防陈旧 ——
		//   dict 层本地扫描（proofreadDictDebounceMs，默认 200ms，零成本即时标红）
		//   completion / LLM 校对统一 800ms，两个 AI 请求几乎同时发出同时回来
		let completionTimer = 0;
		let dictTimer = 0;
		let llmTimer = 0;
		let completionSeq = 0;
		let dictSeq = 0;
		let llmSeq = 0;

		const findTextarea = () => {
			const el = document.querySelector("[data-composer-card] textarea");
			return el instanceof HTMLTextAreaElement ? el : null;
		};

		const composerCaret = () => {
			const el = findTextarea();
			if (el !== null && typeof el.selectionStart === "number") return el.selectionStart;
			return null;
		};

		/** 光标所在行以 / 或 @ 开头（斜杠菜单、@ 引用）时不触发补全。 */
		const lineStartsWithTrigger = (draft, caret) => {
			const before = draft.slice(0, caret);
			const line = before.slice(before.lastIndexOf("\n") + 1).trimStart();
			return line.startsWith("/") || line.startsWith("@");
		};

		// 合并词典层与 LLM 层检出：词典优先，重叠剔除，按位置排序（与
		// lib/proofread-llm.js 的 mergeIssues 同逻辑，浏览器侧无 import 故内联）
		const mergeIssues = (local, llm, limit = 8) => {
			const out = [...(Array.isArray(local) ? local : [])];
			for (const item of Array.isArray(llm) ? llm : []) {
				const s = item.offset;
				const e = s + item.orig.length;
				const clashes = out.some((it) => s < it.offset + it.orig.length && it.offset < e);
				if (!clashes) out.push(item);
			}
			out.sort((a, b) => a.offset - b.offset);
			return out.slice(0, limit);
		};

		// —— 错别字导航：有效检出 = 位置仍对得上当前草稿 且 未被标记正确 ——
		const effectiveIssues = () => {
			const a = assistStore.getSnapshot();
			const merged = mergeIssues(a.dictIssues, a.llmIssues);
			if (merged.length === 0) return [];
			const ta = findTextarea();
			const text = ta !== null ? ta.value : "";
			if (text === "") return [];
			const ignored = Array.isArray(a.ignored) ? a.ignored : [];
			return merged.filter((it) =>
				text.slice(it.offset, it.offset + it.orig.length) === it.orig &&
				!ignored.some((g) => g.offset === it.offset && g.orig === it.orig),
			);
		};

		const navActive = () => {
			const a = assistStore.getSnapshot();
			return configStore.getSnapshot().proofreadEnabled && a.dismissedRev !== a.issueRev && effectiveIssues().length > 0;
		};

		const navMove = (delta) => {
			const eff = effectiveIssues();
			if (eff.length === 0) return;
			const a = assistStore.getSnapshot();
			const cur = typeof a.issueIndex === "number" ? a.issueIndex : 0;
			setAssist({ issueIndex: (cur + delta + eff.length) % eff.length });
		};

		const navFixCurrent = () => {
			const eff = effectiveIssues();
			if (eff.length === 0) return;
			const a = assistStore.getSnapshot();
			const issue = eff[Math.min(typeof a.issueIndex === "number" ? a.issueIndex : 0, eff.length - 1)];
			const ta = findTextarea();
			if (ta === null) return;
			const text = ta.value;
			if (text.slice(issue.offset, issue.offset + issue.orig.length) !== issue.orig) return; // 位置已失效
			if (inputActionsRef !== null && inputActionsRef !== undefined && typeof inputActionsRef.setDraft === "function") {
				inputActionsRef.setDraft(text.slice(0, issue.offset) + issue.fix + text.slice(issue.offset + issue.orig.length));
			} else {
				ta.focus();
				ta.setSelectionRange(issue.offset, issue.offset + issue.orig.length);
				try { document.execCommand("insertText", false, issue.fix); } catch (_err) { /* 静默 */ }
			}
			setAssist({ issueIndex: 0 });
		};

		const navMarkCorrect = () => {
			const eff = effectiveIssues();
			if (eff.length === 0) return;
			const a = assistStore.getSnapshot();
			const issue = eff[Math.min(typeof a.issueIndex === "number" ? a.issueIndex : 0, eff.length - 1)];
			setAssist({
				ignored: [...(Array.isArray(a.ignored) ? a.ignored : []), { offset: issue.offset, orig: issue.orig }],
				issueIndex: 0,
			});
		};

		// —— 文中红字镜像层 ——
		const mirrorStyleProps = ["fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight", "textRendering", "textTransform", "tabSize", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "overflowWrap", "wordBreak"];

		const copyMirrorMetrics = (ta, el) => {
			const cs = getComputedStyle(ta);
			for (const prop of mirrorStyleProps) el.style[prop] = cs[prop];
			el.style.boxSizing = "border-box";
			const rect = ta.getBoundingClientRect();
			el.style.left = `${rect.left + ta.clientLeft}px`;
			el.style.top = `${rect.top + ta.clientTop}px`;
			el.style.width = `${ta.clientWidth}px`;
			el.style.height = `${ta.clientHeight}px`;
			el.scrollTop = ta.scrollTop;
			el.scrollLeft = ta.scrollLeft;
		};

		const ensureMirror = () => {
			if (mirrorEl !== null) return mirrorEl;
			mirrorEl = document.createElement("div");
			mirrorEl.className = "ia_mirror";
			mirrorEl.setAttribute("data-input-assist", "mirror");
			mirrorEl.addEventListener("click", (e) => {
				const span = e.target instanceof Element ? e.target.closest(".ia_typo") : null;
				if (span === null) return;
				const off = Number(span.getAttribute("data-ia-off"));
				const eff = effectiveIssues();
				const idx = eff.findIndex((it) => it.offset === off);
				if (idx !== -1) setAssist({ issueIndex: idx });
			});
			document.body.appendChild(mirrorEl);
			return mirrorEl;
		};

		// —— 镜像层：错别字红字 + ghost text 共用 ——
		// textarea 自己渲染真实文字（正常色）；镜像层把已输入文字渲染为透明
		// span 仅撑布局（错别字处叠红字、末尾叠灰色 ghost 建议），与 NovAI
		// 的 GhostTextOverlay 同构：已输入部分 invisible 占位，建议自然落在
		// 光标后。ghost 插在文本末尾而非真实光标处——textarea 有建议时用户
		// 光标恒在末尾（点击中间会丢建议），且 suffix 场景 v1 不支持。
		const ghostVisible = () => {
			const a = assistStore.getSnapshot();
			const cfg = configStore.getSnapshot();
			return cfg.completionEnabled && a.suggestion !== "" && a.sugDraft === (findTextarea()?.value ?? null);
		};

		const syncMirror = () => {
			if (typeof document === "undefined") return;
			const ta = findTextarea();
			const typos = ta !== null && navActive();
			const ghost = ta !== null && ghostVisible();
			if (!typos && !ghost) {
				if (mirrorEl !== null) mirrorEl.style.display = "none";
				return;
			}
			const el = ensureMirror();
			el.style.display = "block";
			copyMirrorMetrics(ta, el);
			const eff = typos ? effectiveIssues() : [];
			const a = assistStore.getSnapshot();
			const curIdx = Math.min(typeof a.issueIndex === "number" ? a.issueIndex : 0, eff.length - 1);
			const text = ta.value;
			let html = "";
			let pos = 0;
			for (let i = 0; i < eff.length; i += 1) {
				const it = eff[i];
				if (it.offset > pos) html += escHtml(text.slice(pos, it.offset));
				html += `<span class="ia_typo${i === curIdx ? " ia_typoCur" : ""}" data-ia-off="${it.offset}">${escHtml(text.slice(it.offset, it.offset + it.orig.length))}</span>`;
				pos = it.offset + it.orig.length;
			}
			html += escHtml(text.slice(pos));
			if (ghost) html += `<span class="ia_ghost">${escHtml(a.suggestion)}</span>`;
			el.innerHTML = html;
			el.scrollTop = ta.scrollTop;
			el.scrollLeft = ta.scrollLeft;
		};

		function onDraftChanged(draft, rev) {
			const cfg = configStore.getSnapshot();
			const caret = composerCaret() ?? draft.length;
			const completionActive =
				cfg.completionEnabled && draft.trim().length >= 2 && !lineStartsWithTrigger(draft, caret);
			debug({ onDraftChanged: true, draftLen: draft.length, rev, completionActive });

			// 逐词采纳部分接受时：草稿变化源于我们自己，保留剩余建议且不重调度
			// （避免 ghost 闪烁）；建议已吃光时正常调度，立刻续出下一段（NovAI 同款）
			const justAccepted = assistStore.getSnapshot().suggestion !== "" &&
				assistStore.getSnapshot().sugDraft === draft;

			clearTimeout(completionTimer);
			completionSeq += 1;
			const cSeq = completionSeq;
			if (!completionActive) {
				setAssist({ suggestion: "", fetching: false, sugRev: -1 });
			} else if (!justAccepted) {
				completionTimer = setTimeout(async () => {
					setAssist({ fetching: true });
					try {
						const res = await rpc("complete", { prefix: draft.slice(0, caret), suffix: draft.slice(caret) });
						debug({ completionRes: res });
						if (cSeq !== completionSeq) return;
						if (res !== undefined && res.ok === true) {
							const reason = res.value?.reason ?? "";
							setAssist({
								suggestion: reason === "" && typeof res.value?.text === "string" ? res.value.text : "",
								sugRev: rev,
								sugDraft: draft,
								sugCaret: caret,
								fetching: false,
								error: reason,
								errorRev: reason === "" ? -1 : rev,
							});
						} else {
							setAssist({
								suggestion: "",
								fetching: false,
								error: res?.error?.message ?? "completion failed",
								errorRev: rev,
							});
						}
					} catch (_err) {
						debug({ completionErr: String(_err && _err.message ? _err.message : _err) });
						if (cSeq === completionSeq) setAssist({ suggestion: "", fetching: false });
					}
				}, cfg.completionDebounceMs);
			}

			// —— 错别字：两层拆分 ——
			//   词典层：浏览器本地扫描，200ms 防抖，即时标红、零成本、不发 RPC
			//   LLM 层：host 侧请求，800ms 防抖（与补全同节奏），结果叠加到词典之上
			const proofActive = cfg.proofreadEnabled && draft.trim().length >= 4;
			clearTimeout(dictTimer);
			clearTimeout(llmTimer);
			dictSeq += 1;
			llmSeq += 1;
			const dSeq = dictSeq;
			const pSeq = llmSeq;
			if (!proofActive) {
				setAssist({ dictIssues: [], llmIssues: [], checking: false, issueIndex: 0, ignored: [] });
			} else {
				dictTimer = setTimeout(() => {
					if (dSeq !== dictSeq) return;
					setAssist({ dictIssues: scanLocalTypos(draft), issueRev: rev, issueIndex: 0 });
				}, cfg.proofreadDictDebounceMs);
				if (cfg.proofreadUseLlm !== false) {
					llmTimer = setTimeout(async () => {
						setAssist({ checking: true });
						try {
							const res = await rpc("proofread", { text: draft, llmOnly: true });
							debug({ proofRes: res });
							if (pSeq !== llmSeq) return;
							setAssist({
								llmIssues: res !== undefined && res.ok === true && Array.isArray(res.value?.issues) ? res.value.issues : [],
								issueRev: rev,
								checking: false,
							});
						} catch (_err) {
							if (pSeq === llmSeq) setAssist({ checking: false });
						}
					}, cfg.proofreadDebounceMs);
				} else {
					setAssist({ llmIssues: [] });
				}
			}
		}

		// —— 组件 ——
		// ghost text 模式下建议本体由镜像层渲染（灰色内联在光标后），这里只剩
		// 一条超薄快捷键提示；loading / 错误仍走原样式条。
		function SuggestBar(props) {
			const { useInput, inputActions, useAssist, useConfig, t } = props;
			if (typeof useInput !== "function") return null;
			const draft = useInput((s) => s.draft);
			const rev = useInput((s) => s.draftRev);
			const assist = useAssist(identity);
			const cfg = useConfig(identity);
			if (inputActions !== undefined && inputActions !== null) inputActionsRef = inputActions;
			react.useEffect(() => {
				onDraftChanged(draft, rev);
			}, [draft, rev]);
			const visible = assist.suggestion !== "" && assist.sugRev === rev;
			// 建议可见性变化时同步镜像层（ghost 出现/消失都走这里）；
			// completionEnabled 开关变化也要重同步（关掉时摘掉残留 ghost）
			react.useEffect(() => {
				syncMirror();
			}, [visible, assist.suggestion, draft, cfg.completionEnabled]);
			if (!cfg.completionEnabled) return null;
			// ghost text 模式下建议本体全由镜像层渲染，这里不渲染任何可见内容
			// （NovAI 同款：零浮层）。overlay 插槽只保留错误提示（如 no-api-key）。
			const showError = assist.error !== "" && assist.errorRev === rev;
			if (!showError) return null;
			const msg = assist.error === "no-api-key" ? t("error.noApiKey") : String(assist.error).slice(0, 90);
			return react.createElement("div", { className: "ia_bar", "data-input-assist": "suggest" },
				react.createElement("span", { key: "err", className: "ia_err" }, "input-assist: " + msg),
			);
		}

		function TypoNav(props) {
			const { useInput, inputActions, useAssist, useConfig, t, api } = props;
			if (typeof useAssist !== "function") return null;
			const assist = useAssist(identity);
			const cfg = useConfig(identity);
			const draft = typeof useInput === "function" ? useInput((s) => s.draft) : "";
			if (inputActions !== undefined && inputActions !== null) inputActionsRef = inputActions;
			// 以草稿文本为准计算有效检出（词典层+LLM 层合并后，位置失配/已标记正确的剔除）
			const issues = mergeIssues(assist.dictIssues, assist.llmIssues);
			const ignored = Array.isArray(assist.ignored) ? assist.ignored : [];
			const eff = draft === "" ? [] : issues.filter((it) =>
				draft.slice(it.offset, it.offset + it.orig.length) === it.orig &&
				!ignored.some((g) => g.offset === it.offset && g.orig === it.orig),
			);
			const dismissed = assist.dismissedRev === assist.issueRev;
			const show = cfg.proofreadEnabled && !dismissed && eff.length > 0;
			// 渲染后同步镜像层（草稿/检出/选中项/忽略变化都会走到这里）
			react.useEffect(() => {
				syncMirror();
				return () => { if (mirrorEl !== null) mirrorEl.style.display = "none"; };
			}, [draft, assist.dictIssues, assist.llmIssues, assist.issueIndex, assist.ignored, dismissed, cfg.proofreadEnabled]);
			if (!show) return null;
			const curIdx = Math.min(typeof assist.issueIndex === "number" ? assist.issueIndex : 0, eff.length - 1);
			const cur = eff[curIdx];
			const btn = (key, label, title, className, onClick) =>
				react.createElement("button", { type: "button", key, className, title, onClick }, label);
			return react.createElement("div", { className: "ia_nav", "data-input-assist": "proofread" },
				react.createElement("span", { key: "title", className: "ia_navTitle" },
					react.createElement("span", { className: "ia_navDot" }),
					t("proofread.title"),
				),
				btn("prev", "‹", t("proofread.prevHint"), "ia_btnIcon", () => api?.navMove?.(-1)),
				react.createElement("span", { key: "pos", className: "ia_navPos" }, `${curIdx + 1}/${eff.length}`),
				btn("next", "›", t("proofread.nextHint"), "ia_btnIcon", () => api?.navMove?.(1)),
				react.createElement("span", { key: "detail", className: "ia_navDetail" },
					react.createElement("span", { className: "ia_navOrig" }, cur.orig),
					react.createElement("span", { className: "ia_navArrow" }, "→"),
					react.createElement("span", { className: "ia_navFixWord" }, cur.fix),
					cur.reason ? react.createElement("span", { className: "ia_navReason" }, cur.reason) : null,
				),
				react.createElement("span", { key: "spacer", className: "ia_spacer" }),
				btn("fix", t("proofread.fix"), t("proofread.fixHint"), "ia_btn ia_btnPrimary", () => api?.navFixCurrent?.()),
				btn("correct", t("proofread.markCorrect"), t("proofread.markCorrectHint"), "ia_btn", () => api?.navMarkCorrect?.()),
				btn("dismiss", t("proofread.dismiss"), t("proofread.dismissHint"), "ia_btnGhost", () => api?.dismissIssues?.()),
			);
		}

		function ToggleControl({ useConfig, t, api }) {
			const cfg = useConfig(identity);
			const btn = (key, label, titleKey) =>
				react.createElement("button", {
					type: "button",
					key: key,
					className: cfg[key] ? "ia_toggle ia_on" : "ia_toggle",
					title: t(titleKey),
					onClick: () => api.toggle(key),
				}, label);
			return react.createElement("div", { className: "ia_toggles", "data-input-assist": "toggle" },
				btn("completionEnabled", "补", "toggle.completion"),
				btn("proofreadEnabled", "校", "toggle.proofread"),
			);
		}

		function apply(ctx) {
			const slots = ctx.get("slots");
			const locale = ctx.get("locale");
			const connection = ctx.get("connection");
			const remote = ctx.get("remote");
			if (slots === undefined || locale === undefined || connection === undefined) return;
			connectionRef = connection;

			assistStore = runtimeClient.createSnapshotStore({
				suggestion: "",
				sugRev: -1,
				sugDraft: "",
				sugCaret: 0,
				fetching: false,
				dictIssues: [],
				llmIssues: [],
				issueRev: -1,
				issueIndex: 0,
				ignored: [],
				checking: false,
				error: "",
				errorRev: -1,
				dismissedRev: -1,
			});
			configStore = runtimeClient.createSnapshotStore({ ...DEFAULT_CONFIG });

			ctx.effect(() => locale.register(NS, {
				zh: {
					"toggle.completion": "输入补全开/关",
					"toggle.proofread": "错别字检查开/关",
					"error.noApiKey": "input-assist：未配置 API Key（settings.yaml → input-assist.completionApiKey，或 dsh 已保存的 DEEPSEEK_API_KEY）",
					"proofread.title": "疑似错别字",
					"proofread.fix": "修正",
					"proofread.fixHint": "修正当前选中项（Ctrl+Shift+F）",
					"proofread.markCorrect": "标记正确",
					"proofread.markCorrectHint": "本次输入中该处不算错误，不替换（Ctrl+Shift+G）",
					"proofread.dismiss": "忽略",
					"proofread.dismissHint": "本次输入不再提醒（Esc）",
					"proofread.prevHint": "上一个（Ctrl+Shift+,）",
					"proofread.nextHint": "下一个（Ctrl+Shift+.）",
				},
				en: {
					"toggle.completion": "Toggle input completion",
					"toggle.proofread": "Toggle typo checking",
					"error.noApiKey": "input-assist: API key missing (settings.yaml → input-assist.completionApiKey, or dsh-stored DEEPSEEK_API_KEY)",
					"proofread.title": "Possible typos",
					"proofread.fix": "Fix",
					"proofread.fixHint": "Fix the selected occurrence only (Ctrl+Shift+F)",
					"proofread.markCorrect": "Mark correct",
					"proofread.markCorrectHint": "Treat this occurrence as correct for this draft (Ctrl+Shift+G)",
					"proofread.dismiss": "Dismiss",
					"proofread.dismissHint": "Stop reminding for this draft (Esc)",
					"proofread.prevHint": "Previous (Ctrl+Shift+,)",
					"proofread.nextHint": "Next (Ctrl+Shift+.)",
				},
			}), "input-assist: dictionaries");

			const typoApi = {
				navMove,
				navFixCurrent,
				navMarkCorrect,
				dismissIssues: () => setAssist({ dismissedRev: assistStore.getSnapshot().issueRev }),
			};
			// 调试钩子：真实浏览器控制台可用 window.__iaApi.navMove(1) 等直接驱动
			try { window.__iaApi = typoApi; } catch (_err) { /* 无 window 环境 */ }

			slots.inject("conversation.input.overlay", () => slots.register({
				name: "conversation.input.overlay",
				id: "input-assist-suggest",
				order: 200,
				locale: NS,
				inject: () => ({ hooks: { assist: assistStore, config: configStore } }),
			}, SuggestBar));

			slots.inject("conversation.input.dock", () => slots.register({
				name: "conversation.input.dock",
				id: "input-assist-proofread",
				order: 80,
				locale: NS,
				inject: () => ({ hooks: { assist: assistStore, config: configStore }, api: typoApi }),
			}, TypoNav));

			slots.inject("conversation.input.right", () => slots.register({
				name: "conversation.input.right",
				id: "input-assist-toggle",
				order: 40,
				locale: NS,
				inject: () => ({
					hooks: { config: configStore },
					api: { toggle: (key) => persistConfig({ [key]: !configStore.getSnapshot()[key] }) },
				}),
			}, ToggleControl));

			if (remote !== undefined) {
				ctx.effect(() => remote.$on("settings/document-updated", (ns) => {
					if (ns === NS) loadConfig();
				}), "input-assist: settings document watcher");
			}
			loadConfig();

			// 滚动/缩放时重同步镜像层（capture 捕获 textarea 滚动）
			const onViewportChange = () => { syncMirror(); };
			ctx.effect(() => {
				window.addEventListener("scroll", onViewportChange, true);
				window.addEventListener("resize", onViewportChange);
				return () => {
					window.removeEventListener("scroll", onViewportChange, true);
					window.removeEventListener("resize", onViewportChange);
					if (mirrorEl !== null) { mirrorEl.remove(); mirrorEl = null; }
				};
			}, "input-assist: mirror viewport sync");

			// 键盘拦截（捕获阶段）：
			//   Tab/Esc        — 补全建议采纳/关闭（仅建议可见且对应当前草稿时）
			//   Ctrl+Shift 组合 — 错别字导航（仅输入框聚焦且有检出时）
			const onKeyDown = (e) => {
				if (e.isComposing || e.keyCode === 229) return; // 输入法组合期放行
				if (e.ctrlKey || e.metaKey || e.altKey) debug({ lastKey: { key: e.key, code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey, inComposer: e.target instanceof HTMLTextAreaElement } });
				const target = e.target;
				if (!(target instanceof HTMLTextAreaElement)) return;
				if (target.closest("[data-composer-card]") === null) return;
				const assist = assistStore.getSnapshot();

				// —— 错别字导航快捷键 ——
				if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
					const key = e.key;
					let handled = false;
					if (key === "," || key === "<") { if (navActive()) { navMove(-1); handled = true; } }
					else if (key === "." || key === ">") { if (navActive()) { navMove(1); handled = true; } }
					else if (key === "F" || key === "f") { if (navActive()) { navFixCurrent(); handled = true; } }
					else if (key === "G" || key === "g") { if (navActive()) { navMarkCorrect(); handled = true; } }
					if (handled) {
						e.preventDefault();
						e.stopPropagation();
						return;
					}
				}

				// —— 补全 Tab 逐词采纳 / Esc（建议优先）——
				if (assist.suggestion === "" || assist.sugDraft !== target.value) {
					// 无建议时 Esc 仍可忽略本次错别字提醒
					if (e.key === "Escape" && navActive()) {
						e.preventDefault();
						e.stopPropagation();
						setAssist({ dismissedRev: assistStore.getSnapshot().issueRev });
					}
					return;
				}
				if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
					e.preventDefault();
					e.stopPropagation();
					// 逐词采纳：只吞下一个分词单位；Shift+Tab 全量采纳
					const chunk = e.shiftKey ? assist.suggestion : nextSegment(assist.suggestion);
					if (chunk === "") return;
					const caret = typeof target.selectionStart === "number" ? target.selectionStart : target.value.length;
					const next = target.value.slice(0, caret) + chunk + target.value.slice(caret);
					const rest = assist.suggestion.slice(chunk.length);
					if (inputActionsRef !== null && inputActionsRef !== undefined && typeof inputActionsRef.setDraft === "function") {
						inputActionsRef.setDraft(next);
					} else {
						target.focus();
						try { document.execCommand("insertText", false, chunk); } catch (_err) { /* 静默 */ }
					}
					if (rest === "") {
						// 吃光了：清建议；setDraft 触发的 onDraftChanged 会自动再调度一轮
						setAssist({ suggestion: "", fetching: false, sugRev: -1 });
					} else {
						// 剩余建议继续显示；onDraftChanged 里 justAccepted 守卫会跳过这次重调度
						setAssist({ suggestion: rest, sugDraft: next });
					}
					return;
				}
				if (e.key === "Escape") {
					e.preventDefault();
					e.stopPropagation();
					setAssist({ suggestion: "", fetching: false, sugRev: -1 });
				}
			};
			ctx.effect(() => {
				document.addEventListener("keydown", onKeyDown, true);
				return () => document.removeEventListener("keydown", onKeyDown, true);
			}, "input-assist: keydown interceptor");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
