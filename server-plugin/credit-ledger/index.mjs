/**
 * Credit Ledger — SillyTavern server plugin.
 *
 * Looks up remaining API balance using keys that SillyTavern ALREADY stores
 * on the server, so the browser never sees a key.
 *
 * Hard security rules (do not relax):
 *   1. Key values never leave this process except in the Authorization header
 *      of a balance request. They are never returned, logged, or written.
 *   2. A key is only ever sent to a host it is already bound to by the user's
 *      own SillyTavern settings:
 *        - DeepSeek key   -> api.deepseek.com only (hard-coded)
 *        - Custom key     -> only a host that appears in the user's saved
 *                            Custom URL / connection profiles / proxy presets,
 *                            and when several custom keys exist the caller must
 *                            name exactly which key (no "whatever is active").
 *        - Proxy preset   -> only that preset's own URL.
 *      Google / Vertex / OpenAI / Claude keys are never read at all.
 *   3. HTTPS only, redirects refused, fixed read-only GET paths, 15 s timeout,
 *      response size capped.
 *   4. Server-side throttle: at most one real lookup per target every 30 s,
 *      whatever the browser asks. Protects proxy accounts from rate limits.
 *   5. Read-only: no payment, key or account endpoints are ever called.
 */

import fs from 'node:fs';
import path from 'node:path';

export const info = {
    id: 'credit-ledger',
    name: 'Credit Ledger',
    description: 'Read-only API balance lookup using keys already stored by SillyTavern.',
};

const VERSION = '1.0.0';
const MIN_INTERVAL_MS = 30_000;
const TIMEOUT_MS = 15_000;
const MAX_BODY = 256 * 1024;
const STATUS_TTL_MS = 6 * 60 * 60 * 1000;

const SLOT_KEYS = Object.freeze({
    custom: 'api_key_custom',
    deepseek: 'api_key_deepseek',
});

/** @type {Map<string, {at:number, result:any}>} */
const cache = new Map();
/** @type {Map<string, Promise<any>>} */
const inflight = new Map();
/** @type {Map<string, {at:number, data:any}>} */
const statusCache = new Map();

let stReadSecret = null;

// ------------------------------------------------------------ helpers

function maskText(s) {
    return String(s ?? '')
        .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
        .replace(/\b(Bearer\s+)\S+/gi, '$1***')
        .slice(0, 300);
}

function readJsonFile(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
        return null;
    }
}

/** Reads the raw secrets array for one slot. Values stay inside this module. */
function readSlot(directories, slotKey) {
    const data = readJsonFile(path.join(directories.root, 'secrets.json'));
    const arr = data?.[slotKey];
    if (Array.isArray(arr)) return arr.filter(x => x && typeof x.value === 'string' && x.value);
    if (typeof arr === 'string' && arr) return [{ id: '', value: arr, label: 'Key', active: true }];
    return [];
}

function readSecretValue(directories, slotKey, secretId) {
    if (stReadSecret) {
        try {
            const v = stReadSecret(directories, slotKey, secretId || null);
            if (v) return v;
        } catch { /* fall through */ }
    }
    const arr = readSlot(directories, slotKey);
    const hit = arr.find(s => (secretId ? s.id === secretId : s.active));
    return hit?.value || '';
}

function maskValue(v) {
    const s = String(v || '');
    return s.length <= 10 ? '**********' : '*******' + s.slice(-3);
}

function hostOf(url) {
    try {
        const u = new URL(String(url));
        return u.protocol === 'https:' ? u.host.toLowerCase() : '';
    } catch {
        return '';
    }
}

/** Hosts the user has bound to the Custom key in their own ST settings. */
function allowedCustomHosts(directories) {
    const s = readJsonFile(path.join(directories.root, 'settings.json')) || {};
    const urls = [];
    const oai = s.oai_settings || {};
    urls.push(oai.custom_url, oai.reverse_proxy);
    for (const p of (Array.isArray(s.proxies) ? s.proxies : [])) urls.push(p?.url);
    const profiles = s.extension_settings?.connectionManager?.profiles;
    for (const p of (Array.isArray(profiles) ? profiles : [])) urls.push(p?.['api-url'], p?.['proxy-url']);
    return new Set(urls.map(hostOf).filter(Boolean));
}

function proxyPresets(directories) {
    const s = readJsonFile(path.join(directories.root, 'settings.json')) || {};
    const list = Array.isArray(s.proxies) ? s.proxies : [];
    return list.filter(p => p && p.name && p.name !== 'None' && p.url);
}

