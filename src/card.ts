/**
 * Character card I/O — SillyTavern V2 compatible (PNG `tEXt:chara` + JSON).
 *
 * 迁移纪律（主人 2026-09-22：「里面有我在玩的所有角色卡，要做好迁移工作」）：
 *   **只读他的库，不写回**；未知字段必须逐字保留（判据 A5 往返不丢字段）。
 *   为此 `Card.fields` 收纳一切本层未解释的键，导出时原样还原。
 */
import { readFileSync } from 'node:fs';
import type { Card, CardField, LorebookEntry } from './types.ts';
import { sha256 } from './hash.ts';
import { importWorldbook, type StWorldbook } from './worldbook.ts';

/** Keys this layer interprets; everything else is preserved verbatim. */
const KNOWN = new Set([
  'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
  'creator', 'creator_notes', 'character_version', 'tags', 'avatar',
  'spec', 'spec_version', 'create_date', 'chat', 'fav', 'creatorcomment', 'data',
]);

export interface StCard {
  name?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  mes_example?: string;
  creator?: string;
  creator_notes?: string;
  character_version?: string;
  tags?: string[];
  avatar?: string;
  spec?: string;
  spec_version?: string;
  create_date?: string;
  chat?: string;
  fav?: boolean;
  creatorcomment?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

// ── PNG chunk plumbing ──────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Iterate PNG chunks: yields {type, data, offset, length}. */
function* chunks(png: Buffer): Generator<{ type: string; data: Buffer; offset: number; length: number }> {
  if (png.subarray(0, 8).toString('binary') !== '\x89PNG\r\n\x1a\n') {
    throw new Error('不是 PNG 文件（签名不匹配）——ST 卡必须是 PNG 或 JSON');
  }
  let i = 8;
  while (i + 12 <= png.length) {
    const length = png.readUInt32BE(i);
    const type = png.subarray(i + 4, i + 8).toString('latin1');
    yield { type, data: png.subarray(i + 8, i + 8 + length), offset: i, length };
    if (type === 'IEND') return;
    i += 12 + length;
  }
}

/** Extract the `chara` tEXt payload from a ST PNG card. */
export function readStPng(png: Buffer): StCard {
  for (const chunk of chunks(png)) {
    if (chunk.type !== 'tEXt') continue;
    const nul = chunk.data.indexOf(0);
    if (nul < 0) continue;
    const keyword = chunk.data.subarray(0, nul).toString('latin1');
    if (keyword !== 'chara') continue;
    const b64 = chunk.data.subarray(nul + 1).toString('latin1');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as StCard;
  }
  throw new Error('PNG 里没有 chara 元数据块——不是 SillyTavern 人物卡');
}

/** Build a `tEXt` chunk carrying the card JSON. */
function textChunk(keyword: string, value: string): Buffer {
  const payload = Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(value, 'latin1')]);
  const type = Buffer.from('tEXt', 'latin1');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(payload.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([type, payload])));
  return Buffer.concat([head, type, payload, crcBuf]);
}

/**
 * Write a ST PNG card: any existing `chara` chunk is replaced, otherwise a new
 * one is inserted right after IHDR (writing before IDAT keeps decoders happy).
 */
export function writeStPng(png: Buffer, card: StCard): Buffer {
  const b64 = Buffer.from(JSON.stringify(card), 'utf8').toString('base64');
  const chunk = textChunk('chara', b64);
  const parts: Buffer[] = [png.subarray(0, 8)];
  let inserted = false;
  let skippedOld = false;
  for (const c of chunks(png)) {
    const raw = png.subarray(c.offset, c.offset + 12 + c.length);
    if (c.type === 'tEXt') {
      const nul = c.data.indexOf(0);
      if (nul > 0 && c.data.subarray(0, nul).toString('latin1') === 'chara') {
        skippedOld = true;
        continue;
      }
    }
    parts.push(raw);
    if (!inserted && c.type === 'IHDR') {
      parts.push(chunk);
      inserted = true;
    }
  }
  void skippedOld;
  return Buffer.concat(parts);
}

// ── Card <-> StCard ─────────────────────────────────────────────────────────
/**
 * Read a text field tolerating both ST card layouts.
 *
 * ⚠ 2026-09-22 真数据实测：主人的 **57/58 张卡是 `chara_card_v3`，其中 44 张顶层
 * `description/personality/scenario/mes_example` 全为空**，内容住在 `data.*` 里。
 * 只读顶层会把 44 张卡读成**空角色**——这是只有拿真卡跑才会暴露的迁移硬伤。
 * 规则：顶层非空优先，否则回落 `data.<同名字段>`。
 */
function pick(st: StCard, key: string): string {
  const top = st[key];
  if (typeof top === 'string' && top.length > 0) return top;
  const data = st.data;
  if (data !== undefined && data !== null && typeof data === 'object') {
    const nested = (data as Record<string, unknown>)[key];
    if (typeof nested === 'string' && nested.length > 0) return nested;
  }
  return typeof top === 'string' ? top : '';
}

