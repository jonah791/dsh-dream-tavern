/**
 * ST 预设桥接 · 判据（2026-09-22）
 *
 * 判据要求：① 好样本映射正确、顺序→priority、marker→登记为未建模；
 * ② **未建模项逐条带理由**（不许静默丢字段——那正是卡内世界书 1223 条被丢的同一类缺陷）；
 * ③ 坏样本各自响亮失败；④ 解析器**不抛**。
 *
 * ⚠ 真实文件（`tavern/色欲之罪预设/`，1.6 MB）的读数由 `scripts/quality-sweep.mjs --preset` 产出，
 * 不放本文件：单测必须确定、不依赖本机外部资产。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeStPreset } from '../lib/st-preset.js';

const P = (over) => ({ content: '', enabled: true, marker: false, identifier: 'x', name: 'x', role: 'system', injection_position: 0, injection_depth: 4, system_prompt: false, ...over });

const GOOD = {
  name: '夹具预设',
  temperature: 1,
  openai_max_tokens: 4096,
  someBrandNewField: 42,
  prompts: [
    P({ identifier: 'a', name: '甲', content: '第一条规范。' }),
    P({ identifier: 'charDescription', name: 'Char Description', marker: true }),
    P({ identifier: 'b', name: '乙', content: '第二条规范。' }),
    P({ identifier: 'c', name: '丙', content: '关掉的。', enabled: false }),
  ],
  prompt_order: [{ character_id: 100001, order: [
    { identifier: 'a', enabled: true },
    { identifier: 'charDescription', enabled: true },
    { identifier: 'b', enabled: true },
    { identifier: 'c', enabled: true },
  ] }],
};

test('好样本：顺序表即顺序，priority 递减；marker 不进 blocks', () => {
  const r = bridgeStPreset(GOOD, { budgetChars: 5000 });
  assert.deepEqual(r.errors, []);
  assert.equal(r.preset?.name, '夹具预设');
  assert.equal(r.preset?.budgetChars, 5000, '预算用本插件的口径（不沿用 ST 的 token 上限）');
  assert.deepEqual(r.preset?.blocks.map((b) => b.id), ['a', 'b', 'c'], 'marker 不得进 blocks');
  const [a, b, c] = r.preset.blocks;
  assert.ok(a.priority > b.priority && b.priority > c.priority, 'priority 必须随序位递减');
  assert.equal(a.slot, 'system', 'injection_position=0 ⇒ 相对位置，归 system 区段');
  assert.equal(r.stats.orderSource, 'prompt_order');
  assert.equal(r.stats.markers, 1);
});

test('两条 enabled 都生效：prompt 自己关掉 ⇒ block 关掉', () => {
  const r = bridgeStPreset(GOOD, { budgetChars: 100 });
  const c = r.preset.blocks.find((b) => b.id === 'c');
  assert.equal(c.enabled, false, 'prompts[].enabled=false 必须传导');
});

test('顺序表里关掉 ⇒ 也关掉（两者都启用才启用）', () => {
  const st = JSON.parse(JSON.stringify(GOOD));
  st.prompt_order[0].order[2].enabled = false;
  const r = bridgeStPreset(st, { budgetChars: 100 });
  assert.equal(r.preset.blocks.find((b) => b.id === 'b').enabled, false);
  assert.equal(r.stats.disabledByOrder, 1);
});

test('★ 未建模项逐条带理由：marker、采样参数、未识别字段都要登记且理由非空', () => {
  const r = bridgeStPreset(GOOD, { budgetChars: 100 });
  const fields = r.unmodeled.map((u) => u.field);
  assert.ok(fields.includes('prompt(marker):charDescription'), 'marker 必须登记：' + JSON.stringify(fields));
  assert.ok(fields.includes('top:temperature'), '采样参数必须登记');
  assert.ok(fields.includes('top:openai_max_tokens'), '生成上限必须登记');
  assert.ok(fields.includes('top:someBrandNewField'), '**未识别**字段也必须登记（原样留档，不假装支持）');
  for (const u of r.unmodeled) assert.ok(u.reason.length >= 6, `${u.field} 的理由太短：${u.reason}`);
  assert.ok(r.mapped.length >= 4, '对账表要写清映射了什么');
});

test('injection_position=1 ⇒ 映射到 depth-N（唯一会走深度的情形）', () => {
  const st = {
    prompts: [P({ identifier: 'd', content: '深度注入。', injection_position: 1, injection_depth: 3 })],
    prompt_order: [{ character_id: 1, order: [{ identifier: 'd', enabled: true }] }],
  };
  const r = bridgeStPreset(st, { budgetChars: 100 });
  assert.deepEqual(r.errors, []);
  assert.equal(r.preset.blocks[0].slot, 'depth-3');
});

test('缺 prompt_order ⇒ 退回 prompts 顺序，但**如实记账**语义可能不同', () => {
  const st = { prompts: [P({ identifier: 'a', content: 'A' }), P({ identifier: 'b', content: 'B' })] };  const r = bridgeStPreset(st, { budgetChars: 100 });
  assert.equal(r.stats.orderSource, 'prompts-array');
  assert.ok(r.unmodeled.some((u) => u.field === 'prompt_order' && /退回按 prompts/.test(u.reason)));
});

test('尸体样本：坏输入各自响亮失败且带原因，且**不抛**', () => {
  const cases = [
    [null, /顶层必须是对象/, 'null'],
    [[], /顶层必须是对象/, 'array'],
    [{}, /缺少 prompts 数组/, 'no-prompts'],
    [{ prompts: [] }, /prompts 为空/, 'empty-prompts'],
    [{ prompts: [P({ identifier: 'a', content: 'A' })], prompt_order: [{ order: [{ identifier: 'ghost', enabled: true }] }] }, /不存在的 identifier：ghost/, 'dangling-ref'],
    [{ prompts: [P({ identifier: 'm', marker: true })], prompt_order: [{ order: [{ identifier: 'm', enabled: true }] }] }, /没有任何可映射的内容条目/, 'all-markers'],
  ];
  for (const [raw, rx, label] of cases) {
    let r;
    assert.doesNotThrow(() => { r = bridgeStPreset(raw, { budgetChars: 100 }); }, `${label}: 解析器抛了`);
    assert.equal(r.preset, undefined, `${label}: 坏输入不得给出 preset`);
    assert.ok(r.errors.some((e) => rx.test(e)), `${label}: 错误信息不到位 → ${JSON.stringify(r.errors)}`);
  }
});

test('对照组：同一批断言对好样本必须全绿（证明它们会红也会绿）', () => {
  const ok = bridgeStPreset(GOOD, { budgetChars: 100 });
  assert.equal(ok.preset !== undefined, true);
  assert.deepEqual(ok.errors, []);
  assert.ok(ok.unmodeled.length > 0, '好样本也应登记未建模项——登记不等于失败');
});