async function safeGet(url, key) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
        const headers = { Accept: 'application/json' };
        if (key) headers.Authorization = `Bearer ${key}`;
        const res = await fetch(url, { method: 'GET', headers, redirect: 'error', signal: ctl.signal });
        const text = (await res.text()).slice(0, MAX_BODY);
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        return { status: res.status, ok: res.ok, json };
    } finally {
        clearTimeout(timer);
    }
}

class LookupError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

// ------------------------------------------------------------ providers

async function lookupDeepSeek(key) {
    const r = await safeGet('https://api.deepseek.com/user/balance', key);
    if (r.status === 401 || r.status === 403) throw new LookupError('auth', '키가 거절됐어요 (401/403).');
    if (r.status === 429) throw new LookupError('rate', '조회가 너무 잦다고 거절됐어요 (429). 잠시 뒤에 다시 해주세요.');
    if (!r.ok || !r.json) throw new LookupError('http', `잔액 조회 실패 (HTTP ${r.status}).`);
    const infos = Array.isArray(r.json.balance_infos) ? r.json.balance_infos : [];
    const main = infos.find(i => i.currency === 'USD') || infos[0];
    if (!main) throw new LookupError('format', '응답에 잔액 정보가 없어요.');
    return {
        remaining: Number(main.total_balance),
        used: null,
        unlimited: false,
        unit: main.currency === 'CNY' ? '¥' : '$',
        currency: main.currency,
        available: !!r.json.is_available,
        balances: infos.map(i => ({ currency: i.currency, total: Number(i.total_balance) })),
    };
}

async function siteStatus(origin) {
    const hit = statusCache.get(origin);
    if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.data;
    let data = null;
    try {
        // Public, anonymous endpoint — no key sent.
        const r = await safeGet(`${origin}/api/status`, '');
        data = r.json?.data || null;
    } catch { /* optional */ }
    statusCache.set(origin, { at: Date.now(), data });
    return data;
}

async function lookupNewApi(origin, key) {
    const [sub, use] = [
        await safeGet(`${origin}/v1/dashboard/billing/subscription`, key),
        await safeGet(`${origin}/v1/dashboard/billing/usage`, key),
    ];
    for (const r of [sub, use]) {
        if (r.status === 401 || r.status === 403) throw new LookupError('auth', '키가 거절됐어요 (401/403).');
        if (r.status === 429) throw new LookupError('rate', '조회가 너무 잦다고 거절됐어요 (429). 잠시 뒤에 다시 해주세요.');
        if (!r.ok || !r.json || r.json.error) {
            throw new LookupError('http', `이 사이트는 잔액 조회를 지원하지 않거나 실패했어요 (HTTP ${r.status}).`);
        }
    }
    const granted = Number(sub.json.hard_limit_usd);
    const used = Number(use.json.total_usage) / 100;
    if (!Number.isFinite(granted) || !Number.isFinite(used)) throw new LookupError('format', '응답 형식을 알 수 없어요.');
    const unlimited = granted >= 99_999_999;

    const st = await siteStatus(origin);
    let unit = '';
    if (st) {
        const t = String(st.quota_display_type || '').toUpperCase();
        if (t === 'CNY') unit = '¥';
        else if (t === 'USD') unit = '$';
        else if (t === 'TOKENS') unit = 'tok';
        else if (st.custom_currency_symbol && st.custom_currency_symbol !== '¤') unit = String(st.custom_currency_symbol).slice(0, 4);
    }
    return {
        remaining: unlimited ? null : round(granted - used),
        used: round(used),
        unlimited,
        unit,
        siteName: st?.system_name ? String(st.system_name).slice(0, 40) : '',
    };
}

function round(n) {
    return Math.round(n * 1e6) / 1e6;
}

// ------------------------------------------------------------ routes

