/**
 * 世界书迁移：ST 格式 → 本模型的解释层。
 *
 * 夹具纪律：只读主人的世界书目录；路径由 `DREAM_TAVERN_WORLDS` 提供，
 * 未设置时整组跳过（不假绿）。
 *
 * 跑法：
 *   DREAM_TAVERN_WORLDS=".../default-user/worlds" node --test tests/worldbook.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { importWorldbook, normalizeKeys, positionToSlot, describeImport } from '../lib/worldbook.js';

const DIR = process.env.DREAM_TAVERN_WORLDS ?? '';
const books = (() => {
  if (!DIR) return [];
  try {
    return readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.json')).map((f) => join(DIR, f))
      .filter((p) => { try { return statSync(p).isFile(); } catch { return false; } });
  } catch { return []; }
})();

test('normalizeKeys 接受数组与逗号串两种编码', () => {
  assert.deepEqual(normalizeKeys(['a', 'b']), ['a', 'b']);
  assert.deepEqual(normalizeKeys('a, b ,,c'), ['a', 'b', 'c']);
  assert.deepEqual(normalizeKeys(null), []);
});

test('positionToSlot 认旧数字编码与新字符串编码', () => {
  assert.equal(positionToSlot(0, 4), 'before_history');
  assert.equal(positionToSlot(1, 4), 'after_history');
  assert.equal(positionToSlot(4, 4), 'depth-4');
  assert.equal(positionToSlot('before_char', 3), 'before_history');
  assert.equal(positionToSlot('after_char', 3), 'after_history');
  assert.equal(positionToSlot('at_depth', 2), 'depth-2');
  assert.equal(positionToSlot(undefined, undefined), 'before_history');
  assert.equal(positionToSlot(4, 0), 'depth-1', 'depth 非法时回落到 depth-1，不猜成 0');
});

test('disable=true 映射为 enabled=false（不是丢掉条目）', () => {
  const { entries } = importWorldbook({
    entries: { '1': { uid: 1, key: ['x'], content: 'C', disable: true } },
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].enabled, false);
});

test('content 为空 / 既非常量又无关键词 => 跳过并给出理由', () => {
  const { entries, skipped } = importWorldbook({
    entries: {
      a: { uid: 'a', key: ['k'], content: '' },
      b: { uid: 'b', key: [], content: '有内容但永远无法命中' },
      c: { uid: 'c', key: [], content: '常驻', constant: true },
    },
  });
  assert.deepEqual(entries.map((e) => e.id), ['c']);
  assert.equal(skipped.length, 2);
  assert.match(skipped.map((s) => s.reason).join(' '), /content 为空/);
  assert.match(skipped.map((s) => s.reason).join(' '), /永远无法命中/);
});

test('useProbability=false 时不下发 probability（避免把不生效的概率当判据）', () => {
  const { entries } = importWorldbook({
    entries: { a: { uid: 'a', key: ['k'], content: 'C', probability: 50, useProbability: false } },
  });
  assert.equal(entries[0].probability, undefined);
});

test('entries 为数组形态也能导入（ST 存在两种编码）', () => {
  const { entries } = importWorldbook({ entries: [{ uid: 1, key: ['k'], content: 'C' }] });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, '1');
});

test('迁移实测：主人的全部世界书都能导入且不丢字段', { skip: books.length === 0 ? '未设置 DREAM_TAVERN_WORLDS' : false }, () => {
  const failures = [];
  let totalEntries = 0;
  let totalRaw = 0;
  let totalSkipped = 0;
  const unknown = new Set();
  const unmodeled = new Set();
  for (const path of books) {
    try {
      const book = JSON.parse(readFileSync(path, 'utf8'));
      const result = importWorldbook(book);
      totalEntries += result.entries.length;
      totalRaw += Object.keys(result.raw).length;
      totalSkipped += result.skipped.length;
      for (const k of result.unknownKeys) unknown.add(k);
      for (const k of Object.keys(result.unmodeled)) unmodeled.add(k);
      // 原始条目必须条条留档（迁移判据 = 不丢）
      const declared = Array.isArray(book.entries) ? book.entries.length : Object.keys(book.entries ?? {}).length;
      if (Object.keys(result.raw).length !== declared) {
        failures.push(`${path}: raw ${Object.keys(result.raw).length} != declared ${declared}`);
      }
    } catch (err) {
      failures.push(`${path}: ${err.message}`);
    }
  }
  assert.equal(failures.length, 0, `${books.length} 本中 ${failures.length} 本失败：\n${failures.slice(0, 5).join('\n')}`);
  assert.ok(totalEntries > 0, '导入条目数不应为 0');
  assert.equal(unknown.size, 0, `出现既未解释也未登记的字段（可疑，须登记或建模）：${[...unknown].join(',')}`);
  assert.ok(unmodeled.size > 0, '应存在「已知未建模」字段——若为 0，说明登记表过期或样本变了');
  console.log(`    [读数] ${books.length} 本 / 解释 ${totalEntries} 条 / 留档 ${totalRaw} 条 / 跳过 ${totalSkipped} 条 / 已知未建模 ${unmodeled.size} 种 / 未知 ${unknown.size} 种`);
});

test('describeImport 面向主人的摘要包含槽位分布与未建模字段', () => {
  const result = importWorldbook({
    entries: { a: { uid: 'a', key: ['k'], content: 'C', position: 4, depth: 3 } },
  });
  const text = describeImport(result);
  assert.match(text, /槽位分布/);
  assert.match(text, /depth-3=1/);
  assert.match(text, /未建模字段/);
});
