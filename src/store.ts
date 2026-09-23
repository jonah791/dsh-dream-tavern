/**
 * Data store — cards (index + read), world books, sessions (history / state / manifests).
 *
 * 两条硬约束：
 *  1. **迁移源只读**：主人的酒馆目录只用于读取，本层写入一律落在我们自己的 dataDir。
 *  2. **不变量「只追加」**：历史只 append；回退走**原子快照**，不改写已发出的前缀。
 */
import { mkdir, readFile, readdir, stat, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readCardFile, slugify } from './card.ts';
import type { Card, ChatMessage, Manifest } from './types.ts';
import { importWorldbook, type ImportResult, type StWorldbook } from './worldbook.ts';

export interface CardIndexEntry {
  /** Stable id derived from the file name (filesystem-safe). */
  id: string;
  name: string;
  file: string;
  bytes: number;
  mtimeMs: number;
  source: 'st-png' | 'json';
}

export interface StoreConfig {
  /** Where *we* write everything (never the migration source). */
  dataDir: string;
  /** Read-only card library (e.g. the owner's SillyTavern `characters/`). */
  cardDirs: string[];
  /** Read-only world book library. */
  worldDirs: string[];
}

async function listFiles(dir: string, exts: string[]): Promise<string[]> {
  try {
    const names = await readdir(dir);
    const out: string[] = [];
    for (const name of names) {
      const lower = name.toLowerCase();
      if (!exts.some((e) => lower.endsWith(e))) continue;
      const path = join(dir, name);
      try { if ((await stat(path)).isFile()) out.push(path); } catch { /* 读不到就跳过，不假装存在 */ }
    }
    return out.sort();
  } catch {
    return [];
  }
}

export class Store {
  constructor(private readonly config: StoreConfig) {}

  get dataDir(): string { return this.config.dataDir }

  /** Scan every configured card dir. Lists by metadata only (no PNG parsing). */
  async scanCards(): Promise<{ cards: CardIndexEntry[]; unreadable: string[] }> {
    const cards: CardIndexEntry[] = [];
    const unreadable: string[] = [];
    for (const dir of this.config.cardDirs) {
      for (const path of await listFiles(dir, ['.png', '.json'])) {
        const file = path.split(/[\\/]/).pop() ?? path;
        try {
          const info = await stat(path);
          cards.push({
            id: slugify(file.replace(/\.(png|json)$/i, '')),
            name: file.replace(/\.(png|json)$/i, ''),
            file: path,
            bytes: info.size,
            mtimeMs: info.mtimeMs,
            source: file.toLowerCase().endsWith('.png') ? 'st-png' : 'json',
          });
        } catch {
          unreadable.push(path);
        }
      }
    }
    return { cards, unreadable };
  }

  /** Read one card by id or by exact file name. */
  async readCard(idOrName: string): Promise<{ card: Card; file: string; sha256: string } | null> {
    const { cards } = await this.scanCards();
    const wanted = idOrName.trim();
    const hit = cards.find((c) => c.id === wanted)
      ?? cards.find((c) => c.name === wanted)
      ?? cards.find((c) => c.id.toLowerCase() === wanted.toLowerCase())
      ?? cards.find((c) => slugify(c.name) === wanted);
    if (!hit) return null;
    const { card, sha256 } = readCardFile(hit.file);
    return { card, file: hit.file, sha256 };
  }

  /** Raw ST json of a card (for round-trip export without re-deriving fields). */
  async readCardRaw(idOrName: string): Promise<{ raw: Record<string, unknown>; file: string } | null> {
    const { cards } = await this.scanCards();
    const wanted = idOrName.trim();
    const hit = cards.find((c) => c.id === wanted) ?? cards.find((c) => c.name === wanted);
    if (!hit) return null;
    const { raw } = readCardFile(hit.file);
    return { raw: raw as unknown as Record<string, unknown>, file: hit.file };
  }

  /** Import one world book file by exact name (or first name match). */
  async importWorldbookFile(nameOrPath: string): Promise<{ result: ImportResult; file: string } | null> {
    const candidates: string[] = [];
    if (existsSync(nameOrPath)) candidates.push(nameOrPath);
    for (const dir of this.config.worldDirs) {
      for (const path of await listFiles(dir, ['.json'])) {
        const base = (path.split(/[\\/]/).pop() ?? '').replace(/\.json$/i, '');
        if (base === nameOrPath || path === nameOrPath) candidates.push(path);
      }
    }
    const file = candidates[0];
    if (file === undefined) return null;
    const book = JSON.parse(await readFile(file, 'utf8')) as StWorldbook;
    return { result: importWorldbook(book), file };
  }