export async function init(router) {
    try {
        const mod = await import('../../src/endpoints/secrets.js');
        if (typeof mod.readSecret === 'function') stReadSecret = mod.readSecret;
    } catch {
        // Older/newer layout: fall back to reading secrets.json directly.
    }

    router.get('/ping', (_req, res) => res.json({ ok: true, version: VERSION }));

    // Lists which keys exist — labels and masked tails only, never values.
    router.get('/sources', (req, res) => {
        try {
            const dirs = req.user.directories;
            const list = (slot) => readSlot(dirs, SLOT_KEYS[slot]).map(s => ({
                id: s.id || '', label: String(s.label || 'Key').slice(0, 60), masked: maskValue(s.value), active: !!s.active,
            }));
            res.json({
                custom: list('custom'),
                deepseek: list('deepseek'),
                proxies: proxyPresets(dirs).map(p => ({ name: String(p.name).slice(0, 60), host: hostOf(p.url), hasPassword: !!p.password })),
                allowedHosts: [...allowedCustomHosts(dirs)],
            });
        } catch {
            res.status(500).json({ error: '키 목록을 읽지 못했어요.' });
        }
    });

    router.post('/balance', async (req, res) => {
        try {
            const dirs = req.user.directories;
            const b = req.body || {};
            const kind = String(b.kind || '');
            let key = '';
            let origin = '';
            let target = '';

            if (kind === 'deepseek') {
                const arr = readSlot(dirs, SLOT_KEYS.deepseek);
                if (!arr.length) throw new LookupError('nokey', '실리태번에 저장된 DeepSeek 키가 없어요.');
                key = readSecretValue(dirs, SLOT_KEYS.deepseek, b.secretId ? String(b.secretId) : null);
                target = `deepseek|${b.secretId || 'active'}`;
            } else if (kind === 'newapi') {
                if (b.slot === 'proxy') {
                    const preset = proxyPresets(dirs).find(p => p.name === String(b.proxyName || ''));
                    if (!preset) throw new LookupError('nokey', '그 이름의 프록시 프리셋을 찾지 못했어요.');
                    if (!preset.password) throw new LookupError('nokey', '프록시 프리셋에 비밀번호(키)가 없어요.');
                    if (!hostOf(preset.url)) throw new LookupError('url', 'https 주소만 조회할 수 있어요.');
                    origin = new URL(preset.url).origin;
                    key = preset.password;
                    target = `proxy|${preset.name}`;
                } else {
                    const host = hostOf(b.baseUrl);
                    if (!host) throw new LookupError('url', 'https 주소만 조회할 수 있어요.');
                    if (!allowedCustomHosts(dirs).has(host)) {
                        throw new LookupError('url', '이 주소는 실리태번 연결 설정에 저장돼 있지 않아서 키를 보낼 수 없어요. 먼저 실리태번에서 이 주소로 연결해주세요.');
                    }
                    const arr = readSlot(dirs, SLOT_KEYS.custom);
                    if (!arr.length) throw new LookupError('nokey', '실리태번에 저장된 사용자 지정(Custom) 키가 없어요.');
                    const sid = b.secretId ? String(b.secretId) : '';
                    if (!sid && arr.length > 1) throw new LookupError('pick', '사용자 지정 키가 여러 개라서, 이 지갑에 쓸 키를 먼저 골라주세요.');
                    if (sid && !arr.some(s => s.id === sid)) throw new LookupError('nokey', '고른 키가 실리태번에서 지워졌어요. 키를 다시 골라주세요.');
                    key = readSecretValue(dirs, SLOT_KEYS.custom, sid || null);
                    origin = new URL(b.baseUrl).origin;
                    target = `custom|${host}|${sid || 'only'}`;
                }
            } else {
                throw new LookupError('kind', '지원하지 않는 조회 종류예요.');
            }
            if (!key) throw new LookupError('nokey', '키를 찾지 못했어요.');

            const userKey = `${req.user.profile?.handle || 'u'}|${target}`;
            const hit = cache.get(userKey);
            if (hit && Date.now() - hit.at < MIN_INTERVAL_MS) {
                return res.json({ ...hit.result, cached: true, at: hit.at });
            }
            if (!inflight.has(userKey)) {
                const p = (kind === 'deepseek' ? lookupDeepSeek(key) : lookupNewApi(origin, key))
                    .then(result => { cache.set(userKey, { at: Date.now(), result }); return result; })
                    .finally(() => inflight.delete(userKey));
                inflight.set(userKey, p);
            }
            const result = await inflight.get(userKey);
            key = '';
            return res.json({ ...result, cached: false, at: cache.get(userKey)?.at || Date.now() });
        } catch (err) {
            if (err instanceof LookupError) return res.status(400).json({ error: err.message, code: err.code });
            const msg = err?.name === 'AbortError' ? '응답이 15초 안에 오지 않았어요.' : '연결에 실패했어요.';
            console.warn('[credit-ledger] lookup failed:', maskText(err?.message));
            return res.status(502).json({ error: msg, code: 'net' });
        }
    });

    console.log('[credit-ledger] loaded (read-only balance lookup)');
}

export async function exit() {
    cache.clear();
    inflight.clear();
}
