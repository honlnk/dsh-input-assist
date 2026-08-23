// dsh-input-assist — browser half (client half).
// 布局参考 dsh-composer-enter（双侧插件的浏览器侧接线）与 dsh-voice-input
// （inputActions.setDraft 写草稿）。UI 座位全部 additive：
//   conversation.input.overlay — 补全建议条（⇥ Tab 采纳 · Esc 关闭）
//   conversation.input.dock    — 错别字导航条（上一个/下一个/修正/标记正确/忽略）
//   conversation.input.right   — 「补 / 校」两个功能开关
//   镜像层（body 挂载）— 在输入框文本上以红色波浪线标注错字，点击可选中
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
			completionDebounceMs: 600,
			completionMaxTokens: 64,
			proofreadEnabled: true,
			proofreadUseLlm: true,
			proofreadModel: "deepseek-chat",
			proofreadDebounceMs: 1000,
		};

		const identity = (v) => v;
		const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
		const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

		const CSS = [
			".ia_bar{display:flex;align-items:center;gap:8px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;max-width:100%}",
			".ia_barText{color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:44em}",
			".ia_barHint{display:flex;align-items:center;gap:4px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
			".ia_key{border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 4px;font-size:11px}",
			".ia_spin{flex:none;width:10px;height:10px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:ia_rot .8s linear infinite}",
			"@keyframes ia_rot{to{transform:rotate(360deg)}}",
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

		// —— 调度：两路独立防抖，结果带 rev 戳防陈旧 ——
		let completionTimer = 0;
		let proofTimer = 0;
		let completionSeq = 0;
		let proofSeq = 0;

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

		// —— 错别字导航：有效检出 = 位置仍对得上当前草稿 且 未被标记正确 ——
		const effectiveIssues = () => {
			const a = assistStore.getSnapshot();
			if (!Array.isArray(a.issues) || a.issues.length === 0) return [];
			const ta = findTextarea();
			const text = ta !== null ? ta.value : "";
			if (text === "") return [];
			const ignored = Array.isArray(a.ignored) ? a.ignored : [];
			return a.issues.filter((it) =>
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

		const syncMirror = () => {
			if (typeof document === "undefined") return;
			const ta = findTextarea();
			const active = ta !== null && navActive();
			if (!active) {
				if (mirrorEl !== null) mirrorEl.style.display = "none";
				return;
			}
			const el = ensureMirror();
			el.style.display = "block";
			copyMirrorMetrics(ta, el);
			const eff = effectiveIssues();
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

			clearTimeout(completionTimer);
			completionSeq += 1;
			const cSeq = completionSeq;
			if (!completionActive) {
				setAssist({ suggestion: "", fetching: false, sugRev: -1 });
			} else {
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

			const proofActive = cfg.proofreadEnabled && draft.trim().length >= 4;
			clearTimeout(proofTimer);
			proofSeq += 1;
			const pSeq = proofSeq;
			if (!proofActive) {
				setAssist({ issues: [], checking: false, issueIndex: 0, ignored: [] });
			} else {
				proofTimer = setTimeout(async () => {
					setAssist({ checking: true });
					try {
						const res = await rpc("proofread", { text: draft });
						debug({ proofRes: res });
						if (pSeq !== proofSeq) return;
						setAssist({
							issues: res !== undefined && res.ok === true && Array.isArray(res.value?.issues) ? res.value.issues : [],
							issueRev: rev,
							checking: false,
							issueIndex: 0,
						});
					} catch (_err) {
						if (pSeq === proofSeq) setAssist({ checking: false });
					}
				}, cfg.proofreadDebounceMs);
			}
		}

		// —— 组件 ——
		function SuggestBar(props) {
			const { useInput, inputActions, useAssist, useConfig, t } = props;
			debug({
				suggestRendered: true,
				propKeys: Object.keys(props).sort().join(","),
				hasUseInput: typeof useInput,
				hasInputActions: typeof inputActions,
				hasUseAssist: typeof useAssist,
			});
			if (typeof useInput !== "function") return null;
			const draft = useInput((s) => s.draft);
			const rev = useInput((s) => s.draftRev);
			const assist = useAssist(identity);
			const cfg = useConfig(identity);
			if (inputActions !== undefined && inputActions !== null) inputActionsRef = inputActions;
			react.useEffect(() => {
				onDraftChanged(draft, rev);
			}, [draft, rev]);
			if (!cfg.completionEnabled) return null;
			const visible = assist.suggestion !== "" && assist.sugRev === rev;
			const showError = assist.error !== "" && assist.errorRev === rev;
			if (!visible && !assist.fetching && !showError) return null;
			const children = [];
			if (assist.fetching) {
				children.push(react.createElement("span", { key: "spin", className: "ia_spin" }));
				children.push(react.createElement("span", { key: "loading" }, t("suggest.loading")));
			} else if (visible) {
				children.push(react.createElement("span", { key: "text", className: "ia_barText" }, assist.suggestion));
				children.push(
					react.createElement("span", { key: "hint", className: "ia_barHint" },
						react.createElement("kbd", { className: "ia_key" }, "Tab"),
						t("suggest.accept"),
						react.createElement("kbd", { className: "ia_key" }, "Esc"),
						t("suggest.close"),
					),
				);
			} else if (showError) {
				const msg = assist.error === "no-api-key" ? t("error.noApiKey") : String(assist.error).slice(0, 90);
				children.push(react.createElement("span", { key: "err", className: "ia_err" }, "input-assist: " + msg));
			}
			return react.createElement("div", { className: "ia_bar", "data-input-assist": "suggest" }, children);
		}

		function TypoNav(props) {
			const { useInput, inputActions, useAssist, useConfig, t, api } = props;
			if (typeof useAssist !== "function") return null;
			const assist = useAssist(identity);
			const cfg = useConfig(identity);
			const draft = typeof useInput === "function" ? useInput((s) => s.draft) : "";
			if (inputActions !== undefined && inputActions !== null) inputActionsRef = inputActions;
			// 以草稿文本为准计算有效检出（位置失配/已标记正确的剔除）
			const issues = Array.isArray(assist.issues) ? assist.issues : [];
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
			}, [draft, assist.issues, assist.issueIndex, assist.ignored, dismissed, cfg.proofreadEnabled]);
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
				issues: [],
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
					"suggest.loading": "正在生成建议…",
					"suggest.accept": "采纳",
					"suggest.close": "关闭",
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
					"suggest.loading": "Generating suggestion…",
					"suggest.accept": "Accept",
					"suggest.close": "Close",
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

				// —— 补全 Tab 采纳 / Esc（建议条优先）——
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
					const caret = typeof target.selectionStart === "number" ? target.selectionStart : target.value.length;
					const next = target.value.slice(0, caret) + assist.suggestion + target.value.slice(caret);
					if (inputActionsRef !== null && inputActionsRef !== undefined && typeof inputActionsRef.setDraft === "function") {
						inputActionsRef.setDraft(next);
					} else {
						target.focus();
						try { document.execCommand("insertText", false, assist.suggestion); } catch (_err) { /* 静默 */ }
					}
					setAssist({ suggestion: "", fetching: false, sugRev: -1 });
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
