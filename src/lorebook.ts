/**
 * Lorebook keyword matching — **pure** module (criterion A6).
 *
 * 纯函数：同输入必得同输出，不做 IO、不看时钟、不用真随机
 * （`probability` 走内容+轮次派生的确定性哈希，见 hash.deterministicUnit）。
 */
import { deterministicUnit } from './hash.ts';
import type { ChatMessage, LorebookEntry, Slot } from './types.ts';

export interface LorebookHit {
  entry: LorebookEntry;
  /** The matched keyword; undefined for `constant` entries. */
  triggerHit?: string;
  slot: Slot;
  priority: number;
}

export interface MatchContext {
  history: ChatMessage[];
  turnInput: string;
  turn: number;
  /** How many trailing history messages are scanned for keywords (default: all). */
  scanDepth?: number;
}

/** Split a keyword list; trims and drops empties. */
export function parseKeywords(raw: string): string[] {
  return raw
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0);
}

/**
 * Map a lorebook `position` to an assembly slot.
 * `depth-N` keeps N; `before`/`after` map to the history-adjacent slots.
 */
export function slotOf(entry: LorebookEntry): Slot {
  const position = (entry.position ?? 'before').trim();
  if (position === 'after') return 'after_history';
  const depth = /^depth-(\d+)$/.exec(position);
  if (depth) return `depth-${Number(depth[1])}` as Slot;
  return 'before_history';
}

/**
 * Semantic rank of a slot for ordering.
 *
 * ⚠ 2026-09-22 实测教训：首版直接比槽位**字符串**，于是 `after_history`
 * 因字母序排在 `before_history` **前面**——语义完全反了，是单测抓出来的。
 * 排序必须走**显式序**，不能靠字符串比较碰运气。
 */
export function slotRank(slot: Slot): number {
  if (slot === 'before_history') return 0;
  if (slot === 'after_history') return 1_000_000;
  const depth = /^depth-(\d+)$/.exec(slot);
  if (depth) return Number(depth[1]);
  return 500_000;
}

/** Ordering used everywhere: position bucket, then order desc, then id asc (stable). */
export function compareHits(a: LorebookHit, b: LorebookHit): number {
  const ra = slotRank(a.slot);
  const rb = slotRank(b.slot);
  if (ra !== rb) return ra - rb;
  if (a.priority !== b.priority) return b.priority - a.priority;
  return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
}

/**
 * Return the entries that fire for this context, sorted deterministically.
 *
 * Rules:
 * - `enabled === false` never fires.
 * - `constant: true` always fires, with no `triggerHit`.
 * - otherwise the entry fires when any keyword appears (case-insensitive
 *   substring) in the scanned window (trailing `scanDepth` history + turn input).
 * - `probability` (0..1) gates the hit via a deterministic unit value derived
 *   from `entry.id + turn`, so repeated runs on the same turn agree exactly.
 */
export function matchLorebook(entries: LorebookEntry[], ctx: MatchContext): LorebookHit[] {
  const depth = ctx.scanDepth ?? ctx.history.length;
  const window = ctx.history.slice(Math.max(0, ctx.history.length - depth));
  const haystack = (window.map((m) => m.text).join('\n') + '\n' + ctx.turnInput).toLowerCase();

  const hits: LorebookHit[] = [];
  for (const entry of entries) {
    if (entry.enabled === false) continue;
    const slot = slotOf(entry);
    const priority = entry.order ?? 0;

    let triggerHit: string | undefined;
    if (entry.constant === true) {
      triggerHit = undefined;
    } else {
      const keywords = parseKeywords(entry.keywords);
      if (keywords.length === 0) continue; // no keywords and not constant => never fires
      triggerHit = keywords.find((k) => haystack.includes(k));
      if (triggerHit === undefined) continue;
    }

    if (typeof entry.probability === 'number') {
      const unit = deterministicUnit(`${entry.id}:${ctx.turn}`);
      if (unit >= entry.probability) continue;
    }

    hits.push({ entry, triggerHit, slot, priority });
  }

  return hits.sort(compareHits);
}
