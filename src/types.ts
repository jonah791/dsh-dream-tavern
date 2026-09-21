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

export interface PresetBlock {
  id: string;
  slot: Slot;
  priority: number;
  /** Template text; supports {{card.name}} / {{input}} / {{state}} placeholders. */
  text: string;
  enabled?: boolean;
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
}

export interface AssembleResult {
  manifest: Manifest;
  messages: ChatMessage[];
}

/** Key/values exposed to preset template placeholders. */
export type TemplateScope = Record<string, string>;
