/**
 * 装配质量判据 · 判据（「装得好不好」族）
 *
 * 判据族声明：与 A1–A7（「装得对不对」）**分族**。本文件要证明的是：
 *  ① 好样本三条全过；
 *  ② **每条判据各有一个尸体样本**，且该样本**只让它红**（另两条保持绿）
 *     ⇒ 三条互不掩盖，红点能精确定位；
 *  ③ 判据有分辨力：坏样本若不红，则这条判据只是装饰（恒绿不是证据）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assemble } from '../lib/assemble.js';
import { judgeAssembly, describeQuality } from '../lib/quality.js';

const card = {
  id: 'c1', name: '质量夹具角色',
  description: '主定义。', persona: '人设。', scenario: '场景。',
  firstMessage: 'F', exampleDialogue: '', systemPrompt: '', postHistoryInstructions: '',
  fields: [], lorebook: [],
};

const NORM_ID = 'role';

function presetOf({ normSlot = 'system', normPriority = 100, budgetChars = 100000 } = {}) {
  return {
    id: 'p1', name: '质量夹具预设', budgetChars,
    blocks: [
      { id: NORM_ID, slot: normSlot, priority: normPriority, text: '输出规范：只输出正文，不加选项列表。' },
      { id: 'style', slot: 'system', priority: 60, text: '文风：第二人称。' },
    ],
  };
}

// ⚠ 关键词必须**真的出现在被扫描的文本里**（历史 + 本轮输入），否则该条目从不触发，
// 「重复注入」的尸体样本会静默变成空样本 —— 2026-09-22 首版用 '客栈' 而夹具文本里没有它，
// 于是判据不红、尸体样本白做。此处用 '掌柜'（在本轮输入里）。
const lorebookOf = () => [
  { id: 'lo-hit', keywords: '掌柜', content: '命中条目。', order: 5 },
];

const base = {
  card,
  state: { hp: 1 },
  history: [{ role: 'user', text: '我推门而入。' }],
  turnInput: '我问掌柜要一间房。',
  turn: 1,
};

function run({ preset, lorebook }) {
  const { manifest } = assemble({ ...base, preset, lorebook });
  return judgeAssembly({ manifest, preset, normBlockIds: [NORM_ID] });
}

const reds = (r) => r.verdicts.filter((v) => !v.ok).map((v) => v.id);

test('好样本：三条质量判据全过，且通过时也带读数（不是干巴巴一个 ok）', () => {
  const r = run({ preset: presetOf(), lorebook: lorebookOf() });
  assert.deepEqual(reds(r), [], '好样本不该有红：' + JSON.stringify(r.verdicts));
  assert.equal(r.ok, true);
  for (const v of r.verdicts) assert.ok(v.detail.length > 0, `${v.id} 通过时也要给读数`);
  assert.match(describeQuality(r), /全过/);
});

test('尸体样本①「同一来源注入两遍」⇒ 只让 no-duplicate 红（2026-09-22 世界书重复注入事故）', () => {
  const dup = lorebookOf();
  const r = run({ preset: presetOf(), lorebook: [...dup, ...dup] });
  assert.deepEqual(reds(r), ['no-duplicate'], '应精确红一条：' + JSON.stringify(r.verdicts));
  const v = r.verdicts.find((x) => x.id === 'no-duplicate');
  assert.match(v.detail, /出现 2 次/, '证据要说出次数与来源');
});

test('尸体样本②「规范块被塞进 depth-N」⇒ 只让 norm-first 红（教训：规范太靠后导致格式漂移）', () => {
  const r = run({ preset: presetOf({ normSlot: 'depth-1' }), lorebook: lorebookOf() });
  assert.deepEqual(reds(r), ['norm-first'], '应精确红一条：' + JSON.stringify(r.verdicts));
  assert.match(r.verdicts.find((x) => x.id === 'norm-first').detail, /depth-1/);
});

test('尸体样本②b「规范块在 system 里但 priority 低于卡定义」⇒ 同样红（区内顺序由 priority 定）', () => {
  // card.description 的 priority 是 99（写死在 assemble.ts 里）⇒ 规范块 50 会被挤到它后面
  const r = run({ preset: presetOf({ normPriority: 50 }), lorebook: lorebookOf() });
  assert.deepEqual(reds(r), ['norm-first'], '应精确红一条：' + JSON.stringify(r.verdicts));
  assert.match(r.verdicts.find((x) => x.id === 'norm-first').detail, /priority=50/);
});

test('尸体样本③「裁到无可裁仍超预算」⇒ 只让 within-budget 红（须响亮记账，不静默截断）', () => {
  const big = { ...card, description: '主定义。'.repeat(120) };
  const preset = presetOf({ budgetChars: 400 });
  const { manifest } = assemble({ ...base, card: big, preset, lorebook: lorebookOf() });
  assert.equal(manifest.overBudget, true, '夹具没造出超预算 ⇒ 本判据无意义（先修夹具）');
  const r = judgeAssembly({ manifest, preset, normBlockIds: [NORM_ID] });
  assert.deepEqual(reds(r), ['within-budget'], '应精确红一条：' + JSON.stringify(r.verdicts));
});

test('对照组：判据必须**会红**——三条若全恒绿，本节就是装饰', () => {
  const good = run({ preset: presetOf(), lorebook: lorebookOf() });
  const bad = run({ preset: presetOf({ normSlot: 'after_history' }), lorebook: (() => { const l = lorebookOf(); return [...l, ...l]; })() });
  assert.equal(good.ok, true);
  assert.equal(bad.ok, false, '同时坏两处必须被判为不通过');
  assert.deepEqual(reds(bad).sort(), ['no-duplicate', 'norm-first'], '两处坏应各自被点名，互不掩盖');
});

test('未指名规范块时 norm-first 不适用（不替内容层判断哪段是规范）', () => {
  const { manifest } = assemble({ ...base, preset: presetOf({ normSlot: 'depth-1' }), lorebook: lorebookOf() });
  const r = judgeAssembly({ manifest, preset: presetOf({ normSlot: 'depth-1' }), normBlockIds: [] });
  assert.equal(r.verdicts.find((v) => v.id === 'norm-first').ok, true);
  assert.match(r.verdicts.find((v) => v.id === 'norm-first').detail, /不适用/);
});

test('名字写错的规范块要被抓出（不许静默当通过）', () => {
  const { manifest } = assemble({ ...base, preset: presetOf(), lorebook: lorebookOf() });
  const r = judgeAssembly({ manifest, preset: presetOf(), normBlockIds: ['no-such-block'] });
  assert.equal(r.verdicts.find((v) => v.id === 'norm-first').ok, false);
  assert.match(r.verdicts.find((v) => v.id === 'norm-first').detail, /不在预设里/);
});
