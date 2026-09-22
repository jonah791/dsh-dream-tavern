/**
 * SillyTavern world book import — 迁移层（只读主人的库，绝不写回）。
 *
 * ST 世界书形状：`{ entries: { <uid>: {...43 字段...} }, originalData }`
 * 本层只解释装配需要的字段，**原始条目整条保留**在 `raw` 里，供往返与审计。
 * 未识别的字段一律不丢（`unknownKeys` 如实报出）——迁移工作的判据就是「不丢」。
 */
import type { LorebookEntry, Slot } from './types.ts';

/** A raw ST world-info entry; keys are the upstream's, values untyped by design. */
export type StWorldEntry = Record<string, unknown>;

export interface StWorldbook {
  entries?: Record<string, StWorldEntry> | StWorldEntry[];
  originalData?: unknown;
  [key: string]: unknown;
}

export interface ImportResult {
  entries: LorebookEntry[];
  /** uid -> the untouched upstream entry, so nothing is lost by importing. */
  raw: Record<string, StWorldEntry>;
  /** Fields we knowingly do not model, with the reason — an explicit boundary. */
  unmodeled: Record<string, string>;
  /** Fields that are neither interpreted nor declared — these are the suspicious ones. */
  unknownKeys: string[];
  /** Entries skipped entirely, with the reason. */
  skipped: Array<{ uid: string; reason: string }>;
}

/** Fields this layer interprets; anything else must be declared below or it counts as unknown. */
const INTERPRETED = new Set([
  'uid', 'key', 'keysecondary', 'content', 'comment', 'constant', 'disable',
  'position', 'depth', 'order', 'probability', 'useProbability', 'scanDepth',
  'selective', 'selectiveLogic', 'caseSensitive', 'matchWholeWords', 'role',
  'group', 'groupWeight', 'displayIndex', 'vectorized', 'extensions',
]);

/**
 * 已知但**不建模**的字段，逐个给出理由。
 *
 * 迁移工作的诚实边界：这些是 ST 的完整语义（递归控制、冷却/延迟、按角色字段匹配、
 * 宏出口、分组评分），要忠实实现需要跨轮计时器与角色上下文，本层故意不假装支持。
 * 它们**原样保留在 `raw` 里**，不会丢；重要的是「不知道」与「知道但不做」必须可区分。
 */
const KNOWN_UNMODELED: Record<string, string> = {
  addMemo: 'ST 编辑器的备注，不参与装配',
  automationId: 'ST 自动化扩展的挂载点',
  characterFilter: '按角色过滤：需要角色卡片上下文，本层未建模',
  cooldown: '触发冷却：需要跨轮计时器，本层未建模',
  delay: '延迟触发：需要跨轮计时器，本层未建模',
  delayUntilRecursion: '递归延迟',
  excludeRecursion: '递归排除',
  preventRecursion: '禁止递归',
  groupOverride: '分组覆盖',
  groupWeight: '分组权重',
  ignoreBudget: '预算豁免（本层一律参与预算，故不支持）',
  matchCharacterDepthPrompt: '按角色深度提示匹配',
  matchCharacterDescription: '按角色描述匹配',
  matchCharacterPersonality: '按角色性格匹配',
  matchCreatorNotes: '按作者注释匹配',
  matchPersonaDescription: '按玩家人设匹配',
  matchScenario: '按场景匹配',
  outletName: '宏出口名（ST 宏系统）',
  sticky: '粘性触发：需要跨轮计时器，本层未建模',
  triggers: 'ST 扩展触发列表',
  useGroupScoring: '分组评分',
};

/**
 * ST `position` → our slot.
 * ST encodes: 0 = before char, 1 = after char, 2/3 = top/bottom of the author's
 * note, 4 = at `depth` messages from the end, and newer builds use strings
 * (`before_char` / `after_char` / `at_depth`). Both encodings are accepted here.
 */
export function positionToSlot(position: unknown, depth: unknown): Slot {
  const asString = typeof position === 'string' ? position.trim().toLowerCase() : '';
  if (asString === 'after_char' || asString === 'after') return 'after_history';
  if (asString === 'at_depth' || asString === 'depth') return depthSlot(depth);
  if (asString === 'before_char' || asString === 'before') return 'before_history';

  const n = typeof position === 'number' ? position : Number(position);
  if (!Number.isFinite(n)) return 'before_history';
  if (n === 1) return 'after_history';
  if (n === 4) return depthSlot(depth);
  return 'before_history';
}

function depthSlot(depth: unknown): Slot {
  const n = typeof depth === 'number' ? depth : Number(depth);
  if (!Number.isFinite(n) || n < 1) return 'depth-1';
  return `depth-${Math.floor(n)}` as Slot;
}

/** ST `key` may be an array or a comma-separated string. */
export function normalizeKeys(key: unknown): string[] {
  if (Array.isArray(key)) return key.filter((k): k is string => typeof k === 'string');
  if (typeof key === 'string') return key.split(',').map((k) => k.trim()).filter(Boolean);
  return [];
}

