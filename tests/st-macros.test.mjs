/**
 * ST 宏渲染回归测试（2026-09-23）
 *
 * 背景（实测）：启用块里有 **35 个 ST 宏，本插件原先一个都渲染不了**——
 * `renderTemplate` 的键正则只认 `[a-zA-Z0-9_.]`，而 `{{setvar::x::v}}` 含冒号 ⇒ 不匹配。
 * 失效的是**控制层**：人称变量 / 字数档 / 思考预算 / 协议名。产出侧后果是正文里出现
 * 字面量 `{{user}}`，且模型无人称可依 ⇒ 在推理里来回摇摆（当日实测）。
 *
 * 本测试分两层：
 *   ① 宏语义（纯函数）：覆盖 / 追加 / 空值 / 未定义保留 / 注释 / trim / 未知宏保留
 *   ② 真实预设回归：把 `色欲之罪.json` 的启用块逐块渲染，断言**不再残留** `setvar`/`getvar`
 *
 * 运行：先构建（tsc），再 node --test tests/st-macros.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** 路径解析：Windows 形态优先，缺失时回退 WSL 形态（夹具不得依赖运行平台）。 */
function pickRoot(winPath) {
  if (existsSync(winPath)) return winPath;
  return winPath.replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`);
}

const PLUGIN = process.env.DSH_DREAM_TAVERN_ROOT ?? pickRoot('E:/alice/self-plugins/dsh-dream-tavern');
const PRESET_JSON = process.env.DSH_LUST_PRESET ?? pickRoot('E:/alice/tavern/色欲之罪.json');
const assembleLib = `${PLUGIN}/lib/assemble.js`;
const stPresetLib = `${PLUGIN}/lib/st-preset.js`;

if (!existsSync(assembleLib)) {
  console.error(`[skip] 缺少已构建产物：${assembleLib}`);
  process.exit(1);
}

const { renderStMacros } = await import(pathToFileURL(assembleLib).href);

/** 新宏状态。 */
function freshState(extra = {}) {
  return { vars: new Map(), ...extra };
}

/** 渲染并只取文本（大多数用例不关心 trimmed）。 */
function render(text, state) {
  return renderStMacros(text, state).text;
}

test('setvar 写入 → getvar 读出；同名后出现者覆盖', () => {
  const s = freshState();
  assert.equal(render('{{setvar::rencheng_var::第三人称}}', s), '');
  assert.equal(render('{{getvar::rencheng_var}}', s), '第三人称');
  // 该预设实测对同名变量 set 两次（后出现的赢）
  assert.equal(render('{{setvar::rencheng_var::人称设定：第三人称视角。}}', s), '');
  assert.equal(render('{{getvar::rencheng_var}}', s), '人称设定：第三人称视角。');
});

test('addvar 追加到已有值（该预设的 dream_protocol 就是这么累积的）', () => {
  const s = freshState();
  render('{{setvar::dream_protocol::DREAM_PLOT_OUTPUT}}', s);
  render('{{addvar::dream_protocol::,DREAM_SCENE_INFO}}', s);
  render('{{addvar::dream_protocol::,DREAM_SELF_CHECK}}', s);
  assert.equal(render('{{getvar::dream_protocol}}', s), 'DREAM_PLOT_OUTPUT,DREAM_SCENE_INFO,DREAM_SELF_CHECK');
});

test('空值 setvar：置空串（**已定义**）——与「未定义」必须可区分', () => {
  const s = freshState();
  render('{{setvar::judge_var::}}', s);
  assert.equal(s.vars.has('judge_var'), true, '空值也是定义');
  assert.equal(render('{{getvar::judge_var}}', s), '', '已定义的空值渲染成空（不是保留原文）');
});

test('尸体样本：未定义的 getvar **原样保留**（不静默清空）', () => {
  const s = freshState();
  // 该预设确实 getvar 了一个从未 set 的变量（thought_of_chain_var）
  assert.equal(render('{{getvar::thought_of_chain_var}}', s), '{{getvar::thought_of_chain_var}}');
  // 若此断言失败（返回空串），说明实现改成了 ST 的「未定义返回空」——
  // 那会让「变量没被 set」静默消失，正是本仓反复踩过的坑（§5.10）。
});

test('注释宏与 trim：注释清空，trim 置标记并清空自身', () => {
  const s = freshState();
  assert.equal(render('{{//⟦P-ALL⟧}}', s), '');
  const r = renderStMacros('  {{trim}}  正文  ', s);
  assert.equal(r.trimmed, true);
  assert.equal(r.text.trim(), '正文', '调用方据 trimmed 对整块去空白');
  assert.equal(renderStMacros('正文', s).trimmed, false, '没有 trim 宏时不得置标记');
});

test('char / user：有值则替换，拿不到则原样保留', () => {
  const withNames = freshState({ charName: '仙母', userName: '我' });
  assert.equal(render('{{char}}对{{user}}说', withNames), '仙母对我说');
  const withoutNames = freshState();
  assert.equal(render('{{char}}对{{user}}说', withoutNames), '{{char}}对{{user}}说');
});

test('未知宏原样保留（含该预设用到的扩展宏 lora_constant）', () => {
  const s = freshState();
  assert.equal(render('{{压缩相邻消息::lora_constant}}', s), '{{压缩相邻消息::lora_constant}}');
  assert.equal(render('{{unknown_macro}}', s), '{{unknown_macro}}');
});

test('多行值：setvar 的值可跨行（该预设的 thinking_budget / sleep_var_schema 就是）', () => {
  const s = freshState();
  const multi = '{{setvar::thinking_budget::- 思考强度：ultra\n- 预算无上限}}';
  assert.equal(render(multi, s), '');
  assert.equal(render('{{getvar::thinking_budget}}', s), '- 思考强度：ultra\n- 预算无上限');
});

test('嵌套宏：setvar 的值里含 getvar（实测该预设就有）——必须迭代渲染到不动点', () => {
  const s = freshState();
  render('{{setvar::thinking_budget::- 思考强度：ultra}}', s);
  // 该预设块 56 的真实形状：外层 setvar 的值里嵌着内层 getvar
  const outer = '{{setvar::thought_of_chain_var::\n【思维模式要求】\n  {{getvar::thinking_budget}}\n- 正文只写故事本身。\n}}';
  assert.equal(render(outer, s), '', '外层 setvar 必须被识别（单轮正则匹配不到它）');
  assert.equal(
    render('{{getvar::thought_of_chain_var}}', s),
    '\n【思维模式要求】\n  - 思考强度：ultra\n- 正文只写故事本身。\n',
    '内层宏先渲染，外层 setvar 才拿得到最终值（顺序反了就会把未渲染的内层存进变量）',
  );
});

// ── 真实预设回归（端到端：桥接 → 逐块渲染）────────────────────────────────

test('真实预设：启用块渲染后不再残留 setvar / getvar / addvar', () => {
  if (!existsSync(PRESET_JSON)) {
    assert.fail(`缺少真实预设：${PRESET_JSON}（本测试需要它作为金标准）`);
  }
  const raw = JSON.parse(readFileSync(PRESET_JSON, 'utf8'));
  const s = freshState({ charName: '角色', userName: '玩家' });
  const leftovers = [];
  let macroCount = 0;
  let rendered = 0;
  for (const p of raw.prompts ?? []) {
    if (p.enabled !== true) continue;
    const text = String(p.content ?? '');
    if (!text.includes('{{')) continue;
    macroCount += (text.match(/\{\{[^{}]*\}\}/g) ?? []).length;
    const out = render(text, s);
    rendered += 1;
    for (const m of out.match(/\{\{(setvar|getvar|addvar)::[^{}]*\}\}/g) ?? []) {
      leftovers.push(`${String(p.identifier)}: ${m.slice(0, 60)}`);
    }
  }
  assert.ok(macroCount > 0, '前提：该预设的启用块里确实有宏（否则本测试没覆盖到目标）');
  assert.deepEqual(leftovers, [],
    `变量类宏必须全部渲染掉；残留 ${leftovers.length} 处：\n${leftovers.join('\n')}`);
  assert.ok(rendered > 0, '前提：至少渲染过一个含宏的启用块');
});
