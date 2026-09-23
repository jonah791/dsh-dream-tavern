/**
 * marker 落位 · 判据（2026-09-22）
 *
 * 背景：ST 预设用 marker 让**「卡片字段插在哪一段」变成预设可拨的**；本插件原先把它**写死在
 * `assemble.ts`** 里（§4.5 `card-tier` 的硬边界）。本节证明那条差距已补上，且**向后兼容**：
 * 没有 marker 的预设 ⇒ 落位与内建缺省**逐字节相同**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assemble } from '../lib/assemble.js';
import { parsePresetFile } from '../lib/preset-file.js';

const card = {
  id: 'c1', name: '落位夹具',
  description: '主定义正文。', persona: '人设摘要。', scenario: '场景。',
  firstMessage: 'F', exampleDialogue: '', systemPrompt: '', postHistoryInstructions: '',
  fields: [], lorebook: [],
};

const baseInput = (preset) => ({
  preset, card, lorebook: [], history: [], state: {}, turnInput: '探针。', turn: 1,
});

/** 取某来源片段在装配单里的落位（slot + priority）。 */
function placementOf(manifest, source) {
  for (const e of manifest.entries) {
    for (const p of e.parts) if (p.source === source) return { slot: p.slot, priority: p.priority };
  }
  return undefined;
}

const NO_MARKER = { id: 'p', name: '无 marker', blocks: [
  { id: 'role', slot: 'system', priority: 100, text: '规范。' },
] };

test('对照组（向后兼容）：没有 marker 的预设 ⇒ 卡片字段用**内建缺省落位**', () => {
  const { manifest } = assemble(baseInput(NO_MARKER));
  assert.deepEqual(placementOf(manifest, 'card:description'), { slot: 'system', priority: 99 });
  assert.deepEqual(placementOf(manifest, 'card:persona'), { slot: 'persona_prefix', priority: 100 });
  assert.deepEqual(placementOf(manifest, 'card:scenario'), { slot: 'system', priority: 90 });
});

test('★ marker 块接管落位：声明 description 落到 depth-2 后，它就真的在 depth-2', () => {
  const preset = { id: 'p', name: '带 marker', blocks: [
    { id: 'role', slot: 'system', priority: 100, text: '规范。' },
    { id: 'm-desc', marker: 'description', slot: 'depth-2', priority: 50, text: '' },
  ] };
  const { manifest } = assemble(baseInput(preset));
  assert.deepEqual(placementOf(manifest, 'card:description'), { slot: 'depth-2', priority: 50 }, '未接管：' + JSON.stringify(manifest.entries.map((e) => e.slot)));
  // marker 块**本身不带内容**：它只在 parts 里体现为那条卡片字段，不额外产生片段
  assert.ok(!manifest.entries.some((e) => e.parts.some((p) => p.id.startsWith('preset:m-desc'))), 'marker 块不该作为内容片段被注入');
  assert.deepEqual(placementOf(manifest, 'card:persona'), { slot: 'persona_prefix', priority: 100 }, '未声明的字段不受影响');
});

test('marker 块 enabled:false ⇒ 声明关掉，回落到内建缺省', () => {
  const preset = { id: 'p', name: 'marker 关掉', blocks: [
    { id: 'role', slot: 'system', priority: 100, text: '规范。' },
    { id: 'm-desc', marker: 'description', slot: 'depth-2', priority: 50, text: '', enabled: false },
  ] };
  const { manifest } = assemble(baseInput(preset));
  assert.deepEqual(placementOf(manifest, 'card:description'), { slot: 'system', priority: 99 });
});

test('单个 marker 可拨 ≠ 全盘可拨：未声明的字段一律保持内建缺省（对照组）', () => {
  const preset = { id: 'p', name: '只拨一个', blocks: [
    { id: 'm-state', marker: 'state', slot: 'after_history', priority: 20, text: '' },
  ] };
  const { manifest } = assemble(baseInput(preset));
  assert.deepEqual(placementOf(manifest, 'state'), { slot: 'after_history', priority: 20 }, 'state 被接管');
  assert.deepEqual(placementOf(manifest, 'card:description'), { slot: 'system', priority: 99 }, '其余字段不受影响');
});

test('尸体样本：未知 marker 名必须在**载入期**响亮失败（写错的落位声明不得静默失效）', () => {
  const bad = parsePresetFile({ blocks: [{ id: 'm', marker: 'charDescription', slot: 'system', priority: 10, text: '' }] }, 100);
  assert.equal(bad.preset, undefined, 'ST 的 identifier 不是本插件的 marker 名——不该被接受');
  assert.ok(bad.errors.some((e) => /marker 非法/.test(e)), '要报「marker 非法」：' + JSON.stringify(bad.errors));
  const good = parsePresetFile({ blocks: [{ id: 'm', marker: 'description', slot: 'system', priority: 10, text: '' }] }, 100);
  assert.equal(good.preset?.blocks[0]?.marker, 'description', '合法 marker 必须被保留下来（对照组）');
});
