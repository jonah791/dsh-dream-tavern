/**
 * 预设文件加载 · 判据（2026-09-22）
 *
 * 背景：预设原先**写死**为内建默认，而同文件有一条注释宣称「放进 dataDir 就能改」——
 * **没有对应实现**。缺了加载器，本插件的第一个目的（迭代预设）在代码上不可达。
 *
 * 判据要求：① 好文件解析成功且字段保真；② **坏文件必须响亮失败**（不得静默退回默认——
 * 那会让研究结论张冠李戴）；③ 每条校验都有尸体样本。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePresetFile } from '../lib/preset-file.js';

const goodBlock = { id: 'role', slot: 'system', priority: 100, text: '规范：{{card.name}} 只输出正文。' };

test('好文件：解析成功，字段保真（含 depth-N 槽位与 enabled）', () => {
  const r = parsePresetFile({
    id: 'p-x', name: '实验预设', budgetChars: 12345,
    blocks: [goodBlock, { id: 'd1', slot: 'depth-3', priority: 5, text: '深度注入。', enabled: false }],
  }, 999);
  assert.deepEqual(r.errors, []);
  assert.equal(r.preset?.id, 'p-x');
  assert.equal(r.preset?.name, '实验预设');
  assert.equal(r.preset?.budgetChars, 12345, '文件里的预算必须压过 fallback');
  assert.equal(r.preset?.blocks.length, 2);
  assert.equal(r.preset?.blocks[1]?.slot, 'depth-3');
  assert.equal(r.preset?.blocks[1]?.enabled, false);
});

test('缺 budgetChars ⇒ 用调用方给的 fallback（不是静默 0）', () => {
  const r = parsePresetFile({ blocks: [goodBlock] }, 777);
  assert.deepEqual(r.errors, []);
  assert.equal(r.preset?.budgetChars, 777);
});

test('容忍 `{ preset: {...} }` 包装（外部工具导出常见），但不猜更深的层级', () => {
  const r = parsePresetFile({ preset: { blocks: [goodBlock] } }, 100);
  assert.deepEqual(r.errors, []);
  assert.equal(r.preset?.blocks.length, 1);
});

test('尸体样本：坏 slot / 重复 id / 缺 priority / 非字符串 text / 空 blocks 都必须被抓出', () => {
  const cases = [
    [{ blocks: [{ ...goodBlock, slot: 'nowhere' }] }, /slot 非法/, 'bad-slot'],
    [{ blocks: [{ ...goodBlock, slot: 'depth-0' }] }, /slot 非法/, 'depth-0（N 必须 ≥1）'],
    [{ blocks: [goodBlock, { ...goodBlock, priority: 1 }] }, /id 重复/, 'dup-id'],
    [{ blocks: [{ ...goodBlock, priority: 'high' }] }, /priority 必须是数字/, 'non-numeric-priority'],
    [{ blocks: [{ ...goodBlock, text: 42 }] }, /text 必须是字符串/, 'non-string-text'],
    [{ blocks: [] }, /blocks 为空/, 'empty-blocks'],
    [{ blocks: 'nope' }, /blocks 必须是数组/, 'blocks-not-array'],
    [[], /顶层必须是对象/, 'array-top-level'],
  ];
  for (const [raw, rx, label] of cases) {
    const r = parsePresetFile(raw, 100);
    assert.equal(r.preset, undefined, `${label}: 坏文件不得给出 preset`);
    assert.ok(r.errors.some((e) => rx.test(e)), `${label}: 错误信息不到位 → ${JSON.stringify(r.errors)}`);
  }
});

test('★ 关键纪律：坏文件绝不静默退回默认——errors 非空时 preset 必须是 undefined', () => {
  const r = parsePresetFile({ blocks: [{ ...goodBlock, slot: 'nowhere' }, goodBlock] }, 100);
  assert.equal(r.preset, undefined, '有一个坏块就整份拒绝（不允许「跳过坏块用其余」——那会悄悄改掉实验条件）');
  assert.ok(r.errors.length > 0);
});

test('对照组：判据必须**会红**——同一批断言对好文件必须全绿', () => {
  const ok = parsePresetFile({ blocks: [goodBlock] }, 100);
  assert.equal(ok.preset !== undefined, true);
  assert.deepEqual(ok.errors, []);
});
