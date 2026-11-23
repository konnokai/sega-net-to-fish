// 把書籤小工具抓到的成績整理成水魚 /player/update_records 要的格式。
// 全部都是純函式，方便直接用 node --test 驗證。

const FC_VALUES = new Set(['fc', 'fcp', 'ap', 'app']);
const FS_VALUES = new Map([
  ['sync', 'sync'],
  ['fs', 'fs'],
  ['fsp', 'fsp'],
  ['fsd', 'fsd'],
  ['fsdp', 'fsdp'],
  ['fdx', 'fsd'],
  ['fdxp', 'fsdp'],
]);

export function mapFc(value) {
  const v = String(value ?? '').toLowerCase();
  return FC_VALUES.has(v) ? v : '';
}

export function mapFs(value) {
  const v = String(value ?? '').toLowerCase();
  return FS_VALUES.get(v) ?? '';
}

// 網站偶爾會在歌名裡留下引號拼接的殘片；只清這個，不動空白。
export function cleanTitle(title) {
  return String(title ?? '')
    .replace(/" \+ '/g, '')
    .replace(/' \+ "/g, '')
    .trim();
}

export function collapseTitle(title) {
  return String(title ?? '').replace(/\s+/g, ' ').trim();
}

// 水魚的 DX 分數上限就是音符總數 × 3。只用來分辨兩首同名 Link。
export function maxDxScore(song, levelIndex) {
  const notes = song?.charts?.[levelIndex]?.notes;
  if (!Array.isArray(notes) || notes.length === 0) return 0;
  const total = notes.reduce((sum, n) => sum + (Number(n) || 0), 0);
  return total > 0 ? total * 3 : 0;
}

export function buildMusicIndex(musicData) {
  const exact = new Map();
  const collapsed = new Map();
  for (const song of musicData ?? []) {
    if (!song || typeof song.title !== 'string' || !song.type) continue;
    push(exact, `${cleanTitle(song.title)}\u0000${song.type}`, song);
    push(collapsed, `${collapseTitle(song.title)}\u0000${song.type}`, song);
  }
  return { exact, collapsed };
}

function push(map, key, song) {
  const list = map.get(key);
  if (list) list.push(song);
  else map.set(key, [song]);
}

function stripOuterQuotes(title) {
  return title.length > 2 && title.startsWith('"') && title.endsWith('"')
    ? title.slice(1, -1)
    : title;
}

function lookup(index, title, type) {
  const untrimmed = String(title ?? '');
  const raw = untrimmed.trim();
  const cleaned = cleanTitle(raw);
  // untrimmed 放第一：有一首歌的歌名就是全形空白（水魚 DB 標題為 U+3000）。
  const variants = [untrimmed, raw, cleaned, stripOuterQuotes(cleaned)];

  let hit = null;
  for (const v of variants) {
    hit = index.exact.get(`${v}\u0000${type}`);
    if (hit) break;
  }
  if (!hit) {
    for (const v of variants) {
      hit = index.collapsed.get(`${collapseTitle(v)}\u0000${type}`);
      if (hit) break;
    }
  }
  if (!hit) return null;

  // 網站把兩首歌都顯示成 Link，只有水魚 DB 分成 Link 與 Link(CoF)。
  if (type === 'SD' && collapseTitle(cleaned) === 'Link') {
    const cof = index.exact.get('Link(CoF)\u0000SD');
    if (cof) return [...hit, ...cof.filter((song) => !hit.some((h) => h.id === song.id))];
  }
  return hit;
}

function pickByDxScore(candidates, levelIndex, dxScoreMax) {
  if (!Number.isFinite(dxScoreMax) || dxScoreMax <= 0) return null;
  const ranked = candidates
    .map((song) => ({ song, diff: Math.abs(maxDxScore(song, levelIndex) - dxScoreMax) }))
    .sort((a, b) => a.diff - b.diff);
  const [best, next] = ranked;
  if (!best || best.diff > 30) return null;
  if (next && next.diff === best.diff) return null;
  return best.song;
}

export function resolveRecords(rawRecords, musicData) {
  return resolveWithIndex(rawRecords, buildMusicIndex(musicData));
}

export function resolveWithIndex(rawRecords, index) {
  const records = new Map();
  const unmatched = [];
  let total = 0;

  for (const item of Array.isArray(rawRecords) ? rawRecords : []) {
    total += 1;
    const title = String(item?.title ?? '');
    const type = item?.type === 'DX' ? 'DX' : item?.type === 'SD' ? 'SD' : '';
    const levelIndex = Number(item?.level_index);
    const achievements = Number(item?.achievements);
    const base = { title, type: type || String(item?.type ?? ''), level_index: item?.level_index };

    if (
      !title ||
      !type ||
      !Number.isInteger(levelIndex) ||
      levelIndex < 0 ||
      levelIndex > 4 ||
      !Number.isFinite(achievements) ||
      achievements <= 0
    ) {
      unmatched.push({ ...base, reason: 'bad_record' });
      continue;
    }

    const candidates = lookup(index, title, type);
    if (!candidates) {
      unmatched.push({ ...base, reason: 'not_found' });
      continue;
    }

    const playable = candidates.filter((song) =>
      Array.isArray(song.cids) ? levelIndex < song.cids.length : song.charts?.[levelIndex],
    );
    if (playable.length === 0) {
      unmatched.push({ ...base, reason: 'no_chart' });
      continue;
    }

    let song = playable[0];
    if (playable.length > 1) {
      song = pickByDxScore(playable, levelIndex, Number(item?.dxScoreMax));
      if (!song) {
        unmatched.push({
          ...base,
          reason: 'ambiguous',
          candidates: playable.map((s) => s.title),
        });
        continue;
      }
    }

    const dxScore = Number(item?.dxScore);
    records.set(`${song.id}:${levelIndex}`, {
      title: song.title,
      type: song.type,
      level_index: levelIndex,
      achievements: Math.min(achievements, 101),
      dxScore: Number.isFinite(dxScore) ? Math.max(0, Math.trunc(dxScore)) : 0,
      fc: mapFc(item?.fc),
      fs: mapFs(item?.fs),
    });
  }

  return {
    records: [...records.values()],
    unmatched,
    stats: {
      total,
      resolved: records.size,
      unmatched: unmatched.length,
    },
  };
}
