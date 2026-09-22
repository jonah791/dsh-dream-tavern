/**
 * 上下文控制面 · 判据（2026-09-22 新增）
 *
 * 判据族声明：本文件验的是「**控制面说得准不准**」——不是 A1–A7 那一族
 * （那些验「装配**装得对不对**」）。这里问的是：**每一个被声称可拨的旋钮，
 * 是否真的能指认到装配单里的一个能解出来的落点**。
 *
 * 为什么需要它：2026-09-21「最优上下文」命题的三个限定里，第一个是
 * 「上下文空间怎么定义（哪些旋钮可拨）」——如果这张表是凭文档措辞抄的，
 * 它就是空谈；**表的每一项都必须能被真装配单验证**。
 *
 * 夹具纪律：全部自造，不碰主人的卡库/世界书（不依赖运行平台，不读环境变量）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assemble } from '../lib/assemble.js';
import { CONTROL_SURFACE, MANIFEST_FIELDS, resolveManifestPath } from '../lib/control-surface.js';

const card = {
  id: 'c1',
  name: '控制面夹具角色',
  description: '主定义：一段足够长的角色描述，用来占住 system 区段。',
  persona: '人设摘要：冷静克制。',
  scenario: '雨夜客栈。',
  firstMessage: 'F',
  exampleDialogue: '玩家：你好\n角色：嗯。',
  systemPrompt: '系统覆盖说明。',
  postHistoryInstructions: '历史之后仍要遵守的说明。',
  fields: [],
  lorebook: [],
};

function presetWith(budgetChars) {
  return {
    id: 'p1',
    name: '控制面夹具预设',
    ...(budgetChars === undefined ? {} : { budgetChars }),
    blocks: [
      { id: 'b-system', slot: 'system', priority: 100, text: '系统区段。{{card.name}}' },
      { id: 'b-prefix', slot: 'persona_prefix', priority: 10, text: '人设前缀。' },
      { id: 'b-before', slot: 'before_history', priority: 10, text: '历史之前。' },
      { id: 'b-suffix', slot: 'persona_suffix', priority: 10, text: '人设后缀。' },
      { id: 'b-depth', slot: 'depth-1', priority: 10, text: '贴近输入的一条深度注入。' },
      { id: 'b-after', slot: 'after_history', priority: 10, text: '历史之后。' },
    ],
  };
}

const lorebook = [
  { id: 'lo-const', keywords: '', constant: true, content: '常开条目内容。' },
  { id: 'lo-hit', keywords: '客栈, 雨', content: '命中条目内容。', order: 5 },
  { id: 'lo-miss', keywords: '绝不出现的词', content: '不该出现。' },
];

const base = {
  card,
  lorebook,
  state: { hp: 10 },
  history: [
    { role: 'user', text: '我推门而入。' },
    { role: 'assistant', text: '客栈里很安静。' },
  ],
  turnInput: '我问掌柜要一间房。',
  turn: 1,
  script: { title: '主线', segment: '剧本片段。' },
};

/** 无预算 ⇒ 不裁剪：用来验证「有内容」的那些落点。 */
const full = assemble({ ...base, preset: presetWith(undefined) }).manifest;
/** 极小预算 ⇒ 必定发生 lorebook 裁剪：用来验证 `dropped[]`。 */
const trimmed = assemble({ ...base, preset: presetWith(120) }).manifest;

const BOTH = [['full', full], ['trimmed', trimmed]];

test('三列齐全：每个旋钮都写清「当前值 / 可拨范围 / 怎么量它的效果」', () => {
  assert.ok(CONTROL_SURFACE.length > 0);
  for (const dial of CONTROL_SURFACE) {
    assert.ok(dial.id.length > 0, '旋钮必须有 id');
    assert.ok(dial.current.length >= 8, `current 太短（疑似占位）：${dial.id}`);
    assert.ok(dial.range.length >= 8, `range 太短（疑似占位）：${dial.id}`);
    assert.ok(dial.measure.length >= 8, `measure 太短（疑似占位）：${dial.id}`);
  }
});

test('旋钮不可被静默删减：九类旋钮必须都在（少了就是控制面缩水）', () => {
  const ids = CONTROL_SURFACE.map((d) => d.id).sort();
  assert.deepEqual(ids, [
    'budget', 'card-tier', 'history', 'order', 'probability', 'slot', 'state', 'template', 'trigger',
  ]);
  assert.equal(new Set(ids).size, ids.length, 'id 必须唯一');
});

test('★ 每个旋钮都要能指认装配单落点：路径必须能在真装配单上解出值', () => {
  const unresolved = [];
  for (const dial of CONTROL_SURFACE) {
    if (dial.manifestField === null) continue;
    const hit = BOTH.find(([, m]) => resolveManifestPath(m, dial.manifestField) !== undefined);
    if (!hit) unresolved.push(`${dial.id} → ${dial.manifestField}`);
  }
  assert.deepEqual(unresolved, [],
    '这些旋钮声称有落点，却在真装配单上解不出来（＝空谈）：\n' + unresolved.join('\n'));
});

test('特指：dropped[] 必须在「有裁剪」的那份上解出，partTriggerHit 必须在「有命中」的那份上解出', () => {
  assert.ok(trimmed.dropped.length > 0, '夹具没触发裁剪 ⇒ 该判据无意义（先修夹具）');
  assert.ok(resolveManifestPath(trimmed, MANIFEST_FIELDS.dropped) !== undefined);
  assert.ok(resolveManifestPath(full, MANIFEST_FIELDS.partTriggerHit) !== undefined,
    '夹具里应有条目真的命中关键词（triggerHit 才有值）');
});

test('观测缺口必须自曝：解不出的旋钮要写 gap，且缺口集合不得被悄悄扩大', () => {
  const gapped = CONTROL_SURFACE.filter((d) => d.manifestField === null);
  assert.deepEqual(gapped.map((d) => d.id).sort(), ['probability', 'template'],
    'null 落点是一个**逃生通道**：只允许这两个已知观测缺口，新增必须先在这里登记（防「解不出就标 null」）');
  for (const dial of gapped) {
    assert.ok((dial.gap ?? '').length >= 20, `${dial.id} 必须写清为什么观测不到：${dial.gap}`);
  }
  // 反向：有落点的不得同时写 gap（避免语义含糊）
  for (const dial of CONTROL_SURFACE.filter((d) => d.manifestField !== null)) {
    assert.equal(dial.gap, undefined, `${dial.id} 已有落点，不该再写 gap`);
  }
});

test('对照组：路径解析器必须**会失败**——否则上一条判据恒真（恒为空不是证据）', () => {
  assert.equal(resolveManifestPath(full, 'nope'), undefined);
  assert.equal(resolveManifestPath(full, 'entries[].nope'), undefined);
  assert.equal(resolveManifestPath(full, 'entries[].parts[].nope'), undefined);
  assert.equal(resolveManifestPath(null, 'entries'), undefined);
  // 真路径必须解得出（同一个解析器，正反两侧都要有读数）
  assert.ok(Array.isArray(resolveManifestPath(full, 'entries')));
  assert.equal(typeof resolveManifestPath(full, MANIFEST_FIELDS.totalChars), 'number');
  assert.equal(typeof resolveManifestPath(full, MANIFEST_FIELDS.overBudget), 'boolean');
});
