/**
 * Dream Tavern — shared types for the pure assembly layer.
 *
 * 契约面（英文 JSDoc）住本文件；面向主人的操作面文案（中文）住在各模块的
 * 报错/渲染函数里。见 AGENTS.md §5.30「读者决定形式」。
 *
 * 关键设计：**装配条目与最终消息 1:1**（`messages = entries.map(e => ({role, text}))`）
 * ——重建规则可证，不留隐式合并逻辑。片段的来源信息走 `parts`。
 */

/** Where a fragment is injected, relative to the conversation history. */
export type Slot =
  | 'system'
  | 'persona_prefix'
  | 'persona_suffix'
  | 'before_history'
  | `depth-${number}`
  | 'after_history';

export type Role = 'system' | 'user' | 'assistant';

/** Provenance of one fragment that contributed to an entry. */
export interface ManifestPart {
  id: string;
  slot: Slot;
  /** 'preset:<blockId>' | 'card' | 'lorebook:<id>' | 'script' | 'state' */
  source: string;
  /** Lorebook keyword that fired the fragment, when applicable. */
  triggerHit?: string;
  priority: number;
  text: string;
  sha256: string;
}

/** One emitted message, plus the fragments that produced it. */
export interface ManifestEntry {
  /** Stable id, unique within one manifest. */
  id: string;
  slot: Slot;
  role: Role;
  /** 'preset' | 'card' | 'lorebook:<id>' | 'history:<i>' | 'state' | 'script' | 'input' */
  source: string;
  priority: number;
  /** Exact payload sent to the model. */
  text: string;
  bytes: number;
  sha256: string;
  parts: ManifestPart[];
}

/** The assembly manifest: the authoritative description of one model request. */
export interface Manifest {
  version: 1;
  turn: number;
  entries: ManifestEntry[];
  /** Ids excluded by the budget trim (deterministic: lowest priority first). */
  dropped: string[];
  totalChars: number;
  /** True when trimming could not bring the request under the preset budget. */
  overBudget: boolean;
  /** Content hash of the entry list (deterministic; contains no timestamps). */
  hash: string;
}

/** One chat message as handed to the model. */
export interface ChatMessage {
  role: Role;
  text: string;
}

export interface LorebookEntry {
  id: string;
  /** Comma-separated keywords; ignored when `constant` is true. */
  keywords: string;
  /** Always injected regardless of keyword hit. */
  constant?: boolean;
  /** 'before' | 'after' | `depth-N` (N >= 1: N messages before the end of history). */
  position?: string;
  /** Higher first within the same position. */
  order?: number;
  /** 0..1 gate; deterministic (seeded by content+turn), never random per run. */
  probability?: number;
  content: string;
  enabled?: boolean;
}

export interface CardField {
  key: string;
  value: string;
}

export interface Card {
  id: string;
  name: string;
  /** Free-form persona / description text. */
  description: string;
  persona: string;
  scenario: string;
  firstMessage: string;
  exampleDialogue: string;
  /** Card-level system override (ST `system_prompt`), injected as a high-priority system fragment. */
  systemPrompt: string;
  /** Card-level post-history instructions (ST `post_history_instructions`), injected after history. */
  postHistoryInstructions: string;
  /** Extra fields preserved verbatim (round-trip safety, criterion A5). */
  fields: CardField[];
  /** Card-owned lore book entries (ST `data.character_book`), merged with the session world book. */
  lorebook: LorebookEntry[];
}

/**
 * 能被预设**声明落位**的卡片/运行时字段（marker）。
 *
 * ⚠ 2026-09-22 增补的背景：ST 预设用 marker（`charDescription`/`scenario`/…）让
 * **「卡片字段插在哪一段」变成预设可拨的**；而本插件原先把它**写死在 `assemble.ts` 里**
 * （§4.5 `card-tier` 的硬边界）。⇒ 按 ST 的直觉去迭代「定义放哪」时，本插件**表达不出来**。
 * 本字段把那条差距补上：预设可声明一个 `marker` 块，**接管该字段的槽位与优先级**。
 *
 * 名字用**本插件自己的字段名**（不沿用 ST 的 identifier）——ST→本插件的映射归 `st-preset.ts`，
 * 免得又犯「把某个实现的专有名字当成通用约定」那个错。
 */
export type MarkerName =
  | 'description' | 'persona' | 'systemPrompt' | 'scenario'
  | 'exampleDialogue' | 'postHistoryInstructions' | 'state' | 'script';

export const MARKER_NAMES: readonly MarkerName[] = [
  'description', 'persona', 'systemPrompt', 'scenario',
  'exampleDialogue', 'postHistoryInstructions', 'state', 'script',
];

export interface PresetBlock {
  id: string;
  slot: Slot;
  priority: number;
  /** Template text; supports {{card.name}} / {{input}} / {{state}} placeholders. */
  text: string;
  enabled?: boolean;
  /**
   * 声明本块**代表哪个卡片/运行时字段的位置**（内容来自卡片，不来自 `text`）。
   * 设了它 ⇒ 装配器用**本块的 slot 与 priority** 放该字段，覆盖 `assemble.ts` 的内建缺省。
   * 未声明 ⇒ 完全维持原行为（向后兼容：没有 marker 的预设行为逐字节不变）。
   */
  marker?: MarkerName;
}

export interface Preset {
  id: string;
  name: string;
  blocks: PresetBlock[];
  /** Hard budget for the assembled request, in characters. */
  budgetChars?: number;
}

export interface AssembleInput {
  preset: Preset;
  card: Card;
  lorebook: LorebookEntry[];
  history: ChatMessage[];
  state: Record<string, unknown>;
  turnInput: string;
  turn: number;
  script?: { title: string; segment: string };
  /**
   * 玩家角色名（可选，2026-09-23 新增）：供预设里的 `{{user}}` 宏使用。
   *
   * 为什么是可选而不是必填：拿不到时 `{{user}}` **原样保留**（不静默清空）——保留是可观测的
   * 证据（产出里出现字面量即说明这层没接通），而清空会让「宏没渲染」静默消失。
   */
  playerName?: string;
}

export interface AssembleResult {
  manifest: Manifest;
  messages: ChatMessage[];
}

/** Key/values exposed to preset template placeholders. */
export type TemplateScope = Record<string, string>;
