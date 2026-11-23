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
const MAX_ENTRIES = 300;
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
    wallets: [],
    prices: DEFAULT_PRICES,
    pricesVersion: PRICES_VERSION,
    entries: [],
    unpriced: [],
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

function fmt(n, unit = '$') {
    if (n === null || n === undefined || !Number.isFinite(n)) return '—';
    const a = Math.abs(n);
    const digits = a === 0 ? 2 : a < 0.01 ? 5 : a < 1 ? 4 : a < 1000 ? 2 : 0;
    const s = n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    if (!unit) return s;
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

function walletFor(meta) {
    const host = meta.host;
    // Extra addresses the user tied to a wallet win over everything else,
    // e.g. a personal Cloudflare Worker that relays to the same Vertex account.
    if (host) {
        for (const w of S.wallets) if (aliasHosts(w).includes(host)) return w;
    }
    for (const w of S.wallets) {
        if (w.type === 'newapi' || w.type === 'manual') {
            if (host && hostOf(w.url) === host) return w;
        } else if (!meta.viaProxy && TYPES[w.type]?.source === meta.source) {
            return w;
        }
    }
    return null;
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
    return { source, model: String(body.model || ''), host, viaProxy, stream: !!body.stream, messages: body.messages, t: Date.now() };
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
    const adj = tokenCost * calibFactor(w);
    if (!w.base || t >= w.base.at) {
        w.spentSinceBase = (w.spentSinceBase || 0) + adj;
        w.rawSinceBase = (w.rawSinceBase || 0) + tokenCost;
        w.estCalls = (w.estCalls || 0) + 1;
    }
    addDaily(w, adj, t);
    return adj;
}

function notifyWithdraw(w, amount, calls = 1) {
    if (!S.notify || !w || !Number.isFinite(amount) || amount <= 0) return;
    const unit = walletUnit(w);
    const rem = remainingOf(w);
    const remText = rem.kind === 'real' ? fmt(rem.value, unit) : rem.kind === 'est' ? `~${fmt(rem.value, unit)}` : '';
    const what = calls > 1 ? ` (최근 ${calls}회 합계)` : '';
    const msg = `−${fmt(amount, unit)}${what}${remText ? ` · 잔액 ${remText}` : ''}`;
    try {
        toastr.info(msg, `💳 ${w.name} 출금`, { timeOut: 4500, extendedTimeOut: 2000, toastClass: 'toast cl-bank-toast', preventDuplicates: false });
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
        model: meta.model,
        in: usage.in, out: usage.out, think: usage.think, cached: usage.cached,
        est: estimated,
        cost: lookup ? null : tokenCost,
        costSrc: lookup ? 'pending' : (tokenCost === null ? 'unpriced' : 'tokens'),
        tokenCost,
    };
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
    if (w && !lookup && entry.cost) notifyWithdraw(w, entry.cost);
}

function installFetchHook() {
    if (window.__creditLedgerHooked) return;
    window.__creditLedgerHooked = true;
    const orig = window.fetch;
    window.fetch = function (input, init) {
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
            notifyWithdraw(w, delta, pending.length || 1);
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
        if (aliasHosts(w).length) sub.push(`묶인 주소 ${aliasHosts(w).length}개`);
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
        else if (report.calls < CALIB_MIN_CALLS || report.raw < CALIB_MIN_SPEND) report.reason = 'small';
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
        small: `아직 사용량이 적어서(${CALIB_MIN_CALLS}회 또는 ${fmt(CALIB_MIN_SPEND, unit)} 미만) 비교하기 일러요. 잔액만 맞춰뒀어요.`,
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
    const hosts = aliasHosts(w);
    const own = (w.type === 'newapi' || w.type === 'manual') ? hostOf(w.url) : '';
    const src = TYPES[w.type]?.source;
    const lookup = TYPES[w.type]?.lookup;
    let n = 0;
    for (const e of S.entries) {
        if (e.w) continue;
        const hit = (e.host && (hosts.includes(e.host) || e.host === own)) || (src && !e.host && e.src === src);
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
        const k = host || source;
        const existing = walletFor({ source, host, viaProxy });
        const opts = [['skip', '가져오지 않기']];
        if (host) {
            opts.push(['new:newapi', '새 지갑: 프록시 (잔액 조회)'], ['new:manual', '새 지갑: 기타 (단가로 계산)'],
                ['join:vertex', 'Vertex 지갑에 묶기 (같은 Vertex 계정)'], ['join:gemini', 'AI Studio 지갑에 묶기 (같은 구글 키)']);
            for (const w of S.wallets) if (!TYPES[w.type].lookup && w.type !== 'vertex' && w.type !== 'gemini') opts.push([`join:${w.id}`, `"${w.name}" 지갑에 묶기`]);
        } else if (SRC_TYPE[source]) {
            opts.push([`new:${SRC_TYPE[source]}`, `새 지갑: ${TYPES[SRC_TYPE[source]].label}`]);
        }
        let def = 'skip';
        let note = '';
        if (existing) note = `이미 "${existing.name}" 지갑에 들어가요`;
        else if (seen.has(k)) note = '위 프로필과 같은 연결이에요';
        else if (!host && proxyName) note = '프록시 프리셋 주소를 못 찾았어요';
        else if (host) def = isRelay(url) ? 'join:vertex' : 'new:newapi';
        else if (SRC_TYPE[source]) def = `new:${SRC_TYPE[source]}`;
        else note = `${source}는 아직 지원하지 않아요`;
        if (!existing) seen.add(k);
        let keyRef = null;
        if (source === 'custom') {
            const sid = p['secret-id'] || ((sources?.custom || []).length === 1 ? sources.custom[0].id : '');
            if (sid) keyRef = { slot: 'custom', id: sid };
        } else if (proxyName) keyRef = { slot: 'proxy', name: proxyName };
        const desc = [source, host || '', keyRef?.slot === 'custom' ? `키: ${keyLabel(keyRef.id)?.label || '이름 모름'}` : proxyName ? `프록시: ${proxyName}` : '', p.model || ''].filter(Boolean).join(' · ');
        const sel = el('select', { class: 'text_pole' }, ...opts.map(([v, t]) => el('option', { value: v, text: t, selected: v === def })));
        return { p, source, host, url, keyRef, sel, desc, note };
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
                    w = { id: uid(), name: type === 'vertex' ? 'Vertex' : 'AI Studio', type, url: '', unit: '$', auto: true, aliases: [] };
                    S.wallets.push(w);
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
                    if (TYPES[type].source && S.wallets.some(x => x.type === type)) continue;
                    if (!TYPES[type].source && S.wallets.some(x => hostOf(x.url) === r.host || aliasHosts(x).includes(r.host))) continue;
                    const w = { id: uid(), name: r.p.name || TYPES[type].label, type, url: TYPES[type].source ? '' : r.url, unit: TYPES[type].lookup ? '' : '$', auto: true, aliases: [] };
                    if (type === 'newapi') w.keyRef = r.keyRef;
                    if (type === 'deepseek') w.secretId = r.p['secret-id'] || '';
                    S.wallets.push(w);
                    created.push(w);
                } else if (v.startsWith('join:')) {
                    const target = v.slice(5);
                    const w = (target === 'vertex' || target === 'gemini') ? findOrMake(target) : S.wallets.find(x => x.id === target);
                    if (!w || S.wallets.some(x => aliasHosts(x).includes(r.host))) continue;
                    w.aliases = [...(w.aliases || []), r.url];
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
    const unit = el('input', { class: 'text_pole cl-unit', value: w.unit || '', placeholder: '$' });
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
    const rowBal = el('label', { class: 'cl-field' }, el('span', { text: '지금 남은 잔액 (콘솔에서 확인한 값)' }), el('div', { class: 'cl-row' }, startBal, unit));
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
                unit: unit.value.trim(),
                auto: auto.checked,
                aliases: aliases.value.split(/\s+/).map(s => s.trim()).filter(Boolean),
            };
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
            if (dupe) toastr.info(`"${dupe.name}"과 같은 연결이라, 기록은 먼저 만든 지갑으로 들어가요.`);
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

function renderLog() {
    const box = document.getElementById('cl_log');
    if (!box) return;
    box.replaceChildren();
    const rows = S.entries.slice(-100).reverse();
    if (!rows.length) { box.append(el('div', { class: 'cl-note', text: '기록 없음' })); return; }
    const tbl = el('table', { class: 'cl-table' },
        el('tr', {}, ...['시간', '지갑', '모델', '입력/출력', '비용'].map(h => el('th', { text: h }))));
    for (const e of rows) {
        const w = S.wallets.find(x => x.id === e.w);
        const tok = `${fmtTok(e.in)} / ${fmtTok(e.out + (e.think || 0))}${e.think ? ` (생각 ${fmtTok(e.think)})` : ''}${e.cached ? ` · 캐시 ${fmtTok(e.cached)}` : ''}${e.est ? ' ≈' : ''}`;
        const addBtn = !w ? el('button', {
            class: 'menu_button cl-mini', text: '지갑 만들기',
            onclick: () => openEditor(null, e.host ? { type: 'newapi', url: `https://${e.host}/v1` } : { type: ({ vertexai: 'vertex', makersuite: 'gemini', deepseek: 'deepseek' })[e.src] || 'manual' }),
        }) : null;
        tbl.append(el('tr', {},
            el('td', { text: new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }),
            el('td', {}, w ? document.createTextNode(w.name) : el('span', { class: 'cl-warn-text', text: e.host || e.src }), addBtn),
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
        setInterval(() => { try { renderChip(); } catch { /* */ } }, 60_000);
    } catch (e) {
        console.warn('[credit-ledger] failed to start', e);
    }
})();
