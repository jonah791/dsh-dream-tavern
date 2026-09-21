/**
 * Canonical hashing helpers.
 *
 * 不变量「装配单即事实」与「确定性」都建立在这两个函数上：
 * 同一个条目列表必须永远得到同一个 hash——所以规范化时**不含时间戳**，
 * 且键序固定。
 */
import { createHash } from 'node:crypto';
import type { ManifestEntry } from './types.ts';

/** SHA-256 hex of a UTF-8 string. */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Canonical JSON: keys sorted, no whitespace drift.
 * Values must be JSON-serialisable; functions/undefined are rejected loudly
 * rather than silently dropped (a silently dropped key would change the hash
 * without changing the request — exactly the class of bug we are guarding).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const item = obj[key];
      if (item === undefined) {
        throw new Error(`canonicalJson: 键 ${key} 的值为 undefined——拒绝静默丢弃（会改变 hash 而不改变请求）`);
      }
      parts.push(JSON.stringify(key) + ':' + canonicalJson(item));
    }
    return '{' + parts.join(',') + '}';
  }
  throw new Error(`canonicalJson: 不支持的值类型 ${typeof value}`);
}

/** Hash of the entry list, ignoring nothing that affects the request body. */
export function hashEntries(entries: ManifestEntry[]): string {
  return sha256(
    canonicalJson(
      entries.map((e) => ({
        id: e.id,
        slot: e.slot,
        role: e.role,
        source: e.source,
        priority: e.priority,
        text: e.text,
      })),
    ),
  );
}

/** Hash of the final message list — used by criterion A1 to compare rebuild vs actual. */
export function hashMessages(messages: { role: string; text: string }[]): string {
  return sha256(canonicalJson(messages.map((m) => ({ role: m.role, text: m.text }))));
}

/**
 * Deterministic pseudo-random in [0,1) derived from a seed string.
 * Used for lorebook `probability` so that a run is reproducible (criterion A2);
 * a real RNG would break determinism.
 */
export function deterministicUnit(seed: string): number {
  const digest = createHash('sha256').update(seed, 'utf8').digest();
  const first = digest[0] ?? 0;
  const second = digest[1] ?? 0;
  return ((first << 8) | second) / 65536;
}
