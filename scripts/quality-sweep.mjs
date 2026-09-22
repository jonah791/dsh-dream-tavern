#!/usr/bin/env node
/**
 * 质量判据的**真实数据扫描器** —— 在主人真卡库上跑 Q1–Q3，并回报「哪些旋钮真的被观测到」。
 *
 * 这是「可度量的搜索循环」的第一件执行装置（2026-09-21 命题的工程等价物）。
 * 它**不调模型**：只跑装配 + 结构质量判据 ⇒ 可廉价反复跑（搜索循环要能承担几百次迭代）。
 *
 * ⚠ 读数范围标注（§5.9 规则 6）——本扫描的结论**只覆盖以下域**：
 *   · 输入：固定探针 `PROBE_INPUT`、turn=1、空历史、空状态 ⇒ **只测结构质量，不测模型表现**
 *   · 世界书：只并入**卡内**世界书（`card.lorebook`）；会话世界书为空中 ⇒ 67 本独立世界书未参与
 *   · 预设：内建 default（`budgetChars`）⇒ 主人的真实预设（`tavern/色欲之罪预设/`）未参与
 *   ⇒ 想扩域，就拨这三个旋钮再跑一遍（这正是搜索循环的用法）。
 *
 * 跑法：
 *   node scripts/quality-sweep.mjs                       # 用默认卡库
 *   DREAM_TAVERN_CARDS="C:/.../characters" node scripts/quality-sweep.mjs
 *   DREAM_TAVERN_CARDS=... node scripts/quality-sweep.mjs --budget 20000
 * 退出码：0 = 全部干净；1 = 有卡未过（附逐卡原因）；2 = 卡库不可达（本扫描不适用，**不假装通过**）。
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCardFile } from '../lib/card.js';
import { assemble } from '../lib/assemble.js';
import { judgeAssembly } from '../lib/quality.js';
import { defaultPreset } from '../lib/preset.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const DEFAULT_CARDS = 'C:/Users/tr/AppData/Roaming/com.tauritavern.client/data/default-user/characters';
const PROBE_INPUT = '你好。';
const DEFAULT_BUDGET = 40000;

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Translate `C:/x` into the WSL mount path when not running on Windows. */
function nativePath(input) {
  if (process.platform === 'win32') return input;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(input);
  if (m === null) return input;
  return `/mnt/${(m[1] ?? 'c').toLowerCase()}/${(m[2] ?? '').replace(/\\/g, '/')}`;
}

const cardsDir = nativePath(process.env.DREAM_TAVERN_CARDS ?? DEFAULT_CARDS);
const budget = Number(argValue('--budget') ?? DEFAULT_BUDGET);
const preset = defaultPreset(budget);
/**
 * 「哪个块是输出规范」是**内容层判断**，由调用方指名。
 *
 * ⚠ 2026-09-22 首版把 `role` 与 `discipline` 都指名为规范块 ⇒ 58 张卡全红在
 * `discipline priority=90 低于最高 100`。复核后：`discipline` 的实际内容是**叙事手艺**
 * （推进情节 / 人设一致 / 不替玩家决定），而 `preset.ts` 头注所指的「输出规范」
 * （加小标题 / 加选项 / 复述上轮）由 `role` 承担。
 * ⇒ **指名过宽是我的判断错，不是卡或预设的缺陷**；收窄为 `role`。
 * （判据的分辨力不因此削弱：`tests/quality.test.mjs` 的尸体样本②b 证明 priority 一旦掉下去必红。）
 */
const NORM_BLOCK_IDS = ['role'];

/**
 * 探针输入**按卡自适应**：拼上该卡第一条非 constant 世界书条目的关键词。
 * 理由：固定探针「你好。」下 57 张有卡内世界书的卡**命中 0 次** ⇒ `trigger` 旋钮
 * 从未被观测到（永远停在推断）。探针带上关键词后，命中路径才会真的被走到。
 */
function probeInputFor(card) {
  const entry = card.lorebook.find((e) => e.constant !== true && typeof e.keywords === 'string' && e.keywords.trim() !== '');
  if (entry === undefined) return PROBE_INPUT;
  const first = (entry.keywords.split(',')[0] ?? '').trim();
  return first === '' ? PROBE_INPUT : `${PROBE_INPUT}${first}`;
}

console.log('═'.repeat(72));
console.log('梦境酒馆 · 质量判据真实数据扫描（不调模型）');
console.log('═'.repeat(72));
console.log(`  卡库 ${cardsDir}`);
console.log(`  预设 default · budgetChars=${budget} · 规范块 ${NORM_BLOCK_IDS.join('/')}`);
console.log(`  探针输入 "${PROBE_INPUT}" · turn=1 · 空历史 · 空状态 · 仅卡内世界书`);

