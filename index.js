// Credit Ledger — tracks API spend per "wallet" and shows remaining balance.
//
// Design rules:
//  - The fetch hook is pass-through: it only reads response.clone() in the
//    background and never changes requests or responses.
//  - No API key is ever handled here. Real balances come from the optional
//    server plugin (plugins/credit-ledger), which uses keys ST already stores.
//  - Everything is wrapped in try/catch: a bug here must never break chatting.

const MODULE = 'creditLedger';
const PLUGIN = '/api/plugins/credit-ledger';
const GEN_PATH = '/api/backends/chat-completions/generate';
const MAX_ENTRIES = 800;
const DAILY_KEEP_DAYS = 62;
const AUTO_DELAY_MS = 10_000;
const AUTO_MIN_GAP_MS = 60_000;

const TYPES = {
    vertex: { label: 'Google Vertex AI', lookup: false, source: 'vertexai' },
    gemini: { label: 'Google AI Studio (Gemini 키)', lookup: false, source: 'makersuite' },
    deepseek: { label: 'DeepSeek 공식', lookup: true, source: 'deepseek' },
    newapi: { label: '프록시 (NewAPI/OneAPI 계열)', lookup: true, source: null },
    manual: { label: '기타 (단가로만 계산)', lookup: false, source: null },
};

// USD per 1M tokens. Defaults are a starting point only — the user can edit
// them. "in2/out2" apply when the prompt is over "over" tokens.
// "from"/"to" (YYYY-MM-DD, inclusive) limit a row to a date range, so a
// promotion and the regular price can both be listed.
const DEFAULT_PRICES = [
    { model: 'gemini-4-argon', in: 2, out: 10, cached: 0.10, to: '2026-11-30', note: '50% 프로모션' },
    { model: 'gemini-4-argon', in: 4, out: 20, cached: 0.20, from: '2026-12-01', note: '정상가' },
    { model: 'gemini-4-carbon', in: 2, out: 10, cached: 0.10, to: '2026-11-30', note: '50% 프로모션' },
    { model: 'gemini-4-carbon', in: 4, out: 20, cached: 0.20, from: '2026-12-01', note: '정상가' },
    { model: 'gemini-4-neon', in: 3, out: 15, cached: 0.15 },
    { model: 'gemini-4-hydrogen', in: 1.5, out: 7.5, cached: 0.075 },
    { model: 'gemini-3.8-flash', in: 0.75, out: 3.75, cached: 0.075, to: '2026-12-31', note: '50% 프로모션' },
    { model: 'gemini-3.8-flash', in: 1.5, out: 7.5, cached: 0.15, from: '2027-01-01', note: '정상가' },
    { model: 'gemini-3.1-pro', in: 2, out: 12, cached: 0.20, over: 200000, in2: 4, out2: 18 },
    { model: 'gemini-3-pro', in: 2, out: 12, cached: 0.20, over: 200000, in2: 4, out2: 18 },
    { model: 'gemini-3-flash', in: 0.50, out: 3, cached: 0.05 },
    { model: 'gemini-2.5-pro', in: 1.25, out: 10, cached: 0.125, over: 200000, in2: 2.5, out2: 15 },
    { model: 'gemini-2.5-flash', in: 0.30, out: 2.50, cached: 0.03 },
    { model: 'gemini-2.5-flash-lite', in: 0.10, out: 0.40, cached: 0.01 },
];
const PRICES_VERSION = 2;

const defaultSettings = Object.freeze({
    showChip: true,
    notify: true,
    autoCalib: true,
    showChat: true,
    showExt: true,
    showGen: true,
    showModel: false,
    wallets: [],
    prices: DEFAULT_PRICES,
    pricesVersion: PRICES_VERSION,
    entries: [],
    unpriced: [],
    originRules: [],
});

const ctx = () => SillyTavern.getContext();
let S = null;
let pluginOk = null;
let sourcesCache = null;
const refreshTimers = new Map();
const refreshing = new Set();

// ------------------------------------------------------------ settings

function settings() {
    const es = ctx().extensionSettings;
    if (!es[MODULE]) es[MODULE] = structuredClone(defaultSettings);
    // Read before defaults are filled in: settings from 1.0.x have no version.
    if (!Object.hasOwn(es[MODULE], 'pricesVersion')) es[MODULE].pricesVersion = 1;
    for (const k of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(es[MODULE], k)) es[MODULE][k] = structuredClone(defaultSettings[k]);
    }
    const s = es[MODULE];
    if ((s.pricesVersion || 1) < PRICES_VERSION) {
        // Add new default rows without touching anything the user edited.
        const sig = (p) => `${String(p.model).toLowerCase()}|${p.from || ''}|${p.to || ''}`;
        const have = new Set(s.prices.map(sig));
        const added = DEFAULT_PRICES.filter(p => !have.has(sig(p))).map(p => structuredClone(p));
        s.prices = [...added, ...s.prices];
        s.pricesVersion = PRICES_VERSION;
    }
    return s;
}
const save = () => ctx().saveSettingsDebounced();
const uid = () => Math.random().toString(36).slice(2, 10);

