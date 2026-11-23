const $ = (id) => document.getElementById(id);
const DIFFS = ['BASIC', 'ADVANCED', 'EXPERT', 'MASTER', 'Re:MASTER'];

const ui = {
  configWarning: $('config-warning'),
  bindState: $('bind-state'),
  bindLoggedOut: $('bind-logged-out'),
  bindLoggedIn: $('bind-logged-in'),
  bindGranted: $('bind-granted'),
  bindScopeWarning: $('bind-scope-warning'),
  bindError: $('bind-error'),
  logout: $('logout'),
  bookmarklet: $('bookmarklet'),
  uploadCode: $('upload-code'),
  newCode: $('new-code'),
  codeHint: $('code-hint'),
  importEmpty: $('import-empty'),
  importReady: $('import-ready'),
  statTotal: $('stat-total'),
  statResolved: $('stat-resolved'),
  statUnmatched: $('stat-unmatched'),
  unmatchedBox: $('unmatched-box'),
  unmatchedCount: $('unmatched-count'),
  unmatchedList: $('unmatched-list'),
  importBtn: $('import-btn'),
  importResult: $('import-result'),
  scopeLabel: $('scope-label'),
};

let state = {
  loggedIn: false,
  hasSession: false,
  needsLogin: false,
  grantedScope: '',
  scopeOk: true,
  clientConfigured: true,
  upload: null,
  code: null,
  bookmarklet: '',
  scope: '',
};
let importBusy = false;
let codeBusy = false;
let codeAttempted = false;
let codeTimer = null;
let uploadTimer = null;
let importNotice = null;
let lastUploadAt = 0;

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function number(value) {
  return Number(value || 0).toLocaleString('zh-TW');
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString('zh-TW', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function setNotice(element, message, warning) {
  element.textContent = message;
  element.className = warning ? 'notice notice-warn' : 'notice';
  element.hidden = !message;
}

function renderBind() {
  const loggedIn = state.loggedIn;
  ui.bindState.textContent = loggedIn ? '已登入' : state.needsLogin ? '需重新登入' : '未登入';
  ui.bindState.classList.toggle('is-bound', loggedIn);

  ui.bindLoggedOut.hidden = loggedIn;
  ui.bindLoggedIn.hidden = !loggedIn;
  ui.bindGranted.textContent =
    loggedIn && state.grantedScope ? `（授權範圍：${state.grantedScope}）` : '';

  ui.bindScopeWarning.hidden = !state.needsLogin;
  if (state.needsLogin) {
    ui.bindScopeWarning.textContent = state.scopeOk
      ? '登入已失效，請重新登入。'
      : `授權範圍是「${state.grantedScope || '未知'}」，需要「${state.scope}」才能匯入。請重新登入。`;
  }
}

function renderCode() {
  clearTimeout(codeTimer);
  ui.bookmarklet.setAttribute('href', state.bookmarklet || '#');
  ui.newCode.disabled = !state.hasSession;

  if (!state.hasSession) {
    ui.uploadCode.textContent = '--------';
    ui.codeHint.textContent = '登入後才會產生上傳碼。';
    return;
  }

  if (state.code && state.code.expiresAt > Date.now()) {
    ui.uploadCode.textContent = state.code.value;
    ui.codeHint.textContent = `有效到 ${formatTime(state.code.expiresAt)}。`;
    codeTimer = setTimeout(renderCode, state.code.expiresAt - Date.now() + 1000);
  } else if (state.code) {
    ui.uploadCode.textContent = '已過期';
    ui.codeHint.textContent = '按「重新產生」取得新的上傳碼。';
  } else if (state.upload) {
    ui.uploadCode.textContent = '已使用';
    ui.codeHint.textContent = '這批成績已經送到伺服器。';
  } else {
    ui.uploadCode.textContent = '--------';
    ui.codeHint.textContent = '按「重新產生」取得新的上傳碼。';
  }
}

function renderUnmatched(upload) {
  const total = upload.unmatchedTotal || 0;
  ui.unmatchedBox.hidden = total === 0;
  ui.unmatchedCount.textContent = number(total);
  ui.unmatchedList.replaceChildren();

  for (const item of upload.unmatched || []) {
    const li = document.createElement('li');
    const diff = DIFFS[item.level_index] || '?';
    const reason =
      item.reason === 'not_found'
        ? '水魚沒有這首歌'
        : item.reason === 'ambiguous'
          ? '無法分辨是哪一首'
          : '資料格式不對';
    const title = String(item.title || '').trim() || '(空白歌名)';
    li.textContent = `${title} [${item.type}] ${diff}：${reason}`;
    ui.unmatchedList.append(li);
  }

  if (total > (upload.unmatched || []).length) {
    const li = document.createElement('li');
    li.textContent = `…還有 ${number(total - upload.unmatched.length)} 筆`;
    ui.unmatchedList.append(li);
  }
}

function renderUpload() {
  clearTimeout(uploadTimer);
  const upload = state.upload;
  ui.importEmpty.hidden = Boolean(upload);
  ui.importReady.hidden = !upload;
  if (!upload) {
    importNotice = null;
    lastUploadAt = 0;
    setNotice(ui.importResult, '', false);
    return;
  }

  if (upload.receivedAt !== lastUploadAt) {
    lastUploadAt = upload.receivedAt;
    importNotice = null;
  }

  ui.statTotal.textContent = number(upload.stats?.total);
  ui.statResolved.textContent = number(upload.stats?.resolved);
  ui.statUnmatched.textContent = number(upload.stats?.unmatched);
  renderUnmatched(upload);

  if (upload.imported) {
    setNotice(
      ui.importResult,
      `上次匯入：新增 ${number(upload.imported.creates)} 筆、更新 ${number(upload.imported.updates)} 筆。`,
      false,
    );
    ui.importBtn.textContent = '再匯入一次';
  } else if (importNotice) {
    setNotice(ui.importResult, importNotice.message, importNotice.warning);
    ui.importBtn.textContent = '匯入水魚';
  } else {
    setNotice(ui.importResult, '', false);
    ui.importBtn.textContent = '匯入水魚';
  }

  uploadTimer = setTimeout(render, Math.max(upload.expiresAt - Date.now(), 0) + 1000);
}

function render() {
  // 過期後伺服器下次讀取才刪，這裡先自己收掉，SSE 沒有通知。
  if (state.upload && state.upload.expiresAt <= Date.now()) state.upload = null;
  ui.configWarning.hidden = state.clientConfigured;
  ui.scopeLabel.textContent = state.scope ? `scope: ${state.scope}` : '';
  renderBind();
  renderCode();
  renderUpload();
}

function applyState(next) {
  state = { ...state, ...next };
  render();
}

async function refresh() {
  applyState(await api('/api/state'));
  await maybeCreateCode();
}

async function maybeCreateCode() {
  if (!state.hasSession) return;
  if (state.code || state.upload || codeBusy || codeAttempted) return;
  codeAttempted = true;
  await newCode();
}

async function newCode() {
  if (codeBusy) return;
  if (!state.hasSession) {
    ui.codeHint.textContent = '登入後才會產生上傳碼。';
    return;
  }
  codeBusy = true;
  try {
    const data = await api('/api/upload-code', { method: 'POST' });
    state.code = { value: data.code, expiresAt: data.expiresAt };
    state.bookmarklet = data.bookmarklet;
    renderCode();
  } catch (err) {
    ui.codeHint.textContent = `產生失敗：${err.message}`;
  } finally {
    codeBusy = false;
  }
}

async function doImport() {
  if (importBusy) return;
  importBusy = true;
  importNotice = null;
  ui.importBtn.disabled = true;
  ui.importBtn.textContent = '匯入中…';
  setNotice(ui.importResult, '', false);

  try {
    const data = await api('/api/import', { method: 'POST' });
    importNotice = {
      message: `已送出 ${number(data.total)} 筆：新增 ${number(data.creates)} 筆、更新 ${number(data.updates)} 筆。`,
      warning: false,
    };
    setNotice(ui.importResult, importNotice.message, false);
    ui.importBtn.textContent = '再匯入一次';
    await refresh();
  } catch (err) {
    importNotice = { message: err.message, warning: true };
    setNotice(ui.importResult, importNotice.message, true);
    await refresh();
  } finally {
    importBusy = false;
    ui.importBtn.disabled = false;
    if (ui.importBtn.textContent === '匯入中…') ui.importBtn.textContent = '匯入水魚';
  }
}

async function doLogout() {
  ui.logout.disabled = true;
  try {
    await api('/api/logout', { method: 'POST' });
    await refresh();
  } catch (err) {
    setNotice(ui.bindError, err.message, true);
  } finally {
    ui.logout.disabled = false;
  }
}

async function copyBookmarklet() {
  const text = state.bookmarklet;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const button = $('copy-bookmarklet');
    const old = button.textContent;
    button.textContent = '已複製';
    setTimeout(() => {
      button.textContent = old;
    }, 1800);
  } catch {
    window.prompt('複製這段書籤網址', text);
  }
}

function handleAuthQuery() {
  const params = new URLSearchParams(location.search);
  const auth = params.get('auth');
  if (!auth) return;

  const messages = {
    denied: '你拒絕了水魚授權。',
    state: '授權狀態不符，請再試一次。',
    scope: '水魚應用還沒拿到這個權限。寫入權限要人工審核通過。',
    config: '伺服器還沒設定水魚應用或 SESSION_SECRET。',
    error: '登入失敗，請再試一次。',
  };
  setNotice(ui.bindError, messages[auth] || '登入失敗，請再試一次。', true);
  history.replaceState({}, '', location.pathname);
}

function connect() {
  // 伺服器沒設定時 /api/events 一律 503，重連只會一直打。
  if (!state.clientConfigured) return;
  const source = new EventSource('/api/events');
  source.addEventListener('state', (event) => {
    applyState(JSON.parse(event.data));
    maybeCreateCode();
  });
  source.addEventListener('error', () => {
    // EventSource 只在連線中斷時自己重試；收到非 200 會直接關掉，這時自己接回來。
    if (source.readyState !== EventSource.CLOSED) return;
    setTimeout(() => {
      refresh()
        .catch((err) => console.error(err))
        .finally(connect);
    }, 5000);
  });
}

ui.logout.addEventListener('click', doLogout);
$('new-code').addEventListener('click', newCode);
$('copy-bookmarklet').addEventListener('click', copyBookmarklet);
ui.importBtn.addEventListener('click', doImport);

handleAuthQuery();
refresh()
  .catch((err) => console.error(err))
  .finally(connect);