/** The card's own embedded lore book, when the V2/V3 layout carries one. */
function pickCharacterBook(st: StCard): LorebookEntry[] {
  const data = st.data;
  if (data === undefined || data === null || typeof data !== 'object') return [];
  const book = (data as Record<string, unknown>)['character_book'];
  if (book === undefined || book === null || typeof book !== 'object') return [];
  try {
    return importWorldbook(book as StWorldbook).entries;
  } catch {
    // 卡内世界书解析失败不阻断读卡：原始数据留在 `data` 里原样保存，不假装导入成功。
    return [];
  }
}

/** First greeting: `first_mes` wins, otherwise the first alternate greeting. */
function pickGreeting(st: StCard): string {
  const primary = pick(st, 'first_mes');
  if (primary.length > 0) return primary;
  const data = st.data;
  if (data === undefined || data === null || typeof data !== 'object') return '';
  const alternates = (data as Record<string, unknown>)['alternate_greetings'];
  if (!Array.isArray(alternates)) return '';
  const first = alternates.find((g): g is string => typeof g === 'string' && g.length > 0);
  return first ?? '';
}

/** Map a ST card JSON into our model, preserving every unexplained key. */
export function fromSt(st: StCard): Card {
  const extras: CardField[] = [];
  for (const [key, value] of Object.entries(st)) {
    if (KNOWN.has(key)) continue;
    extras.push({ key, value: JSON.stringify(value) });
  }
  return {
    id: typeof st.avatar === 'string' && st.avatar.length > 0 ? st.avatar : (st.name ?? 'unnamed'),
    name: st.name ?? '',
    description: pick(st, 'description'),
    persona: pick(st, 'personality'),
    scenario: pick(st, 'scenario'),
    firstMessage: pickGreeting(st),
    exampleDialogue: pick(st, 'mes_example'),
    systemPrompt: pick(st, 'system_prompt'),
    postHistoryInstructions: pick(st, 'post_history_instructions'),
    fields: extras,
    lorebook: pickCharacterBook(st),
  };
}

/**
 * Write an interpreted field back to **the location it was read from**.
 *
 * ⚠ 2026-09-22 实测教训：`fromSt` 对 44/58 张 V3 卡是从 `data.*` 回落的，而首版
 * `toSt` 一律写顶层 ⇒ 导出会把空的开场白**覆盖成替补开场**，等于篡改主人的卡。
 * 这是判据 A5（往返不丢/不改）抓出来的回归。
 */
function putField(out: StCard, key: string, value: string): void {
  const top = out[key];
  if (typeof top === 'string' && top.length > 0) {
    out[key] = value;
    return;
  }
  const data = out.data;
  if (data !== undefined && data !== null && typeof data === 'object'
    && typeof (data as Record<string, unknown>)[key] === 'string') {
    out.data = { ...(data as Record<string, unknown>), [key]: value };
    return;
  }
  out[key] = value;
}

/**
 * Map back to ST shape.
 *
 * 有 `base` 时**只回写与 base 解析结果不同的字段**——未改动的卡导出后与原卡逐字段一致
 * （判据 A5）。没有 `base` 时按顶层布局全量导出（新建卡）。
 */
export function toSt(card: Card, base?: StCard): StCard {
  const out: StCard = { ...(base ?? {}) };
  if (base === undefined) {
    out.name = card.name;
    out.description = card.description;
    out.personality = card.persona;
    out.scenario = card.scenario;
    out.first_mes = card.firstMessage;
    out.mes_example = card.exampleDialogue;
  } else {
    const original = fromSt(base);
    if (card.name !== original.name) out.name = card.name;
    if (card.description !== original.description) putField(out, 'description', card.description);
    if (card.persona !== original.persona) putField(out, 'personality', card.persona);
    if (card.scenario !== original.scenario) putField(out, 'scenario', card.scenario);
    if (card.firstMessage !== original.firstMessage) putField(out, 'first_mes', card.firstMessage);
    if (card.exampleDialogue !== original.exampleDialogue) putField(out, 'mes_example', card.exampleDialogue);
    if (card.systemPrompt !== original.systemPrompt) putField(out, 'system_prompt', card.systemPrompt);
    if (card.postHistoryInstructions !== original.postHistoryInstructions) putField(out, 'post_history_instructions', card.postHistoryInstructions);
  }
  for (const field of card.fields) out[field.key] = JSON.parse(field.value);
  return out;
}

/** Read a card from disk: `.png` (ST) or `.json` (ST / our own export). */
export function readCardFile(path: string): { card: Card; raw: StCard; sha256: string } {
  const buf = readFileSync(path);
  const st = path.toLowerCase().endsWith('.png')
    ? readStPng(buf)
    : (JSON.parse(buf.toString('utf8')) as StCard);
  return { card: fromSt(st), raw: st, sha256: sha256(buf.toString('binary')) };
}

/** Generate a readable slug id from a card name (filesystem-safe). */
export function slugify(name: string): string {
  return name
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80) || 'card';
}