  /** List world book files across all configured dirs. */
  async scanWorldbooks(): Promise<Array<{ name: string; file: string; bytes: number }>> {
    const out: Array<{ name: string; file: string; bytes: number }> = [];
    for (const dir of this.config.worldDirs) {
      for (const path of await listFiles(dir, ['.json'])) {
        const name = (path.split(/[\\/]/).pop() ?? '').replace(/\.json$/i, '');
        let bytes = 0;
        try { bytes = (await stat(path)).size; } catch { /* 保留 0，不猜 */ }
        out.push({ name, file: path, bytes });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  // ── sessions ─────────────────────────────────────────────────────────────
  sessionDir(sessionId: string): string {
    return join(this.config.dataDir, 'sessions', sessionId);
  }

  private async ensure(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  async appendHistory(sessionId: string, message: ChatMessage): Promise<void> {
    const dir = this.sessionDir(sessionId);
    await this.ensure(dir);
    await appendFile(join(dir, 'history.jsonl'), JSON.stringify(message) + '\n', 'utf8');
  }

  async readHistory(sessionId: string): Promise<ChatMessage[]> {
    try {
      const text = await readFile(join(this.sessionDir(sessionId), 'history.jsonl'), 'utf8');
      return text.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as ChatMessage);
    } catch {
      return [];
    }
  }

  async writeManifest(sessionId: string, manifest: Manifest): Promise<string> {
    const dir = join(this.sessionDir(sessionId), 'manifests');
    await this.ensure(dir);
    const path = join(dir, `${String(manifest.turn).padStart(4, '0')}.json`);
    await writeFile(path, JSON.stringify(manifest, null, 2), 'utf8');
    return path;
  }

  async readManifest(sessionId: string, turn: number): Promise<Manifest | null> {
    try {
      return JSON.parse(await readFile(join(this.sessionDir(sessionId), 'manifests', `${String(turn).padStart(4, '0')}.json`), 'utf8')) as Manifest;
    } catch {
      return null;
    }
  }

  /**
   * Write the model's reasoning (思维链) for one turn to `reasoning/<turn>.md`.
   *
   * 为什么单独落盘而不是塞进 `history.jsonl`：history 的每一行都会**回流进下一次请求**
   * （`assemble` 把 history 映射成消息），往里加字段会把思维链带进上下文、改变被测对象本身。
   * 思维链是**响应侧**证据，与 `manifests/`（请求侧证据）并列，互不污染。
   *
   * @param sessionId - session directory name.
   * @param turn - turn number (same numbering as `manifests/`).
   * @param text - raw reasoning text; empty string ⇒ nothing is written.
   * @returns the file path, or `''` when there was no reasoning to persist.
   */
  async writeReasoning(sessionId: string, turn: number, text: string): Promise<string> {
    if (text.trim().length === 0) return '';
    const dir = join(this.sessionDir(sessionId), 'reasoning');
    await this.ensure(dir);
    const path = join(dir, `${String(turn).padStart(4, '0')}.md`);
    await writeFile(path, text, 'utf8');
    return path;
  }

  async readReasoning(sessionId: string, turn: number): Promise<string | null> {
    try {
      return await readFile(join(this.sessionDir(sessionId), 'reasoning', `${String(turn).padStart(4, '0')}.md`), 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * Write one turn's **conditions + readings** to `turns/<turn>.json`.
   *
   * 为什么需要它（2026-09-23，主人要求「每次的请求要可见，相当于全流程透明」）：
   * `manifests/` 只记**请求**（装配了什么），`history.jsonl` 只记**正文**，`reasoning/` 只记**思维链**——
   * 而「这一轮是哪张卡 / 哪个预设 / 哪个模型 / 什么参数跑的」以及「`finishKind` / `truncated` / usage」
   * **一处都没落盘**，只在工具返回值里一闪而过。于是产出读数**无法归因**（换过参数后两轮读数不可比），
   * 失败（如空正文）事后也**查不到当时的结束原因**。
   * 本记录把三者钉在一起，并补齐实验条件。
   *
   * @param sessionId - session directory name.
   * @param turn - turn number (same numbering as `manifests/`).
   * @param record - plain JSON-serialisable record; written verbatim.
   * @returns the file path.
   */
  async writeTurnRecord(sessionId: string, turn: number, record: Record<string, unknown>): Promise<string> {
    const dir = join(this.sessionDir(sessionId), 'turns');
    await this.ensure(dir);
    const path = join(dir, `${String(turn).padStart(4, '0')}.json`);
    await writeFile(path, JSON.stringify(record, null, 2), 'utf8');
    return path;
  }

  async readTurnRecord(sessionId: string, turn: number): Promise<Record<string, unknown> | null> {
    try {
      const raw = await readFile(join(this.sessionDir(sessionId), 'turns', `${String(turn).padStart(4, '0')}.json`), 'utf8');
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async writeState(sessionId: string, state: Record<string, unknown>): Promise<void> {
    const dir = this.sessionDir(sessionId);
    await this.ensure(dir);
    await writeFile(join(dir, 'state.json'), JSON.stringify(state, null, 2), 'utf8');
  }

  async readState(sessionId: string): Promise<Record<string, unknown>> {
    try {
      return JSON.parse(await readFile(join(this.sessionDir(sessionId), 'state.json'), 'utf8')) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /**
   * The most recent manifest on disk.
   *
   * ⚠ 2026-09-22 实测教训：轮次号**不是** `history.length` 的线性函数（开场占 1 条、
   * 每轮追加 2 条），所以「用历史长度反推上一次是第几轮」会算错，面板因此把
   * 「上轮请求」显示成「—」。改为直接扫 `manifests/` 目录取最大编号——不靠推算。
   */
  async readLatestManifest(sessionId: string): Promise<{ turn: number; manifest: Manifest } | null> {
    const dir = join(this.sessionDir(sessionId), 'manifests');
    try {
      const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
      const last = names.at(-1);
      if (last === undefined) return null;
      const turn = Number(last.replace(/\.json$/, ''));
      if (!Number.isFinite(turn)) return null;
      const manifest = JSON.parse(await readFile(join(dir, last), 'utf8')) as Manifest;
      return { turn, manifest };
    } catch {
      return null;
    }
  }

  /**
   * Atomic rollback: restore history + state to the snapshot taken at `turn`.
   * Both files are rewritten together; a missing snapshot fails loudly.
   */
  async rollback(sessionId: string, turn: number): Promise<{ history: number; stateTurns: number }> {
    const dir = this.sessionDir(sessionId);
    const snapDir = join(dir, 'snapshots', String(turn).padStart(4, '0'));
    const historyPath = join(snapDir, 'history.jsonl');
    const statePath = join(snapDir, 'state.json');
    if (!existsSync(historyPath) || !existsSync(statePath)) {
      throw new Error(`回退失败：第 ${turn} 轮没有完整快照（${snapDir}）——不猜、不部分回退`);
    }
    const historyText = await readFile(historyPath, 'utf8');
    const stateText = await readFile(statePath, 'utf8');
    await writeFile(join(dir, 'history.jsonl'), historyText, 'utf8');
    await writeFile(join(dir, 'state.json'), stateText, 'utf8');
    const history = historyText.split('\n').filter((l) => l.trim().length > 0).length;
    const stateTurns = Object.keys(JSON.parse(stateText) as Record<string, unknown>).length;
    return { history, stateTurns };
  }

  /** Snapshot history + state so a later rollback is exact. */
  async snapshot(sessionId: string, turn: number): Promise<string> {
    const dir = this.sessionDir(sessionId);
    const snapDir = join(dir, 'snapshots', String(turn).padStart(4, '0'));
    await this.ensure(snapDir);
    let historyText = '';
    let stateText = '{}';
    try { historyText = await readFile(join(dir, 'history.jsonl'), 'utf8'); } catch { historyText = ''; }
    try { stateText = await readFile(join(dir, 'state.json'), 'utf8'); } catch { stateText = '{}'; }
    await writeFile(join(snapDir, 'history.jsonl'), historyText, 'utf8');
    await writeFile(join(snapDir, 'state.json'), stateText, 'utf8');
    return snapDir;
  }
}
