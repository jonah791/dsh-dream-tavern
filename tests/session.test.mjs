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
    route: { provider: 'test', model: 'test-model' },
    // 形态判据的标记表（2026-09-25）：**空数组 ⇒ 不检查该项**，且 retryMax=1 ⇒ 不重试
    // ⇒ 本夹具行为与旧版**逐字节一致**（既有断言全部照旧生效）。需要判据的用例自己声明标记。
    proseMarkers: [],
    chainMarkers: [],
    retryMax: 1,
    complete: async (messages, options) => {
      const last = messages.at(-1);
      return {
        text: options.purpose === 'settle'
          ? '{"天气":"雨","好感":1}'
          : options.purpose === 'candidates'
            ? '推门进去\n后退一步\n喊她的名字'
            : `回复：${last.text.slice(0, 10)}`,
        // 思维链与结束原因（2026-09-23 新增字段）：假 Completer 必须与 Completion 契约同形，
        // 否则 `writeReasoning` 会拿到 undefined（契约迁移漏改生产者 ⇒ 全库扫描纪律）。
        reasoning: '先看她此刻在做什么，再决定用哪句开口。',
        finishKind: 'stop',
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

test('readLatestManifest：轮次号不能靠历史长度反推（开场 1 条 + 每轮 2 条）', async () => {
  const f = fixture();
  try {
    assert.equal(await f.store.readLatestManifest('lm'), null, '空会话没有装配单');
    const first = await runTurn(f.deps, { session: 'lm', cardId: 'test-card', input: '第一轮。' });
    assert.equal(first.turn, 2);
    let latest = await f.store.readLatestManifest('lm');
    assert.equal(latest.turn, 2, '第一张装配单是第 2 轮（历史此刻 3 条，不是 2）');
    await runTurn(f.deps, { session: 'lm', cardId: 'test-card', input: '第二轮。' });
    latest = await f.store.readLatestManifest('lm');
    assert.equal(latest.turn, 4, '第 4 轮');
    assert.equal((await f.store.readHistory('lm')).length, 5, '历史 5 条 —— 与轮次号不成线性');

    // 面板读数必须取到最新那张，而不是算出来的错号
    const panel = createTavernPanel(f.deps);
    const view = await panel.view({ session: 'lm' });
    const metrics = view.blocks.find((b) => b.kind === 'metrics');
    const req = metrics.items.find((i) => i.label === '上轮请求');
    assert.notEqual(req.value, '—', '上轮请求必须有读数');
    assert.ok(String(req.hint).includes('第 4 轮'), `读数应指向第 4 轮，实际 ${req.hint}`);
  } finally { f.cleanup(); }
});

test('思维链落盘：reasoning/<turn>.md 与装配单同轮号，且**不得**回流进对话历史', async () => {
  const f = fixture();
  try {
    const r = await runTurn(f.deps, { session: 'rs', cardId: 'test-card', input: '我走进去。' });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.finishKind, 'stop');
    assert.equal(r.truncated, false, 'stop 不是截断');
    assert.ok(r.reasoningChars > 0, '本回合应有思维链字符数');
    const onDisk = await f.store.readReasoning('rs', r.turn);
    assert.ok(onDisk !== null, 'reasoning/<turn>.md 必须落盘');
    assert.match(onDisk, /先看她此刻在做什么/);

    // 关键不变量：思维链是**响应侧**证据，绝不能回流进 history——
    // history 每一行都会被 assemble 映射成下一次请求的消息，混进去就改变了被测对象本身。
    const history = await f.store.readHistory('rs');
    for (const m of history) {
      assert.equal(m.reasoning, undefined, 'history 行不得带 reasoning 字段');
      assert.doesNotMatch(m.text, /先看她此刻在做什么/, '思维链文本不得混进 history');
    }
  } finally { f.cleanup(); }
});

test('截断判据以 finish 为准（反例：token 代理量会漏报）', async () => {
  const f = fixture();
  try {
    // outputTokens(20) < maxTokens(200) ⇒ 旧代理量会报「没截断」；权威信号说 max-tokens ⇒ 必须报截断
    const deps = {
      ...f.deps,
      complete: async () => ({
        text: '半句话就断了',
        reasoning: '',
        finishKind: 'max-tokens',
        usage: { inputTokens: 1, outputTokens: 20, cacheReadTokens: 0 },
      }),
    };
    const r = await runTurn(deps, { session: 'tr', cardId: 'test-card', input: 'x' });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.truncated, true, 'finish=max-tokens 必须判截断——代理量在这一格会漏报');
    assert.equal(r.reasoningPath, '', '没有思维链时不落盘、路径为空串');
    assert.equal(r.reasoningChars, 0);
  } finally { f.cleanup(); }
});

