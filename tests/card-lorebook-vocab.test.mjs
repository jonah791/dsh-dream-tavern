/**
 * 卡内世界书词汇 · 判据（2026-09-22 真卡库发现）
 *
 * 事故：`character_book.entries[]`（**卡内**世界书）与独立世界书文件用**两套词汇**：
 *   卡内：`keys` / `insertion_order` / `id` / `enabled`
 *   独立：`key`  / `order`          / `uid` / `disable`
 * 原实现只认后者 ⇒ 主人 57 张真卡的 1223 条卡内条目里，「关键词非空」的**是 0 条**
 * —— 除 constant 外全被当作「永远无法命中」丢弃。修复后真卡库扫描：命中 **0 次 → 61 次**。
 *
 * 判据要求两侧都认（向后兼容），且 `enabled`/`disable` 这对**反义字段**不能被读反。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { importWorldbook } from '../lib/worldbook.js';

/** 卡内词汇（`character_book.entries[]` 的真实字段名，2026-09-22 从真卡读出来的）。 */
const cardVocabBook = {
  name: '卡内世界书夹具',
  entries: [
    { id: 7, keys: ['客栈', '雨'], content: '卡内·关键词条目。', enabled: true, insertion_order: 12, constant: false, position: 'before_char' },
    { id: 8, keys: [], content: '卡内·关掉的条目。', enabled: false, insertion_order: 3, constant: true },
  ],
};

/** 独立世界书文件的词汇（原有支持，不得回归）。 */
const fileVocabBook = {
  entries: {
    '0': { uid: 0, key: ['灯'], content: '文件·关键词条目。', order: 5, constant: false },
    '1': { uid: 1, key: [], content: '文件·被 disable 的条目。', disable: true, constant: true },
  },
};

test('★ 卡内词汇：keys（复数）必须被认出——否则条目会被当作「永远无法命中」丢弃', () => {
  const r = importWorldbook(cardVocabBook);
  const hit = r.entries.find((e) => e.content === '卡内·关键词条目。');
  assert.ok(hit !== undefined, '关键词条目丢失了（正是真卡库的原始症状）');
  assert.equal(hit.keywords, '客栈,雨', 'keys 必须映射到 keywords');
  assert.equal(hit.id, '7', 'id 必须作为条目 id（而非数组下标）');
  assert.equal(hit.order, 12, 'insertion_order 必须映射到 order');
  assert.equal(r.skipped.length, 0, '卡内词汇下不该有「永远无法命中」的跳过：' + JSON.stringify(r.skipped));
});

test('卡内词汇：enabled:false 必须真的关掉（它与 disable 语义相反，读反会静默反掉开关）', () => {
  const r = importWorldbook(cardVocabBook);
  const off = r.entries.find((e) => e.content === '卡内·关掉的条目。');
  assert.ok(off !== undefined, 'constant 条目应当被保留');
  assert.equal(off.enabled, false, 'enabled:false 被读成了开启');
});

test('对照组：独立世界书词汇（key / uid / order / disable）必须照旧工作', () => {
  const r = importWorldbook(fileVocabBook);
  const hit = r.entries.find((e) => e.content === '文件·关键词条目。');
  assert.ok(hit !== undefined, '独立词汇回归了');
  assert.equal(hit.keywords, '灯');
  assert.equal(hit.id, '0');
  assert.equal(hit.order, 5);
  const off = r.entries.find((e) => e.content === '文件·被 disable 的条目。');
  assert.equal(off.enabled, false, 'disable:true 必须仍然关掉');
});

test('对照组：两套词汇都缺席时，仍按「非 constant 且无关键词 ⇒ 丢弃」处理（不得静默保留死条目）', () => {
  const r = importWorldbook({ entries: [{ content: '无关键词也无 constant。' }] });
  assert.equal(r.entries.length, 0);
  assert.match(r.skipped[0]?.reason ?? '', /永远无法命中/);
});
