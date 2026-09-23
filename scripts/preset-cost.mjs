#!/usr/bin/env node
/**
 * Per-block cost report for one preset — the first measurement of a preset iteration loop.
 *
 * WHY: iterating a preset needs to know **where the characters are** before deciding what to cut.
 * The existing scripts answer other questions (`quality-sweep` judges assembly structure,
 * `sample_report.py` judges produced text). Neither says "this one block is 58% of your content".
 * Measured motivation (2026-09-23): the real preset assembles a ~66K-character system message and
 * 58/58 cards blow the 40K budget, while the largest single block is 38K characters on its own.
 *
 * Block labels: a bridged SillyTavern preset exposes only UUID identifiers, which makes the report
 * useless for "which block should I cut?". The original ST `prompts[].name` is therefore carried
 * back in as the label, falling back to the block's own opening text.
 *
 * Deliberate boundary (same as `src/quality.ts`): this reports **cost facts only**. It does NOT
 * judge whether a block is good, redundant, or removable — that is a content-layer decision for
 * the preset author. A cheap block can be essential; an expensive one can be essential too.
 *
 * Scope label (readings must carry their domain): the numbers cover the preset's own block text.
 * They exclude template rendering, card fields, lorebook entries, and history.
 *
 * Usage:
 *   node scripts/preset-cost.mjs --preset <file> [--budget 40000] [--top 20] [--json]
 * Exit codes: 0 = reported; 3 = instrument problem (preset unreadable or unparsable).
 */
import { readFileSync } from 'node:fs';
import { parsePresetFile } from '../lib/preset-file.js';
import { bridgeStPreset } from '../lib/st-preset.js';

const DEFAULT_BUDGET = 40000;
const LABEL_CLIP = 34;

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Convert a Windows path to its WSL mount form when running under Linux. */
function nativePath(input) {
  if (process.platform === 'win32') return input;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(input);
  if (m === null) return input;
  return `/mnt/${(m[1] ?? 'c').toLowerCase()}/${(m[2] ?? '').replace(/\\/g, '/')}`;
}

/** Carry the original ST prompt names back in, keyed by the identifier the bridge kept as block id. */
function stNames(value) {
  const names = new Map();
  if (value === null || typeof value !== 'object' || !Array.isArray(value.prompts)) return names;
  for (const prompt of value.prompts) {
    if (prompt === null || typeof prompt !== 'object') continue;
    const identifier = prompt.identifier;
    const name = prompt.name;
    if (typeof identifier === 'string' && typeof name === 'string' && name !== '') names.set(identifier, name);
  }
  return names;
}

/** One-line label: the ST name when known, else the block's opening text flattened to a single line. */
function labelOf(id, text, names) {
  const named = typeof id === 'string' ? names.get(id) : undefined;
  const source = named !== undefined && named !== '' ? named : text;
  const flat = source.replace(/\s+/g, ' ').trim();
  if (flat === '') return '(空块)';
  return flat.length <= LABEL_CLIP ? flat : `${flat.slice(0, LABEL_CLIP)}…`;
}

const presetArg = argValue('--preset');
if (presetArg === undefined) {
  console.error('usage: node scripts/preset-cost.mjs --preset <file> [--budget 40000] [--top 20] [--json]');
  process.exit(3);
}
const budget = Number(argValue('--budget') ?? DEFAULT_BUDGET);
const top = Number(argValue('--top') ?? 20);
const asJson = process.argv.includes('--json');

const path = nativePath(presetArg);
let raw;
try {
  raw = JSON.parse(readFileSync(path, 'utf8'));
} catch (e) {
  console.error(`裁决：ERROR —— 预设读不到或不是 JSON（${presetArg}）：${e instanceof Error ? e.message : String(e)}`);
  process.exit(3);
}