test('没收到 finish（异常中断）时才回退到 token 代理量', async () => {
  const f = fixture();
  try {
    const deps = {
      ...f.deps,
      complete: async () => ({
        text: 'x',
        reasoning: '',
        finishKind: '',
        usage: { inputTokens: 1, outputTokens: 200, cacheReadTokens: 0 },
      }),
    };
    const r = await runTurn(deps, { session: 'tr2', cardId: 'test-card', input: 'x' });
    assert.equal(r.finishKind, '');
    assert.equal(r.truncated, true, 'finishKind 空 ⇒ 回退代理量（outputTokens 200 >= maxTokens 200）');
  } finally { f.cleanup(); }
});

test('空正文必须响亮失败，且**不得**写进历史（真实产出的空转失败模式）', async () => {
  const f = fixture();
  try {
    // 2026-09-23 实测形状：模型把预算烧在思维链上、正文一字未出，而 finish 仍是 stop
    // ⇒ token 判据看不出来。若当成功，会往 history 写一条 0 字符 assistant 行污染后续轮。
    const deps = {
      ...f.deps,
      complete: async () => ({
        text: '   \n  ',
        reasoning: '开始写。\n\n好，开写。\n\n开写。',
        finishKind: 'stop',
        usage: { inputTokens: 3331, outputTokens: 2835, cacheReadTokens: 50560 },
      }),
    };
    const r = await runTurn(deps, { session: 'empty', cardId: 'test-card', input: '看她翻页的手指。' });

    assert.equal(r.ok, false, '空正文必须判失败');
    assert.match(r.reason, /空正文/);
    assert.match(r.reason, /finish=stop/, '失败原因要带结束原因，便于归因');
    assert.match(r.reason, /思维链 12 字/, '失败原因要带思维链字数（去空白口径）');
    assert.equal(r.finishKind, 'stop');
    assert.equal(r.usage.outputTokens, 2835, 'token 花了就要报出来（成本账）');

    // 关键：失败也要留下诊断证据——思维链必须落盘
    assert.ok(r.reasoningPath !== '', '思维链是唯一诊断证据，失败路径也必须落盘');
    assert.match(await f.store.readReasoning('empty', r.turn), /开写/);

    // 关键：失败轮不得追加任何历史行。
    // ⚠ 注意口径：`ensureOpening` 在调用模型**之前**就写了卡自带开场白，所以失败轮过后
    // history 里仍会有那 1 条开场白——这不是污染。要断言的是「没多出用户行 / 没多出空行」。
    const after = await f.store.readHistory('empty');
    assert.equal(after.length, 1, '失败轮只应留下卡自带开场白，不得追加任何行');
    assert.equal(after[0].role, 'assistant');
    assert.ok(after[0].text.length > 0, '留下的那条是开场白');
    assert.ok(!after.some((m) => m.role === 'user'), '用户输入不得入库（否则下一次请求会看到「用户说了话但助手没答」）');
    assert.ok(!after.some((m) => m.text.trim() === ''), '不得出现空正文行');
  } finally { f.cleanup(); }
});

test('每轮的「条件 + 读数」必须落盘（主人要求：每次请求可见 · 全流程透明）', async () => {
  const f = fixture();
  try {
    const r = await runTurn(f.deps, { session: 'rec', cardId: 'test-card', input: '我走进去。' });
    assert.equal(r.ok, true, r.reason);
    assert.ok(r.turnRecordPath !== '', '必须给出轮次记录路径');
    const rec = await f.store.readTurnRecord('rec', r.turn);
    assert.ok(rec !== null, 'turns/<turn>.json 必须存在');

    // 实验条件必须齐——否则读数不可归因（换过参数之后两轮读数不是一回事）
    assert.equal(rec.cardId, 'test-card');
    assert.equal(rec.provider, 'test');
    assert.equal(rec.model, 'test-model');
    assert.equal(rec.maxTokens, 200);
    assert.equal(rec.temperature, 0.9);
    assert.equal(rec.budgetChars, 24000);
    assert.equal(typeof rec.presetId, 'string', '预设 id 要记（区分是哪个预设跑出来的）');
    assert.ok(typeof rec.manifestHash === 'string' && rec.manifestHash.length > 0, '装配单 hash 要记——把请求与读数钉在一起');

    // 读数必须齐
    assert.equal(rec.ok, true);
    assert.equal(rec.finishKind, 'stop');
    assert.equal(rec.truncated, false);
    assert.equal(rec.a1Ok, true);
    assert.equal(rec.usage.outputTokens, 20);
    assert.ok(rec.textChars > 0, '正文字数');
    assert.ok(rec.reasoningChars > 0, '思维链字数');
    assert.ok(typeof rec.manifestPath === 'string' && rec.manifestPath !== '');
  } finally { f.cleanup(); }
});

