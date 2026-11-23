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
const DEFAULT_PRICES = [
    { model: 'gemini-2.5-pro', in: 1.25, out: 10, cached: 0.125, over: 200000, in2: 2.5, out2: 15 },
    { model: 'gemini-2.5-flash', in: 0.30, out: 2.50, cached: 0.03 },
    { model: 'gemini-2.5-flash-lite', in: 0.10, out: 0.40, cached: 0.01 },
    { model: 'gemini-3-pro', in: 2, out: 12, cached: 0.20, over: 200000, in2: 4, out2: 18 },
    { model: 'gemini-3.1-pro', in: 2, out: 12, cached: 0.20, over: 200000, in2: 4, out2: 18 },
    { model: 'gemini-3-flash', in: 0.50, out: 3, cached: 0.05 },
];

const defaultSettings = Object.freeze({
    showChip: true,
    wallets: [],
    prices: DEFAULT_PRICES,
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
    for (const k of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(es[MODULE], k)) es[MODULE][k] = structuredClone(defaultSettings[k]);
    }
    return es[MODULE];
}
const save = () => ctx().saveSettingsDebounced();
const uid = () => Math.random().toString(36).slice(2, 10);

function dayKey(t = Date.now()) {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

function priceFor(model) {
    const id = String(model || '').toLowerCase().replace(/^models\//, '').split('/').pop();
    let best = null;
    for (const p of S.prices) {
        const key = String(p.model || '').toLowerCase().trim();
        if (key && id.startsWith(key) && (!best || key.length > best.model.length)) best = { ...p, model: key };
    }
    return best;
}

function costFromTokens(model, u) {
    const p = priceFor(model);
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

function record(meta, usage, estimated) {
    const w = walletFor(meta);
    const lookup = w && TYPES[w.type]?.lookup;
    const tokenCost = costFromTokens(meta.model, usage);
    const entry = {
        id: uid(),
        t: Date.now(),
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
        w.spentSinceBase = (w.spentSinceBase || 0) + tokenCost;
        addDaily(w, tokenCost);
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
        chip.addEventListener('click', openPanel);
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

function openPanel() {
    const drawer = document.querySelector('#cl_settings .inline-drawer-content');
    const toggle = document.querySelector('#cl_settings .inline-drawer-toggle');
    if (drawer && toggle && getComputedStyle(drawer).display === 'none') toggle.click();
    const panel = document.getElementById('rm_extensions_block');
    if (panel && !panel.classList.contains('openDrawer')) {
        document.querySelector('#extensions-settings-button .drawer-toggle')?.click();
    }
    setTimeout(() => document.getElementById('cl_settings')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);
}

// ------------------------------------------------------------ UI: panel

const PANEL_HTML = `
<div id="cl_settings" class="cl-root">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>💳 크레딧 장부</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div id="cl_plugin_status" class="cl-note"></div>
      <div id="cl_wallets"></div>
      <div class="cl-row">
        <button id="cl_add" class="menu_button">＋ 지갑 추가</button>
        <button id="cl_add_current" class="menu_button">＋ 지금 연결된 API로 추가</button>
      </div>
      <div id="cl_editor" class="cl-editor" hidden></div>
      <details class="cl-section">
        <summary>최근 사용 기록</summary>
        <div id="cl_log"></div>
      </details>
      <details class="cl-section">
        <summary>토큰 단가표 (Vertex / AI Studio / 기타)</summary>
        <div class="cl-note">1백만 토큰당 가격이에요. 모델 이름은 앞부분만 맞으면 돼요 (예: <code>gemini-2.5-pro</code>는 <code>gemini-2.5-pro-preview-05-06</code>에도 적용). 기본값은 참고용이니 구글 요금 페이지에서 꼭 확인해주세요. "20만↑"은 입력이 20만 토큰을 넘을 때 가격이에요.</div>
        <div id="cl_unpriced" class="cl-note cl-warn-text"></div>
        <div id="cl_prices"></div>
        <div class="cl-row">
          <button id="cl_price_add" class="menu_button">＋ 모델 추가</button>
          <button id="cl_price_reset" class="menu_button">기본값으로</button>
        </div>
      </details>
      <label class="checkbox_label"><input id="cl_show_chip" type="checkbox"> 입력창 위에 요약 줄 보이기</label>
    </div>
  </div>
</div>`;

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
    const box = document.getElementById('cl_plugin_status');
    if (!box) return;
    const needs = S.wallets.some(w => TYPES[w.type]?.lookup);
    if (pluginOk === null) box.textContent = '서버 플러그인 확인 중…';
    else if (pluginOk) box.textContent = '✅ 서버 플러그인 연결됨 — DeepSeek·프록시 실제 잔액을 조회할 수 있어요.';
    else box.textContent = needs
        ? '⚠️ 서버 플러그인이 없어서 DeepSeek·프록시 실제 잔액은 조회할 수 없어요. (Vertex 계산은 정상 작동해요)'
        : 'ℹ️ 서버 플러그인 없음 — Vertex·AI Studio 계산에는 필요 없어요.';
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

async function calibrate(w) {
    const { Popup } = ctx();
    const cur = remainingOf(w);
    const v = await Popup.show.input(`${w.name} 잔액 보정`, '콘솔에서 확인한 실제 남은 금액을 숫자만 입력해주세요.', cur.value !== null ? cur.value.toFixed(2) : '');
    if (v === null || v === undefined || v === false) return;
    const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
    if (!Number.isFinite(n)) { toastr.warning('숫자를 입력해주세요.'); return; }
    w.base = { amount: n, at: Date.now() };
    w.spentSinceBase = 0;
    save();
    renderAll();
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

async function openEditor(existing, preset) {
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
                    out.base = { amount: n, at: Date.now() };
                    out.spentSinceBase = 0;
                }
            }
            if (existing?.type !== t || existing?.url !== out.url || JSON.stringify(existing?.keyRef) !== JSON.stringify(out.keyRef)) {
                out.real = null;
                out.lastDelta = null;
                out.lastError = '';
            }
            const i = S.wallets.findIndex(x => x.id === out.id);
            if (i >= 0) S.wallets[i] = out; else S.wallets.push(out);
            // Past unassigned requests to a newly tied address now belong here.
            const hosts = aliasHosts(out);
            for (const e of S.entries) {
                if (e.w || !e.host || !hosts.includes(e.host)) continue;
                e.w = out.id;
                if (!TYPES[t].lookup && Number.isFinite(e.tokenCost)) {
                    e.cost = e.tokenCost;
                    e.costSrc = 'tokens';
                    if (!out.base || e.t >= out.base.at) out.spentSinceBase = (out.spentSinceBase || 0) + e.tokenCost;
                    addDaily(out, e.tokenCost, e.t);
                }
            }
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
    const rows = S.entries.slice(-30).reverse();
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
    const cols = [['model', '모델'], ['in', '입력'], ['out', '출력'], ['cached', '캐시'], ['in2', '입력 20만↑'], ['out2', '출력 20만↑']];
    const tbl = el('table', { class: 'cl-table cl-prices' }, el('tr', {}, ...cols.map(([, h]) => el('th', { text: h })), el('th')));
    S.prices.forEach((p, i) => {
        const tr = el('tr');
        for (const [k] of cols) {
            const inp = el('input', { class: 'text_pole', value: p[k] ?? '', type: k === 'model' ? 'text' : 'number', step: 'any' });
            inp.addEventListener('change', () => {
                if (k === 'model') p.model = inp.value.trim();
                else {
                    const n = inp.value === '' ? undefined : Number(inp.value);
                    p[k] = Number.isFinite(n) ? n : undefined;
                    if (k === 'in2' || k === 'out2') p.over = 200000;
                }
                S.unpriced = S.unpriced.filter(m => !priceFor(m));
                save();
                renderPrices();
            });
            tr.append(el('td', {}, inp));
        }
        tr.append(el('td', {}, el('button', { class: 'menu_button cl-mini', text: '✕', onclick: () => { S.prices.splice(i, 1); save(); renderPrices(); } })));
        tbl.append(tr);
    });
    box.append(tbl);
}

function renderAll() {
    try {
        renderChip();
        renderPluginStatus();
        renderWallets();
        renderLog();
    } catch (e) {
        console.warn('[credit-ledger] render failed', e);
    }
}

function mountPanel() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host || document.getElementById('cl_settings')) return;
    host.insertAdjacentHTML('beforeend', PANEL_HTML);
    document.getElementById('cl_add').addEventListener('click', () => openEditor(null));
    document.getElementById('cl_add_current').addEventListener('click', () => openEditor(null, currentConnection()));
    document.getElementById('cl_price_add').addEventListener('click', () => { S.prices.push({ model: '', in: 0, out: 0 }); save(); renderPrices(); });
    document.getElementById('cl_price_reset').addEventListener('click', async () => {
        if (!await ctx().Popup.show.confirm('단가표 초기화', '기본 단가표로 되돌릴까요? 직접 넣은 값은 사라져요.')) return;
        S.prices = structuredClone(DEFAULT_PRICES);
        save();
        renderPrices();
    });
    const chk = document.getElementById('cl_show_chip');
    chk.checked = !!S.showChip;
    chk.addEventListener('change', () => { S.showChip = chk.checked; save(); renderChip(); });
    renderPrices();
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