let pngs;
try {
  pngs = readdirSync(cardsDir).filter((f) => f.toLowerCase().endsWith('.png'));
} catch {
  console.log('\n  ⚠ 卡库不可达 ⇒ 本扫描**不适用**（退出码 2，不假装通过）');
  process.exit(2);
}

const observed = {
  slots: new Set(),
  sources: new Set(),
  cardsWithLorebookHit: 0,
  cardsWithTrim: 0,
  cardsWithTriggerHit: 0,
  adaptiveProbes: 0,
};
const failures = [];
const notices = [];
let noticeCards = 0;
let okCount = 0;
let totalEntries = 0;
let totalChars = 0;

console.log(`\n  共 ${pngs.length} 张 PNG\n`);

for (const file of pngs) {
  const path = join(cardsDir, file);
  let result;
  try {
    const { card } = readCardFile(path);
    const probe = probeInputFor(card);
    // 调用方负责合并世界书（装配器**不得**自行加源——2026-09-22 重复注入事故的修法）
    const { manifest } = assemble({
      preset, card, lorebook: [...card.lorebook],
      history: [], state: {}, turnInput: probe, turn: 1,
    });
    if (probe !== PROBE_INPUT) observed.adaptiveProbes += 1;
    const report = judgeAssembly({ manifest, preset, normBlockIds: NORM_BLOCK_IDS });
    for (const e of manifest.entries) {
      observed.slots.add(e.slot);
      for (const p of e.parts) {
        observed.sources.add(p.source.split(':')[0]);
        if (p.triggerHit !== undefined) observed.cardsWithTriggerHit += 1;
      }
    }
    if (manifest.dropped.length > 0) observed.cardsWithTrim += 1;
    if (card.lorebook.length > 0) observed.cardsWithLorebookHit += 1;
    totalEntries += manifest.entries.length;
    totalChars += manifest.totalChars;
    result = { file, manifest, report };
  } catch (e) {
    failures.push({ file, reason: `装配抛错：${e instanceof Error ? e.message : String(e)}` });
    console.log(`  ✖ ${file}  —— 装配抛错`);
    continue;
  }
  const reds = result.report.verdicts.filter((v) => !v.ok);
  if (result.report.notices.length > 0) { noticeCards += 1; notices.push(...result.report.notices.map((n) => `${file}: ${n}`)); }
  if (reds.length === 0) {
    okCount += 1;
  } else {
    failures.push({
      file,
      reason: reds.map((v) => `${v.id}: ${v.detail}`).join(' | '),
    });
    console.log(`  ✖ ${file}`);
    for (const v of reds) console.log(`      ${v.id} → ${v.detail}`);
  }
}

console.log('\n' + '─'.repeat(72));
console.log('聚合读数');
console.log(`  通过 ${okCount}/${pngs.length} · 未过 ${failures.length}`);
console.log(`  条目总数 ${totalEntries} · 请求字数合计 ${totalChars}`);
console.log('  观测到的旋钮（这些从「推断」转为**实测**的依据）：');
console.log(`    · slot    实际出现的槽位 ${[...observed.slots].sort().join(' / ')}（共 ${observed.slots.size} 类）`);
console.log(`    · source  实际出现的来源族 ${[...observed.sources].sort().join(' / ')}`);
console.log(`    · trigger 卡内世界书非空 ${observed.cardsWithLorebookHit} 张 · 条数命中合计 ${observed.cardsWithTriggerHit} 次`);
console.log(`    · budget  触发裁剪的卡 ${observed.cardsWithTrim} 张（budgetChars=${budget}）`);
console.log(`    · 探针    自适应探针 ${observed.adaptiveProbes} 张（带上了该卡世界书的关键词）`);
console.log(`  提示（不判失败，内容层观察）：${noticeCards} 张卡存在跨来源的内容重复`);
for (const n of notices.slice(0, 5)) console.log(`    · ${n}`);
if (notices.length > 5) console.log(`    · …另有 ${notices.length - 5} 条`);
const gapped = failures.length === 0 ? '无' : String(failures.length);
console.log(`  未过卡数 ${gapped}`);

console.log('\n' + '═'.repeat(72));
if (failures.length === 0) {
  console.log('裁决：PASS —— 真卡库上三条质量判据全过');
  console.log('═'.repeat(72));
  process.exit(0);
} else {
  console.log(`裁决：FAIL —— ${failures.length} 张未过（逐卡原因见上）`);
  console.log('═'.repeat(72));
  process.exit(1);
}
