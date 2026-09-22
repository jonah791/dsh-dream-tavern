/**
 * 预设文件加载 —— 让「迭代预设」这件事**在代码上真的可能**。
 *
 * 事故（2026-09-22 发现）：`index.ts` 里预设是 `defaultPreset(config.budgetChars)` **写死**的，
 * 而同一文件有一条注释写着「replaced by dataDir config once edited there」——
 * **那句话在代码里没有任何对应实现**（`index.ts` 连 `readFileSync` 都没引入）。
 * 于是「把预设放进 dataDir 就能改」是一条**读起来像事实的假话**；更严重的是本插件
 * 被指定的第一个目的（**迭代预设**）在代码上**根本不可达**。
 *
 * 设计（对齐本仓既有模式）：**不猜默认，响亮失败**。
 * - 未配置 `presetPath` ⇒ 用内建默认（原行为，零风险）。
 * - 配了但读不到/解析不过 ⇒ 报错并**拒绝出轮**（与「未配置 provider/model ⇒ 第一轮响亮失败」同族），
 *   绝不静默退回默认——那会让研究结论张冠李戴。
 *
 * ⚠ 本模块的解析部分是**纯函数**（可离线测）；IO 只在 `loadPresetFile` 里，且**不抛**。
 */
import { readFileSync } from 'node:fs';
import type { Preset, PresetBlock, Slot } from './types.ts';
import { MARKER_NAMES, type MarkerName } from './types.ts';
import { bridgeStPreset, type StBridgeResult } from './st-preset.ts';

export interface PresetParseResult {
  preset?: Preset;
  errors: string[];
  /** 当文件是 ST 预设时，附带桥接对账表（供调用方把「未建模项」如实呈现，而不是静默丢）。 */
  bridge?: StBridgeResult;
}

/** ST 预设的判据：有 `prompts` 数组。本插件格式用 `blocks`。 */
function looksLikeStPreset(raw: unknown): boolean {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    && Array.isArray((raw as Record<string, unknown>)['prompts']);
}

const FIXED_SLOTS = new Set(['system', 'persona_prefix', 'persona_suffix', 'before_history', 'after_history']);

function isSlot(v: unknown): v is Slot {
  if (typeof v !== 'string') return false;
  if (FIXED_SLOTS.has(v)) return true;
  return /^depth-[1-9]\d*$/.test(v);
}

/**
 * 解析一份预设 JSON。**纯函数、不抛**：把所有问题收进 `errors`，只有零错误才给出 `preset`。
 *
 * @param fallbackBudget 文件没写 `budgetChars` 时用它（调用方传配置里的预算）
 */
export function parsePresetFile(raw: unknown, fallbackBudget: number): PresetParseResult {
  const errors: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { errors: ['顶层必须是对象'] };
  }
  // 容忍 `{ "preset": {...} }` 这种包装（外部工具导出常见），但不猜更深的层级。
  const obj = raw as Record<string, unknown>;
  const body = (obj['preset'] !== null && typeof obj['preset'] === 'object' && !Array.isArray(obj['preset']))
    ? (obj['preset'] as Record<string, unknown>)
    : obj;

  const id = typeof body['id'] === 'string' && body['id'].length > 0 ? body['id'] : 'file-preset';
  const name = typeof body['name'] === 'string' ? body['name'] : id;
  const budgetRaw = body['budgetChars'];
  const budgetChars = typeof budgetRaw === 'number' && Number.isFinite(budgetRaw) && budgetRaw > 0
    ? budgetRaw
    : fallbackBudget;
  if (budgetRaw !== undefined && budgetChars !== budgetRaw) {
    errors.push(`budgetChars 非法（${JSON.stringify(budgetRaw)}）——须为正数`);
  }

  const blocksRaw = body['blocks'];
  if (!Array.isArray(blocksRaw)) return { errors: [...errors, 'blocks 必须是数组'] };
  if (blocksRaw.length === 0) errors.push('blocks 为空（空预设会装配出没有任何规范的请求）');

  const blocks: PresetBlock[] = [];
  const seen = new Set<string>();
  blocksRaw.forEach((b, i) => {
    const at = `blocks[${i}]`;
    if (b === null || typeof b !== 'object' || Array.isArray(b)) { errors.push(`${at} 不是对象`); return; }
    const o = b as Record<string, unknown>;
    const bid = o['id'];
    if (typeof bid !== 'string' || bid.length === 0) { errors.push(`${at}.id 必须是非空字符串`); return; }
    if (seen.has(bid)) { errors.push(`${at}.id 重复（${bid}）——id 必须唯一（它同时是装配单里的标识）`); return; }
    seen.add(bid);
    if (!isSlot(o['slot'])) {
      errors.push(`${at}.slot 非法（${JSON.stringify(o['slot'])}）——须为 system/persona_prefix/persona_suffix/before_history/after_history 或 depth-N（N≥1）`);
      return;
    }
    if (typeof o['priority'] !== 'number' || !Number.isFinite(o['priority'])) {
      errors.push(`${at}.priority 必须是数字`);
      return;
    }
    if (typeof o['text'] !== 'string') { errors.push(`${at}.text 必须是字符串`); return; }
    if (o['enabled'] !== undefined && typeof o['enabled'] !== 'boolean') {
      errors.push(`${at}.enabled 必须是布尔`);
      return;
    }
    // marker 必须落在已知集合里——**载入期校验**（不是每轮静默忽略）：写错名字的落位声明
    // 会静默失效，那是「撒谎的配置」（本仓反复踩过的那类缺陷）。
    if (o['marker'] !== undefined && !MARKER_NAMES.includes(o['marker'] as MarkerName)) {
      errors.push(`${at}.marker 非法（${JSON.stringify(o['marker'])}）—— 已知：${MARKER_NAMES.join(' / ')}`);
      return;
    }
    blocks.push({
      id: bid,
      slot: o['slot'],
      priority: o['priority'],
      text: o['text'],
      ...(o['enabled'] === undefined ? {} : { enabled: o['enabled'] as boolean }),
      ...(o['marker'] === undefined ? {} : { marker: o['marker'] as MarkerName }),
    });
  });

  if (errors.length > 0) return { errors };
  return { preset: { id, name, blocks, budgetChars }, errors: [] };
}

/** 读并解析一份预设文件。**不抛**：失败以 `errors` 返回。 */
export function loadPresetFile(path: string, fallbackBudget: number): PresetParseResult {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return { errors: [`读不到文件：${e instanceof Error ? e.message : String(e)}`] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { errors: [`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`] };
  }
  // ST 预设（主人的正本格式）⇒ 走桥接；桥接的**未建模清单**随之返回，由调用方负责呈现。
  if (looksLikeStPreset(raw)) {
    const b = bridgeStPreset(raw, { budgetChars: fallbackBudget });
    return b.preset === undefined ? { errors: b.errors, bridge: b } : { preset: b.preset, errors: [], bridge: b };
  }
  return parsePresetFile(raw, fallbackBudget);
}
