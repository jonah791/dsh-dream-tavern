#!/usr/bin/env node
/**
 * 质量判据的**真实数据扫描器**（可选用**真实预设**）—— 「可度量的搜索循环」的执行装置。
 *
 * 它**不调模型**：只跑装配 + 结构质量判据 ⇒ 可廉价反复跑（搜索循环要能承担几百次迭代）。
 *
 * ⚠ 读数范围标注（§5.9 规则 6）——本扫描的结论**只覆盖以下域**：
 *   · 输入：固定探针 +（可选）该卡第一条非 constant 世界书的关键词、turn=1、空历史、空状态
 *   · 世界书：只并入**卡内**世界书；会话世界书为空
 *   · 预设：`--preset <file>` 给的（ST 格式自动桥接）或内建 default
 *   ⇒ **只测结构质量，不测模型表现**。
 *
 * 跑法：
 *   node scripts/quality-sweep.mjs                                   # 内建 default
 *   node scripts/quality-sweep.mjs --preset "E:/alice/tavern/色欲之罪预设/色欲之罪V3.1.json"
 *   node scripts/quality-sweep.mjs --preset <f> --budget 40000
 * 退出码：0 = 全干净；1 = 有卡未过；2 = 卡库不可达；3 = **预设加载失败（仪器/配置问题，非判据失败）**。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCardFile } from '../lib/card.js';
import { assemble } from '../lib/assemble.js';
import { judgeAssembly } from '../lib/quality.js';
import { defaultPreset } from '../lib/preset.js';
import { parsePresetFile } from '../lib/preset-file.js';
import { bridgeStPreset } from '../lib/st-preset.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const DEFAULT_CARDS = 'C:/Users/tr/AppData/Roaming/com.tauritavern.client/data/default-user/characters';
const PROBE_INPUT = '你好。';
const DEFAULT_BUDGET = 40000;

/**
 * 「哪个块是输出规范」是**内容层判断**，由调用方指名（`--norm a,b`）。
 *
 * ⚠ 2026-09-22 实测教训：首版把内建 default 的块 id `role` **写死**，一换到真实预设
 * （`色欲之罪V3.1`，51 个块的 id 全是 UUID）就整片误红——「规范块 role 不在预设里」。
 * ⇒ 现在：用内建 default 时缺省 `role`；**载入外部预设时缺省为空（不适用）**，
 * 需要人显式指名。**空 ≠ 通过被伪造**：`judgeAssembly` 对空名单会如实回「本判据不适用」。
 */
function normIdsFor(presetArg) {
  const explicit = argValue('--norm');
  if (explicit !== undefined) return explicit.split(',').map((s) => s.trim()).filter((s) => s !== '');
  return presetArg === undefined ? ['role'] : [];
}

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

const cardsDir = nativePath(process.env.DREAM_TAVERN_CARDS ?? DEFAULT_CARDS);
const budget = Number(argValue('--budget') ?? DEFAULT_BUDGET);
const presetArg = argValue('--preset');
const normIds = normIdsFor(presetArg);

/** 载入一个预设：ST 格式自动桥接；本插件格式直接解析。失败 ⇒ 退出码 3（**仪器问题，不是判据失败**）。 */
function loadPreset(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    console.error(`裁决：ERROR —— 预设读不到或不是 JSON（${path}）：${e instanceof Error ? e.message : String(e)}`);
    process.exit(3);
  }
  const isSt = raw !== null && typeof raw === 'object' && Array.isArray(raw.prompts);
  if (isSt) {
    const r = bridgeStPreset(raw, { budgetChars: budget });
    if (r.preset === undefined) {
      console.error(`裁决：ERROR —— ST 预设桥接失败：${r.errors.join('；')}`);
      process.exit(3);
    }
    return { preset: r.preset, kind: 'st', bridge: r };
  }
  const r = parsePresetFile(raw, budget);
  if (r.preset === undefined) {
    console.error(`裁决：ERROR —— 预设解析失败：${r.errors.join('；')}`);
    process.exit(3);
  }
  return { preset: r.preset, kind: 'plugin', bridge: null };
}

console.log('═'.repeat(72));
console.log('梦境酒馆 · 质量判据真实数据扫描（不调模型）');
console.log('═'.repeat(72));
console.log(`  卡库 ${cardsDir}`);
console.log(`  预算 budgetChars=${budget} · 规范块 ${(normIds.join('/') || '(未指名 ⇒ 本判据不适用)')}`);
console.log(`  探针 "${PROBE_INPUT}"（按卡自适应补关键词） · turn=1 · 空历史 · 空状态 · 仅卡内世界书`);