function truthy(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  return false;
}

/** Import one ST world book into our model. Pure: no IO, no clock. */
export function importWorldbook(book: StWorldbook): ImportResult {
  const rawSource = book.entries ?? {};
  const pairs: Array<[string, StWorldEntry]> = Array.isArray(rawSource)
    ? rawSource.map((e, i) => [String(e['uid'] ?? e['id'] ?? i), e])
    : Object.entries(rawSource);

  const entries: LorebookEntry[] = [];
  const raw: Record<string, StWorldEntry> = {};
  const unmodeled = new Set<string>();
  const unknown = new Set<string>();
  const skipped: Array<{ uid: string; reason: string }> = [];

  for (const [fallbackUid, entry] of pairs) {
    const uid = String(entry['uid'] ?? entry['id'] ?? fallbackUid);
    raw[uid] = entry;
    for (const key of Object.keys(entry)) {
      if (INTERPRETED.has(key)) continue;
      if (Object.prototype.hasOwnProperty.call(KNOWN_UNMODELED, key)) unmodeled.add(key);
      else unknown.add(key);
    }

    const content = typeof entry['content'] === 'string' ? entry['content'] : '';
    if (content.length === 0) {
      skipped.push({ uid, reason: 'content 为空' });
      continue;
    }
    const constant = truthy(entry['constant']);
    // ⚠ 2026-09-22 真卡库实测：**卡内**世界书（`character_book.entries[]`）与独立世界书文件
    // 用的是**两套词汇**：卡内是 `keys`（复数）/`insertion_order`/`id`/`enabled`，
    // 独立文件是 `key`/`order`/`uid`/`disable`。原实现只认后者 ⇒ 主人 57 张卡的卡内世界书里
    // **除 constant 外的条目全被当作「永远无法命中」丢弃**（1223 条，关键词非空 0 条）。
    const keys = normalizeKeys(entry['key'] ?? entry['keys']);
    if (!constant && keys.length === 0) {
      skipped.push({ uid, reason: '既非 constant 也没有关键词（永远无法命中）' });
      continue;
    }

    const useProbability = entry['useProbability'] === undefined ? true : truthy(entry['useProbability']);
    const probabilityRaw = Number(entry['probability']);
    const probability = useProbability && Number.isFinite(probabilityRaw)
      ? Math.min(1, Math.max(0, probabilityRaw))
      : undefined;

    entries.push({
      id: uid,
      keywords: keys.join(','),
      ...(constant ? { constant: true } : {}),
      position: positionToSlot(entry['position'], entry['depth']),
      order: Number.isFinite(Number(entry['order'] ?? entry['insertion_order']))
        ? Number(entry['order'] ?? entry['insertion_order'])
        : 0,
      ...(probability === undefined ? {} : { probability }),
      content,
      // 卡内用 `enabled`（正），独立文件用 `disable`（反）——语义相反，认错会静默反掉开关。
      enabled: entry['enabled'] === undefined ? !truthy(entry['disable']) : truthy(entry['enabled']),
    });
  }

  return { entries, raw, unmodeled: KNOWN_UNMODELED_OF(unmodeled), unknownKeys: [...unknown].sort(), skipped };
}

/** Collect only the reasons for the fields actually seen. */
function KNOWN_UNMODELED_OF(seen: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of [...seen].sort()) out[key] = KNOWN_UNMODELED[key] ?? '';
  return out;
}

/** Human-readable import summary（操作面文案，中文）. */
export function describeImport(result: ImportResult): string {
  const enabled = result.entries.filter((e) => e.enabled !== false).length;
  const consts = result.entries.filter((e) => e.constant === true).length;
  const slots = new Map<string, number>();
  for (const e of result.entries) slots.set(e.position ?? 'before_history', (slots.get(e.position ?? 'before_history') ?? 0) + 1);
  const slotText = [...slots.entries()].sort().map(([k, v]) => `${k}=${v}`).join(' ');
  return [
    `导入 ${result.entries.length} 条（启用 ${enabled} · 常驻 ${consts}）`,
    `槽位分布：${slotText}`,
    result.skipped.length > 0 ? `跳过 ${result.skipped.length} 条：${result.skipped.slice(0, 3).map((s) => `${s.uid}(${s.reason})`).join('、')}${result.skipped.length > 3 ? ' …' : ''}` : '无跳过条目',
    `已知未建模字段 ${Object.keys(result.unmodeled).length} 种（原样留档，不假装支持）：${Object.keys(result.unmodeled).slice(0, 8).join(',')}${Object.keys(result.unmodeled).length > 8 ? ' …' : ''}`,
    result.unknownKeys.length > 0 ? `⚠ 未知字段（既未解释也未登记）：${result.unknownKeys.join(',')}` : '无未知字段',
  ].join('\n');
}
