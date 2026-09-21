/**
 * A6 — lorebook matching is a pure function.
 * 判据：同输入同输出；constant 必中；关键词大小写不敏感；depth 槽位映射正确；
 *       probability 走确定性哈希（同 turn 必同结果）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchLorebook, parseKeywords, slotOf, compareHits } from '../lib/lorebook.js';

const H = (text, role = 'user') => ({ role, text });

test('parseKeywords 去空白、小写、丢空项', () => {
  assert.deepEqual(parseKeywords(' Alpha , beta ,, '), ['alpha', 'beta']);
  assert.deepEqual(parseKeywords(''), []);
});

test('slotOf 映射 before/after/depth-N', () => {
  assert.equal(slotOf({ id: 'a', keywords: 'x', content: '' }), 'before_history');
  assert.equal(slotOf({ id: 'a', keywords: 'x', content: '', position: 'after' }), 'after_history');
  assert.equal(slotOf({ id: 'a', keywords: 'x', content: '', position: 'depth-3' }), 'depth-3');
  assert.equal(slotOf({ id: 'a', keywords: 'x', content: '', position: '乱写' }), 'before_history');
});

test('关键词命中：大小写不敏感，且能在 turnInput 里命中', () => {
  const entries = [{ id: 'e1', keywords: 'sword, 剑', content: 'C' }];
  const hits = matchLorebook(entries, { history: [H('He drew the SWORD')], turnInput: '', turn: 1 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].triggerHit, 'sword');
  const hits2 = matchLorebook(entries, { history: [], turnInput: '他拔出了剑', turn: 1 });
  assert.equal(hits2.length, 1);
});

test('constant 必中且无 triggerHit；无关键词且非常量 => 永不命中', () => {
  const hits = matchLorebook(
    [
      { id: 'k', keywords: '', content: 'always', constant: true },
      { id: 'n', keywords: '', content: 'never' },
    ],
    { history: [], turnInput: '任意', turn: 1 },
  );
  assert.deepEqual(hits.map((h) => h.entry.id), ['k']);
  assert.equal(hits[0].triggerHit, undefined);
});

test('enabled:false 不命中', () => {
  const hits = matchLorebook([{ id: 'e', keywords: 'a', content: 'x', enabled: false }], {
    history: [H('a')], turnInput: '', turn: 1,
  });
  assert.equal(hits.length, 0);
});

test('scanDepth 限制扫描窗口', () => {
  const entries = [{ id: 'e', keywords: 'old', content: 'x' }];
  const history = [H('old news'), H('nothing'), H('nothing')];
  assert.equal(matchLorebook(entries, { history, turnInput: '', turn: 1 }).length, 1);
  assert.equal(matchLorebook(entries, { history, turnInput: '', turn: 1, scanDepth: 1 }).length, 0);
});

test('A6 纯函数：两次调用结果深度相等', () => {
  const entries = [
    { id: 'a', keywords: 'x', content: 'A', order: 5 },
    { id: 'b', keywords: 'x', content: 'B', order: 5 },
    { id: 'c', keywords: 'x', content: 'C', constant: true },
  ];
  const ctx = { history: [H('x')], turnInput: 'x', turn: 7 };
  const first = matchLorebook(entries, ctx);
  const second = matchLorebook(entries, ctx);
  assert.deepEqual(first, second);
  // 同槽位内 order 降序（a/b 的 order=5 高于常量 c 的默认 0），order 相同则 id 升序
  assert.deepEqual(first.map((h) => h.entry.id), ['a', 'b', 'c']);
});

test('probability 是确定性的（同 turn 必同结果）', () => {
  const entries = [{ id: 'p', keywords: 'x', content: 'P', probability: 0.5 }];
  const ctx = { history: [H('x')], turnInput: '', turn: 42 };
  const a = matchLorebook(entries, ctx).length;
  const b = matchLorebook(entries, ctx).length;
  assert.equal(a, b, 'probability 不得引入真随机（否则破坏判据 A2）');
});

test('compareHits：槽位 -> 优先级降序 -> id 升序', () => {
  const mk = (id, slot, priority) => ({ entry: { id, keywords: '', content: '' }, slot, priority });
  const sorted = [mk('b', 'before_history', 1), mk('a', 'before_history', 1), mk('z', 'before_history', 9), mk('c', 'after_history', 0)].sort(compareHits);
  assert.deepEqual(sorted.map((h) => h.entry.id), ['z', 'a', 'b', 'c']);
});
