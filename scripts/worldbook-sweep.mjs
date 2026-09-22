#!/usr/bin/env node
/**
 * 独立世界书扫描器 —— 关掉控制面里 **`probability` 旋钮的观测缺口**。
 *
 * 背景（§4.5）：`probability` 的作用在**单份装配单里看不出来**——装配单只记录「中了什么」，
 * 不记录「没中什么」⇒ 要量它**必须做多轮对照**（同一条目在 n 轮里的命中频次）。
 * 卡内世界书不含 `probability`（真卡词汇里没有该字段），所以它只能在**独立世界书文件**上测。
 *
 * ⚠ 读数范围标注：
 *   · 只跑 `matchLorebook`（**纯函数**）+ `importWorldbook`（**纯函数**）⇒ 不调模型、零成本
 *   · 探针文本固定（`PROBE`）＋ 轮次扫描 `turn = 1..N` ⇒ 只反映「按轮次确定性的概率门」，
 *     不反映真实游玩时的历史演化（那需要真实会话）
 *
 * 跑法：
 *   node scripts/worldbook-sweep.mjs                      # 用默认世界书目录
 *   DREAM_TAVERN_WORLDS="C:/.../worlds" node scripts/worldbook-sweep.mjs --turns 12
 * 退出码：0 = 扫描完成；2 = 世界书目录不可达（不假装通过）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importWorldbook } from '../lib/worldbook.js';
import { matchLorebook } from '../lib/lorebook.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const DEFAULT_WORLDS = 'C:/Users/tr/AppData/Roaming/com.tauritavern.client/data/default-user/worlds';
const PROBE = '客栈';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function nativePath(input) {
  if (process.platform === 'win32') return input;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(input);
  if (m === null) return input;
  return `/mnt/${(m[1] ?? 'c').toLowerCase()}/${(m[2] ?? '').replace(/\\/g, '/')}`;
}

const worldsDir = nativePath(process.env.DREAM_TAVERN_WORLDS ?? DEFAULT_WORLDS);
const turns = Number(argValue('--turns') ?? 10);

console.log('═'.repeat(72));
console.log('梦境酒馆 · 独立世界书扫描（关 probability 观测缺口 · 不调模型）');
console.log('═'.repeat(72));
console.log(`  世界书 ${worldsDir} · 轮次 1..${turns} · 探针 "${PROBE}"`);

let files;
try {
  files = readdirSync(worldsDir).filter((f) => f.toLowerCase().endsWith('.json'));
} catch {
  console.log('\n  ⚠ 世界书目录不可达 ⇒ 本次扫描不适用（退出码 2，不假装通过）');
  process.exit(2);
}

const agg = {
  books: 0,
  explained: 0,
  skipped: 0,
  unmodeledKinds: new Set(),
  unknownKinds: new Set(),
  /** 有待测概率门的条目：命中次数 → 条目数 */
  probed: 0,
  probedHits: 0,
  fractional: 0,
  /** 命中次数分布（用于看概率门是否真的在起作用） */
  hitHistogram: new Map(),
  slots: new Set(),
  alwaysOn: 0,
};
const probedSamples = [];

for (const file of files) {
  let imported;
  try {
    imported = importWorldbook(JSON.parse(readFileSync(join(worldsDir, file), 'utf8')));
  } catch {
    continue; // 单本书坏了不影响结论
  }
  agg.books += 1;
  agg.explained += imported.entries.length;
  agg.skipped += imported.skipped.length;
  for (const k of Object.keys(imported.unmodeled ?? {})) agg.unmodeledKinds.add(k);
  for (const k of Object.keys(imported.unknown ?? {})) agg.unknownKinds.add(k);

  // ⚠ 首版用同一个探针跑所有条目 ⇒ 分布两极（0 次 / N 次），**混淆了「关键词没匹配」与「概率门挡下」**。
  // 改为**逐条用自己的第一个关键词探**：关键词必然命中，于是命中次数**只反映概率门**。
  const firstKeyword = (e) => (typeof e.keywords === 'string' ? (e.keywords.split(',')[0] ?? '').trim() : '');
  for (const e of imported.entries) {
    if (e.probability === undefined) continue;
    agg.probed += 1;
    const probe = firstKeyword(e);
    let n = 0;
    for (let turn = 1; turn <= turns; turn += 1) {
      const hits = matchLorebook([e], { history: [], turnInput: probe, turn });
      if (hits.length > 0) n += 1;
    }
    if (n > 0) agg.probedHits += 1;
    if (e.probability < 1) agg.fractional += 1;
    agg.hitHistogram.set(n, (agg.hitHistogram.get(n) ?? 0) + 1);
    if (probedSamples.length < 5 && e.probability < 1) probedSamples.push({ file, id: e.id, probability: e.probability, hits: n, of: turns });
  }
}

console.log(`\n  世界书 ${agg.books} 本 · 解释 ${agg.explained} 条 · 跳过 ${agg.skipped} 条`);
console.log(`  已知未建模字段 ${agg.unmodeledKinds.size} 种 · 未知字段 ${agg.unknownKinds.size} 种`);
console.log(`  命中过的槽位：${[...agg.slots].sort().join(' / ') || '(无)'}`);
console.log('\n─'.repeat(72));
console.log('probability 旋钮的观测面（这正是单份装配单看不出来的那部分）');
console.log(`  带概率门的条目 ${agg.probed} 条 · 在 ${turns} 轮里至少命中一次的 ${agg.probedHits} 条`);
console.log(`  ⚠ 其中 **p<1（真会被门挡）的 ${agg.fractional} 条** —— 这才是「门有没有被行使」的判据`);
const hist = [...agg.hitHistogram.entries()].sort((a, b) => a[0] - b[0]);
console.log(`  「${turns} 轮里命中次数」分布：`);
for (const [n, count] of hist) console.log(`    命中 ${n} 次 → ${count} 条`);
if (probedSamples.length > 0) {
  console.log('  样本：');
  for (const s of probedSamples) console.log(`    ${s.file.slice(0, 28)} #${s.id} p=${s.probability} ⇒ ${s.hits}/${s.of}`);
}

console.log('\n' + '═'.repeat(72));
console.log(agg.probed === 0
  ? '裁决：扫描完成 —— 但**没有**带概率门的条目 ⇒ probability 旋钮在本语料上仍**未被观测**（如实记，不假装升格）'
  : agg.fractional === 0
    ? '裁决：扫描完成 —— 有概率门条目，但**全部 p=1** ⇒ 门从未被行使 ⇒ probability 旋钮**仍是推断**（多轮对照未能升格它）'
    : '裁决：扫描完成 —— 存在 p<1 的条目 ⇒ probability 旋钮取得**多轮对照读数**（见上分布）');
console.log('═'.repeat(72));
process.exit(0);
