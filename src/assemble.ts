/**
 * The assembler — **pure** core of the tavern (criteria A1/A2/A7).
 *
 * 设计：**装配条目与最终消息 1:1**。
 *   `messages = manifest.entries.map(e => ({ role: e.role, text: e.text }))`
 * 因此「装配单即事实」可以逐字节复核，且没有隐式合并逻辑可漂移。
 * 片段的来源、命中关键词、优先级全部记录在 `entry.parts`，供研究层做字节账。
 */
import { hashEntries, hashMessages, canonicalJson, sha256 } from './hash.ts';
import { matchLorebook } from './lorebook.ts';
import type {
  AssembleInput, AssembleResult, ChatMessage, Manifest, ManifestEntry, ManifestPart,
  PresetBlock, Slot, TemplateScope,
} from './types.ts';

/** Slots that live inside the single leading system message. */
const SYSTEM_SLOTS: Slot[] = ['system', 'persona_prefix', 'before_history', 'persona_suffix'];

const SLOT_RANK: Record<string, number> = {
  system: 0, persona_prefix: 1, before_history: 2, persona_suffix: 3,
};

/** Render `{{key}}` placeholders; unknown keys are left verbatim (no silent blanks). */
export function renderTemplate(text: string, scope: TemplateScope): string {
  return text.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(scope, key) ? (scope[key] as string) : whole,
  );
}

function part(id: string, slot: Slot, source: string, priority: number, text: string, triggerHit?: string): ManifestPart {
  const base = { id, slot, source, priority, text, sha256: sha256(text) };
  return triggerHit === undefined ? base : { ...base, triggerHit };
}

function entryFrom(e: Omit<ManifestEntry, 'bytes' | 'sha256'>): ManifestEntry {
  return { ...e, bytes: Buffer.byteLength(e.text, 'utf8'), sha256: sha256(e.text) };
}

