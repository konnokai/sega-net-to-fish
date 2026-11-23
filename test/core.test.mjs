import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cleanTitle,
  mapFc,
  mapFs,
  maxDxScore,
  resolveRecords,
} from '../lib/core.mjs';

function song(id, title, type, notesByDiff) {
  return {
    id,
    title,
    type,
    ds: [1, 2, 3, 4, 5],
    cids: [id * 10, id * 10 + 1, id * 10 + 2, id * 10 + 3, id * 10 + 4],
    charts: notesByDiff.map((notes) => ({ notes })),
  };
}

const music = [
  song(1, 'Song A', 'DX', [
    [10, 0, 0, 0, 0],
    [20, 0, 0, 0, 0],
    [30, 0, 0, 0, 0],
    [40, 0, 0, 0, 0],
    [50, 0, 0, 0, 0],
  ]),
  song(131, 'Link', 'SD', [
    [30, 0, 0, 0],
    [30, 0, 0, 0],
    [30, 0, 0, 0],
    [30, 0, 0, 0],
    [30, 0, 0, 0],
  ]),
  song(383, 'Link(CoF)', 'SD', [
    [60, 0, 0, 0],
    [60, 0, 0, 0],
    [60, 0, 0, 0],
    [60, 0, 0, 0],
    [60, 0, 0, 0],
  ]),
  song(9, 'D✪N’T  ST✪P  R✪CKIN’', 'SD', [
    [10, 0, 0, 0],
    [10, 0, 0, 0],
    [10, 0, 0, 0],
    [10, 0, 0, 0],
    [10, 0, 0, 0],
  ]),
  song(8, '\u3000', 'DX', [
    [10, 0, 0, 0, 0],
    [10, 0, 0, 0, 0],
    [10, 0, 0, 0, 0],
    [10, 0, 0, 0, 0],
    [10, 0, 0, 0, 0],
  ]),
  song(7, '"411Ψ892"', 'DX', [
    [10, 0, 0, 0, 0],
    [10, 0, 0, 0, 0],
    [10, 0, 0, 0, 0],
    [10, 0, 0, 0, 0],
    [10, 0, 0, 0, 0],
  ]),
];

test('fc / fs 圖示轉成水魚的代碼', () => {
  assert.equal(mapFc('fcp'), 'fcp');
  assert.equal(mapFc('ap'), 'ap');
  assert.equal(mapFc('back'), '');
  assert.equal(mapFc('nonsense'), '');
  assert.equal(mapFs('sync'), 'sync');
  assert.equal(mapFs('fsp'), 'fsp');
  assert.equal(mapFs('fdx'), 'fsd');
  assert.equal(mapFs('fdxp'), 'fsdp');
  assert.equal(mapFs('fsdp'), 'fsdp');
  assert.equal(mapFs('back'), '');
});

test('cleanTitle 只清引號殘片，保留 D✪N’T 的雙空白', () => {
  assert.equal(cleanTitle('" + \'abc\' + "'), 'abc');
  assert.equal(cleanTitle('D✪N’T  ST✪P  R✪CKIN’'), 'D✪N’T  ST✪P  R✪CKIN’');
});

test('maxDxScore 是音符總數 × 3', () => {
  assert.equal(maxDxScore(music[0], 0), 30);
  assert.equal(maxDxScore(music[0], 4), 150);
  assert.equal(maxDxScore({ charts: [] }, 0), 0);
});

test('一般歌曲直接用水魚的標題', () => {
  const result = resolveRecords(
    [{ title: 'Song A', type: 'DX', level_index: 3, achievements: 100.5, dxScore: 400, fc: 'ap', fs: 'fdx' }],
    music,
  );
  assert.equal(result.stats.total, 1);
  assert.equal(result.stats.resolved, 1);
  assert.deepEqual(result.records[0], {
    title: 'Song A',
    type: 'DX',
    level_index: 3,
    achievements: 100.5,
    dxScore: 400,
    fc: 'ap',
    fs: 'fsd',
  });
});

test('Link 用 DX 分數上限分辨 Link 與 Link(CoF)', () => {
  const base = {
    title: 'Link',
    type: 'SD',
    level_index: 3,
    achievements: 98.9,
    dxScore: 0,
    fc: 'fc',
    fs: '',
  };
  const cof = resolveRecords([{ ...base, dxScoreMax: 180 }], music);
  assert.equal(cof.records[0].title, 'Link(CoF)');

  const normal = resolveRecords([{ ...base, dxScoreMax: 90 }], music);
  assert.equal(normal.records[0].title, 'Link');

  const unknown = resolveRecords([base], music);
  assert.equal(unknown.records.length, 0);
  assert.equal(unknown.unmatched[0].reason, 'ambiguous');
});

test('全形空白歌名與引號歌名都不會被 trim 掉', () => {
  const space = resolveRecords(
    [{ title: '\u3000', type: 'DX', level_index: 3, achievements: 100, dxScore: 10 }],
    music,
  );
  assert.equal(space.records[0].title, '\u3000');

  const quoted = resolveRecords(
    [{ title: '"411Ψ892"', type: 'DX', level_index: 3, achievements: 100, dxScore: 10 }],
    music,
  );
  assert.equal(quoted.records[0].title, '"411Ψ892"');
});

test('D✪N’T 的雙空白與被壓成單空白都能命中', () => {
  for (const title of ['D✪N’T  ST✪P  R✪CKIN’', 'D✪N’T ST✪P R✪CKIN’']) {
    const result = resolveRecords(
      [{ title, type: 'SD', level_index: 0, achievements: 100, dxScore: 10 }],
      music,
    );
    assert.equal(result.records[0].title, 'D✪N’T  ST✪P  R✪CKIN’');
  }
});

test('查不到的歌曲與壞資料分開列出', () => {
  const result = resolveRecords(
    [
      { title: '不存在', type: 'DX', level_index: 0, achievements: 100, dxScore: 1 },
      { title: 'Song A', type: 'DX', level_index: 9, achievements: 100, dxScore: 1 },
      { title: 'Song A', type: 'DX', level_index: 0, achievements: 0, dxScore: 1 },
      { title: 'Song A', type: 'UTAGE', level_index: 0, achievements: 100, dxScore: 1 },
    ],
    music,
  );
  assert.equal(result.stats.resolved, 0);
  assert.deepEqual(
    result.unmatched.map((u) => u.reason),
    ['not_found', 'bad_record', 'bad_record', 'bad_record'],
  );
});

test('同一譜面重複出現只留一筆', () => {
  const result = resolveRecords(
    [
      { title: 'Song A', type: 'DX', level_index: 0, achievements: 90, dxScore: 1 },
      { title: 'Song A', type: 'DX', level_index: 0, achievements: 99, dxScore: 2 },
    ],
    music,
  );
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].achievements, 99);
});
