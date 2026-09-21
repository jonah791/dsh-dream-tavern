/**
 * 回合层与面板：用**假补全器**离线跑通整条回路。
 *
 * 这组测试的价值在于：A1（装配单即事实）、A3（原子回退）、A7（无旁路）、
 * 三 Agent 职责互斥，全部**不依赖真模型**即可判定——验收脚本因此能进 CI。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { runTurn, runCandidates, runSettlement, extractJsonObject } from '../lib/session.js';
import { defaultPreset } from '../lib/preset.js';
import { createTavernPanel } from '../lib/panel.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dream-tavern-'));
  const cards = join(root, 'cards');
  const worlds = join(root, 'worlds');
  mkdirSync(cards, { recursive: true });
  mkdirSync(worlds, { recursive: true });
  writeFileSync(join(cards, 'test-card.json'), JSON.stringify({
    name: '测试卡', description: '描述', personality: '性格：冷静', scenario: '场景：雨夜',
    first_mes: '【开场】雨在下。', mes_example: '示例',
  }), 'utf8');
  writeFileSync(join(worlds, 'book.json'), JSON.stringify({
    entries: { '1': { uid: 1, key: ['雨'], content: '【世界书】雨夜有钟声。' } },
  }), 'utf8');
  const store = new Store({ dataDir: join(root, 'data'), cardDirs: [cards], worldDirs: [worlds] });
  const deps = {
    store,
    preset: defaultPreset,
    budgetChars: 24000,
    maxTokens: 200,
    temperature: 0.9,
    complete: async (messages, options) => {
      const last = messages.at(-1);
      return {
        text: options.purpose === 'settle'
          ? '{"天气":"雨","好感":1}'
          : options.purpose === 'candidates'
            ? '推门进去\n后退一步\n喊她的名字'
            : `回复：${last.text.slice(0, 10)}`,
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 },
      };
    },
  };
  return { root, store, deps, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('runTurn：开局落一次、A1 通过、历史按「只追加」增长', async () => {
  const f = fixture();
  try {
    const first = await runTurn(f.deps, { session: 's1', cardId: 'test-card', input: '我走进去。' });
    assert.equal(first.ok, true, first.reason);
    assert.equal(first.a1Ok, true, first.a1Detail);
    assert.equal(first.turn, 2, '开场白占第 1 轮，本轮应为第 2 轮');
    const history = await f.store.readHistory('s1');
    assert.deepEqual(history.map((m) => m.role), ['assistant', 'user', 'assistant']);
    assert.equal(history[0].text, '【开场】雨在下。');

    const second = await runTurn(f.deps, { session: 's1', cardId: 'test-card', input: '再看一眼。' });
    assert.equal(second.turn, 4, '第 2 轮后历史 3 条，下一轮是第 4 轮');
    assert.deepEqual((await f.store.readHistory('s1')).map((m) => m.role), ['assistant', 'user', 'assistant', 'user', 'assistant']);
  } finally { f.cleanup(); }
});

test('A2：同输入不同会话产出同一装配单 hash（确定性）', async () => {
  const f = fixture();
  try {
    const a = await runTurn(f.deps, { session: 'sa', cardId: 'test-card', input: '同样的话。' });
    const b = await runTurn(f.deps, { session: 'sb', cardId: 'test-card', input: '同样的话。' });
    assert.equal(a.manifest.hash, b.manifest.hash);
  } finally { f.cleanup(); }
});

test('A7：面板动作与工具走同一条装配路径（同输入同 hash）', async () => {
  const f = fixture();
  try {
    const viaTool = await runTurn(f.deps, { session: 'tool', cardId: 'test-card', input: '我推门。' });
    const panel = createTavernPanel(f.deps);
    const viaPanel = await panel.actions.play.run({ session: 'panel', cardId: 'test-card', input: '我推门。' });
    assert.equal(viaPanel.ok, true, viaPanel.message);
    assert.equal(viaPanel.data.a1Ok, true);
    const panelManifest = await f.store.readManifest('panel', viaPanel.data.turn);
    assert.ok(panelManifest !== null, '面板路径也必须落盘装配单');
    assert.equal(panelManifest.hash, viaTool.manifest.hash, '两条路径的装配单必须一致——否则就是旁路');
  } finally { f.cleanup(); }
});

test('世界书命中会进装配单，且命中关键词被记录', async () => {
  const f = fixture();
  try {
    const result = await runTurn(f.deps, { session: 's2', cardId: 'test-card', input: '雨声里我抬头。', worldbook: 'book' });
    assert.equal(result.ok, true, result.reason);
    const manifest = await f.store.readManifest('s2', result.turn);
    const lore = manifest.entries.flatMap((e) => e.parts).find((p) => p.source.startsWith('lorebook:'));
    assert.ok(lore, '应当命中世界书条目');
    assert.equal(lore.triggerHit, '雨');
  } finally { f.cleanup(); }
});

test('M4：结算 Agent 是唯一状态写者，且状态进下一轮 system', async () => {
  const f = fixture();
  try {
    await runTurn(f.deps, { session: 's3', cardId: 'test-card', input: '第一轮。' });
    const before = await f.store.readState('s3');
    assert.deepEqual(before, {}, '正文 Agent 不得写状态');
    const settled = await runSettlement(f.deps, { session: 's3', cardId: 'test-card', input: '第一轮。' });
    assert.equal(settled.ok, true, settled.reason);
    assert.deepEqual(await f.store.readState('s3'), { 天气: '雨', 好感: 1 });
    const next = await runTurn(f.deps, { session: 's3', cardId: 'test-card', input: '第二轮。' });
    const manifest = await f.store.readManifest('s3', next.turn);
    const sys = manifest.entries.find((e) => e.role === 'system');
    assert.ok(sys.text.includes('好感'), '状态必须出现在下一轮的 system 里');
  } finally { f.cleanup(); }
});

test('候选 Agent：解析出行、剔除序号、不写正文也不写状态', async () => {
  const f = fixture();
  try {
    await runTurn(f.deps, { session: 's4', cardId: 'test-card', input: '站着。' });
    const historyBefore = (await f.store.readHistory('s4')).length;
    const result = await runCandidates(f.deps, { session: 's4', cardId: 'test-card', input: '站着。', count: 3 });
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(result.candidates, ['推门进去', '后退一步', '喊她的名字']);
    assert.equal((await f.store.readHistory('s4')).length, historyBefore, '候选不得写进历史');
    assert.deepEqual(await f.store.readState('s4'), {}, '候选不得写状态');
  } finally { f.cleanup(); }
});

test('A3：回退把正文与状态一起还原到快照点', async () => {
  const f = fixture();
  try {
    await runTurn(f.deps, { session: 's5', cardId: 'test-card', input: '第一轮。' });
    await runSettlement(f.deps, { session: 's5', cardId: 'test-card', input: '第一轮。' });
    const historyAtTurn2 = readFileSync(join(f.store.sessionDir('s5'), 'snapshots', '0002', 'history.jsonl'), 'utf8');
    const stateAtTurn2 = readFileSync(join(f.store.sessionDir('s5'), 'snapshots', '0002', 'state.json'), 'utf8');
    await runTurn(f.deps, { session: 's5', cardId: 'test-card', input: '第二轮。' });
    assert.equal((await f.store.readHistory('s5')).length, 5);

    const out = await f.store.rollback('s5', 2);
    assert.equal(readFileSync(join(f.store.sessionDir('s5'), 'history.jsonl'), 'utf8'), historyAtTurn2, '正文必须字节级还原');
    assert.equal(readFileSync(join(f.store.sessionDir('s5'), 'state.json'), 'utf8'), stateAtTurn2, '状态必须字节级还原');
    // 快照 2 = 「第 2 轮开始前」，那时只有开场白 1 条
    assert.equal(out.history, 1);
    assert.deepEqual(await f.store.readState('s5'), {}, '状态也回到那一时刻');

    // 行为级证明：回退后重跑同一轮，应当得到与当初完全相同的装配单（补全器确定性）
    const replay = await runTurn(f.deps, { session: 's5', cardId: 'test-card', input: '第一轮。' });
    assert.equal(replay.turn, 2, '轮次编号也应回到 2');
    assert.equal(replay.a1Ok, true);
    assert.equal((await f.store.readHistory('s5')).length, 3, '重跑后历史回到 3 条');
  } finally { f.cleanup(); }
});

test('A3 反例：没有完整快照时响亮拒绝，不做部分回退', async () => {
  const f = fixture();
  try {
    await runTurn(f.deps, { session: 's6', cardId: 'test-card', input: '第一轮。' });
    const before = readFileSync(join(f.store.sessionDir('s6'), 'history.jsonl'), 'utf8');
    await assert.rejects(() => f.store.rollback('s6', 99), /没有完整快照/);
    assert.equal(readFileSync(join(f.store.sessionDir('s6'), 'history.jsonl'), 'utf8'), before, '拒绝时不得改动任何文件');
  } finally { f.cleanup(); }
});

test('extractJsonObject：容忍围栏与前后废话，坏输入返回 null', () => {
  assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJsonObject('前言 {"a":{"b":"}"}} 后语'), { a: { b: '}' } });
  assert.equal(extractJsonObject('没有对象'), null);
  assert.equal(extractJsonObject('{坏 json'), null);
});

test('面板 view：无历史时给出开局指引，有历史时展示正文与状态', async () => {
  const f = fixture();
  try {
    const panel = createTavernPanel(f.deps);
    const empty = await panel.view({ session: 'pv' });
    assert.ok(empty.blocks.some((b) => b.kind === 'text' && JSON.stringify(b).includes('开局')));
    await runTurn(f.deps, { session: 'pv', cardId: 'test-card', input: '进去。' });
    const filled = await panel.view({ session: 'pv' });
    const text = filled.blocks.find((b) => b.kind === 'text');
    assert.ok(JSON.stringify(text).includes('开场'), '正文块应含开场白');
    assert.ok(filled.blocks.some((b) => b.kind === 'metrics'), '应有读数块');
  } finally { f.cleanup(); }
});
