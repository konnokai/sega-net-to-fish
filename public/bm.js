(() => {
  const PANEL_ID = 'df-import-panel';
  const SERVER_ORIGIN = (() => {
    try {
      return new URL(document.currentScript.src).origin;
    } catch {
      return '';
    }
  })();

  if (window.__dfImportBusy) return;
  if (!SERVER_ORIGIN) {
    alert('書籤載入失敗，請重新整理國際服頁面再試一次。');
    return;
  }
  if (!/(^|\.)maimaidx-eng\.com$|(^|\.)maimaidx\.jp$/.test(location.hostname)) {
    alert('請在 maimaidx-eng.com 的頁面上執行這個書籤。');
    return;
  }

  document.getElementById(PANEL_ID)?.remove();
  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.style.cssText = [
    'position:fixed',
    'right:16px',
    'bottom:16px',
    'z-index:2147483647',
    'max-width:420px',
    'padding:14px 16px',
    'border-radius:10px',
    'background:#16202a',
    'color:#eef4f8',
    'font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif',
    'box-shadow:0 12px 40px rgba(0,0,0,.35)',
    'white-space:pre-wrap',
  ].join(';');

  const text = document.createElement('div');
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', '關閉');
  close.style.cssText =
    'position:absolute;top:4px;right:8px;border:0;background:transparent;color:#9fb0bd;font:20px/1 system-ui;cursor:pointer;padding:4px';
  close.onclick = () => panel.remove();

  panel.append(close, text);
  document.body.append(panel);

  const status = (message) => {
    text.textContent = message;
  };

  window.__dfImportBusy = true;
  (async () => {
    const code = (prompt('請輸入網頁上顯示的上傳碼（例如 ABCD-EFGH）') || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    if (!code) {
      panel.remove();
      return;
    }

    const DIFFICULTIES = ['BASIC', 'ADVANCED', 'EXPERT', 'MASTER', 'Re:MASTER'];
    const records = [];

    for (let diff = 0; diff < DIFFICULTIES.length; diff += 1) {
      status(`讀取 ${DIFFICULTIES[diff]} 成績…（${diff + 1}/5）`);
      const res = await fetch(`/maimai-mobile/record/musicGenre/search/?genre=99&diff=${diff}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`讀取成績失敗（HTTP ${res.status}）`);
      if (!res.url.includes('musicGenre/search')) {
        throw new Error('登入已過期，請重新登入 maimaidx-eng.com');
      }

      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const rows = doc.querySelectorAll('.w_450.m_15.p_r.f_0');
      if (rows.length === 0) {
        throw new Error('沒有讀到歌曲列表，請確認已登入並停在成績頁');
      }

      for (const row of rows) {
        const scoreBlocks = row.querySelectorAll('.music_score_block');
        if (scoreBlocks.length === 0) continue;

        const name = row.querySelector('.music_name_block');
        if (!name) continue;

        const achievement = parseFloat((scoreBlocks[0].textContent || '').replace(/,/g, ''));
        if (!Number.isFinite(achievement) || achievement <= 0) continue;

        let dxScore = 0;
        let dxScoreMax = 0;
        const dxMatch = (scoreBlocks[1]?.textContent || '').match(/([\d,]+)\s*\/\s*([\d,]+)/);
        if (dxMatch) {
          dxScore = parseInt(dxMatch[1].replace(/,/g, ''), 10);
          dxScoreMax = parseInt(dxMatch[2].replace(/,/g, ''), 10);
        }

        const icons = Array.from(row.querySelectorAll('img.h_30')).map((img) =>
          (img.getAttribute('src') || '')
            .split('/')
            .pop()
            .replace(/\.png.*$/, '')
            .replace(/^music_icon_/, ''),
        );
        const fs = icons[0] && icons[0] !== 'back' ? icons[0] : '';
        const fc = icons[1] && icons[1] !== 'back' ? icons[1] : '';
        const kind = row.querySelector('.music_kind_icon');
        const type = kind && /_standard/.test(kind.getAttribute('src') || '') ? 'SD' : 'DX';

        records.push({
          title: name.textContent,
          type,
          level_index: diff,
          achievements: achievement,
          dxScore,
          dxScoreMax,
          fc,
          fs,
        });
      }
    }

    if (records.length === 0) {
      throw new Error('五個難度都沒有讀到成績');
    }

    status(`讀到 ${records.length} 筆，送到伺服器…`);
    const res = await fetch(`${SERVER_ORIGIN}/api/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, records }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `上傳失敗（HTTP ${res.status}）`);
    }

    status(
      `已送出 ${data.total} 筆，可匯入 ${data.resolved} 筆。\n回到網頁按「匯入水魚」。`,
    );
    setTimeout(() => panel.remove(), 20000);
  })()
    .catch((err) => {
      status(`失敗：${err.message || err}`);
    })
    .finally(() => {
      window.__dfImportBusy = false;
    });
})();