test('逐轮 temperature/maxTokens 覆盖：传了用传的、落盘记实际生效值、不传回落配置', async () => {
  const f = fixture();
  try {
    // 传了：模型调用与轮次记录都必须用**覆盖值**（否则读数与实发参数不一致 ⇒ 归因失效）
    const seen = [];
    const deps = {
      ...f.deps,
      complete: async (messages, options) => {
        seen.push({ ...options });
        return {
          text: '覆盖轮正文。', reasoning: '', finishKind: 'stop',
          usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0 },
        };
      },
    };
    const r = await runTurn(deps, { session: 'ovr', cardId: 'test-card', input: '我走进去。', temperature: 0.3, maxTokens: 50 });
    assert.equal(r.ok, true, r.reason);
    assert.equal(seen.at(-1).temperature, 0.3, '模型调用必须收到覆盖温度');
    assert.equal(seen.at(-1).maxTokens, 50, '模型调用必须收到覆盖上限');
    const rec = await f.store.readTurnRecord('ovr', r.turn);
    assert.equal(rec.temperature, 0.3, '轮次记录必须记**实际生效值**（读数自带范围标注）');
    assert.equal(rec.maxTokens, 50);

    // 不传：回落配置值（回归——老调用方行为逐字节不变）
    const r2 = await runTurn(deps, { session: 'dflt', cardId: 'test-card', input: '我走进去。' });
    assert.equal(r2.ok, true, r2.reason);
    assert.equal(seen.at(-1).temperature, 0.9, '不传 ⇒ 用配置值');
    assert.equal(seen.at(-1).maxTokens, 200);
    const rec2 = await f.store.readTurnRecord('dflt', r2.turn);
    assert.equal(rec2.temperature, 0.9);
    assert.equal(rec2.maxTokens, 200);
  } finally { f.cleanup(); }
});

test('形态判据 + 重试：空正文 → 只有链 → 正常；逐次留痕，历史只写成功那一次', async () => {
  const f = fixture();
  try {
    const seq = [
      { text: '', reasoning: '想了很多，一个字没写。' },
      { text: '〇、识人：这是思考链，不是正文。', reasoning: '把链当正文了。' },
      { text: '<dream_plot>正文来了。</dream_plot>', reasoning: '这次对了。' },
    ];
    let calls = 0;
    const deps = {
      ...f.deps,
      proseMarkers: ['<dream_plot>'],
      chainMarkers: ['〇、识人'],
      retryMax: 3,
      complete: async () => {
        const s = seq[Math.min(calls, seq.length - 1)];
        calls += 1;
        return { text: s.text, reasoning: s.reasoning, finishKind: 'stop', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0 } };
      },
    };
    const r = await runTurn(deps, { session: 'retry', cardId: 'test-card', input: '我走进去。' });
    assert.equal(r.ok, true, r.reason);
    assert.equal(calls, 3, '应当恰好调了 3 次（前两次判为不可用 ⇒ 重试）');
    assert.ok(r.text.includes('<dream_plot>'), '交付的必须是成功那一次的正文');

    const rec = await f.store.readTurnRecord('retry', r.turn);
    assert.equal(rec.ok, true);
    assert.equal(rec.attempts.length, 3, '逐次留痕：三次都要记（不许只留最后一次）');
    assert.deepEqual(rec.attempts.map((a) => a.verdict), ['empty-text', 'chain-in-content', 'ok']);
    assert.equal(rec.chainInContent, false, '最终那次不带链');

    const history = await f.store.readHistory('retry');
    assert.equal(history.filter((m) => m.role === 'assistant').length, 2, '开场白 + 成功那一次（失败的不写入）');
  } finally { f.cleanup(); }
});

test('重试用尽但最后一次「带链且有正文」⇒ 接受并标记 chainInContent（故事确实交付了）', async () => {
  const f = fixture();
  try {
    let calls = 0;
    const deps = {
      ...f.deps,
      proseMarkers: ['<dream_plot>'],
      chainMarkers: ['〇、识人'],
      retryMax: 2,
      complete: async () => {
        calls += 1;
        return { text: '〇、识人：链在开头。<dream_plot>正文</dream_plot>', reasoning: '', finishKind: 'stop', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0 } };
      },
    };
    const r = await runTurn(deps, { session: 'chain', cardId: 'test-card', input: '我走进去。' });
    assert.equal(r.ok, true, '有正文就不该整轮丢弃：' + r.reason);
    assert.equal(calls, 2, '试满 retryMax 次');
    // t-1b8be614 的判据：**返回体**必须能区分「勉强接受」与「一次干净的成功」。
    // 此前两者同形（ok:true / reason:''）——标记不可见 = 没标记。
    assert.equal(r.chainInContent, true, '返回体要能看出这是带链接受的轮次');
    assert.equal(r.chainHit, '〇、识人', '命中的链标记要回显');
    assert.equal(r.attempts.length, 2, '逐次尝试要回显，不许只活在轮次记录里');
    assert.equal(r.attempts[0].verdict, 'chain-in-content');
    const rec = await f.store.readTurnRecord('chain', r.turn);
    assert.equal(rec.chainInContent, true, '带链必须显式标记（报告要能单列）');
    assert.equal(rec.attempts.length, 2);
  } finally { f.cleanup(); }
});