/** Deterministic ordering inside the system message. */
function compareParts(a: ManifestPart, b: ManifestPart): number {
  const ra = SLOT_RANK[a.slot] ?? 9;
  const rb = SLOT_RANK[b.slot] ?? 9;
  if (ra !== rb) return ra - rb;
  if (a.priority !== b.priority) return b.priority - a.priority;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Assemble one model request. Pure: no IO, no clock, no RNG. */
export function assemble(input: AssembleInput): AssembleResult {
  const { preset, card, lorebook, history, state, turnInput, turn, script } = input;
  const stateText = canonicalJson(state);
  const scope: TemplateScope = {
    'card.name': card.name,
    'card.persona': card.persona,
    'card.scenario': card.scenario,
    input: turnInput,
    state: stateText,
    script: script ? script.segment : '',
    turn: String(turn),
  };

  const parts: ManifestPart[] = [];

  // 1) preset blocks (declared order; unknown placeholders stay visible)
  for (const block of preset.blocks as PresetBlock[]) {
    if (block.enabled === false) continue;
    parts.push(part(`preset:${block.id}`, block.slot, `preset:${block.id}`, block.priority, renderTemplate(block.text, scope)));
  }

  // 2) card definition / persona / system override as first-class system fragments
  //
  // ⚠ `description` 必须进上下文：在 ST 里它是**主定义**（人设/世界观），`personality`
  // 只是摘要字段。2026-09-22 实测：只注入 persona 时，一张 description=2844 字的卡
  // 装配出来只有 1146 字——主定义整段丢失。
  if (card.description.length > 0) parts.push(part('card:description', 'system', 'card:description', 99, card.description));
  if (card.persona.length > 0) parts.push(part('card:persona', 'persona_prefix', 'card', 100, card.persona));
  if (card.systemPrompt.length > 0) parts.push(part('card:sysprompt', 'system', 'card:system_prompt', 98, card.systemPrompt));
  if (card.scenario.length > 0) parts.push(part('card:scenario', 'system', 'card', 90, card.scenario));
  // 对话样例只作文风参考，且必须在文本里说清楚它不是当前剧情（否则会被当成已发生的事）
  if (card.exampleDialogue.length > 0) {
    parts.push(part(
      'card:example', 'system', 'card:example', 45,
      `【对话样例（仅供文风与语气参考，**不是**当前剧情的一部分）】\n${card.exampleDialogue}`,
    ));
  }

  // 3) live state — the model must see exactly what the settlement agent wrote
  parts.push(part('state', 'system', 'state', 80, stateText));

  // 4) script segment (optional main-line anchor)
  if (script && script.segment.length > 0) parts.push(part('script', 'system', 'script', 70, script.segment));

  // 5) lorebook hits — card-owned book first (its entries keep their own ids), then the session's
  const allLore = [...card.lorebook, ...lorebook];
  const hits = matchLorebook(allLore, { history, turnInput, turn });
  for (const hit of hits) {
    parts.push(part(`lore:${hit.entry.id}`, hit.slot, `lorebook:${hit.entry.id}`, hit.priority, hit.entry.content, hit.triggerHit));
  }

  // 6) card-level post-history instructions (ST semantics: after the transcript, before the reply)
  if (card.postHistoryInstructions.length > 0) {
    parts.push(part('card:posthist', 'after_history', 'card:post_history_instructions', 50, card.postHistoryInstructions));
  }

  // ── budget trim (deterministic: lorebook first, lowest priority first) ──
  const dropped: string[] = [];
  let systemParts = parts.filter((p) => SYSTEM_SLOTS.includes(p.slot)).sort(compareParts);
  const depthParts = parts.filter((p) => p.slot.startsWith('depth-'));
  const afterParts = parts.filter((p) => p.slot === 'after_history');

  const historyChars = history.reduce((n, m) => n + m.text.length, 0) + turnInput.length;
  const budget = preset.budgetChars ?? Number.POSITIVE_INFINITY;
  const trimOrder = [...systemParts]
    .filter((p) => p.source.startsWith('lorebook:'))
    .sort((a, b) => (a.priority - b.priority) || (a.id < b.id ? -1 : 1));
  for (const candidate of trimOrder) {
    const total = systemParts.reduce((n, p) => n + p.text.length, 0)
      + depthParts.reduce((n, p) => n + p.text.length, 0)
      + afterParts.reduce((n, p) => n + p.text.length, 0) + historyChars;
    if (total <= budget) break;
    systemParts = systemParts.filter((p) => p !== candidate);
    dropped.push(candidate.id);
  }

  // ── emit entries (order == message order) ──
  const entries: ManifestEntry[] = [];
  if (systemParts.length > 0) {
    entries.push(entryFrom({
      id: 'sys', slot: 'system', role: 'system', source: 'system',
      priority: 0, text: systemParts.map((p) => p.text).join('\n\n'), parts: systemParts,
    }));
  }

  history.forEach((message, index) => {
    entries.push(entryFrom({
      id: `hist:${index}`, slot: 'before_history', role: message.role, source: `history:${index}`,
      priority: 0, text: message.text, parts: [],
    }));
  });
  const historyStart = entries.length - history.length;

  // depth-N: ST 约定——把即将发出的用户输入当作 depth 0，故 depth-1 紧贴它上方；
  // depth-2 再上一条。最深的先插，索引才不会被后续插入推移。
  const depthSorted = depthParts
    .slice()
    .sort((a, b) => Number(b.slot.slice(6)) - Number(a.slot.slice(6)) || (a.id < b.id ? -1 : 1));
  for (const p of depthSorted) {
    const n = Math.max(1, Number(p.slot.slice(6)));
    const at = Math.min(
      historyStart + history.length,
      Math.max(historyStart, historyStart + history.length - n + 1),
    );
    entries.splice(at, 0, entryFrom({
      id: `depth:${p.id}`, slot: p.slot, role: 'system', source: p.source,
      priority: p.priority, text: p.text, parts: [p],
    }));
  }

  for (const p of afterParts.sort(compareParts)) {
    entries.push(entryFrom({
      id: `after:${p.id}`, slot: 'after_history', role: 'system', source: p.source,
      priority: p.priority, text: p.text, parts: [p],
    }));
  }
  entries.push(entryFrom({
    id: 'input', slot: 'after_history', role: 'user', source: 'input',
    priority: 0, text: turnInput, parts: [],
  }));

  const totalChars = entries.reduce((n, e) => n + e.text.length, 0);
  const manifest: Manifest = {
    version: 1,
    turn,
    entries,
    dropped,
    totalChars,
    /** 裁剪到无可裁仍超预算时置真——响亮记账，不静默截断。 */
    overBudget: preset.budgetChars !== undefined && totalChars > preset.budgetChars,
    hash: hashEntries(entries),
  };
  return { manifest, messages: messagesFromManifest(manifest) };
}

/** Rebuild the request body from a manifest. This is the A1 reconstruction. */
export function messagesFromManifest(manifest: Manifest): ChatMessage[] {
  return manifest.entries.map((e) => ({ role: e.role, text: e.text }));
}

export interface VerifyResult {
  ok: boolean;
  manifestHash: string;
  rebuiltHash: string;
  actualHash: string;
  /** Non-empty when the actual request diverged from the manifest. */
  differences: string[];
}

/**
 * Criterion A1: the request actually sent must equal the request rebuilt from
 * the manifest, byte for byte. Reports *where* it diverged, not just that it did.
 */
export function verifyAgainstActual(
  manifest: Manifest,
  actual: { role: string; text: string }[],
): VerifyResult {
  const rebuilt = messagesFromManifest(manifest);
  const rebuiltHash = hashMessages(rebuilt);
  const actualHash = hashMessages(actual);
  const differences: string[] = [];
  const max = Math.max(rebuilt.length, actual.length);
  for (let i = 0; i < max; i += 1) {
    const a = rebuilt[i];
    const b = actual[i];
    if (a === undefined) { differences.push(`#${i} 装配单缺失，实际多出 role=${b?.role}`); continue; }
    if (b === undefined) { differences.push(`#${i} 实际缺失，装配单多出 role=${a.role}`); continue; }
    if (a.role !== b.role) differences.push(`#${i} role 不一致：装配单=${a.role} 实际=${b.role}`);
    if (a.text !== b.text) {
      differences.push(`#${i} 正文不一致：装配单 ${a.text.length} 字 vs 实际 ${b.text.length} 字（首个差异字符 @${firstDiff(a.text, b.text)}）`);
    }
  }
  return { ok: differences.length === 0, manifestHash: manifest.hash, rebuiltHash, actualHash, differences };
}

function firstDiff(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i;
  return n;
}
