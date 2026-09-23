/**
 * 开场白宏渲染回归（2026-09-23 缺陷修复）
 *
 * 缺陷（实测）：卡片 `first_mes` 里的 `{{user}}` 以**字面量**进上下文，模型照抄。
 * 两处根因，缺一不可：
 *   · `assemble` 对历史逐字发出，而 `history[0]`（= 卡片开场白）**不走宏渲染**；
 *   · `tavern_assemble` 调 `assemble` 时**漏传 `playerName`** ⇒ 名字到不了渲染器
 *     （`tavern_play` 那条路是传的，两条路不一致）。
 *
 * 判据（可证伪，含对照组）：
 *   ① 给了名字 ⇒ `history[0]` 的 `{{user}}` 被替换（`{{char}}` 同样）
 *   ② **不给名字 ⇒ 必须原样保留**——对照组，证明不是「无差别删掉」
 *   ③ 其余历史（真实对话）**逐字发出**，不得二次加工
 *   ④ 未知宏原样保留（不静默清空）
 *
 * 运行：先构建（tsc），再 node --test tests/opening-macros.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assemble, renderCardText } from '../lib/assemble.js';

const preset = {
  id: 'p1', name: '测试预设',
  blocks: [{ id: 'sys', slot: 'system', priority: 10, text: '规则块。' }],
};

const card = {
  id: 'c1', name: '仙母', description: 'D', persona: 'P', scenario: 'S',
  firstMessage: '那是 {{user}}。{{char}} 看着他。',
  exampleDialogue: '', systemPrompt: '', postHistoryInstructions: '',
  fields: [], lorebook: [],
};

/**
 * 历史：第 0 条 = 开场白（播种不变量：`ensureOpening` 只在历史为空时落 `card.firstMessage`）；
 * 第 1 条 = 真实对话（模型输出，必须逐字）。
 */
const history = [
  { role: 'assistant', text: card.firstMessage },
  { role: 'assistant', text: '模型自己写的：{{user}} 的手还搭在门沿上' },
];

const base = {
  preset, card, lorebook: [], history, state: {}, turnInput: '我推门进去', turn: 2,
};

test('① 给了玩家名 ⇒ history[0] 的 {{user}} 被替换，{{char}} 同样', () => {
  const { manifest } = assemble({ ...base, playerName: '阿昭' });
  const first = manifest.entries[1];
  assert.equal(first.source, 'history:0');
  assert.ok(first.text.includes('那是 阿昭。'), `开场白的 {{user}} 必须被替换；实际=${first.text}`);
  assert.ok(!first.text.includes('{{user}}'), 'history[0] 不得残留 {{user}}');
  assert.ok(first.text.includes('仙母 看着他。'), '{{char}} 取自卡片自身，同样渲染');
});

test('② 对照组：不给名字 ⇒ {{user}} 必须原样保留（证明不是无差别删掉）', () => {
  const { manifest } = assemble({ ...base, playerName: undefined });
  const first = manifest.entries[1];
  assert.ok(first.text.includes('{{user}}'), '拿不到名字时保留原文——不编造名字（静默改名＝改写角色身份）');
  assert.ok(first.text.includes('仙母'), '{{char}} 不依赖玩家名，仍应渲染');
});

test('③ 其余历史逐字发出，不被二次加工', () => {
  const { manifest } = assemble({ ...base, playerName: '阿昭' });
  const second = manifest.entries[2];
  assert.equal(second.source, 'history:1');
  assert.equal(second.text, history[1].text, '真实对话必须逐字发出（模型说了什么就记什么）');
});

test('④ 未知宏原样保留（不静默清空）', () => {
  assert.equal(
    renderCardText('前{{压缩相邻消息::lora_constant}}后', '仙母', '阿昭'),
    '前{{压缩相邻消息::lora_constant}}后',
  );
});

test('⑤ renderCardText：空串名字按「未知」处理', () => {
  assert.equal(renderCardText('{{user}}', '仙母', ''), '{{user}}');
  assert.equal(renderCardText('{{user}}', '仙母', '阿昭'), '阿昭');
});