test('finish=error 的失败详情必须三处留存：结果 / 轮次记录 / 侧车轨迹（t-91746d6a）', async () => {
  const f = fixture();
  try {
    const deps = {
      ...f.deps,
      complete: async () => ({
        text: '', reasoning: '想了但没写。', finishKind: 'error',
        finishFailure: { code: 'PROVIDER_ERROR', message: 'provider unavailable' },
        usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0 },
      }),
    };
    const r = await runTurn(deps, { session: 'err', cardId: 'test-card', input: '我走进去。' });
    assert.equal(r.ok, false);
    // ① 结果里带着：它是唯一的归因线索（此前只留一个 `error` 字样）
    assert.deepEqual(r.finishFailure, { code: 'PROVIDER_ERROR', message: 'provider unavailable' });
    // ② 轮次记录里带着：事后追因看的是落盘，不是回忆
    const rec = await f.store.readTurnRecord('err', r.turn);
    assert.equal(rec.finishKind, 'error');
    assert.deepEqual(rec.finishFailure, { code: 'PROVIDER_ERROR', message: 'provider unavailable' });
    // ③ 侧车轨迹里带着：这一类轮次可能连记录都没写成，必须有一行可 tail / grep 的轨迹
    const tracePath = join(r.turnRecordPath, '..', '..', 'llm-finish-trace.jsonl');
    const trace = readFileSync(tracePath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(trace.length, 1, '非 stop 的每一次尝试都要落一行');
    assert.equal(trace[0].ok, false);
    assert.equal(trace[0].failure, 'empty-text', '形态要与判据一致');
    assert.equal(trace[0].finishKind, 'error');
    assert.deepEqual(trace[0].finishFailure, { code: 'PROVIDER_ERROR', message: 'provider unavailable' });
  } finally { f.cleanup(); }
});

test('重试用尽仍是空正文 ⇒ 硬失败：拒绝写入历史，attempts 记全，原因含形态与次数', async () => {
  const f = fixture();
  try {
    let calls = 0;
    const deps = {
      ...f.deps,
      retryMax: 3,
      complete: async () => {
        calls += 1;
        return { text: '', reasoning: '只想了没写。', finishKind: 'stop', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0 } };
      },
    };
    const r = await runTurn(deps, { session: 'fail', cardId: 'test-card', input: '我走进去。' });
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes('empty-text'), '原因要含形态：' + r.reason);
    assert.ok(r.reason.includes('尝试 3/3'), '原因要含尝试次数：' + r.reason);
    assert.equal(calls, 3);

    const history = await f.store.readHistory('fail');
    assert.equal(history.filter((m) => m.role === 'assistant').length, 1, '失败轮不得写入历史（只有开场白）');
    const rec = await f.store.readTurnRecord('fail', r.turn);
    assert.equal(rec.ok, false);
    assert.equal(rec.failure, 'empty-text');
    assert.equal(rec.attempts.length, 3);
  } finally { f.cleanup(); }
});

test('失败轮同样要落盘轮次记录（事后追因靠它）', async () => {
  const f = fixture();
  try {
    const deps = {
      ...f.deps,
      complete: async () => ({
        text: '',
        reasoning: '想',
        finishKind: 'stop',
        usage: { inputTokens: 1, outputTokens: 9, cacheReadTokens: 0 },
      }),
    };
    const r = await runTurn(deps, { session: 'rec2', cardId: 'test-card', input: 'x' });
    assert.equal(r.ok, false);
    const rec = await f.store.readTurnRecord('rec2', r.turn);
    assert.ok(rec !== null, '失败也要留记录，否则事后查不到当时的结束原因');
    assert.equal(rec.ok, false);
    assert.equal(rec.failure, 'empty-text');
    assert.equal(rec.finishKind, 'stop');
    assert.equal(rec.usage.outputTokens, 9, 'token 花了就要记账');
  } finally { f.cleanup(); }
});
