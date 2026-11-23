import { DurableObject } from 'cloudflare:workers';
import { buildMusicIndex, resolveWithIndex } from '../lib/core.mjs';

const SESSION_COOKIE = 'df_session';
const LOGIN_COOKIE = 'df_login';
const SESSION_AGE = 180 * 24 * 60 * 60;
const LOGIN_AGE = 10 * 60;
const CODE_TTL = 15 * 60 * 1000;
const UPLOAD_TTL = 60 * 60 * 1000;
const TOKEN_MARGIN = 30 * 1000;
const MUSIC_TTL = 60 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const HEARTBEAT_MS = 20 * 1000;
const MAX_STREAMS = 200;
// 3000 筆全塞進每一幀會拖垮慢速連線；列表只留前 200 筆，總數另外送。
const UNMATCHED_LIMIT = 200;

const encoder = new TextEncoder();
const PING = encoder.encode(': ping\n\n');

let musicCache = null;
let hmacCache = { secret: '', key: null };

function authOrigin(env) {
  return (env.DF_AUTH_ORIGIN || 'https://auth.diving-fish.com').replace(/\/+$/, '');
}

function proberOrigin(env) {
  return (env.DF_PROBER_ORIGIN || 'https://www.diving-fish.com/api/maimaidxprober').replace(
    /\/+$/,
    '',
  );
}

function scopeOf(env) {
  return env.DF_SCOPE || 'prober.records.write';
}

// /oauth/userinfo 要有 openid 才給呼叫、有 profile 才回 preferred_username。
function loginScope(env) {
  const scopes = ['openid', 'profile', ...scopeOf(env).split(/\s+/)];
  return [...new Set(scopes.filter(Boolean))].join(' ');
}

function allowedOrigins(env) {
  return new Set(
    (env.ALLOWED_ORIGINS || 'https://maimaidx-eng.com,https://maimaidx.jp')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function configured(env) {
  return Boolean(env.DF_CLIENT_ID && env.DF_CLIENT_SECRET && env.SESSION_SECRET);
}

function b64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function randomToken(bytes) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256b64url(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return b64url(new Uint8Array(digest));
}

function hmacKey(env) {
  if (!env.SESSION_SECRET) throw new Error('缺少 SESSION_SECRET');
  if (hmacCache.secret !== env.SESSION_SECRET) {
    hmacCache = {
      secret: env.SESSION_SECRET,
      key: crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(env.SESSION_SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      ),
    };
  }
  return hmacCache.key;
}

async function sign(value, env) {
  const signature = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(env),
    new TextEncoder().encode(value),
  );
  return b64url(new Uint8Array(signature));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verify(value, signature, env) {
  return timingSafeEqual(signature, await sign(value, env));
}

function readCookie(request, name) {
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}

function isHttps(request) {
  return new URL(request.url).protocol === 'https:';
}

function cookie(name, value, maxAge, request) {
  const parts = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (isHttps(request)) parts.push('Secure');
  return parts.join('; ');
}

async function sessionId(request, env, headers) {
  const raw = readCookie(request, SESSION_COOKIE);
  if (raw) {
    const [id, signature] = raw.split('.');
    if (/^[A-Za-z0-9_-]{43}$/.test(id) && signature && (await verify(id, signature, env))) {
      return id;
    }
  }
  const id = randomToken(32);
  const signature = await sign(id, env);
  headers.append('Set-Cookie', cookie(SESSION_COOKIE, `${id}.${signature}`, SESSION_AGE, request));
  return id;
}

async function setLoginCookie(headers, data, request, env) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify(data)));
  const signature = await sign(payload, env);
  headers.append('Set-Cookie', cookie(LOGIN_COOKIE, `${payload}.${signature}`, LOGIN_AGE, request));
}

async function readLoginCookie(request, env) {
  const raw = readCookie(request, LOGIN_COOKIE);
  const [payload, signature] = raw.split('.');
  if (!payload || !signature || !(await verify(payload, signature, env))) return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromB64url(payload)));
  } catch {
    return null;
  }
}

