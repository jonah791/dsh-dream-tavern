/**
 * A1 / A2 — 装配单即事实 + 确定性。
 * 判据：条目与消息 1:1；从装配单重建的 body 与实际逐字节相等；
 *       同输入两次运行 hash 一致；篡改实际请求必被检出并指出位置；
 *       预算裁剪是确定性的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assemble, messagesFromManifest, renderTemplate, verifyAgainstActual } from '../lib/assemble.js';

const card = {
  id: 'c1', name: '测试角色', description: 'D',
  persona: '冷静克制的剑客。', scenario: '雨夜客栈。',
  firstMessage: 'F', exampleDialogue: 'E',
  systemPrompt: '', postHistoryInstructions: '',
  fields: [], lorebook: [],
};

test('卡的 description / persona / scenario / example 都必须进上下文', () => {
  const { manifest } = assemble(base);
  const sys = manifest.entries.find((e) => e.role === 'system');
  assert.ok(sys.text.includes('D'), 'description（ST 的主定义）必须进 system');
  assert.ok(sys.text.includes('冷静克制的剑客。'), 'persona 必须进 system');
  assert.ok(sys.text.includes('雨夜客栈。'), 'scenario 必须进 system');
  assert.ok(sys.text.includes('E'), '对话样例必须进 system');
  assert.ok(sys.text.includes('不是'), '样例必须注明不是当前剧情');
  const sources = sys.parts.map((p) => p.source);
  assert.ok(sources.includes('card:description'));
  assert.ok(sources.includes('card:example'));
});

test('卡的 system_prompt / post_history_instructions 各自到正确槽位', () => {
  const withOverrides = {
    ...base,
    card: { ...card, systemPrompt: '【卡级系统提示】', postHistoryInstructions: '【历史后指令】' },
  };
  const { manifest } = assemble(withOverrides);
  const sys = manifest.entries.find((e) => e.role === 'system');
  const after = manifest.entries.find((e) => e.slot === 'after_history' && e.source === 'card:post_history_instructions');
  assert.ok(sys.text.includes('【卡级系统提示】'), 'system_prompt 进 system');
  assert.ok(after !== undefined, 'post_history_instructions 必须落在 after_history 槽');
  assert.ok(after.text.includes('【历史后指令】'));
  assert.ok(sys.text.indexOf('【卡级系统提示】') < sys.text.indexOf('雨夜客栈。'), '优先级：卡级系统提示在 scenario 之前');
});

const preset = {
  id: 'p1', name: '测试预设',
  blocks: [
    { id: 'sys', slot: 'system', priority: 10, text: '你是{{card.name}}。场景：{{card.scenario}}' },
    { id: 'rules', slot: 'system', priority: 5, text: '只输出正文。' },
  ],
};

const base = {
  preset, card, lorebook: [], history: [
    { role: 'user', text: '你好' },
    { role: 'assistant', text: '……' },
  ], state: { hp: 3, mood: '警惕' }, turnInput: '我推门进去', turn: 1,
};

test('renderTemplate 替换已知键、保留未知键（不静默清空）', () => {
  assert.equal(renderTemplate('{{a}}-{{b}}', { a: 'X' }), 'X-{{b}}');
});

test('A1 条目与消息 1:1，且可逐字节重建', () => {
  const { manifest, messages } = assemble(base);
  assert.equal(manifest.entries.length, messages.length);
  assert.deepEqual(messagesFromManifest(manifest), messages);
  const v = verifyAgainstActual(manifest, messages);
  assert.equal(v.ok, true, v.differences.join('; '));
  assert.equal(v.rebuiltHash, v.actualHash);
});

test('A1 篡改实际请求必被检出，并指出第几条与首个差异字符', () => {
  const { manifest, messages } = assemble(base);
  const tampered = messages.map((m, i) => (i === messages.length - 1 ? { ...m, text: m.text + '（被改）' } : m));
  const v = verifyAgainstActual(manifest, tampered);
  assert.equal(v.ok, false);
  assert.match(v.differences.join('\n'), /#\d+ 正文不一致/);
  assert.match(v.differences.join('\n'), /首个差异字符 @\d+/);
});

test('A1 少发一条也要检出', () => {
  const { manifest, messages } = assemble(base);
  const v = verifyAgainstActual(manifest, messages.slice(0, -1));
  assert.equal(v.ok, false);
  assert.match(v.differences.join('\n'), /实际缺失/);
});

test('A2 确定性：同输入两次运行 hash 完全一致', () => {
  const a = assemble(base);
  const b = assemble(JSON.parse(JSON.stringify(base)));
  assert.equal(a.manifest.hash, b.manifest.hash);
  assert.equal(a.manifest.totalChars, b.manifest.totalChars);
});

test('结构：system 合并为一条，输入是最后一条 user，历史按序', () => {
  const { manifest } = assemble(base);
  assert.equal(manifest.entries[0].role, 'system');
  assert.deepEqual(manifest.entries.map((e) => e.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(manifest.entries.at(-1).source, 'input');
  assert.ok(manifest.entries[0].text.includes('测试角色'));
  assert.ok(manifest.entries[0].text.includes('hp'), '状态必须进 system（后台结算写什么，正文就看什么）');
});

test('depth-N 注入位置：depth-1 = 历史末尾之前一位', () => {
  const withLore = {
    ...base,
    lorebook: [{ id: 'l1', keywords: '推门', content: '【世界书·客栈】', position: 'depth-1' }],
  };
  const { manifest } = assemble(withLore);
  const roles = manifest.entries.map((e) => e.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'system', 'user']);
  assert.equal(manifest.entries[3].text, '【世界书·客栈】');
  assert.equal(manifest.entries[3].slot, 'depth-1');
});

test('文献账：parts 记录来源、命中关键词与优先级', () => {
  const withLore = {
    ...base,
    lorebook: [{ id: 'l1', keywords: '推门', content: '世界书内容', position: 'before', order: 3 }],
  };
  const { manifest } = assemble(withLore);
  const sysParts = manifest.entries[0].parts;
  const lore = sysParts.find((p) => p.source === 'lorebook:l1');
  assert.ok(lore, '世界书命中必须出现在 parts 里');
  assert.equal(lore.triggerHit, '推门');
  assert.equal(lore.priority, 3);
  assert.ok(Math.max(...sysParts.map((p) => p.text.length)) > 0);
});

test('预算裁剪是确定性的：低优先级世界书先掉，且记录在 dropped', () => {
  const many = {
    ...base,
    preset: { ...preset, budgetChars: 40 },
    lorebook: [
      { id: 'lo', keywords: '推门', content: '低优先级内容'.repeat(20), position: 'before', order: 1 },
      { id: 'hi', keywords: '推门', content: '高优先级内容'.repeat(20), position: 'before', order: 99 },
    ],
  };
  const a = assemble(many);
  const b = assemble(JSON.parse(JSON.stringify(many)));
  assert.deepEqual(a.manifest.dropped, b.manifest.dropped, '裁剪必须确定性');
  assert.ok(a.manifest.dropped.length > 0, '预算不够时必须真的裁掉东西');
  // 裁剪顺序恒为「优先级低的先掉」——即使最后两条都被裁，次序也不得颠倒
  assert.ok(
    a.manifest.dropped.indexOf('lore:lo') < a.manifest.dropped.indexOf('lore:hi'),
    `低优先级必须先掉，实际顺序=${JSON.stringify(a.manifest.dropped)}`,
  );
  assert.equal(a.manifest.overBudget, true, '裁到无可裁仍超预算时必须响亮记账');
});

test('预算够时 overBudget 为假且不裁任何条目', () => {
  const roomy = { ...base, preset: { ...preset, budgetChars: 100000 } };
  const { manifest } = assemble(roomy);
  assert.equal(manifest.overBudget, false);
  assert.deepEqual(manifest.dropped, []);
});