/** Load a preset the same way every other script does: ST format bridges, plugin format parses. */
function loadPreset(value) {
  const isSt = value !== null && typeof value === 'object' && Array.isArray(value.prompts);
  if (isSt) {
    const r = bridgeStPreset(value, { budgetChars: budget });
    if (r.preset === undefined) {
      console.error(`裁决：ERROR —— ST 预设桥接失败：${r.errors.join('；')}`);
      process.exit(3);
    }
    return { preset: r.preset, kind: 'st', bridge: r };
  }
  const r = parsePresetFile(value, budget);
  if (r.preset === undefined) {
    console.error(`裁决：ERROR —— 预设解析失败：${r.errors.join('；')}`);
    process.exit(3);
  }
  return { preset: r.preset, kind: 'plugin', bridge: null };
}

const loaded = loadPreset(raw);
const names = stNames(raw);
const blocks = (loaded.preset.blocks ?? []).map((block, index) => {
  const text = typeof block.text === 'string' ? block.text : '';
  const state = Object.hasOwn(block, 'enabled') ? (block.enabled === true ? 'on' : 'off') : 'n/a';
  return {
    order: index,
    id: block.id,
    label: labelOf(block.id, text, names),
    slot: block.slot,
    priority: block.priority,
    state,
    chars: text.length,
  };
});

const active = blocks.filter((b) => b.state !== 'off');
const activeChars = active.reduce((sum, b) => sum + b.chars, 0);
const allChars = blocks.reduce((sum, b) => sum + b.chars, 0);
const ranked = [...active].sort((a, b) => b.chars - a.chars);
const topThree = ranked.slice(0, 3).reduce((sum, b) => sum + b.chars, 0);
const unnamed = ranked.filter((b) => !names.has(String(b.id))).length;

if (asJson) {
  console.log(JSON.stringify({
    preset: loaded.preset.name ?? '', kind: loaded.kind, budget, blocks: blocks.length,
    activeBlocks: active.length, activeChars, allChars, topThreeChars: topThree, ranked,
  }, null, 1));
  process.exit(0);
}

const pct = (n, d) => (d > 0 ? ((n / d) * 100).toFixed(1) : '0.0');
console.log('═'.repeat(72));
console.log('梦境酒馆 · 预设块级成本（不调模型）');
console.log('═'.repeat(72));
console.log(`  预设 ${loaded.preset.name ?? '(无名)'} · 桥接 ${loaded.kind} · blocks=${blocks.length} · 预算 budgetChars=${budget}`);
console.log('  口径：**预设块正文**（模板未渲染；未含卡片字段 / 世界书 / 历史）');
console.log('  ⚠ 本表只报**成本事实**，不判块的好坏或可否删除——那是内容层（预设作者）的决定');
console.log('');
console.log('      字符    占比  启用  slot          prio  块');
for (const b of ranked.slice(0, top)) {
  console.log(`  ${String(b.chars).padStart(7)}  ${pct(b.chars, activeChars).padStart(5)}%  ${b.state.padStart(3)}  ${String(b.slot ?? '').padEnd(12)}  ${String(b.priority ?? '').padStart(4)}  ${b.label}`);
}
if (ranked.length > top) console.log(`  ...另有 ${ranked.length - top} 个启用块（--top 可调）`);

console.log('');
console.log(`  汇总：启用块 ${active.length}/${blocks.length} · 启用正文 ${activeChars} 字符（占预算 ${pct(activeChars, budget)}%）`);
console.log(`        top3 占启用正文 ${pct(topThree, activeChars)}% · 停用块正文 ${allChars - activeChars} 字符`);
const off = blocks.filter((b) => b.state === 'off').length;
const unknown = blocks.filter((b) => b.state === 'n/a').length;
console.log(`        启用态标注：on ${active.length - unknown} · off ${off} · **未标注 ${unknown}**（未标注块按启用计入）`);
if (unnamed > 0) console.log(`        ⚠ ${unnamed} 个启用块没有 ST 名（标签取自正文开头）——块名缺失会让定位变慢`);