function dayKey(t = Date.now()) {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function hostOf(url) {
    try { return new URL(String(url)).host.toLowerCase(); } catch { return ''; }
}

// Wallet currencies. Token prices are in USD; "rate" converts USD into the
// wallet's currency (editable per wallet — defaults are rough).
const CURRENCIES = [
    { sym: '$', label: '달러 ($)', rate: 1 },
    { sym: '₩', label: '원 (₩)', rate: 1400 },
    { sym: '円', label: '엔 (円)', rate: 150 },
    { sym: '¥', label: '위안 (¥)', rate: 7.2 },
];
const BIG_UNITS = new Set(['₩', '円', '원']);
const SUFFIX_UNITS = new Set(['円', '원']);

function rateOf(w) {
    if (Number.isFinite(w?.rate) && w.rate > 0) return w.rate;
    return CURRENCIES.find(c => c.sym === (w?.unit || '$'))?.rate || 1;
}

function fmt(n, unit = '$') {
    if (n === null || n === undefined || !Number.isFinite(n)) return '—';
    const a = Math.abs(n);
    const digits = BIG_UNITS.has(unit)
        ? (a === 0 ? 0 : a < 10 ? 2 : a < 1000 ? 1 : 0)
        : (a === 0 ? 2 : a < 0.01 ? 5 : a < 1 ? 4 : a < 1000 ? 2 : 0);
    const s = n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    if (!unit) return s;
    if (SUFFIX_UNITS.has(unit)) return `${s}${unit}`;
    return unit.length === 1 && unit !== 'tok' ? `${unit}${s}` : `${s} ${unit}`;
}

function fmtTok(n) {
    if (!Number.isFinite(n)) return '?';
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function timeAgo(t) {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return `${s}초 전`;
    if (s < 3600) return `${Math.round(s / 60)}분 전`;
    if (s < 86400) return `${Math.round(s / 3600)}시간 전`;
    return new Date(t).toLocaleDateString();
}

// ------------------------------------------------------------ wallets

function aliasHosts(w) {
    return (Array.isArray(w.aliases) ? w.aliases : []).map(hostOf).filter(Boolean);
}

function keyLinks(w) {
    return (Array.isArray(w.keys) ? w.keys : []).map(k => k.id).filter(Boolean);
}

/**
 * Which wallet a request belongs to. Order:
 *  1. an address the user tied to a wallet (e.g. a personal Cloudflare Worker)
 *  2. the exact API key the user tied to a wallet (several Vertex accounts)
 *  3. a proxy wallet's own address
 *  4. the type's default wallet — one of that type with no keys tied to it
 */
function walletFor(meta) {
    const host = meta.host;
    if (host) {
        for (const w of S.wallets) if (aliasHosts(w).includes(host)) return w;
    }
    if (meta.keyId && !meta.viaProxy) {
        for (const w of S.wallets) if (keyLinks(w).includes(meta.keyId)) return w;
    }
    for (const w of S.wallets) {
        if ((w.type === 'newapi' || w.type === 'manual') && host && hostOf(w.url) === host) return w;
    }
    if (!meta.viaProxy) {
        const same = S.wallets.filter(w => TYPES[w.type]?.source && TYPES[w.type].source === meta.source);
        return same.find(w => !keyLinks(w).length) || null;
    }
    return null;
}

// ------------------------------------------------------------ active keys

// Which stored key ST will use right now, per slot. ST sends no key id with a
// normal generation — it uses the slot's active key — so we track it here from
// ST's own masked key list (labels and ids only, never values).
const KEY_SLOTS = {
    api_key_vertexai: 'Vertex 키 (Express)',
    vertexai_service_account_json: 'Vertex 서비스 계정',
    api_key_makersuite: 'AI Studio 키',
    api_key_deepseek: 'DeepSeek 키',
};
let activeKeys = {};
let keyInfo = {};

async function refreshActiveKeys() {
    try {
        const res = await fetch('/api/secrets/read', { method: 'POST', headers: ctx().getRequestHeaders() });
        if (!res.ok) return;
        const state = await res.json();
        const act = {};
        const info = {};
        for (const slot of Object.keys(KEY_SLOTS)) {
            for (const k of Array.isArray(state?.[slot]) ? state[slot] : []) {
                info[k.id] = { slot, label: String(k.label || 'Key'), masked: String(k.value || ''), active: !!k.active };
                if (k.active) act[slot] = k.id;
            }
        }
        activeKeys = act;
        keyInfo = info;
    } catch { /* keep the last known state */ }
}

function keySlotFor(body) {
    switch (body.chat_completion_source) {
        case 'vertexai': return body.vertexai_auth_mode === 'full' ? 'vertexai_service_account_json' : 'api_key_vertexai';
        case 'makersuite': return 'api_key_makersuite';
        case 'deepseek': return 'api_key_deepseek';
        default: return '';
    }
}

// ------------------------------------------------------------ where a request came from

const GEN_TYPES = {
    normal: '일반 답장', swipe: '스와이프', regenerate: '재생성', continue: '이어쓰기',
    impersonate: '대신 쓰기', quiet: '백그라운드', raw: '백그라운드 (직접)',
};
// Built-in extensions, by folder name.
const BUILTIN_EXT = {
    memory: '요약 (Summarize)', expressions: '표정 (Expressions)', 'stable-diffusion': '이미지 생성',
    vectors: '벡터 저장소', translate: '번역', 'quick-reply': '퀵 리플라이', caption: '이미지 캡션',
    tts: 'TTS', 'regex': '정규식', 'token-counter': '토큰 카운터', 'connection-manager': null, 'shared.js': null,
};
// Frames that only pass a request along — never "the caller".
const PASS_THROUGH = new Set(['SillyTavern-CreditLedger']);
let currentGen = null;
const extNames = {};

function onGenStarted(type, _opts, dryRun) {
    if (dryRun) return;
    currentGen = { type: type || 'normal', at: Date.now() };
}
function onGenEnded() { currentGen = null; }

async function extDisplayName(folder) {
    if (extNames[folder] !== undefined) return extNames[folder];
    extNames[folder] = folder;
    try {
        const m = await fetch(`/scripts/extensions/third-party/${encodeURIComponent(folder)}/manifest.json`).then(r => r.ok ? r.json() : null);
        if (m?.display_name) extNames[folder] = String(m.display_name).slice(0, 40);
    } catch { /* keep folder name */ }
    renderLog();
    return extNames[folder];
}

// Extensions seen wrapping window.fetch (retry, logging…). They sit between
// the real caller and our hook on every request, so they are never "the caller".
const fetchWrappers = new Set();
const PROBE_URL = '/__credit-ledger-wrapper-probe__';
let hookFn = null;
let probedFetch = null;

/**
 * Finds exactly which extensions sit on top of our fetch hook: we send a fake
 * request through window.fetch, our hook answers it locally (nothing leaves the
 * browser), and every extension frame between the top and our hook is a wrapper.
 * Re-run whenever window.fetch changes (some extensions re-wrap themselves later).
 */
function probeWrappers() {
    if (!hookFn || window.fetch === probedFetch) return;
    probedFetch = window.fetch;
    if (window.fetch === hookFn) return;
    try { window.fetch(PROBE_URL).catch(() => {}); } catch { /* */ }
}

function learnWrappersFromProbe(stack) {
    const frames = stackFrames(stack);
    let i = 0;
    while (i < frames.length && frames[i].self) i++;
    for (; i < frames.length && !frames[i].self; i++) {
        if (frames[i].tp) fetchWrappers.add(frames[i].tp);
    }
}

// ST functions that send (or lead to) a generation request. Extensions sometimes
// replace them with a wrapper; such a wrapper shows up in the stack under this name.
const CORE_REQUEST_FNS = new Set(['fetch', 'sendRequest', 'processRequest', 'generateRaw', 'generateQuietPrompt', 'Generate', 'callback', 'sendOpenAIRequest']);

function isPatchedCoreFn(line) {
    const s = line.trim();
    let name = '';
    let member = false;
    const v8 = /^at (?:async )?(.+?) \(/.exec(s);
    if (v8) {
        const as = /\[as ([\w$]+)\]$/.exec(v8[1]);
        const full = v8[1].replace(/\s*\[as [\w$]+\]$/, '');
        member = full.includes('.');
        name = as ? as[1] : full.split('.').pop();
        if (as) member = true;
    } else {
        // Firefox / Safari: "name@url"
        const ff = /^([\w$./<]*)@/.exec(s);
        if (ff) { name = ff[1].split(/[./<]/).filter(Boolean).pop() || ''; member = true; }
    }
    return member && CORE_REQUEST_FNS.has(name);
}

/** Splits a stack into frames: { tp: folder } / { bi: folder } / { core: path } / null. */
function stackFrames(stack) {
    const out = [];
    for (const line of stack.split('\n').slice(1)) {
        const tp = /\/scripts\/extensions\/third-party\/([^/]+)\/([^:?#\s)]+)/.exec(line);
        if (tp) {
            let folder = tp[1];
            try { folder = decodeURIComponent(folder); } catch { /* */ }
            if (PASS_THROUGH.has(folder)) { out.push({ self: true }); continue; }
            if (folder === 'ST-ExtensionDoctor' && tp[2] === 'probe.js') continue;
            // An extension's replacement for one of ST's own request functions
            // (e.g. a patched ConnectionManagerRequestService.sendRequest) only passes
            // the call along — the extension that called it is the real sender.
            out.push({ tp: folder, patch: isPatchedCoreFn(line) });
            continue;
        }
        const bi = /\/scripts\/extensions\/([^/]+)\//.exec(line);
        if (bi && bi[1] !== 'third-party') { out.push({ bi: bi[1] }); continue; }
        const core = /https?:\/\/[^/\s]+(\/[^:?#\s)]+\.m?js)/.exec(line);
        if (core) {
            const fn = /^\s*at (?:async )?([\w$.]+)/.exec(line)?.[1] || /^\s*([\w$.]+)@/.exec(line)?.[1] || '';
            out.push({ core: core[1], fn: fn.split('.').pop() });
        }
    }
    return out;
}

/** Finds the extension (if any) whose code started this request. */
function callerFromStack() {
    const old = Error.stackTraceLimit;
    let stack = '';
    try {
        Error.stackTraceLimit = 80;
        stack = String(new Error().stack || '');
    } catch { /* */ } finally {
        Error.stackTraceLimit = old;
    }
    const frames = stackFrames(stack);
    if (window.__creditLedgerDebug) (window.__creditLedgerStacks ||= []).push({ stack, wrappers: [...fetchWrappers] });
    // Drop our own frames at the top.
    let i = 0;
    while (i < frames.length && frames[i].self) i++;
    // The frames right above our hook belong to whoever wrapped fetch after us.
    // If ST's own request code (or another extension) comes after them, they were
    // only passing the request along — remember them as wrappers.
    const run = [];
    let j = i;
    while (j < frames.length && frames[j].tp) run.push(frames[j++].tp);
    if (run.length && j < frames.length) {
        const lastOfRun = run[run.length - 1];
        const next = frames[j];
        const nextIsSender = next.core && /\/scripts\/(openai|textgen-settings|custom-request|nai-settings|kai-settings|horde)\.js$|\/script\.js$/.test(next.core);
        for (const f of run) if (f !== lastOfRun || nextIsSender) fetchWrappers.add(f);
    } else {
        // Ran out of frames: everything but the last folder of the run is a wrapper.
        for (const f of run.slice(0, -1)) fetchWrappers.add(f);
    }
    const route = frames.slice(i).filter(f => f.core && f.fn).slice(0, 5).map(f => f.fn).join('>');
    let viaSlash = false;
    for (let k = i; k < frames.length; k++) {
        const fr = frames[k];
        if (fr.self) continue;
        if (fr.tp) {
            if (fr.patch) continue;
            // A wrapper is skipped only where it wraps; deeper down it may be a real caller.
            if (k < j && fetchWrappers.has(fr.tp)) continue;
            return { kind: 'third', folder: fr.tp, route };
        }
        if (fr.bi && BUILTIN_EXT[fr.bi] !== null) return { kind: 'builtin', label: BUILTIN_EXT[fr.bi] || fr.bi, route };
        if (fr.core && /\/scripts\/slash-commands/.test(fr.core)) viaSlash = true;
    }
    return { kind: viaSlash ? 'slash' : 'none', route };
}

function captureOrigin() {
    const c = ctx();
    let chat = '';
    try {
        if (c.groupId) chat = c.groups?.find(g => g.id === c.groupId)?.name || '그룹 채팅';
        else if (c.characterId !== undefined && c.characters?.[c.characterId]) chat = c.characters[c.characterId].name;
    } catch { /* */ }
    let chatId = '';
    try { chatId = String(c.getCurrentChatId?.() || ''); } catch { /* */ }
    // One generation sends one successful request. Once that is recorded, later
    // requests (or a generation that died without an END event) are not "it".
    const g = currentGen && !currentGen.used && Date.now() - currentGen.at < 10 * 60 * 1000 ? currentGen : null;
    const gen = g ? g.type : 'raw';
    const caller = callerFromStack();
    let ext = '';
    if (caller?.kind === 'third') { ext = caller.folder; extDisplayName(caller.folder); }
    else if (caller?.kind === 'builtin') ext = `@${caller.label}`;
    else if (caller?.kind === 'slash') ext = '@슬래시 명령 / 퀵 리플라이';
    return { chat: String(chat).slice(0, 60), chatId: chatId.slice(0, 120), gen, ext, genRef: g, route: caller?.route || '' };
}

function extLabel(e) {
    if (!e.ext && !e.gen) return '(이전 기록)';
    if (!e.ext) return ['normal', 'swipe', 'regenerate', 'continue', 'impersonate'].includes(e.gen) ? '직접 채팅' : '알 수 없음';
    const mark = e.extBy === 'rule' ? ' (학습)' : '';
    if (e.ext.startsWith('@')) return e.ext.slice(1) + mark;
    if (extNames[e.ext] === undefined) extDisplayName(e.ext);
    return (extNames[e.ext] || e.ext) + mark;
}

// ------------------------------------------------------------ learning "who sent it"
//
// When the caller can't be found, the user can name it. We then remember a
// fingerprint of that request — hashes of its first and last message (an
// extension's own prompt text), its token limit, model and the ST functions it
// went through — and label look-alike requests the same way from then on.
// Only short hashes are kept, never the text itself.

function hashText(s) {
    let h = 0x811c9dc5;
    const str = String(s);
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
}

function msgText(m) {
    if (typeof m?.content === 'string') return m.content;
    if (Array.isArray(m?.content)) return m.content.map(p => p?.text || '').join('\n');
    return '';
}

function fingerprint(body, route) {
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const head = msgs.length ? `${msgs[0].role}:${msgText(msgs[0]).slice(0, 300)}` : '';
    const last = msgs.length > 1 ? msgs[msgs.length - 1] : null;
    const tail = last ? `${last.role}:${msgText(last).slice(0, 300)}` : '';
    return {
        h: head ? hashText(head) : '',
        t: tail ? hashText(tail) : '',
        mt: Number(body.max_tokens ?? body.max_completion_tokens) || 0,
        r: String(route || '').slice(0, 200),
    };
}

/** How well a learned rule fits a request (0 = not at all). */
function ruleScore(rule, gen, model, fp) {
    if (!fp || rule.gen !== gen) return 0;
    if (rule.r && fp.r && rule.r !== fp.r) return 0;
    let s = 0;
    if (rule.t && rule.t === fp.t) s += 3;
    if (rule.h && rule.h === fp.h) s += 2;
    if (rule.mt && rule.mt === fp.mt) s += 1;
    if (rule.model && rule.model === model) s += 1;
    return s >= 3 ? s : 0;
}

function findRule(gen, model, fp) {
    let best = null;
    let bestScore = 0;
    for (const rule of S.originRules) {
        const sc = ruleScore(rule, gen, model, fp);
        if (sc > bestScore || (sc && sc === bestScore && rule.at > best.at)) { best = rule; bestScore = sc; }
    }
    return best;
}

/** Labels unknown-sender entries (new or old) from the learned rules. */
function applyRules(entries) {
    let n = 0;
    for (const e of entries) {
        if (!e.fp || (e.ext && e.extBy !== 'rule')) continue;
        const rule = findRule(e.gen, e.model, e.fp);
        const ext = rule ? rule.ext : '';
        if (rule && e.ext !== ext) { e.ext = ext; e.extBy = 'rule'; n++; }
        else if (!rule && e.extBy === 'rule') { e.ext = ''; delete e.extBy; n++; }
    }
    return n;
}

async function installedExtensions() {
    const list = [];
    try {
        const res = await fetch('/api/extensions/discover', { headers: ctx().getRequestHeaders() });
        const found = res.ok ? await res.json() : [];
        for (const x of Array.isArray(found) ? found : []) {
            const name = String(x?.name || '');
            if (!name.startsWith('third-party/')) continue;
            const folder = name.slice('third-party/'.length);
            if (PASS_THROUGH.has(folder)) continue;
            list.push({ value: folder, label: await extDisplayName(folder) });
        }
    } catch { /* fall back to built-ins only */ }
    list.sort((a, b) => a.label.localeCompare(b.label, 'ko'));
    for (const label of new Set(Object.values(BUILTIN_EXT).filter(Boolean))) list.push({ value: `@${label}`, label: `${label} (기본 확장)` });
    list.push({ value: '@슬래시 명령 / 퀵 리플라이', label: '슬래시 명령 / 퀵 리플라이' });
    return list;
}

/** Lets the user say which extension sent a request, and learn from it. */
async function labelEntry(e) {
    const { Popup, POPUP_TYPE } = ctx();
    const exts = await installedExtensions();
    const sel = el('select', { class: 'text_pole' },
        el('option', { value: '', text: '— 고르세요 —' }),
        ...exts.map(x => el('option', { value: x.value, text: x.label, selected: e.ext === x.value })),
        el('option', { value: '@@custom', text: '직접 입력…' }),
        el('option', { value: '@@clear', text: '(지정 취소 — 알 수 없음으로)' }));
    const custom = el('input', { class: 'text_pole', type: 'text', placeholder: '이름 (예: 내 QR 스크립트)', hidden: true });
    sel.addEventListener('change', () => { custom.hidden = sel.value !== '@@custom'; });
    const learn = el('input', { type: 'checkbox', checked: !!e.fp });
    if (!e.fp) learn.disabled = true;
    const box = el('div', { class: 'cl-root', style: 'text-align:left' },
        el('h3', { text: '이 요청은 어느 확장이 보냈나요?' }),
        el('div', { class: 'cl-note', text: `${new Date(e.t).toLocaleString()} · ${e.model} · 입력 ${fmtTok(e.in)} / 출력 ${fmtTok(e.out)} · ${GEN_TYPES[e.gen] || ''}` }),
        sel, custom,
        el('label', { class: 'checkbox_label' }, learn, document.createTextNode(' 비슷한 요청도 앞으로 이 확장으로 표시 (학습)')),
        el('div', { class: 'cl-note', text: e.fp
            ? '같은 확장은 보통 매번 비슷한 지시문을 보내요. 그 지시문의 지문(짧은 해시)만 저장해서 다음부터 알아봐요. 내용 자체는 저장하지 않아요.'
            : '업데이트 전 기록이라 지문이 없어서 이 줄만 바꿔요. 학습은 새 기록부터 돼요.' }));
    const ok = await new Popup(box, POPUP_TYPE.CONFIRM, '', { okButton: '저장', cancelButton: '취소' }).show();
    if (!ok) return;
    let ext = sel.value;
    if (ext === '@@custom') {
        const name = custom.value.trim().slice(0, 40);
        if (!name) { toastr.warning('이름을 입력해주세요.'); return; }
        ext = `@${name}`;
    }
    if (!ext) return;
    if (ext === '@@clear') {
        e.ext = ''; delete e.extBy;
        if (e.fp) S.originRules = S.originRules.filter(r => !(r.gen === e.gen && r.h === e.fp.h && r.t === e.fp.t && (r.r || '') === (e.fp.r || '')));
    } else {
        e.ext = ext;
        e.extBy = 'user';
        if (ext.startsWith('@') === false) extDisplayName(ext);
        if (e.fp && learn.checked) {
            const same = S.originRules.find(r => r.gen === e.gen && r.h === e.fp.h && r.t === e.fp.t && (r.r || '') === (e.fp.r || ''));
            if (same) { same.ext = ext; same.at = Date.now(); same.model = e.model; same.mt = e.fp.mt; }
            else S.originRules.push({ id: uid(), ext, gen: e.gen, model: e.model, ...e.fp, at: Date.now(), hits: 0 });
            if (S.originRules.length > 100) S.originRules.splice(0, S.originRules.length - 100);
        }
    }
    const n = applyRules(S.entries);
    save();
    renderAll();
    if (n) toastr.info(`비슷한 이전 기록 ${n}건도 같이 바꿨어요.`, '💳 크레딧 장부');
}

function originText(e, opts = S) {
    const parts = [];
    if (opts.showChat && e.chat) parts.push(`💬 ${e.chat}`);
    if (opts.showExt) parts.push(extLabel(e));
    if (opts.showGen && e.gen) parts.push(GEN_TYPES[e.gen] || e.gen);
    if (opts.showModel && e.model) parts.push(e.model);
    return parts.join(' · ');
}

function keyName(id) {
    const k = keyInfo[id];
    return k ? `${k.label} (${k.masked})` : '지워진 키';
}

function walletUnit(w) {
    if (TYPES[w.type]?.lookup) return w.real?.unit || w.unit || '';
    return w.unit || '$';
}

function remainingOf(w) {
    if (TYPES[w.type]?.lookup) {
        if (!w.real) return { value: null, kind: 'none' };
        if (w.real.unlimited) return { value: null, kind: 'unlimited' };
        return { value: w.real.remaining, kind: 'real', at: w.real.at };
    }
    if (!w.base || !Number.isFinite(w.base.amount)) return { value: null, kind: 'none' };
    return { value: w.base.amount - (w.spentSinceBase || 0), kind: 'est' };
}

function addDaily(w, cost, t = Date.now()) {
    if (!Number.isFinite(cost) || cost <= 0) return;
    w.daily = w.daily || {};
    const k = dayKey(t);
    w.daily[k] = (w.daily[k] || 0) + cost;
    const keys = Object.keys(w.daily).sort();
    while (keys.length > DAILY_KEEP_DAYS) delete w.daily[keys.shift()];
}

function spendStats(w) {
    const today = dayKey();
    const month = today.slice(0, 7);
    let t = 0;
    let m = 0;
    for (const [k, v] of Object.entries(w.daily || {})) {
        if (k === today) t += v;
        if (k.startsWith(month)) m += v;
    }
    return { today: t, month: m };
}

// ------------------------------------------------------------ pricing

function priceValidOn(p, day) {
    return (!p.from || day >= p.from) && (!p.to || day <= p.to);
}

function priceFor(model, t = Date.now()) {
    const id = String(model || '').toLowerCase().replace(/^models\//, '').split('/').pop();
    const day = dayKey(t);
    let best = null;
    let bestScore = -1;
    for (const p of S.prices) {
        const key = String(p.model || '').toLowerCase().trim();
        if (!key || !id.startsWith(key) || !priceValidOn(p, day)) continue;
        // Longer name wins; at equal length a dated row beats an open-ended one.
        const score = key.length * 10 + (p.from || p.to ? 1 : 0);
        if (score > bestScore) { best = { ...p, model: key }; bestScore = score; }
    }
    return best;
}

function costFromTokens(model, u, t = Date.now()) {
    const p = priceFor(model, t);
    if (!p) return null;
    const over = p.over && u.in > p.over;
    const pin = over && Number.isFinite(p.in2) ? p.in2 : p.in;
    const pout = over && Number.isFinite(p.out2) ? p.out2 : p.out;
    const cached = Math.min(u.cached || 0, u.in || 0);
    const pc = Number.isFinite(p.cached) ? p.cached : pin;
    return ((u.in - cached) * pin + cached * pc + ((u.out || 0) + (u.think || 0)) * pout) / 1e6;
}

// ------------------------------------------------------------ capture

function inspectRequest(input, init) {
    const url = typeof input === 'string' ? input : input?.url;
    if (!url || !String(url).includes(GEN_PATH)) return null;
    if (typeof init?.body !== 'string') return null;
    const body = JSON.parse(init.body);
    const source = String(body.chat_completion_source || '');
    const viaProxy = !!body.reverse_proxy;
    let host = '';
    if (source === 'custom') host = hostOf(body.custom_url);
    else if (viaProxy) host = hostOf(body.reverse_proxy);
    const slot = viaProxy ? '' : keySlotFor(body);
    const keyId = slot ? (body.secret_id || activeKeys[slot] || '') : '';
    let origin = {};
    try { probeWrappers(); } catch { /* */ }
    try { origin = captureOrigin(); } catch { /* never block a request */ }
    let fp = null;
    try { fp = fingerprint(body, origin.route); } catch { /* */ }
    return { source, model: String(body.model || ''), host, viaProxy, keyId, origin, fp, stream: !!body.stream, messages: body.messages, t: Date.now() };
}

function readGeminiUsage(o) {
    const u = o?.usageMetadata;
    if (!u) return null;
    return {
        in: Number(u.promptTokenCount) || 0,
        out: Number(u.candidatesTokenCount) || 0,
        think: Number(u.thoughtsTokenCount) || 0,
        cached: Number(u.cachedContentTokenCount) || 0,
    };
}

function readOpenAiUsage(o) {
    const u = o?.usage;
    if (!u || typeof u !== 'object') return null;
    const inTok = Number(u.prompt_tokens ?? u.input_tokens) || 0;
    const outTok = Number(u.completion_tokens ?? u.output_tokens) || 0;
    const think = Number(u.completion_tokens_details?.reasoning_tokens) || 0;
    return {
        in: inTok,
        out: Math.max(0, outTok - think),
        think,
        cached: Number(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cache_read_input_tokens) || 0,
    };
}

function textOfMessages(messages) {
    if (!Array.isArray(messages)) return '';
    return messages.map(m => {
        if (typeof m?.content === 'string') return m.content;
        if (Array.isArray(m?.content)) return m.content.map(p => p?.text || '').join('\n');
        return '';
    }).join('\n');
}

async function estimateUsage(meta, outText) {
    const c = ctx();
    const count = async (s) => {
        try { return await c.getTokenCountAsync(s); } catch { return Math.ceil(String(s).length / 3); }
    };
    return { in: await count(textOfMessages(meta.messages)), out: await count(outText || ''), think: 0, cached: 0 };
}

async function handleResponse(meta, res) {
    if (!res.ok) return;
    if (meta.origin?.genRef) meta.origin.genRef.used = true;
    let usage = null;
    let outText = '';
    const ctype = res.headers.get('content-type') || '';
    if (meta.stream && !ctype.includes('application/json')) {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        const onLine = (line) => {
            if (!line.startsWith('data:')) return;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') return;
            let o;
            try { o = JSON.parse(data); } catch { return; }
            usage = readGeminiUsage(o) || readOpenAiUsage(o) || usage;
            const parts = o?.candidates?.[0]?.content?.parts;
            if (Array.isArray(parts)) outText += parts.filter(p => !p.thought).map(p => p.text || '').join('');
            const delta = o?.choices?.[0]?.delta?.content;
            if (typeof delta === 'string') outText += delta;
        };
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                let i;
                while ((i = buf.indexOf('\n')) >= 0) {
                    onLine(buf.slice(0, i).trimEnd());
                    buf = buf.slice(i + 1);
                }
            }
            if (buf) onLine(buf.trim());
        } catch {
            // Stopped mid-stream — whatever usage we saw is still useful.
        }
    } else {
        let j = null;
        try { j = await res.json(); } catch { return; }
        if (j?.error) return;
        usage = readGeminiUsage(j) || readOpenAiUsage(j);
        outText = j?.choices?.[0]?.message?.content || '';
    }
    let estimated = false;
    if (!usage) {
        usage = await estimateUsage(meta, outText);
        estimated = true;
    }
    record(meta, usage, estimated);
}

/** Correction multiplier learned from the user's balance corrections. */
function calibFactor(w) {
    const f = w?.calib?.factor;
    return S.autoCalib && Number.isFinite(f) && f > 0 ? f : 1;
}

/** Adds a token-priced cost to a non-lookup wallet. Returns the adjusted cost. */
function chargeTokens(w, tokenCost, t) {
    const local = tokenCost * rateOf(w);
    const adj = local * calibFactor(w);
    if (!w.base || t >= w.base.at) {
        w.spentSinceBase = (w.spentSinceBase || 0) + adj;
        w.rawSinceBase = (w.rawSinceBase || 0) + local;
        w.estCalls = (w.estCalls || 0) + 1;
    }
    addDaily(w, adj, t);
    return adj;
}

function notifyWithdraw(w, amount, entries = []) {
    if (!S.notify || !w || !Number.isFinite(amount) || amount <= 0) return;
    const unit = walletUnit(w);
    const rem = remainingOf(w);
    const remText = rem.kind === 'real' ? fmt(rem.value, unit) : rem.kind === 'est' ? `~${fmt(rem.value, unit)}` : '';
    const calls = entries.length || 1;
    const what = calls > 1 ? ` (최근 ${calls}회 합계)` : '';
    const line1 = `−${fmt(amount, unit)}${what}${remText ? ` · 잔액 ${remText}` : ''}`;
    const origins = [...new Set(entries.map(e => originText(e)).filter(Boolean))];
    const line2 = origins.length > 2 ? `${origins.slice(0, 2).join(' / ')} 외 ${origins.length - 2}곳` : origins.join(' / ');
    const html = escapeHtml(line1) + (line2 ? `<br><small>📍 ${escapeHtml(line2)}</small>` : '');
    try {
        toastr.info(html, `💳 ${escapeHtml(w.name)} 출금`, { timeOut: 5000, extendedTimeOut: 2000, toastClass: 'toast cl-bank-toast', preventDuplicates: false, escapeHtml: false });
    } catch { /* ignore */ }
}

function record(meta, usage, estimated) {
    const w = walletFor(meta);
    const lookup = w && TYPES[w.type]?.lookup;
    const now = Date.now();
    const tokenCost = costFromTokens(meta.model, usage, now);
    const entry = {
        id: uid(),
        t: now,
        w: w?.id || null,
        src: meta.source,
        host: meta.host,
        keyId: meta.keyId || '',
        chat: meta.origin?.chat || '',
        chatId: meta.origin?.chatId || '',
        gen: meta.origin?.gen || '',
        ext: meta.origin?.ext || '',
        model: meta.model,
        in: usage.in, out: usage.out, think: usage.think, cached: usage.cached,
        est: estimated,
        cost: lookup ? null : tokenCost,
        costSrc: lookup ? 'pending' : (tokenCost === null ? 'unpriced' : 'tokens'),
        tokenCost,
    };
    if (meta.fp) entry.fp = meta.fp;
    if (!entry.ext && meta.fp) {
        const rule = findRule(entry.gen, entry.model, meta.fp);
        if (rule) { entry.ext = rule.ext; entry.extBy = 'rule'; rule.hits = (rule.hits || 0) + 1; rule.last = now; }
    }
    if (w && !lookup && tokenCost !== null) {
        entry.cost = chargeTokens(w, tokenCost, now);
        if (entry.est) w.estApprox = (w.estApprox || 0) + 1;
    }
    if (w && !lookup && tokenCost === null && meta.model && !S.unpriced.includes(meta.model)) {
        S.unpriced.push(meta.model);
        if (S.unpriced.length > 20) S.unpriced.shift();
    }
    S.entries.push(entry);
    if (S.entries.length > MAX_ENTRIES) S.entries.splice(0, S.entries.length - MAX_ENTRIES);
    save();
    if (w && lookup && w.auto !== false && pluginOk) scheduleRefresh(w, AUTO_DELAY_MS);
    renderAll();
    if (w && !lookup && entry.cost) notifyWithdraw(w, entry.cost, [entry]);
}

function installFetchHook() {
    if (window.__creditLedgerHooked) return;
    window.__creditLedgerHooked = true;
    const orig = window.fetch;
    hookFn = window.fetch = function (input, init) {
        if (input === PROBE_URL) {
            try {
                const old = Error.stackTraceLimit;
                Error.stackTraceLimit = 80;
                const stack = String(new Error().stack || '');
                Error.stackTraceLimit = old;
                learnWrappersFromProbe(stack);
            } catch { /* */ }
            return Promise.resolve(new Response('', { status: 204 }));
        }
        let meta = null;
        try { meta = inspectRequest(input, init); } catch { meta = null; }
        const p = orig.apply(this, arguments);
        if (meta) {
            p.then(res => {
                try { handleResponse(meta, res.clone()).catch(() => {}); } catch { /* ignore */ }
            }, () => {});
        }
        return p;
    };
}

// ------------------------------------------------------------ plugin calls

async function pluginFetch(path, opts = {}) {
    const res = await fetch(PLUGIN + path, { ...opts, headers: { ...ctx().getRequestHeaders(), ...(opts.headers || {}) } });
    let j = null;
    try { j = await res.json(); } catch { /* */ }
    if (!res.ok) throw new Error(j?.error || `서버 플러그인 응답 오류 (HTTP ${res.status})`);
    return j;
}

async function checkPlugin() {
    try {
        await pluginFetch('/ping');
        pluginOk = true;
    } catch {
        pluginOk = false;
    }
    renderAll();
}

async function loadSources(force = false) {
    if (sourcesCache && !force) return sourcesCache;
    sourcesCache = await pluginFetch('/sources');
    return sourcesCache;
}

function scheduleRefresh(w, delay) {
    clearTimeout(refreshTimers.get(w.id));
    const last = w.real?.at || 0;
    const wait = Math.max(delay, last + AUTO_MIN_GAP_MS - Date.now());
    refreshTimers.set(w.id, setTimeout(() => refreshBalance(w.id, false), wait));
}

async function refreshBalance(walletId, manual) {
    const w = S.wallets.find(x => x.id === walletId);
    if (!w || !TYPES[w.type]?.lookup || refreshing.has(w.id)) return;
    if (!pluginOk) {
        if (manual) toastr.warning('잔액 조회용 서버 플러그인이 설치되지 않았어요. 설치 안내를 확인해주세요.', '크레딧 장부');
        return;
    }
    refreshing.add(w.id);
    renderAll();
    try {
        const body = w.type === 'deepseek'
            ? { kind: 'deepseek', secretId: w.secretId || '' }
            : w.keyRef?.slot === 'proxy'
                ? { kind: 'newapi', slot: 'proxy', proxyName: w.keyRef.name }
                : { kind: 'newapi', slot: 'custom', baseUrl: w.url, secretId: w.keyRef?.id || '' };
        const r = await pluginFetch('/balance', { method: 'POST', body: JSON.stringify(body) });
        applyBalance(w, r);
        w.lastError = '';
    } catch (e) {
        w.lastError = String(e.message || e).slice(0, 200);
        if (manual) toastr.error(w.lastError, `${w.name} 잔액 조회`);
    } finally {
        refreshing.delete(w.id);
        save();
        renderAll();
    }
}

function applyBalance(w, r) {
    const prev = w.real;
    const next = { remaining: r.remaining, used: r.used, unlimited: !!r.unlimited, unit: r.unit || w.unit || '', at: r.at || Date.now() };
    if (r.siteName && !w.siteName) w.siteName = r.siteName;
    if (prev && !r.cached && next.at > prev.at) {
        let delta = null;
        if (Number.isFinite(next.used) && Number.isFinite(prev.used)) delta = next.used - prev.used;
        else if (Number.isFinite(next.remaining) && Number.isFinite(prev.remaining)) delta = prev.remaining - next.remaining;
        if (delta !== null && delta > -1e-9) {
            delta = Math.max(0, delta);
            const pending = S.entries.filter(e => e.w === w.id && e.costSrc === 'pending' && e.t <= next.at);
            if (pending.length === 1) {
                pending[0].cost = delta;
                pending[0].costSrc = 'balance';
            } else if (pending.length > 1) {
                for (const e of pending) { e.costSrc = 'group'; e.groupCost = delta; e.groupN = pending.length; }
            }
            if (delta > 0) addDaily(w, delta);
            w.lastDelta = { amount: delta, calls: pending.length, at: next.at };
            w.real = next;
            notifyWithdraw(w, delta, pending);
            return;
        }
    } else if (!prev) {
        for (const e of S.entries) if (e.w === w.id && e.costSrc === 'pending') e.costSrc = 'baseline';
    }
    if (!r.cached || !prev) w.real = next;
}

// ------------------------------------------------------------ UI: chip

function lastEntry() {
    return S.entries[S.entries.length - 1] || null;
}

function entryCostText(e, w) {
    const unit = w ? walletUnit(w) : '$';
    switch (e.costSrc) {
        case 'tokens': return `${fmt(e.cost, unit)}${e.est ? ' (추정)' : ''}`;
        case 'balance': return fmt(e.cost, unit);
        case 'group': return `${e.groupN}회 합계 ${fmt(e.groupCost, unit)}`;
        case 'pending': return '잔액 확인 중…';
        case 'baseline': return '기준 잔액 기록';
        case 'unpriced': return '단가 미설정';
        default: return '—';
    }
}

function renderChip() {
    let chip = document.getElementById('cl_chip');
    if (!S.showChip) { chip?.remove(); return; }
    if (!chip) {
        const host = document.getElementById('form_sheld');
        if (!host) return;
        chip = document.createElement('div');
        chip.id = 'cl_chip';
        chip.title = '크레딧 장부 — 눌러서 자세히 보기';
        chip.addEventListener('click', () => openWindow());
        host.prepend(chip);
    }
    const e = lastEntry();
    if (!e) { chip.textContent = '💳 아직 기록 없음'; return; }
    const w = S.wallets.find(x => x.id === e.w);
    if (!w) {
        chip.textContent = `💳 지갑 미지정 연결 (${e.host || e.src}) — 눌러서 지갑 추가`;
        chip.classList.add('cl-warn');
        return;
    }
    chip.classList.toggle('cl-warn', e.costSrc === 'unpriced');
    const rem = remainingOf(w);
    const remText = rem.kind === 'real' ? fmt(rem.value, walletUnit(w))
        : rem.kind === 'est' ? `~${fmt(rem.value, walletUnit(w))}`
            : rem.kind === 'unlimited' ? '무제한 키' : '잔액 미설정';
    chip.textContent = `💳 ${w.name} · 방금 ${entryCostText(e, w)} · 남은 ${remText}`;
}

// ------------------------------------------------------------ UI: drawer + window

const ORIGIN_OPTS_HTML = `
      <div class="cl-subopts">
        <div class="cl-sub">출금 알림·사용 기록에 표시할 사용처</div>
        <label class="checkbox_label"><input class="cl-opt" data-opt="showChat" type="checkbox"> 채팅 (캐릭터·그룹 이름)</label>
        <label class="checkbox_label"><input class="cl-opt" data-opt="showExt" type="checkbox"> 보낸 곳 (채팅 / 확장 이름)</label>
        <label class="checkbox_label"><input class="cl-opt" data-opt="showGen" type="checkbox"> 생성 종류 (일반·스와이프·백그라운드 등)</label>
        <label class="checkbox_label"><input class="cl-opt" data-opt="showModel" type="checkbox"> 모델 이름</label>
      </div>`;

const DRAWER_HTML = `
<div id="cl_settings" class="cl-root">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>💳 크레딧 장부</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div class="cl-note cl-plugin-status"></div>
      <button id="cl_open_window" class="menu_button cl-wide-btn">💳 관리 창 열기</button>
      <div class="cl-note">입력창 위 요약 줄이나 왼쪽 아래 ✨ 메뉴의 "크레딧 장부"로도 열 수 있어요.</div>
      <label class="checkbox_label"><input class="cl-opt" data-opt="showChip" type="checkbox"> 입력창 위에 요약 줄 보이기</label>
      <label class="checkbox_label"><input class="cl-opt" data-opt="notify" type="checkbox"> 출금 알림 (채팅마다 차감 금액 알림)</label>
      ${ORIGIN_OPTS_HTML}
      <label class="checkbox_label"><input class="cl-opt" data-opt="autoCalib" type="checkbox"> 자동 보정 (잔액 보정할 때 오차를 배워서 다음 계산에 반영)</label>
    </div>
  </div>
</div>`;

const WINDOW_HTML = `
<div class="cl-win-head">
  <b>💳 크레딧 장부</b>
  <span class="cl-note cl-plugin-status"></span>
</div>
<div class="cl-tabs">
  <button class="menu_button cl-tab" data-tab="wallets">지갑</button>
  <button class="menu_button cl-tab" data-tab="links">연결 관리</button>
  <button class="menu_button cl-tab" data-tab="log">사용 기록</button>
  <button class="menu_button cl-tab" data-tab="prices">단가표</button>
  <button class="menu_button cl-tab" data-tab="diag">진단·설정</button>
</div>
<section data-pane="wallets">
  <div class="cl-row">
    <button id="cl_import" class="menu_button">＋ 연결 프로필에서 한 번에 가져오기</button>
    <button id="cl_add_current" class="menu_button">＋ 지금 연결된 API로 추가</button>
    <button id="cl_add" class="menu_button">＋ 직접 추가</button>
  </div>
  <div id="cl_editor" class="cl-editor" hidden></div>
  <div id="cl_wallets" class="cl-grid"></div>
</section>
<section data-pane="links" hidden>
  <div class="cl-note">같은 Vertex라도 <b>계정이 다르면 지갑을 따로</b> 만들고, 여기서 키와 주소를 각 지갑(그룹)에 묶어주세요. "기본"으로 두면 그 종류의 기본 지갑(키가 하나도 안 묶인 지갑)으로 들어가요. 묶은 뒤에 보내는 채팅부터 그 지갑에서 빠져요.</div>
  <div id="cl_links"></div>
</section>
<section data-pane="log" hidden>
  <div id="cl_log"></div>
</section>
<section data-pane="prices" hidden>
  <div class="cl-note">1백만 토큰당 가격(달러)이에요. 모델 이름은 앞부분만 맞으면 돼요 (예: <code>gemini-3.1-pro</code>는 <code>gemini-3.1-pro-preview</code>에도 적용). "20만↑"은 입력이 20만 토큰을 넘을 때 가격, "시작/끝"은 프로모션처럼 기간이 정해진 가격이에요(비우면 항상). 기본값은 커뮤니티에서 정리한 참고값이에요.</div>
  <div id="cl_unpriced" class="cl-note cl-warn-text"></div>
  <div id="cl_prices"></div>
  <div class="cl-row">
    <button id="cl_price_add" class="menu_button">＋ 모델 추가</button>
    <button id="cl_price_merge" class="menu_button">새 기본값 추가</button>
    <button id="cl_price_reset" class="menu_button">기본값으로 되돌리기</button>
  </div>
</section>
<section data-pane="diag" hidden>
  <div id="cl_diag"></div>
  <div class="cl-section">
    <b>설정</b>
    <label class="checkbox_label"><input class="cl-opt" data-opt="showChip" type="checkbox"> 입력창 위에 요약 줄 보이기</label>
    <label class="checkbox_label"><input class="cl-opt" data-opt="notify" type="checkbox"> 출금 알림 (채팅마다 차감 금액 알림)</label>
    ${ORIGIN_OPTS_HTML}
    <label class="checkbox_label"><input class="cl-opt" data-opt="autoCalib" type="checkbox"> 자동 보정</label>
  </div>
</section>`;

let windowPopup = null;
let currentTab = 'wallets';
try { currentTab = localStorage.getItem('cl_tab') || 'wallets'; } catch { /* */ }

function syncOptions() {
    document.querySelectorAll('.cl-opt').forEach(i => { i.checked = !!S[i.dataset.opt]; });
}

function bindOptions(root) {
    root.querySelectorAll('.cl-opt').forEach(i => {
        i.addEventListener('change', () => {
            S[i.dataset.opt] = i.checked;
            save();
            syncOptions();
            renderAll();
        });
    });
}

function selectTab(tab) {
    currentTab = tab;
    try { localStorage.setItem('cl_tab', tab); } catch { /* */ }
    document.querySelectorAll('.cl-window [data-pane]').forEach(p => { p.hidden = p.dataset.pane !== tab; });
    document.querySelectorAll('.cl-window .cl-tab').forEach(b => b.classList.toggle('cl-tab-on', b.dataset.tab === tab));
    if (tab === 'prices') renderPrices();
    if (tab === 'links') refreshActiveKeys().then(renderLinks);
}

const KEY_TYPE = { api_key_vertexai: 'vertex', vertexai_service_account_json: 'vertex', api_key_makersuite: 'gemini', api_key_deepseek: 'deepseek' };

function maskHost(h) {
    // Personal relay names work like passwords, so don't print them in full.
    const m = /^([^.]+)\.((?:[^.]+\.)?(?:workers|pages)\.dev)$/i.exec(h);
    if (!m) return h;
    const sub = m[1];
    return `${sub.slice(0, 1)}${'•'.repeat(Math.max(3, sub.length - 2))}${sub.slice(-1)}.${m[2]}`;
}

function knownHosts() {
    const hosts = new Set();
    for (const p of ctx().extensionSettings.connectionManager?.profiles || []) {
        const h = hostOf(p?.['api-url']);
        if (h) hosts.add(h);
    }
    const o = ctx().chatCompletionSettings || {};
    for (const u of [o.custom_url, o.reverse_proxy]) if (hostOf(u)) hosts.add(hostOf(u));
    for (const e of S.entries) if (e.host) hosts.add(e.host);
    for (const w of S.wallets) for (const h of aliasHosts(w)) hosts.add(h);
    // A proxy wallet's own address is fixed to it — not something to re-tie.
    for (const w of S.wallets) if (w.type === 'newapi' || w.type === 'manual') hosts.delete(hostOf(w.url));
    return [...hosts].sort();
}

function newWalletOfType(type, name) {
    const w = { id: uid(), name: name || TYPES[type].label, type, url: '', unit: TYPES[type].lookup ? '' : '$', auto: true, aliases: [], keys: [] };
    S.wallets.push(w);
    return w;
}

function tieKey(id, target) {
    for (const w of S.wallets) w.keys = (w.keys || []).filter(k => k.id !== id);
    if (target === 'default') return null;
    const info = keyInfo[id];
    const w = target === 'new' ? newWalletOfType(KEY_TYPE[info?.slot] || 'vertex', info?.label) : S.wallets.find(x => x.id === target);
    if (!w) return null;
    w.keys = [...(w.keys || []), { id, slot: info?.slot || '' }];
    return w;
}

function tieHost(host, target) {
    for (const w of S.wallets) w.aliases = (w.aliases || []).filter(a => hostOf(a) !== host);
    if (target === 'none') return null;
    const w = target === 'new' ? newWalletOfType('manual', maskHost(host)) : S.wallets.find(x => x.id === target);
    if (!w) return null;
    w.aliases = [...(w.aliases || []), `https://${host}`];
    return w;
}

function renderLinks() {
    const box = document.getElementById('cl_links');
    if (!box) return;
    box.replaceChildren();
    const after = (w) => {
        if (w) claimEntries(w);
        save();
        renderAll();
        renderLinks();
        if (w) toastr.success(`"${w.name}" 지갑에 묶었어요.`, '크레딧 장부');
    };

    const keyIds = Object.keys(keyInfo);
    box.append(el('h4', { text: '🔑 저장된 키' }));
    if (!keyIds.length) box.append(el('div', { class: 'cl-note', text: '실리태번에 저장된 Vertex·AI Studio·DeepSeek 키가 없어요.' }));
    for (const id of keyIds) {
        const k = keyInfo[id];
        const type = KEY_TYPE[k.slot];
        const owner = S.wallets.find(w => keyLinks(w).includes(id));
        const sel = el('select', { class: 'text_pole' },
            el('option', { value: 'default', text: '기본 (그 종류의 기본 지갑)', selected: !owner }),
            ...S.wallets.filter(w => w.type === type).map(w => el('option', { value: w.id, text: `"${w.name}" 지갑에 묶기`, selected: owner?.id === w.id })),
            el('option', { value: 'new', text: '＋ 새 지갑을 만들어 묶기' }));
        sel.addEventListener('change', () => after(tieKey(id, sel.value)));
        const dflt = owner ? null : walletFor({ source: TYPES[type]?.source, keyId: id });
        box.append(el('div', { class: 'cl-link-row' },
            el('div', {},
                el('b', { text: k.label }), el('span', { class: 'cl-sub', text: ` ${k.masked}` }),
                el('div', { class: 'cl-sub', text: `${KEY_SLOTS[k.slot]}${k.active ? ' · 지금 사용 중' : ''}${dflt ? ` · 지금은 "${dflt.name}"으로 계산` : owner ? '' : ' · 지금은 지갑 없음'}` })),
            sel));
    }

    const hosts = knownHosts();
    box.append(el('h4', { text: '🌐 주소 (워커·프록시 우회 주소)' }));
    if (!hosts.length) box.append(el('div', { class: 'cl-note', text: '아직 본 주소가 없어요. 워커나 우회 주소로 한 번 채팅하거나, 연결 프로필에 저장하면 여기에 나와요.' }));
    for (const h of hosts) {
        const owner = S.wallets.find(w => aliasHosts(w).includes(h));
        const sel = el('select', { class: 'text_pole' },
            el('option', { value: 'none', text: '묶지 않음', selected: !owner }),
            ...S.wallets.map(w => el('option', { value: w.id, text: `"${w.name}" 지갑에 묶기 (${TYPES[w.type].label})`, selected: owner?.id === w.id })),
            el('option', { value: 'new', text: '＋ 새 지갑(기타)을 만들어 묶기' }));
        sel.addEventListener('change', () => after(tieHost(h, sel.value)));
        box.append(el('div', { class: 'cl-link-row' },
            el('div', {}, el('b', { text: maskHost(h) })),
            sel));
    }
}

function openWindow(tab) {
    if (windowPopup) { if (tab) selectTab(tab); return; }
    const { Popup, POPUP_TYPE } = ctx();
    const root = el('div', { class: 'cl-root cl-window' });
    root.innerHTML = WINDOW_HTML;
    root.querySelectorAll('.cl-tab').forEach(b => b.addEventListener('click', () => selectTab(b.dataset.tab)));
    root.querySelector('#cl_add').addEventListener('click', () => openEditor(null));
    root.querySelector('#cl_add_current').addEventListener('click', () => openEditor(null, currentConnection()));
    root.querySelector('#cl_import').addEventListener('click', () => openImport());
    root.querySelector('#cl_price_add').addEventListener('click', () => { S.prices.unshift({ model: '', in: 0, out: 0 }); save(); renderPrices(); });
    root.querySelector('#cl_price_merge').addEventListener('click', () => {
        const sig = (p) => `${String(p.model).toLowerCase()}|${p.from || ''}|${p.to || ''}`;
        const have = new Set(S.prices.map(sig));
        const added = DEFAULT_PRICES.filter(p => !have.has(sig(p))).map(p => structuredClone(p));
        S.prices = [...added, ...S.prices];
        save();
        renderPrices();
        toastr.info(added.length ? `${added.length}개 모델을 추가했어요. 기존 값은 그대로예요.` : '추가할 새 기본값이 없어요.');
    });
    root.querySelector('#cl_price_reset').addEventListener('click', async () => {
        if (!await ctx().Popup.show.confirm('단가표 초기화', '기본 단가표로 되돌릴까요? 직접 넣은 값은 사라져요.')) return;
        S.prices = structuredClone(DEFAULT_PRICES);
        save();
        renderPrices();
    });
    bindOptions(root);
    windowPopup = new Popup(root, POPUP_TYPE.DISPLAY, null, {
        wide: true, large: true, allowVerticalScrolling: true, leftAlign: true,
        onClose: () => { windowPopup = null; },
    });
    windowPopup.show().catch(() => { windowPopup = null; });
    syncOptions();
    selectTab(tab || currentTab);
    renderAll();
}

function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
        else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids) if (k) n.append(k);
    return n;
}

function renderPluginStatus() {
    const needs = S.wallets.some(w => TYPES[w.type]?.lookup);
    const text = pluginOk === null ? '서버 플러그인 확인 중…'
        : pluginOk ? '✅ 서버 플러그인 연결됨 (DeepSeek·프록시 실제 잔액 조회 가능)'
            : needs ? '⚠️ 서버 플러그인이 없어서 DeepSeek·프록시 실제 잔액은 조회할 수 없어요. (Vertex 계산은 정상)'
                : 'ℹ️ 서버 플러그인 없음 (Vertex·AI Studio 계산에는 필요 없어요)';
    document.querySelectorAll('.cl-plugin-status').forEach(b => { b.textContent = text; });
}

function renderDiag() {
    const box = document.getElementById('cl_diag');
    if (!box) return;
    box.replaceChildren(
        el('div', { class: 'cl-note', text: '자동 보정은 이렇게 동작해요: 지갑의 "잔액 보정"에 콘솔에서 본 실제 잔액을 넣으면, 지난 보정 이후 장부가 계산한 금액과 실제로 줄어든 금액을 비교해요. 차이만큼 다음 계산에 배율을 곱해요. 보정할수록 정확해지고, 충전·최근 사용·너무 큰 차이처럼 믿기 어려운 경우는 자동으로 건너뛰어요.' }),
    );
    box.append(renderRules());
    if (S.unpriced.length) box.append(el('div', { class: 'cl-note cl-warn-text', text: `⚠️ 단가표에 없는 모델: ${S.unpriced.join(', ')} → "단가표" 탭에서 추가하면 계산돼요.` }));
    const priced = S.wallets.filter(w => !TYPES[w.type]?.lookup);
    if (!priced.length) { box.append(el('div', { class: 'cl-note', text: '단가로 계산하는 지갑(Vertex·AI Studio·기타)이 없어요.' })); return; }
    for (const w of priced) {
        const unit = walletUnit(w);
        const f = w.calib?.factor;
        const calls = w.estCalls || 0;
        const approx = calls ? Math.round((w.estApprox || 0) / calls * 100) : 0;
        const lines = [
            f ? `보정 배율 ×${f.toFixed(2)} (${w.calib.n}번 보정, 마지막 ${timeAgo(w.calib.at)})${S.autoCalib ? '' : ' — 자동 보정 꺼짐이라 지금은 적용 안 함'}` : '아직 보정 기록 없음 (잔액 보정을 두 번 이상 하면 배워요)',
            w.base ? `마지막 잔액 입력 이후 ${calls}회, 장부 계산 ${fmt(w.spentSinceBase || 0, unit)}` : '시작 잔액이 없어요',
        ];
        if (calls && approx > 30) lines.push(`⚠️ ${approx}%가 토큰 추정(≈) 기록이에요. 스트리밍을 켜면 더 정확해요.`);
        box.append(el('div', { class: 'cl-card' },
            el('b', { text: w.name }),
            ...lines.map(l => el('div', { class: 'cl-sub', text: l })),
            el('div', { class: 'cl-row' },
                el('button', { class: 'menu_button', text: '잔액 보정', onclick: () => calibrate(w) }),
                f ? el('button', { class: 'menu_button', text: '보정 초기화', onclick: () => { w.calib = null; save(); renderAll(); } }) : null)));
    }
}

function renderWallets() {
    const box = document.getElementById('cl_wallets');
    if (!box) return;
    box.replaceChildren();
    if (!S.wallets.length) {
        box.append(el('div', { class: 'cl-note', text: '아직 지갑이 없어요. "지금 연결된 API로 추가"를 누르면 편해요.' }));
    }
    for (const w of S.wallets) {
        const unit = walletUnit(w);
        const rem = remainingOf(w);
        const st = spendStats(w);
        const remText = rem.kind === 'real' ? fmt(rem.value, unit)
            : rem.kind === 'est' ? `~${fmt(rem.value, unit)}`
                : rem.kind === 'unlimited' ? '무제한 키 (잔액 대신 사용액만 보여요)' : (TYPES[w.type]?.lookup ? '아직 조회 안 함' : '시작 잔액을 입력해주세요');
        const sub = [];
        if (rem.kind === 'real') sub.push(`조회 ${timeAgo(rem.at)}`);
        if (rem.kind === 'est') sub.push('추정치');
        if (w.real?.unlimited && Number.isFinite(w.real.used)) sub.push(`누적 사용 ${fmt(w.real.used, unit)}`);
        if (keyLinks(w).length) sub.push(`🔑 ${keyLinks(w).map(id => keyInfo[id]?.label || '지워진 키').join(', ')}`);
        if (aliasHosts(w).length) sub.push(`묶인 주소 ${aliasHosts(w).length}개`);
        if (TYPES[w.type]?.source && !keyLinks(w).length && S.wallets.some(x => x !== w && x.type === w.type)) sub.push('기본 지갑');
        if (!TYPES[w.type]?.lookup && calibFactor(w) !== 1) sub.push(`보정 ×${calibFactor(w).toFixed(2)}`);
        if (w.lastDelta) sub.push(`최근 변동 ${fmt(w.lastDelta.amount, unit)}${w.lastDelta.calls > 1 ? ` (${w.lastDelta.calls}회)` : ''}`);

        const card = el('div', { class: 'cl-card' },
            el('div', { class: 'cl-card-head' },
                el('b', { text: w.name }),
                el('span', { class: 'cl-type', text: TYPES[w.type]?.label || w.type })),
            el('div', { class: 'cl-big', text: remText }),
            sub.length ? el('div', { class: 'cl-sub', text: sub.join(' · ') }) : null,
            el('div', { class: 'cl-sub', text: `오늘 ${fmt(st.today, unit)} · 이번 달 ${fmt(st.month, unit)}` }),
            w.lastError ? el('div', { class: 'cl-sub cl-warn-text', text: `⚠️ ${w.lastError}` }) : null,
            el('div', { class: 'cl-row' },
                TYPES[w.type]?.lookup ? el('button', {
                    class: 'menu_button', text: refreshing.has(w.id) ? '조회 중…' : '잔액 조회',
                    disabled: refreshing.has(w.id), onclick: () => refreshBalance(w.id, true),
                }) : el('button', { class: 'menu_button', text: '잔액 보정', onclick: () => calibrate(w) }),
                el('button', { class: 'menu_button', text: '편집', onclick: () => openEditor(w) }),
                el('button', { class: 'menu_button', text: '삭제', onclick: () => removeWallet(w) })),
        );
        box.append(card);
    }
}

const CALIB_MIN_CALLS = 5;
const CALIB_MIN_SPEND = 0.05;
const CALIB_RECENT_MS = 3 * 60 * 60 * 1000;

function resetBase(w, amount, at = Date.now()) {
    w.base = { amount, at };
    w.spentSinceBase = 0;
    w.rawSinceBase = 0;
    w.estCalls = 0;
    w.estApprox = 0;
}

async function calibrate(w) {
    const { Popup } = ctx();
    const cur = remainingOf(w);
    const v = await Popup.show.input(`${w.name} 잔액 보정`, '콘솔에서 확인한 실제 남은 금액을 숫자만 입력해주세요.', cur.value !== null ? cur.value.toFixed(2) : '');
    if (v === null || v === undefined || v === false) return;
    const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
    if (!Number.isFinite(n)) { toastr.warning('숫자를 입력해주세요.'); return; }
    const now = Date.now();
    let report = null;
    if (w.base && Number.isFinite(w.base.amount)) {
        const lastUse = Math.max(0, ...S.entries.filter(e => e.w === w.id).map(e => e.t));
        report = {
            actual: w.base.amount - n,
            raw: w.rawSinceBase || 0,
            shown: w.spentSinceBase || 0,
            calls: w.estCalls || 0,
            approx: w.estApprox || 0,
            reason: '',
        };
        if (report.actual < 0) report.reason = 'topup';
        else if (report.calls < CALIB_MIN_CALLS || report.raw / rateOf(w) < CALIB_MIN_SPEND) report.reason = 'small';
        else if (now - lastUse < CALIB_RECENT_MS) report.reason = 'recent';
        else {
            const measured = report.actual / report.raw;
            report.measured = measured;
            if (measured < 0.2 || measured > 5) report.reason = 'outlier';
            else {
                const prev = w.calib?.factor;
                const next = prev ? prev * 0.4 + measured * 0.6 : measured;
                report.newFactor = Math.min(5, Math.max(0.2, next));
                if (S.autoCalib) w.calib = { factor: report.newFactor, at: now, n: (w.calib?.n || 0) + 1, last: measured };
            }
        }
    }
    resetBase(w, n, now);
    save();
    renderAll();
    if (report) showCalibReport(w, report);
}

function showCalibReport(w, r) {
    const unit = walletUnit(w);
    const lines = [
        `지난 보정 이후 장부 계산: ${fmt(r.shown, unit)} (단가표 그대로면 ${fmt(r.raw, unit)}, ${r.calls}회)`,
        `실제로 줄어든 금액: ${fmt(r.actual, unit)}`,
    ];
    if (r.measured) lines.push(`오차: 단가표 기준 ${r.measured >= 1 ? '+' : ''}${Math.round((r.measured - 1) * 100)}%`);
    const why = {
        topup: '잔액이 오히려 늘었어요. 충전이나 크레딧 추가가 있었던 것 같아서 이번엔 자동 보정하지 않았어요.',
        small: `아직 사용량이 적어서(${CALIB_MIN_CALLS}회 또는 ${fmt(CALIB_MIN_SPEND * rateOf(w), unit)} 미만) 비교하기 일러요. 잔액만 맞춰뒀어요.`,
        recent: '마지막 사용이 3시간 이내예요. 구글 결제는 몇 시간 늦게 반영돼서 이번엔 자동 보정을 건너뛰고 잔액만 맞췄어요. 다음엔 사용 후 반나절~하루 지나서 보정하면 정확해요.',
        outlier: '차이가 너무 커요(5배 이상). 같은 결제 계정에서 다른 서비스를 썼거나, 단가표에 없는/틀린 모델이 있을 수 있어요. 자동 보정하지 않았어요.',
    }[r.reason];
    if (why) lines.push(`ℹ️ ${why}`);
    else if (r.newFactor) {
        lines.push(S.autoCalib
            ? `✅ 자동 보정 적용: 앞으로 계산에 ×${r.newFactor.toFixed(2)}를 곱해요.`
            : `자동 보정이 꺼져 있어요. 켜면 앞으로 ×${r.newFactor.toFixed(2)}를 곱해서 계산해요.`);
    }
    if (r.calls && r.approx / r.calls > 0.3) lines.push(`⚠️ 기록의 ${Math.round(r.approx / r.calls * 100)}%가 토큰 수 추정(≈)이에요. 스트리밍을 켜면 훨씬 정확해져요.`);
    const html = `<div class="cl-report">${lines.map(l => `<p>${escapeHtml(l)}</p>`).join('')}</div>`;
    ctx().Popup.show.text(`${w.name} 진단 결과`, html);
}

async function removeWallet(w) {
    const { Popup } = ctx();
    const ok = await Popup.show.confirm('지갑 삭제', `"${w.name}" 지갑과 그 통계를 지울까요? (API 키나 실리태번 연결은 건드리지 않아요)`);
    if (!ok) return;
    S.wallets = S.wallets.filter(x => x.id !== w.id);
    for (const e of S.entries) if (e.w === w.id) e.w = null;
    save();
    renderAll();
}

function currentConnection() {
    const o = ctx().chatCompletionSettings || {};
    const source = String(o.chat_completion_source || '');
    const viaProxy = !!o.reverse_proxy;
    const relay = (u) => /\.workers\.dev$/i.test(hostOf(u)) || /\.pages\.dev$/i.test(hostOf(u));
    if (source === 'custom') return { type: relay(o.custom_url) ? 'manual' : 'newapi', url: o.custom_url || '', source };
    if (viaProxy) return { type: relay(o.reverse_proxy) ? 'manual' : 'newapi', url: o.reverse_proxy, source, proxy: true };
    if (source === 'vertexai') return { type: 'vertex', source };
    if (source === 'makersuite') return { type: 'gemini', source };
    if (source === 'deepseek') return { type: 'deepseek', source };
    return { type: 'manual', url: '', source };
}

const isRelay = (u) => /\.(workers|pages)\.dev$/i.test(hostOf(u));
const SRC_ALIAS = { google: 'makersuite', oai: 'openai' };
const SRC_TYPE = { vertexai: 'vertex', makersuite: 'gemini', deepseek: 'deepseek' };

/** Moves unassigned past records that belong to wallet w into it. */
function claimEntries(w) {
    const lookup = TYPES[w.type]?.lookup;
    let n = 0;
    for (const e of S.entries) {
        if (e.w) continue;
        const hit = walletFor({ source: e.src, host: e.host, viaProxy: !!e.host && e.src !== 'custom', keyId: e.keyId }) === w;
        if (!hit) continue;
        e.w = w.id;
        n++;
        if (!lookup && Number.isFinite(e.tokenCost)) {
            e.cost = chargeTokens(w, e.tokenCost, e.t);
            e.costSrc = 'tokens';
        }
    }
    return n;
}

async function proxyHostsByName() {
    const map = {};
    try {
        const s = await loadSources(true);
        for (const p of s.proxies || []) map[p.name] = p.host;
        return { map, sources: s };
    } catch { /* plugin missing */ }
    try {
        const mod = await import('../../../openai.js');
        for (const p of mod.proxies || []) if (p?.name && p.url) map[p.name] = hostOf(p.url);
    } catch { /* layout changed */ }
    return { map, sources: null };
}

async function openImport() {
    if (windowPopup) selectTab('wallets');
    const box = document.getElementById('cl_editor');
    if (!box) return;
    const profiles = (ctx().extensionSettings.connectionManager?.profiles || []).filter(p => p && p.mode !== 'tc' && p.api);
    box.hidden = false;
    box.replaceChildren();
    await refreshActiveKeys();
    if (!profiles.length) {
        box.append(el('div', { class: 'cl-note', text: '채팅 완성(Chat Completion) 연결 프로필이 없어요. 실리태번 API 연결 화면의 "연결 프로필"에서 먼저 저장해주세요.' }),
            el('button', { class: 'menu_button', text: '닫기', onclick: () => { box.hidden = true; } }));
        return;
    }
    const { map: proxyHost, sources } = await proxyHostsByName();
    const keyLabel = (id) => (sources?.custom || []).concat(sources?.deepseek || []).find(k => k.id === id);
    const seen = new Set();

    const rows = profiles.map(p => {
        const source = SRC_ALIAS[p.api] || p.api;
        const proxyName = p.proxy && p.proxy !== 'None' ? p.proxy : '';
        let host = '';
        let url = '';
        if (source === 'custom') { url = p['api-url'] || ''; host = hostOf(url); }
        else if (proxyName && proxyHost[proxyName]) { host = proxyHost[proxyName]; url = `https://${host}`; }
        const viaProxy = !!proxyName;
        const type = SRC_TYPE[source];
        // A saved key id tells different accounts of the same kind apart.
        const sid = !host && type ? (p['secret-id'] || '') : '';
        const k = host || (sid ? `${source}|${sid}` : source);
        const existing = sid
            ? S.wallets.find(w => keyLinks(w).includes(sid))
            : walletFor({ source, host, viaProxy });
        const opts = [['skip', '가져오지 않기']];
        if (host) {
            opts.push(['new:newapi', '새 지갑: 프록시 (잔액 조회)'], ['new:manual', '새 지갑: 기타 (단가로 계산)'],
                ['join:vertex', 'Vertex 지갑에 묶기 (같은 Vertex 계정)'], ['join:gemini', 'AI Studio 지갑에 묶기 (같은 구글 키)']);
            for (const w of S.wallets) if (!TYPES[w.type].lookup && w.type !== 'vertex' && w.type !== 'gemini') opts.push([`join:${w.id}`, `"${w.name}" 지갑에 묶기`]);
        } else if (type) {
            opts.push([`new:${type}`, sid ? `새 지갑 (이 계정 전용): ${TYPES[type].label}` : `새 지갑: ${TYPES[type].label}`]);
            if (sid) for (const w of S.wallets.filter(x => x.type === type)) opts.push([`join:${w.id}`, `"${w.name}" 지갑에 묶기 (같은 계정)`]);
        }
        let def = 'skip';
        let note = '';
        const sameType = type ? S.wallets.filter(x => x.type === type) : [];
        if (existing) note = `이미 "${existing.name}" 지갑에 들어가요`;
        else if (seen.has(k)) note = '위 프로필과 같은 연결이에요';
        else if (!host && proxyName) note = '프록시 프리셋 주소를 못 찾았어요';
        else if (host) def = isRelay(url) ? 'join:vertex' : 'new:newapi';
        else if (sid && sameType.length === 1 && !keyLinks(sameType[0]).length) {
            def = `join:${sameType[0].id}`;
            note = `"${sameType[0].name}" 지갑과 같은 계정인지 확인해주세요. 다른 계정이면 "새 지갑"을 고르세요.`;
        } else if (type) def = `new:${type}`;
        else note = `${source}는 아직 지원하지 않아요`;
        if (sid && keyInfo[sid]) note = [`키: ${keyName(sid)}`, note].filter(Boolean).join(' · ');
        if (!existing) seen.add(k);
        let keyRef = null;
        if (source === 'custom') {
            const sid = p['secret-id'] || ((sources?.custom || []).length === 1 ? sources.custom[0].id : '');
            if (sid) keyRef = { slot: 'custom', id: sid };
        } else if (proxyName) keyRef = { slot: 'proxy', name: proxyName };
        const desc = [source, host || '', keyRef?.slot === 'custom' ? `키: ${keyLabel(keyRef.id)?.label || '이름 모름'}` : proxyName ? `프록시: ${proxyName}` : '', p.model || ''].filter(Boolean).join(' · ');
        const sel = el('select', { class: 'text_pole' }, ...opts.map(([v, t]) => el('option', { value: v, text: t, selected: v === def })));
        return { p, source, host, url, keyRef, sel, desc, note, sid };
    });

    const list = el('div', { class: 'cl-import' });
    for (const r of rows) {
        list.append(el('div', { class: 'cl-import-row' },
            el('div', {}, el('b', { text: r.p.name || '(이름 없음)' }), el('div', { class: 'cl-sub', text: r.desc }),
                r.note ? el('div', { class: 'cl-sub cl-warn-text', text: r.note }) : null),
            r.sel));
    }

    const apply = el('button', {
        class: 'menu_button', text: '선택한 대로 추가', onclick: () => {
            const created = [];
            const findOrMake = (type) => {
                let w = S.wallets.find(x => x.type === type);
                if (!w) {
                    w = newWalletOfType(type, type === 'vertex' ? 'Vertex' : 'AI Studio');
                    created.push(w);
                }
                return w;
            };
            let joined = 0;
            for (const r of rows) {
                const v = r.sel.value;
                if (v === 'skip') continue;
                if (v.startsWith('new:')) {
                    const type = v.slice(4);
                    if (TYPES[type].source && !r.sid && S.wallets.some(x => x.type === type)) continue;
                    if (r.sid && S.wallets.some(x => keyLinks(x).includes(r.sid))) continue;
                    if (!TYPES[type].source && S.wallets.some(x => hostOf(x.url) === r.host || aliasHosts(x).includes(r.host))) continue;
                    const w = newWalletOfType(type, r.p.name || TYPES[type].label);
                    if (!TYPES[type].source) w.url = r.url;
                    if (type === 'newapi') w.keyRef = r.keyRef;
                    if (type === 'deepseek') w.secretId = r.sid;
                    if (r.sid) w.keys = [{ id: r.sid, slot: keyInfo[r.sid]?.slot || '' }];
                    created.push(w);
                } else if (v.startsWith('join:')) {
                    const target = v.slice(5);
                    const w = (target === 'vertex' || target === 'gemini') ? findOrMake(target) : S.wallets.find(x => x.id === target);
                    if (!w) continue;
                    if (r.sid) {
                        if (S.wallets.some(x => keyLinks(x).includes(r.sid))) continue;
                        w.keys = [...(w.keys || []), { id: r.sid, slot: keyInfo[r.sid]?.slot || '' }];
                    } else {
                        if (S.wallets.some(x => aliasHosts(x).includes(r.host))) continue;
                        w.aliases = [...(w.aliases || []), r.url];
                    }
                    joined++;
                }
            }
            let moved = 0;
            for (const w of S.wallets) moved += claimEntries(w);
            box.hidden = true;
            save();
            renderAll();
            toastr.success(`지갑 ${created.length}개 추가, 주소 ${joined}개 묶음${moved ? `, 예전 기록 ${moved}건 정리` : ''}.`, '크레딧 장부');
            if (created.some(w => !TYPES[w.type].lookup)) toastr.info('Vertex/AI Studio/기타 지갑은 "잔액 보정"으로 지금 남은 금액을 넣어주세요.', '크레딧 장부');
            if (pluginOk) {
                (async () => {
                    for (const w of created) {
                        if (w.type === 'deepseek' || (w.type === 'newapi' && w.keyRef)) await refreshBalance(w.id, false);
                    }
                })();
            }
        },
    });
    box.append(
        el('b', { text: '연결 프로필에서 가져오기' }),
        el('div', { class: 'cl-note', text: '프로필마다 어떻게 할지 골라주세요. 내 클라우드플레어 워커처럼 전달만 하는 주소는 "Vertex 지갑에 묶기"를 고르면 돼요. 키 값은 읽지 않고 이름만 봐요.' }),
        list,
        el('div', { class: 'cl-row' }, apply, el('button', { class: 'menu_button', text: '취소', onclick: () => { box.hidden = true; } })),
    );
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function openEditor(existing, preset) {
    if (windowPopup) selectTab('wallets');
    const box = document.getElementById('cl_editor');
    if (!box) return;
    const w = existing ? structuredClone(existing) : {
        id: uid(), name: '', type: preset?.type || 'vertex', url: preset?.url || '', unit: '', auto: true, keyRef: null, secretId: '',
    };
    if (!existing && preset?.url) {
        const h = hostOf(preset.url);
        w.name = h.replace(/^api\./, '');
    } else if (!existing) {
        w.name = TYPES[w.type].label.split(' (')[0];
    }

    let sources = null;
    let sourcesErr = '';
    if (pluginOk) {
        try { sources = await loadSources(true); } catch (e) { sourcesErr = e.message; }
    }

    box.hidden = false;
    box.replaceChildren();
    const name = el('input', { class: 'text_pole', value: w.name, placeholder: '예: 돼지족발찜' });
    const type = el('select', { class: 'text_pole' }, ...Object.entries(TYPES).map(([k, v]) => el('option', { value: k, text: v.label, selected: k === w.type })));
    const url = el('input', { class: 'text_pole', value: w.url || '', placeholder: 'https://api.example.com/v1' });
    const keySel = el('select', { class: 'text_pole' });
    const dsSel = el('select', { class: 'text_pole' });
    const startBal = el('input', { class: 'text_pole', type: 'number', step: 'any', value: existing?.base?.amount ?? '', placeholder: '예: 287.40' });
    const curNow = w.unit || '$';
    const known = CURRENCIES.find(c => c.sym === curNow);
    const curSel = el('select', { class: 'text_pole cl-cur' },
        ...CURRENCIES.map(c => el('option', { value: c.sym, text: c.label, selected: known?.sym === c.sym })),
        el('option', { value: 'custom', text: '직접 입력', selected: !known }));
    const unit = el('input', { class: 'text_pole cl-unit', value: known ? '' : curNow, placeholder: '예: €' });
    const rate = el('input', { class: 'text_pole cl-rate', type: 'number', step: 'any', min: '0', value: String(rateOf(w)) });
    const rateLabel = el('span', { class: 'cl-sub' });
    const syncCur = (fromSelect) => {
        const custom = curSel.value === 'custom';
        unit.hidden = !custom;
        const sym = custom ? (unit.value.trim() || '?') : curSel.value;
        if (fromSelect && !custom) rate.value = String(CURRENCIES.find(c => c.sym === sym).rate);
        rateLabel.textContent = `1달러 = `;
        rate.hidden = sym === '$';
        rateLabel.hidden = sym === '$';
        rateSuffix.textContent = sym === '$' ? '' : sym;
    };
    const rateSuffix = el('span', { class: 'cl-sub' });
    curSel.addEventListener('change', () => syncCur(true));
    unit.addEventListener('input', () => syncCur(false));
    const auto = el('input', { type: 'checkbox', checked: w.auto !== false });
    const aliases = el('textarea', { class: 'text_pole', rows: '2', placeholder: 'https://내워커.workers.dev/v1' });
    aliases.value = (w.aliases || []).join('\n');

    function fillKeys() {
        keySel.replaceChildren(el('option', { value: '', text: '— 키를 골라주세요 —' }));
        for (const k of sources?.custom || []) {
            const v = `custom:${k.id}`;
            keySel.append(el('option', { value: v, text: `[사용자 지정 키] ${k.label} (${k.masked})${k.active ? ' · 현재 사용 중' : ''}`, selected: w.keyRef?.slot === 'custom' && w.keyRef.id === k.id }));
        }
        for (const p of sources?.proxies || []) {
            const v = `proxy:${p.name}`;
            keySel.append(el('option', { value: v, text: `[프록시 프리셋] ${p.name} (${p.host})`, selected: w.keyRef?.slot === 'proxy' && w.keyRef.name === p.name }));
        }
        dsSel.replaceChildren(el('option', { value: '', text: '현재 사용 중인 키' }));
        for (const k of sources?.deepseek || []) {
            dsSel.append(el('option', { value: k.id, text: `${k.label} (${k.masked})`, selected: w.secretId === k.id }));
        }
    }
    fillKeys();

    const rowUrl = el('label', { class: 'cl-field' }, el('span', { text: 'API 주소 (실리태번에 넣은 주소 그대로)' }), url);
    const rowKey = el('label', { class: 'cl-field' }, el('span', { text: '잔액 조회에 쓸 키 (실리태번에 저장된 것 중에서)' }), keySel,
        el('small', { text: '키 값은 서버 밖으로 나오지 않아요. 여기엔 이름과 끝 3글자만 보여요. 이 주소에 맞는 키를 골라야 해요.' }));
    const rowDs = el('label', { class: 'cl-field' }, el('span', { text: 'DeepSeek 키' }), dsSel);
    const rowBal = el('div', { class: 'cl-field' },
        el('span', { text: '화폐 단위 (콘솔에 보이는 잔액 기준)' }),
        el('div', { class: 'cl-row' }, curSel, unit, rateLabel, rate, rateSuffix),
        el('small', { text: '단가표는 달러 기준이라, 원·엔·위안이면 환율로 바꿔서 계산해요. 환율이 조금 틀려도 자동 보정이 맞춰가요.' }),
        el('span', { text: '지금 남은 잔액 (콘솔에서 확인한 값)' }), startBal);
    syncCur(false);
    const rowAuto = el('label', { class: 'checkbox_label' }, auto, el('span', { text: '답장 후 자동으로 잔액 조회 (같은 지갑은 1분에 최대 1번)' }));
    const rowAlias = el('label', { class: 'cl-field' },
        el('span', { text: '같은 계정으로 계산할 다른 주소 (한 줄에 하나, 선택)' }), aliases,
        el('small', { text: '예: 같은 Vertex 계정으로 연결된 내 클라우드플레어 워커 주소. 이 주소로 보낸 요청도 이 지갑에서 빠져요. 주소는 이 실리태번 설정 안에만 저장돼요.' }));
    const noPlugin = el('div', { class: 'cl-note cl-warn-text', text: pluginOk ? (sourcesErr ? `키 목록을 못 읽었어요: ${sourcesErr}` : '') : '서버 플러그인이 없으면 이 종류는 실제 잔액 조회가 안 돼요. 기록과 토큰 수는 남아요.' });

    function sync() {
        const t = type.value;
        rowUrl.hidden = !(t === 'newapi' || t === 'manual');
        rowKey.hidden = t !== 'newapi';
        rowDs.hidden = t !== 'deepseek' || (sources?.deepseek || []).length < 2;
        rowBal.hidden = TYPES[t].lookup;
        rowAuto.hidden = !TYPES[t].lookup;
        noPlugin.hidden = !TYPES[t].lookup || (pluginOk && !sourcesErr);
    }
    type.addEventListener('change', sync);
    sync();

    const saveBtn = el('button', {
        class: 'menu_button', text: '저장', onclick: () => {
            const t = type.value;
            const out = {
                ...w,
                name: name.value.trim() || TYPES[t].label,
                type: t,
                url: url.value.trim(),
                unit: TYPES[t].lookup ? (w.unit || '') : (curSel.value === 'custom' ? unit.value.trim().slice(0, 4) : curSel.value),
                rate: TYPES[t].lookup ? undefined : (curSel.value === '$' ? 1 : Number(rate.value)),
                auto: auto.checked,
                aliases: aliases.value.split(/\s+/).map(s => s.trim()).filter(Boolean),
            };
            if (!TYPES[t].lookup) {
                if (!out.unit) { toastr.warning('화폐 단위를 입력해주세요.'); return; }
                if (!(out.rate > 0)) { toastr.warning('환율을 숫자로 입력해주세요. (예: 1달러 = 1400원)'); return; }
                if (existing?.base && existing.unit && existing.unit !== out.unit && startBal.value === String(existing.base.amount)) {
                    toastr.info('화폐 단위가 바뀌었어요. 남은 잔액도 새 단위로 다시 입력해주세요.', '크레딧 장부', { timeOut: 8000 });
                }
            }
            const badAlias = out.aliases.find(a => !hostOf(a));
            if (badAlias) { toastr.warning(`주소 형식을 확인해주세요: ${badAlias.slice(0, 40)}`); return; }
            const taken = S.wallets.find(x => x.id !== out.id && aliasHosts(x).some(h => aliasHosts(out).includes(h)));
            if (taken) { toastr.warning(`그 주소는 이미 "${taken.name}" 지갑에 묶여 있어요.`); return; }
            if ((t === 'newapi' || t === 'manual') && !hostOf(out.url)) { toastr.warning('API 주소를 확인해주세요.'); return; }
            if (t === 'newapi') {
                const v = keySel.value;
                out.keyRef = v.startsWith('custom:') ? { slot: 'custom', id: v.slice(7) } : v.startsWith('proxy:') ? { slot: 'proxy', name: v.slice(6) } : null;
            }
            if (t === 'deepseek') out.secretId = dsSel.value || '';
            if (!TYPES[t].lookup) {
                const n = Number(startBal.value);
                if (startBal.value !== '' && Number.isFinite(n) && n !== existing?.base?.amount) {
                    resetBase(out, n);
                }
            }
            if (existing?.type !== t || existing?.url !== out.url || JSON.stringify(existing?.keyRef) !== JSON.stringify(out.keyRef)) {
                out.real = null;
                out.lastDelta = null;
                out.lastError = '';
            }
            const i = S.wallets.findIndex(x => x.id === out.id);
            if (i >= 0) S.wallets[i] = out; else S.wallets.push(out);
            // Past unassigned requests that belong here now get counted.
            claimEntries(out);
            const dupe = S.wallets.find(x => x.id !== out.id && x.type === out.type && (TYPES[t].source ? true : hostOf(x.url) === hostOf(out.url)));
            if (dupe && TYPES[t].source) toastr.info(`같은 종류 지갑이 여러 개예요. 계정마다 나누려면 관리 창의 "연결 관리" 탭에서 키를 각 지갑에 묶어주세요.`, '크레딧 장부', { timeOut: 8000 });
            else if (dupe) toastr.info(`"${dupe.name}"과 같은 주소라, 기록은 먼저 만든 지갑으로 들어가요.`);
            box.hidden = true;
            save();
            renderAll();
            if (TYPES[t].lookup && pluginOk && (t === 'deepseek' || out.keyRef)) refreshBalance(out.id, true);
        },
    });
    const cancel = el('button', { class: 'menu_button', text: '취소', onclick: () => { box.hidden = true; } });

    box.append(
        el('b', { text: existing ? '지갑 편집' : '새 지갑' }),
        el('label', { class: 'cl-field' }, el('span', { text: '이름' }), name),
        el('label', { class: 'cl-field' }, el('span', { text: '종류' }), type),
        rowUrl, rowKey, rowDs, rowBal, rowAuto, rowAlias, noPlugin,
        el('div', { class: 'cl-row' }, saveBtn, cancel),
    );
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

let summaryBy = 'ext';

function entryValue(e) {
    if (Number.isFinite(e.cost)) return e.cost;
    if (e.costSrc === 'group' && Number.isFinite(e.groupCost) && e.groupN) return e.groupCost / e.groupN;
    return null;
}

/** This month's spend grouped by where it came from (or by chat). */
function renderOriginSummary() {
    const month = dayKey().slice(0, 7);
    const groups = new Map();
    for (const e of S.entries) {
        if (!e.w || dayKey(e.t).slice(0, 7) !== month) continue;
        const w = S.wallets.find(x => x.id === e.w);
        if (!w) continue;
        const label = summaryBy === 'chat' ? (e.chat || '(채팅 밖)') : summaryBy === 'gen' ? (GEN_TYPES[e.gen] || '알 수 없음') : extLabel(e);
        const unit = walletUnit(w);
        const k = `${label}|${unit}`;
        const g = groups.get(k) || { label, unit, n: 0, sum: 0, unknown: 0 };
        g.n++;
        const v = entryValue(e);
        if (v === null) g.unknown++; else g.sum += v;
        groups.set(k, g);
    }
    const sel = el('select', { class: 'text_pole cl-cur' },
        el('option', { value: 'ext', text: '보낸 곳별', selected: summaryBy === 'ext' }),
        el('option', { value: 'chat', text: '채팅별', selected: summaryBy === 'chat' }),
        el('option', { value: 'gen', text: '생성 종류별', selected: summaryBy === 'gen' }));
    sel.addEventListener('change', () => { summaryBy = sel.value; renderLog(); });
    const list = [...groups.values()].sort((a, b) => b.sum - a.sum);
    const tbl = el('table', { class: 'cl-table' },
        el('tr', {}, ...['사용처', '횟수', '합계'].map(h => el('th', { text: h }))),
        ...list.map(g => el('tr', {},
            el('td', { text: g.label }),
            el('td', { text: String(g.n) }),
            el('td', { text: `${fmt(g.sum, g.unit)}${g.unknown ? ` (+${g.unknown}회 금액 모름)` : ''}` }))));
    return el('div', { class: 'cl-card' },
        el('div', { class: 'cl-row' }, el('b', { text: '이번 달 사용처별 합계' }), sel),
        list.length ? tbl : el('div', { class: 'cl-note', text: '이번 달 기록이 없어요.' }),
        el('div', { class: 'cl-note', text: `최근 ${MAX_ENTRIES}건 기록 기준이에요. "보낸 곳"은 요청을 보낸 코드를 거슬러 찾은 거라, 다른 확장을 거쳐 부르면 중간 확장 이름이 나올 수 있어요.` }));
}

function isUnknown(e) {
    return !e.ext && !!e.gen && !['normal', 'swipe', 'regenerate', 'continue', 'impersonate'].includes(e.gen);
}

function renderRules() {
    const card = el('div', { class: 'cl-card' }, el('b', { text: '학습한 사용처' }));
    if (!S.originRules.length) {
        card.append(el('div', { class: 'cl-note', text: '아직 없어요. "사용 기록" 탭에서 "누구? ✎"를 눌러 보낸 확장을 지정하면, 비슷한 요청을 다음부터 알아서 표시해요.' }));
        return card;
    }
    const tbl = el('table', { class: 'cl-table' },
        el('tr', {}, ...['확장', '종류', '모델', '맞힌 횟수', ''].map(h => el('th', { text: h }))));
    for (const r of [...S.originRules].reverse()) {
        tbl.append(el('tr', {},
            el('td', { text: extLabel({ ext: r.ext, gen: r.gen }) }),
            el('td', { text: GEN_TYPES[r.gen] || r.gen }),
            el('td', { text: r.model || '', class: 'cl-model' }),
            el('td', { text: String(r.hits || 0) }),
            el('td', {}, el('button', {
                class: 'menu_button cl-mini', text: '✕', title: '이 학습 지우기',
                onclick: () => { S.originRules = S.originRules.filter(x => x !== r); applyRules(S.entries); save(); renderAll(); },
            }))));
    }
    card.append(tbl, el('div', { class: 'cl-note', text: '지우면 이 학습으로 붙인 이름도 "알 수 없음"으로 돌아가요. 잘못 붙은 기록은 사용 기록에서 ✎로 바로 고칠 수 있어요.' }));
    return card;
}

function renderLog() {
    const box = document.getElementById('cl_log');
    if (!box) return;
    box.replaceChildren();
    const rows = S.entries.slice(-100).reverse();
    if (!rows.length) { box.append(el('div', { class: 'cl-note', text: '기록 없음' })); return; }
    box.append(renderOriginSummary());
    const today = dayKey();
    const tbl = el('table', { class: 'cl-table' },
        el('tr', {}, ...['시간', '지갑', '사용처', '모델', '입력/출력', '비용'].map(h => el('th', { text: h }))));
    for (const e of rows) {
        const w = S.wallets.find(x => x.id === e.w);
        const tok = `${fmtTok(e.in)} / ${fmtTok(e.out + (e.think || 0))}${e.think ? ` (생각 ${fmtTok(e.think)})` : ''}${e.cached ? ` · 캐시 ${fmtTok(e.cached)}` : ''}${e.est ? ' ≈' : ''}`;
        const addBtn = !w ? el('button', {
            class: 'menu_button cl-mini', text: '지갑 만들기',
            onclick: () => openEditor(null, e.host ? { type: 'newapi', url: `https://${e.host}/v1` } : { type: ({ vertexai: 'vertex', makersuite: 'gemini', deepseek: 'deepseek' })[e.src] || 'manual' }),
        }) : null;
        const d = new Date(e.t);
        const time = (dayKey(e.t) === today ? '' : `${d.getMonth() + 1}/${d.getDate()} `) + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        tbl.append(el('tr', {},
            el('td', { text: time }),
            el('td', {}, w ? document.createTextNode(w.name) : el('span', { class: 'cl-warn-text', text: e.host ? maskHost(e.host) : e.src }), addBtn),
            el('td', {}, document.createTextNode(originText(e, { ...S, showModel: false }) || '—'), ' ',
                el('button', {
                    class: `menu_button cl-mini${isUnknown(e) ? ' cl-who' : ''}`,
                    text: isUnknown(e) ? '누구? ✎' : '✎',
                    title: '보낸 확장 지정하기',
                    onclick: () => labelEntry(e),
                })),
            el('td', { text: e.model, class: 'cl-model' }),
            el('td', { text: tok }),
            el('td', { text: entryCostText(e, w) })));
    }
    box.append(tbl, el('div', { class: 'cl-note', text: '≈ 표시는 응답에 토큰 수가 없어서 실리태번 토큰 계산기로 추정한 값이에요 (생각 토큰은 빠져요).' }));
}

function renderPrices() {
    const box = document.getElementById('cl_prices');
    if (!box) return;
    box.replaceChildren();
    const un = document.getElementById('cl_unpriced');
    if (un) un.textContent = S.unpriced.length ? `⚠️ 단가가 없는 모델: ${S.unpriced.join(', ')} — 아래에 추가해주세요.` : '';
    const cols = [['in', '입력 $'], ['out', '출력 $'], ['cached', '캐시 $'], ['in2', '입력 20만↑'], ['out2', '출력 20만↑'], ['from', '시작일'], ['to', '종료일'], ['note', '메모']];
    const today = dayKey();
    const list = el('div', { class: 'cl-prices' });
    S.prices.forEach((p, i) => {
        const on = priceValidOn(p, today);
        const card = el('div', { class: `cl-price${on ? '' : ' cl-off'}` });
        const fields = el('div', { class: 'cl-price-fields' });
        const mkInput = (k) => {
            const text = k === 'model' || k === 'note' || k === 'from' || k === 'to';
            const inp = el('input', { class: 'text_pole', value: p[k] ?? '', type: text ? 'text' : 'number', step: 'any', placeholder: k === 'from' || k === 'to' ? '비우면 항상' : k === 'model' ? '모델 이름 (예: gemini-4-argon)' : '' });
            inp.addEventListener('change', () => {
                if (k === 'model' || k === 'note') p[k] = inp.value.trim();
                else if (k === 'from' || k === 'to') {
                    const v = inp.value.trim();
                    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) { toastr.warning('날짜는 2026-12-01 형식으로 써주세요.'); inp.value = p[k] || ''; return; }
                    p[k] = v || undefined;
                } else {
                    const n = inp.value === '' ? undefined : Number(inp.value);
                    p[k] = Number.isFinite(n) ? n : undefined;
                    if (k === 'in2' || k === 'out2') p.over = 200000;
                }
                S.unpriced = S.unpriced.filter(m => !priceFor(m));
                save();
                renderPrices();
            });
            return inp;
        };
        for (const [k, label] of cols) fields.append(el('label', {}, el('span', { text: label }), mkInput(k)));
        card.append(
            el('div', { class: 'cl-price-head' }, mkInput('model'),
                on ? null : el('span', { class: 'cl-sub', text: '오늘 미적용' }),
                el('button', { class: 'menu_button cl-mini', text: '✕', title: '이 줄 삭제', onclick: () => { S.prices.splice(i, 1); save(); renderPrices(); } })),
            fields);
        list.append(card);
    });
    box.append(list);
}

function renderAll() {
    try {
        renderChip();
        renderPluginStatus();
        renderWallets();
        renderLog();
        renderDiag();
    } catch (e) {
        console.warn('[credit-ledger] render failed', e);
    }
}

function mountPanel() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (host && !document.getElementById('cl_settings')) {
        host.insertAdjacentHTML('beforeend', DRAWER_HTML);
        const root = document.getElementById('cl_settings');
        root.querySelector('#cl_open_window').addEventListener('click', () => openWindow());
        bindOptions(root);
        syncOptions();
    }
    const menu = document.getElementById('extensionsMenu');
    if (menu && !document.getElementById('cl_menu_item')) {
        const item = el('div', { id: 'cl_menu_item', class: 'list-group-item flex-container flexGap5', title: '크레딧 장부 열기' },
            el('div', { class: 'fa-solid fa-wallet extensionsMenuExtensionButton' }),
            document.createTextNode('크레딧 장부'));
        item.addEventListener('click', () => openWindow());
        menu.append(item);
    }
}

// ------------------------------------------------------------ init

(function init() {
    try {
        S = settings();
        installFetchHook();
        const { eventSource, event_types } = ctx();
        const start = () => {
            try {
                mountPanel();
                renderAll();
                checkPlugin();
            } catch (e) {
                console.warn('[credit-ledger] init failed', e);
            }
        };
        if (document.getElementById('extensions_settings')) start();
        eventSource.on(event_types.APP_READY, start);
        refreshActiveKeys().then(() => renderAll());
        eventSource.on(event_types.APP_READY, refreshActiveKeys);
        eventSource.on(event_types.APP_READY, () => setTimeout(probeWrappers, 3000));
        eventSource.on(event_types.GENERATION_STARTED, onGenStarted);
        for (const ev of ['GENERATION_ENDED', 'GENERATION_STOPPED']) if (event_types[ev]) eventSource.on(event_types[ev], onGenEnded);
        for (const ev of ['SECRET_WRITTEN', 'SECRET_DELETED', 'SECRET_ROTATED', 'SECRET_EDITED']) {
            if (event_types[ev]) eventSource.on(event_types[ev], () => { refreshActiveKeys().then(() => { if (windowPopup) renderLinks(); }); });
        }
        setInterval(() => { try { renderChip(); } catch { /* */ } }, 60_000);
    } catch (e) {
        console.warn('[credit-ledger] failed to start', e);
    }
})();