let real = null;
if (presetArg !== undefined) {
  real = loadPreset(nativePath(presetArg));
  console.log(`\n  预设 --preset ${presetArg}`);
  console.log(`  桥接类型 ${real.kind} · blocks=${real.preset.blocks.length} · name=${real.preset.name}`);
  if (real.bridge !== null) {
    const b = real.bridge;
    console.log(`  对账：ST prompts ${b.stats.prompts} 条（marker ${b.stats.markers} · enabled ${b.stats.enabledInPrompts}）`
      + ` · 顺序取自 ${b.stats.orderSource} · 顺序表关掉 ${b.stats.disabledByOrder} 条 ⇒ 映射出 ${b.stats.blocks} 个 block`);
    console.log(`  映射了什么（${b.mapped.length} 条）：`);
    for (const m of b.mapped) console.log(`    ${m.from} → ${m.to}`);
    console.log(`  未建模（${b.unmodeled.length} 条，**逐条带理由，不静默丢**）——前 8 条：`);
    for (const u of b.unmodeled.slice(0, 8)) console.log(`    ${u.field} :: ${u.reason}`);
    if (b.unmodeled.length > 8) console.log(`    …另有 ${b.unmodeled.length - 8} 条（完整清单见 --json 时的 bridge.unmodeled）`);
  }
}

function probeInputFor(card) {
  const entry = card.lorebook.find((e) => e.constant !== true && typeof e.keywords === 'string' && e.keywords.trim() !== '');
  if (entry === undefined) return PROBE_INPUT;
  const first = (entry.keywords.split(',')[0] ?? '').trim();
  return first === '' ? PROBE_INPUT : `${PROBE_INPUT}${first}`;
}

/** 用给定预设跑一整轮卡库，返回聚合读数。 */
function sweep(label, preset) {
  let pngs;
  try {
    pngs = readdirSync(cardsDir).filter((f) => f.toLowerCase().endsWith('.png'));
  } catch {
    console.log('\n  ⚠ 卡库不可达 ⇒ 本扫描**不适用**（退出码 2，不假装通过）');
    process.exit(2);
  }
  const agg = {
    label, total: pngs.length, ok: 0, failed: 0, notices: 0,
    chars: [], dropped: 0, trimmedCards: 0, slots: new Set(), blocks: preset.blocks.length,
    fails: [],
  };
  for (const file of pngs) {
    try {
      const { card } = readCardFile(join(cardsDir, file));
      const { manifest } = assemble({
        preset, card, lorebook: [...card.lorebook],
        history: [], state: {}, turnInput: probeInputFor(card), turn: 1,
      });
      const report = judgeAssembly({ manifest, preset, normBlockIds: normIds });
      for (const e of manifest.entries) agg.slots.add(e.slot);
      if (manifest.dropped.length > 0) agg.trimmedCards += 1;
      agg.dropped += manifest.dropped.length;
      agg.chars.push(manifest.totalChars);
      if (report.notices.length > 0) agg.notices += 1;
      const reds = report.verdicts.filter((v) => !v.ok);
      if (reds.length === 0) agg.ok += 1;
      else { agg.failed += 1; agg.fails.push(`${file}: ${reds.map((v) => `${v.id}(${v.detail})`).join(' | ')}`); }
    } catch (e) {
      agg.failed += 1;
      agg.fails.push(`${file}: 装配抛错 ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const n = agg.chars.length || 1;
  agg.min = Math.min(...agg.chars);
  agg.max = Math.max(...agg.chars);
  agg.avg = Math.round(agg.chars.reduce((a, b) => a + b, 0) / n);
  agg.sum = agg.chars.reduce((a, b) => a + b, 0);
  return agg;
}

const runs = [];
if (real === null) {
  runs.push(sweep('default', defaultPreset(budget)));
} else {
  runs.push(sweep('default', defaultPreset(budget)));
  runs.push(sweep('--preset', real.preset));
}

console.log('\n' + '─'.repeat(72));
console.log('对照表' + (runs.length === 1 ? '（仅内建 default）' : '（内建 default vs 真实预设）'));
console.log(`  ${'预设'.padEnd(12)} ${'blocks'.padStart(7)} ${'min'.padStart(7)} ${'avg'.padStart(7)} ${'max'.padStart(7)} ${'合计'.padStart(9)} ${'通过'.padStart(9)} ${'裁剪卡'.padStart(7)} ${'裁掉条'.padStart(7)}`);
for (const r of runs) {
  console.log(`  ${r.label.padEnd(12)} ${String(r.blocks).padStart(7)} ${String(r.min).padStart(7)} ${String(r.avg).padStart(7)} ${String(r.max).padStart(7)} ${String(r.sum).padStart(9)} ${`${r.ok}/${r.total}`.padStart(9)} ${String(r.trimmedCards).padStart(7)} ${String(r.dropped).padStart(7)}`);
}
for (const r of runs) {
  console.log(`\n  [${r.label}] 槽位分布：${[...r.slots].sort().join(' / ') || '(无)'} · 跨来源重复提示 ${r.notices} 张`);
  for (const f of r.fails.slice(0, 5)) console.log(`    ✖ ${f}`);
  if (r.fails.length > 5) console.log(`    …另有 ${r.fails.length - 5} 条`);
}

const anyFail = runs.some((r) => r.failed > 0);
console.log('\n' + '═'.repeat(72));
console.log(anyFail
  ? `裁决：FAIL —— ${runs.map((r) => `${r.label} ${r.failed} 张未过`).join(' · ')}`
  : `裁决：PASS —— ${runs.map((r) => `${r.label} ${r.ok}/${r.total}`).join(' · ')}`);
console.log('═'.repeat(72));
process.exit(anyFail ? 1 : 0);
