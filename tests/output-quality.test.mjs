/**
 * 输出质量判据（「模型表现」族）· 判据
 *
 * 与 `quality.ts`（结构族：装配好不好）**分族**：本文件判的是**模型输出的形态**。
 * 要求：① 真实好样本全过；② 每条判据各有一个尸体样本且**只让自己红**；
 *       ③ 对照组证明它不是恒绿装饰。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeOutput, describeOutput, lastAssistantText } from '../lib/output-quality.js';

/** 真实样本：2026-09-22 在 default_Seraphina 上真跑一轮得到的正文（截取）。 */
const REAL_GOOD = [
  '窗棂上爬满了细密的藤蔓，几缕午后的光透过叶隙落在她肩上，把粉色的长发染出一层暖金。她微微侧着头，膝上摊着一只翅膀缠着细藤的雏鸟。',
  '',
  '“你不该下床的。”她的语气没有责备，更多的是那种看着孩子跑太快的担心。她站起身，黑裙的下摆扫过地板，走过来时脚步很轻，像怕惊扰了什么。',
  '',
  '“坐吧。”她朝窗边那条铺着旧毯的长凳偏了偏头，“外面风大，别站在门口。”',
].join('\n');

const reds = (r) => r.verdicts.filter((v) => !v.ok).map((v) => v.id);

test('真实好样本：四条形态判据全过，且通过时也带读数', () => {
  const r = judgeOutput({ text: REAL_GOOD });
  assert.deepEqual(reds(r), [], '真实输出不该被判漂移：' + JSON.stringify(r.verdicts));
  assert.equal(r.ok, true);
  for (const v of r.verdicts) assert.ok(v.detail.length > 0, `${v.id} 通过时也要给读数`);
  assert.match(describeOutput(r), /无漂移/);
});

test('尸体样本①「补一个选项列表」⇒ 只让 no-option-list 红（预设 role 块明令禁止）', () => {
  const drifted = REAL_GOOD + '\n\n接下来你可以：\n1. 坐到长凳上\n2. 问她林子里的东西\n3. 先喝水';
  const r = judgeOutput({ text: drifted });
  assert.deepEqual(reds(r), ['no-option-list'], JSON.stringify(r.verdicts));
  assert.match(r.verdicts.find((v) => v.id === 'no-option-list').detail, /清单式行/);
});

test('尸体样本②「加小标题」⇒ 只让 no-heading 红', () => {
  const r = judgeOutput({ text: '## 室内\n' + REAL_GOOD + '\n【下一步】\n她等你回答。' });
  assert.deepEqual(reds(r), ['no-heading'], JSON.stringify(r.verdicts));
});

test('尸体样本③「冒出 OOC 元说明」⇒ 只让 no-meta 红', () => {
  const r = judgeOutput({ text: REAL_GOOD + '\n\n（注：此处应当给玩家留出回应空间。）' });
  assert.deepEqual(reds(r), ['no-meta'], JSON.stringify(r.verdicts));
});

test('尸体样本④「复述上轮」⇒ 只让 no-repeat-prev 红（≥40 字连续重复）', () => {
  const r = judgeOutput({ text: '她又说了一遍：' + REAL_GOOD.slice(0, 60), previous: REAL_GOOD });
  assert.deepEqual(reds(r), ['no-repeat-prev'], JSON.stringify(r.verdicts));
  assert.match(r.verdicts.find((v) => v.id === 'no-repeat-prev').detail, /连续重复/);
});

test('对照组：判据必须**会红**，且同时坏两处要各自点名、互不掩盖', () => {
  const good = judgeOutput({ text: REAL_GOOD });
  const bad = judgeOutput({ text: 'OOC：我要漂移了\n\n1. 甲\n2. 乙\n', previous: REAL_GOOD });
  assert.equal(good.ok, true);
  assert.equal(bad.ok, false);
  assert.deepEqual(reds(bad).sort(), ['no-meta', 'no-option-list'], JSON.stringify(bad.verdicts));
});

test('首轮不适用复述判定（previous 未给出 ⇒ 通过并标明不适用）', () => {
  const r = judgeOutput({ text: REAL_GOOD });
  const v = r.verdicts.find((x) => x.id === 'no-repeat-prev');
  assert.equal(v.ok, true);
  assert.match(v.detail, /首轮/);
});

test('边界：单行清单不误报（对话里偶然出现「1.」不该判漂移）', () => {
  const r = judgeOutput({ text: REAL_GOOD + '\n\n她说：“第 1. 条规矩，别乱走。”' });
  assert.equal(r.verdicts.find((v) => v.id === 'no-option-list').ok, true, '单行清单式文本被误报了');
});

test('便利函数：从消息数组取最后一条 assistant 正文', () => {
  const msgs = [
    { role: 'system', text: 'S' },
    { role: 'user', text: 'U' },
    { role: 'assistant', text: 'A1' },
    { role: 'user', text: 'U2' },
    { role: 'assistant', text: 'A2' },
  ];
  assert.equal(lastAssistantText(msgs), 'A2');
  assert.equal(lastAssistantText([{ role: 'user', text: 'U' }]), undefined);
});
