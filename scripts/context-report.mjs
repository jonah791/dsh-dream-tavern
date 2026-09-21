#!/usr/bin/env node
/**
 * 上下文编排报告 —— 把一个会话的装配单聚合成一张「钱花在哪」的账。
 *
 * 这是研究线的第一件产物：它不看故事好不好，只看**上下文被谁占了、随轮次怎么长**。
 * 研究「上下文对模型表现的影响」时，这张账是自变量一侧的记录。
 *
 * 跑法：
 *   node scripts/context-report.mjs --data <dataDir> <session>
 *   DREAM_TAVERN_DATA=<dataDir> node scripts/context-report.mjs <session>
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Source category used for the byte account. */
function categoryOf(source) {
  if (source.startsWith('preset:')) return 'preset';
  if (source.startsWith('card:')) return 'card';
  if (source.startsWith('lorebook:')) return 'lorebook';
  if (source.startsWith('history:')) return 'history';
  if (source === 'state') return 'state';
  if (source === 'script') return 'script';
  if (source === 'input') return 'input';
  return source;
}

const argv = process.argv.slice(2);
let dataDir = process.env.DREAM_TAVERN_DATA ?? '';
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--data') { dataDir = argv[i + 1] ?? ''; i += 1; continue; }
  positional.push(argv[i]);
}
const session = positional[0] ?? '';
if (dataDir === '' || session === '') {
  console.error('用法：node scripts/context-report.mjs --data <dataDir> <session>');
  process.exit(1);
}

const dir = join(dataDir, 'sessions', session, 'manifests');
let files;
try {
  files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
} catch (err) {
  console.error(`读不到装配单目录：${dir}（${err.message}）`);
  process.exit(1);
}
if (files.length === 0) {
  console.error(`会话「${session}」还没有装配单`);
  process.exit(1);
}

const turns = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));

console.log('═'.repeat(74));
console.log(`上下文编排报告 · 会话 ${session} · ${turns.length} 轮`);
console.log('═'.repeat(74));

// ── 逐轮总账 ──
console.log('\n[逐轮]');
console.log(`  ${'轮'.padStart(4)} ${'请求字数'.padStart(9)} ${'条目'.padStart(5)} ${'裁剪'.padStart(5)} ${'超预算'.padStart(7)}  hash`);
let prev = 0;
for (const m of turns) {
  const delta = m.totalChars - prev;
  prev = m.totalChars;
  console.log(`  ${String(m.turn).padStart(4)} ${String(m.totalChars).padStart(9)} ${String(m.entries.length).padStart(5)} ${String(m.dropped.length).padStart(5)} ${String(m.overBudget).padStart(7)}  ${m.hash.slice(0, 10)}… (+${delta})`);
}

// ── 来源构成（按字节）──
const byCategory = new Map();
const bySlot = new Map();
for (const m of turns) {
  for (const entry of m.entries) {
    const parts = entry.parts.length > 0 ? entry.parts : [{ source: entry.source, text: entry.text }];
    for (const p of parts) {
      // 按片段**自身**字数记账。片段自带 text，无需均分——
      // 均分会把 system 块的字节平摊到每个来源上（实测把 2 字的 state 报成 2655 字）。
      const bytes = p.text.length;
      const cat = categoryOf(p.source);
      byCategory.set(cat, (byCategory.get(cat) ?? 0) + bytes);
      bySlot.set(entry.slot, (bySlot.get(entry.slot) ?? 0) + bytes);
    }
  }
}
const totalBytes = [...byCategory.values()].reduce((a, b) => a + b, 0);
console.log('\n[来源构成 · 全会话累计]');
for (const [cat, bytes] of [...byCategory.entries()].sort((a, b) => b[1] - a[1])) {
  const pct = (bytes / totalBytes) * 100;
  const bar = '█'.repeat(Math.max(1, Math.round(pct / 2)));
  console.log(`  ${cat.padEnd(10)} ${String(Math.round(bytes)).padStart(8)} 字  ${pct.toFixed(1).padStart(5)}%  ${bar}`);
}
console.log('\n[槽位构成 · 全会话累计]');
for (const [slot, bytes] of [...bySlot.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${slot.padEnd(16)} ${String(Math.round(bytes)).padStart(8)} 字`);
}

// ── 世界书命中 ──
const triggers = new Map();
for (const m of turns) {
  for (const entry of m.entries) {
    for (const p of entry.parts) {
      if (p.triggerHit !== undefined) triggers.set(p.triggerHit, (triggers.get(p.triggerHit) ?? 0) + 1);
    }
  }
}
console.log('\n[世界书触发]');
if (triggers.size === 0) console.log('  本轮样本里没有关键词命中（多为常驻条目或未配世界书）');
else for (const [kw, n] of [...triggers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${kw.padEnd(20)} ${n} 次`);

// ── 增长曲线与裁剪 ──
const first = turns[0].totalChars;
const last = turns[turns.length - 1].totalChars;
const droppedTotal = turns.reduce((n, m) => n + m.dropped.length, 0);
console.log('\n[增长与裁剪]');
console.log(`  首轮 ${first} 字 → 末轮 ${last} 字（增长 ${last - first} 字 / ${turns.length} 轮）`);
console.log(`  累计被预算裁掉 ${droppedTotal} 条；超预算轮次 ${turns.filter((m) => m.overBudget).length}/${turns.length}`);
console.log(`  装配单 hash 唯一数 ${new Set(turns.map((m) => m.hash)).size}/${turns.length}（同 hash = 同请求体）`);