function json(data, status = 200, headers = new Headers()) {
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { status, headers });
}

function redirect(location, headers = new Headers()) {
  headers.set('Location', location);
  headers.set('Cache-Control', 'no-store');
  return new Response(null, { status: 302, headers });
}

function hasScope(granted, required) {
  const have = new Set(String(granted || '').split(/\s+/).filter(Boolean));
  return String(required || '')
    .split(/\s+/)
    .filter(Boolean)
    .every((scope) => have.has(scope));
}

function normalizeCode(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function formatCode(value) {
  return value.length === 8 ? `${value.slice(0, 4)}-${value.slice(4)}` : value;
}

function bookmarklet(origin) {
  return `javascript:(()=>{const s=document.createElement('script');s.src=${JSON.stringify(
    `${origin}/bm.js`,
  )};document.body.appendChild(s)})()`;
}

function appState(env) {
  return env.APP_STATE.get(env.APP_STATE.idFromName('main'));
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

async function musicIndex(env) {
  if (musicCache && Date.now() - musicCache.fetchedAt < MUSIC_TTL) return musicCache.index;

  const headers = {};
  if (musicCache?.etag) headers['If-None-Match'] = musicCache.etag;

  const res = await fetch(`${proberOrigin(env)}/music_data`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 304 && musicCache) {
    musicCache.fetchedAt = Date.now();
    return musicCache.index;
  }
  if (!res.ok) throw new Error(`music_data ${res.status}`);

  const data = await res.json();
  musicCache = {
    index: buildMusicIndex(data),
    etag: res.headers.get('etag') || '',
    fetchedAt: Date.now(),
  };
  return musicCache.index;
}

async function fetchUsername(env, token) {
  try {
    const res = await fetch(`${authOrigin(env)}/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return '';
    const data = await res.json();
    return typeof data.preferred_username === 'string' ? data.preferred_username : '';
  } catch {
    // 拿不到名字不影響匯入，畫面上就不顯示名稱。
    return '';
  }
}

function statePayload(ui, env) {
  const scopeOk = hasScope(ui.info.scope, scopeOf(env));
  const needsLogin = ui.info.hasSession && (ui.info.needsLogin || !scopeOk);
  return {
    loggedIn: ui.info.hasSession && !needsLogin,
    hasSession: ui.info.hasSession,
    needsLogin,
    username: ui.info.username,
    scopeOk,
    scope: scopeOf(env),
    grantedScope: ui.info.scope || '',
    upload: ui.upload && {
      ...ui.upload,
      unmatched: ui.upload.unmatched.slice(0, UNMATCHED_LIMIT),
    },
    code: ui.code ? { value: formatCode(ui.code.code), expiresAt: ui.code.expiresAt } : null,
  };
}

async function handleState(request, env) {
  const headers = new Headers();
  if (!configured(env)) {
    return json(
      {
        loggedIn: false,
        needsLogin: false,
        clientConfigured: false,
        configError: '伺服器尚未設定 DF_CLIENT_ID / DF_CLIENT_SECRET / SESSION_SECRET',
        scope: scopeOf(env),
        grantedScope: '',
        upload: null,
        code: null,
        bookmarklet: bookmarklet(new URL(request.url).origin),
      },
      200,
      headers,
    );
  }

  const id = await sessionId(request, env, headers);
  const ui = await appState(env).getUiState(id);

  return json(
    {
      ...statePayload(ui, env),
      clientConfigured: true,
      scope: scopeOf(env),
      bookmarklet: bookmarklet(new URL(request.url).origin),
    },
    200,
    headers,
  );
}

async function handleEvents(request, env) {
  const headers = new Headers();
  if (!configured(env)) return json({ error: '伺服器尚未設定水魚應用' }, 503, headers);

  const id = await sessionId(request, env, headers);
  const stream = await appState(env).subscribe(id);
  if (!stream) return json({ error: '連線數已達上限，請稍後再試' }, 503, headers);

  // 這次才建立 session 的話，新的 cookie 要跟著 SSE 回應送出去。
  const res = new Response(stream.body, stream);
  const setCookie = headers.get('Set-Cookie');
  if (setCookie) res.headers.set('Set-Cookie', setCookie);
  return res;
}

async function handleLogin(request, env) {
  if (!configured(env)) return redirect('/?auth=config');

  const headers = new Headers();
  await sessionId(request, env, headers);

  const state = randomToken(24);
  const verifier = randomToken(64);
  const challenge = await sha256b64url(verifier);
  const redirectUri = `${new URL(request.url).origin}/callback`;

  const authorize = new URL(`${authOrigin(env)}/oauth/authorize`);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: env.DF_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: loginScope(env),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();

  await setLoginCookie(headers, { state, verifier, redirectUri }, request, env);
  return redirect(authorize.toString(), headers);
}

async function handleCallback(request, env) {
  const headers = new Headers();
  headers.append('Set-Cookie', cookie(LOGIN_COOKIE, '', 0, request));

  const url = new URL(request.url);
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  const error = url.searchParams.get('error') || '';
  const login = await readLoginCookie(request, env);

  if (!login || !state || state !== login.state) return redirect('/?auth=state', headers);
  if (error) {
    const reason = error === 'access_denied' ? 'denied' : error === 'invalid_scope' ? 'scope' : 'error';
    return redirect(`/?auth=${reason}`, headers);
  }
  if (!code) return redirect('/?auth=error', headers);

  const id = await sessionId(request, env, headers);
  const result = await appState(env).login(id, code, login.verifier, login.redirectUri);
  if (!result.ok) {
    const reason = result.error === 'invalid_scope' ? 'scope' : 'error';
    return redirect(`/?auth=${reason}`, headers);
  }
  return redirect('/', headers);
}

async function handleUploadCode(request, env) {
  const headers = new Headers();
  if (!configured(env)) return json({ error: '伺服器尚未設定水魚應用' }, 503, headers);

  const id = await sessionId(request, env, headers);
  const app = appState(env);
  const info = await app.getSessionInfo(id);
  if (!info.hasSession) return json({ error: '請先登入水魚帳號' }, 401, headers);
  if (info.needsLogin) return json({ error: '登入已失效，請重新登入' }, 401, headers);

  const result = await app.createCode(id);
  return json(
    {
      code: formatCode(result.code),
      expiresAt: result.expiresAt,
      bookmarklet: bookmarklet(new URL(request.url).origin),
    },
    200,
    headers,
  );
}

async function handleLogout(request, env) {
  const headers = new Headers();
  if (!configured(env)) return json({ error: '伺服器尚未設定水魚應用' }, 503, headers);

  const id = await sessionId(request, env, headers);
  await appState(env).clearSession(id);
  return json({ ok: true }, 200, headers);
}

async function handleImport(request, env) {
  const headers = new Headers();
  if (!configured(env)) return json({ error: '伺服器尚未設定水魚應用' }, 503, headers);

  const id = await sessionId(request, env, headers);
  const app = appState(env);
  const info = await app.getSessionInfo(id);

  if (!info.hasSession) return json({ error: '尚未登入水魚帳號' }, 401, headers);
  if (info.needsLogin) return json({ error: '登入已失效，請重新登入' }, 401, headers);
  if (!hasScope(info.scope, scopeOf(env))) {
    return json({ error: `目前的授權不含 ${scopeOf(env)}，請重新登入。` }, 403, headers);
  }

  const batch = await app.getUploadRecords(id);
  if (!batch || batch.records.length === 0) {
    return json({ error: '還沒有可匯入的成績' }, 400, headers);
  }
  const records = batch.records;

  const token = await app.getAccessToken(id, false);
  if (!token.ok) {
    if (token.error === 'login_required') {
      return json({ error: '登入已失效，請重新登入' }, 401, headers);
    }
    return json({ error: `換票失敗：${token.message || token.error}` }, 502, headers);
  }

  let res = await sendRecords(env, token.token, records);
  if (res.status === 401) {
    const fresh = await app.getAccessToken(id, true);
    if (!fresh.ok) {
      if (fresh.error === 'login_required') {
        return json({ error: '登入已失效，請重新登入' }, 401, headers);
      }
      return json({ error: `換票失敗：${fresh.message || fresh.error}` }, 502, headers);
    }
    res = await sendRecords(env, fresh.token, records);
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { message: text.slice(0, 500) };
  }

  if (res.ok) {
    const result = { updates: Number(data.updates) || 0, creates: Number(data.creates) || 0 };
    await app.markImported(id, batch.receivedAt, { at: Date.now(), ...result });
    return json({ ok: true, total: records.length, ...result }, 200, headers);
  }
  if (res.status === 401) {
    await app.markNeedsLogin(id);
    return json({ error: '水魚拒絕令牌，請重新登入' }, 401, headers);
  }
  if (res.status === 403) {
    const message = data?.message || '水魚拒絕寫入';
    if (String(message).includes('未同意')) {
      return json({ error: '你尚未在水魚查分器同意使用者協議' }, 403, headers);
    }
    return json({ error: `水魚拒絕寫入：${message}` }, 403, headers);
  }
  if (res.status === 429) return json({ error: '已達今日水魚呼叫上限，請明天再試' }, 429, headers);
  return json(
    { error: `水魚回應 ${res.status}：${data?.message || data?.error || '未知錯誤'}` },
    502,
    headers,
  );
}

function sendRecords(env, token, records) {
  return fetch(`${proberOrigin(env)}/player/update_records`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(records),
    signal: AbortSignal.timeout(60_000),
  });
}

async function handleIngest(request, env) {
  const origin = request.headers.get('Origin') || '';
  const cors = corsHeaders(origin);
  const reply = (data, status) => json(data, status, new Headers(cors));

  if (!allowedOrigins(env).has(origin)) return reply({ error: '不允許的來源' }, 403);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return reply({ error: '只接受 POST' }, 405);

  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > 3 * 1024 * 1024) return reply({ error: '上傳資料太大' }, 413);

  let body;
  try {
    body = await request.json();
  } catch {
    return reply({ error: '資料格式錯誤' }, 400);
  }

  const raw = Array.isArray(body?.records) ? body.records : [];
  if (raw.length === 0) return reply({ error: '沒有收到成績' }, 400);
  if (raw.length > 3000) return reply({ error: '成績筆數超過上限' }, 413);

  const code = normalizeCode(body?.code);
  if (!code) return reply({ error: '缺少上傳碼' }, 400);

  try {
    const app = appState(env);
    const session = await app.peekCode(code);
    if (!session) return reply({ error: '上傳碼無效或已過期，請回網頁重新產生' }, 403);

    const index = await musicIndex(env);
    if (!(await app.consumeCode(code))) {
      return reply({ error: '上傳碼無效或已過期，請回網頁重新產生' }, 403);
    }

    const result = resolveWithIndex(raw, index);
    await app.putUpload(session, result);

    return reply(
      {
        ok: true,
        total: result.stats.total,
        resolved: result.stats.resolved,
        unmatched: result.stats.unmatched,
      },
      200,
    );
  } catch (err) {
    console.error('[ingest]', err);
    return reply({ error: '讀取歌曲資料失敗，請再試一次' }, 502);
  }
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/api/ingest') return handleIngest(request, env);
  if (path === '/api/state') return handleState(request, env);
  if (path === '/api/events' && request.method === 'GET') return handleEvents(request, env);
  if (path === '/api/login') return handleLogin(request, env);
  if (path === '/callback') return handleCallback(request, env);
  if (path === '/api/upload-code' && request.method === 'POST') return handleUploadCode(request, env);
  if (path === '/api/import' && request.method === 'POST') return handleImport(request, env);
  if (path === '/api/logout' && request.method === 'POST') return handleLogout(request, env);

  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      console.error('[worker]', err);
      return json({ error: '伺服器錯誤' }, 500);
    }
  },
};

// shortcut: 全部狀態放在同一個 DO，流量真的變大再拆成 per-session。
export class AppState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.refreshPromises = new Map();
    this.streams = new Map();
    this.heartbeat = null;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL DEFAULT '',
        refresh_token TEXT,
        access_token TEXT,
        access_expires_at INTEGER NOT NULL DEFAULT 0,
        needs_login INTEGER NOT NULL DEFAULT 0,
        username TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      )
    `);
    // 既有部署的 sessions 表沒有 username，加一次就好。
    const columns = this.sql.exec('PRAGMA table_info(sessions)').toArray();
    if (!columns.some((column) => column.name === 'username')) {
      this.sql.exec("ALTER TABLE sessions ADD COLUMN username TEXT NOT NULL DEFAULT ''");
    }
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS codes (
        code TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS uploads (
        session_id TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL,
        stats TEXT NOT NULL,
        unmatched TEXT NOT NULL,
        records TEXT NOT NULL,
        imported TEXT
      )
    `);
  }

  async login(sessionId, code, verifier, redirectUri) {
    const res = await fetch(`${authOrigin(this.env)}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: this.env.DF_CLIENT_ID,
        client_secret: this.env.DF_CLIENT_SECRET,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        error: data.error || 'exchange_failed',
        status: res.status,
        message: data.error_description || data.message || '',
      };
    }

    const now = Date.now();
    const accessToken = String(data.access_token || '');
    this.sql.exec(
      `INSERT INTO sessions
        (id, scope, refresh_token, access_token, access_expires_at, needs_login, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(id) DO UPDATE SET
        scope = excluded.scope,
        refresh_token = excluded.refresh_token,
        access_token = excluded.access_token,
        access_expires_at = excluded.access_expires_at,
        needs_login = 0`,
      sessionId,
      String(data.scope || ''),
      String(data.refresh_token || ''),
      accessToken,
      now + (Number(data.expires_in) || 900) * 1000,
      now,
    );

    // 名稱另外抓。重新登入換帳號時舊名稱一定清掉，寧可空白也不要顯示上一個帳號。
    const username = await fetchUsername(this.env, accessToken);
    this.sql.exec('UPDATE sessions SET username = ? WHERE id = ?', username, sessionId);

    this.#broadcast(sessionId);
    return { ok: true, scope: String(data.scope || '') };
  }

  getSessionInfo(sessionId) {
    const row = this.sql
      .exec(
        'SELECT scope, refresh_token, needs_login, username FROM sessions WHERE id = ?',
        sessionId,
      )
      .toArray()[0];
    if (!row) return { hasSession: false, scope: '', needsLogin: false, username: '' };
    return {
      hasSession: Boolean(row.refresh_token),
      scope: row.scope || '',
      needsLogin: Boolean(row.needs_login) || !row.refresh_token,
      username: row.username || '',
    };
  }

  getUiState(sessionId) {
    return {
      info: this.getSessionInfo(sessionId),
      upload: this.getUploadSummary(sessionId),
      code: this.getCode(sessionId),
    };
  }

  // shortcut: SSE 只存在記憶體，DO 重啟就斷線，瀏覽器會自己重連並補上最新狀態。
  async subscribe(sessionId) {
    let count = 0;
    for (const set of this.streams.values()) count += set.size;
    if (count >= MAX_STREAMS) return null;

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const writers = this.streams.get(sessionId) ?? new Set();
    writers.add(writer);
    this.streams.set(sessionId, writers);

    writer.closed
      .catch(() => {})
      .finally(() => {
        writers.delete(writer);
        if (writers.size === 0) this.streams.delete(sessionId);
      });

    this.#send(writer, this.#frame(sessionId, 'retry: 3000\n'));

    if (!this.heartbeat) this.heartbeat = setInterval(() => this.#tick(), HEARTBEAT_MS);

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  #frame(sessionId, prefix) {
    const payload = statePayload(this.getUiState(sessionId), this.env);
    return encoder.encode(`${prefix}event: state\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  // 用戶端不再讀取時，write 會無上限排隊；積太多就直接斷線，讓瀏覽器重連拿最新狀態。
  #send(writer, bytes) {
    if (writer.desiredSize !== null && writer.desiredSize < -4) {
      writer.abort().catch(() => {});
      return;
    }
    writer.write(bytes).catch(() => {});
  }

  #broadcast(sessionId) {
    const writers = this.streams.get(sessionId);
    if (!writers?.size) return;

    let bytes;
    try {
      bytes = this.#frame(sessionId, '');
    } catch (err) {
      console.error('[sse]', err);
      return;
    }
    for (const writer of writers) this.#send(writer, bytes);
  }

  #tick() {
    if (this.streams.size === 0) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
      return;
    }

    for (const writers of this.streams.values()) {
      for (const writer of writers) this.#send(writer, PING);
    }
  }

  async getAccessToken(sessionId, force) {
    if (this.refreshPromises.has(sessionId)) return this.refreshPromises.get(sessionId);
    const promise = this.#accessToken(sessionId, force).finally(() => {
      this.refreshPromises.delete(sessionId);
    });
    this.refreshPromises.set(sessionId, promise);
    return promise;
  }

  async #accessToken(sessionId, force) {
    const row = this.sql
      .exec(
        'SELECT refresh_token, access_token, access_expires_at, needs_login FROM sessions WHERE id = ?',
        sessionId,
      )
      .toArray()[0];

    if (!row || !row.refresh_token) return { ok: false, error: 'login_required' };
    if (row.needs_login) return { ok: false, error: 'login_required' };
    if (!force && row.access_token && Date.now() < row.access_expires_at - TOKEN_MARGIN) {
      return { ok: true, token: row.access_token };
    }

    const res = await fetch(`${authOrigin(this.env)}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: row.refresh_token,
        client_id: this.env.DF_CLIENT_ID,
        client_secret: this.env.DF_CLIENT_SECRET,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.error === 'invalid_grant') {
        this.sql.exec(
          'UPDATE sessions SET refresh_token = NULL, access_token = NULL, needs_login = 1 WHERE id = ?',
          sessionId,
        );
        this.#broadcast(sessionId);
        return { ok: false, error: 'login_required' };
      }
      return {
        ok: false,
        error: 'refresh_failed',
        status: res.status,
        message: data.error_description || data.error || '',
      };
    }

    const refreshToken = String(data.refresh_token || row.refresh_token);
    const accessToken = String(data.access_token || '');
    const expiresAt = Date.now() + (Number(data.expires_in) || 900) * 1000;

    this.sql.exec(
      'UPDATE sessions SET refresh_token = ?, access_token = ?, access_expires_at = ?, needs_login = 0 WHERE id = ?',
      refreshToken,
      accessToken,
      expiresAt,
      sessionId,
    );

    return { ok: true, token: accessToken };
  }

  markNeedsLogin(sessionId) {
    this.sql.exec('UPDATE sessions SET needs_login = 1 WHERE id = ?', sessionId);
    this.#broadcast(sessionId);
  }

  async clearSession(sessionId) {
    const row = this.sql
      .exec('SELECT refresh_token FROM sessions WHERE id = ?', sessionId)
      .toArray()[0];

    if (row?.refresh_token) {
      try {
        await fetch(`${authOrigin(this.env)}/oauth/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            token: row.refresh_token,
            token_type_hint: 'refresh_token',
            client_id: this.env.DF_CLIENT_ID,
            client_secret: this.env.DF_CLIENT_SECRET,
          }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        // 撤銷失敗還是先清掉本機這份，使用者的水魚設定頁仍可撤銷。
      }
    }

    this.sql.exec('DELETE FROM sessions WHERE id = ?', sessionId);
    this.#broadcast(sessionId);
  }

  createCode(sessionId) {
    const now = Date.now();
    this.sql.exec('DELETE FROM codes WHERE expires_at < ?', now);
    this.sql.exec('DELETE FROM codes WHERE session_id = ?', sessionId);

    const bytes = crypto.getRandomValues(new Uint8Array(8));
    let code = '';
    for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];

    const expiresAt = now + CODE_TTL;
    this.sql.exec(
      'INSERT INTO codes (code, session_id, expires_at) VALUES (?, ?, ?)',
      code,
      sessionId,
      expiresAt,
    );
    this.#broadcast(sessionId);
    return { code, expiresAt };
  }

  getCode(sessionId) {
    const row = this.sql
      .exec(
        'SELECT code, expires_at FROM codes WHERE session_id = ? AND expires_at >= ?',
        sessionId,
        Date.now(),
      )
      .toArray()[0];
    return row ? { code: row.code, expiresAt: row.expires_at } : null;
  }

  peekCode(code) {
    const row = this.sql
      .exec(
        'SELECT session_id FROM codes WHERE code = ? AND expires_at >= ?',
        code,
        Date.now(),
      )
      .toArray()[0];
    return row ? row.session_id : null;
  }

  consumeCode(code) {
    const row = this.sql
      .exec(
        'SELECT session_id FROM codes WHERE code = ? AND expires_at >= ?',
        code,
        Date.now(),
      )
      .toArray()[0];
    this.sql.exec('DELETE FROM codes WHERE code = ?', code);
    if (!row) return null;
    // 書籤後續解析失敗時碼已經沒了，先推一次狀態，頁面才不會還顯示有效。
    this.#broadcast(row.session_id);
    return row.session_id;
  }

  putUpload(sessionId, result) {
    this.sql.exec(
      `INSERT OR REPLACE INTO uploads
        (session_id, received_at, stats, unmatched, records, imported)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      sessionId,
      Date.now(),
      JSON.stringify(result.stats),
      JSON.stringify(result.unmatched),
      JSON.stringify(result.records),
    );
    this.#broadcast(sessionId);
  }

  getUploadSummary(sessionId) {
    const row = this.sql
      .exec(
        'SELECT received_at, stats, unmatched, imported FROM uploads WHERE session_id = ?',
        sessionId,
      )
      .toArray()[0];
    if (!row) return null;
    if (row.received_at + UPLOAD_TTL < Date.now()) {
      this.sql.exec('DELETE FROM uploads WHERE session_id = ?', sessionId);
      return null;
    }

    const unmatched = JSON.parse(row.unmatched);
    return {
      receivedAt: row.received_at,
      expiresAt: row.received_at + UPLOAD_TTL,
      stats: JSON.parse(row.stats),
      unmatched,
      unmatchedTotal: unmatched.length,
      imported: row.imported ? JSON.parse(row.imported) : null,
    };
  }

  getUploadRecords(sessionId) {
    const row = this.sql
      .exec('SELECT received_at, records FROM uploads WHERE session_id = ?', sessionId)
      .toArray()[0];
    if (!row) return null;
    if (row.received_at + UPLOAD_TTL < Date.now()) {
      this.sql.exec('DELETE FROM uploads WHERE session_id = ?', sessionId);
      return null;
    }
    return { receivedAt: row.received_at, records: JSON.parse(row.records) };
  }

  markImported(sessionId, receivedAt, imported) {
    this.sql.exec(
      'UPDATE uploads SET imported = ? WHERE session_id = ? AND received_at = ?',
      JSON.stringify(imported),
      sessionId,
      receivedAt,
    );
    this.#broadcast(sessionId);
  }
}
