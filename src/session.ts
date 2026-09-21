/**
 * Turn layer — 工具与面板**共用**的唯一回合实现（判据 A7：无旁路）。
 *
 * 为什么单独成层：
 *  ① `tavern_play` 工具与面板上的「玩一轮」动作必须走同一条装配路径，否则
 *     装配单记的与面板触发的会分叉（§5.20 规则 3 的事故族）；
 *  ② 补全器以**回调**注入（`complete`），整条回路因此可离线用假补全器测试，
 *     不必依赖真模型——这是验收脚本能跑的前提。
 */
import { assemble, messagesFromManifest, verifyAgainstActual } from './assemble.ts';
import type { Store } from './store.ts';
import type { Card, ChatMessage, LorebookEntry, Manifest, Preset } from './types.ts';

export interface CompletionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface Completion {
  text: string;
  usage: CompletionUsage;
}

/** Injected model access — the only place a real model call can enter. */
export type Completer = (
  messages: ChatMessage[],
  options: { purpose: 'prose' | 'candidates' | 'settle'; maxTokens: number; temperature: number },
) => Promise<Completion>;

export interface TurnDeps {
  store: Store;
  complete: Completer;
  preset: (budgetChars: number) => Preset;
  budgetChars: number;
  maxTokens: number;
  temperature: number;
}

export interface TurnRequest {
  session: string;
  cardId: string;
  input: string;
  worldbook?: string;
  state?: Record<string, unknown>;
  /** Experimental override: replaces the preset's system block for this turn only. */
  systemPromptOverride?: string;
}

export interface TurnResult {
  ok: boolean;
  reason: string;
  turn: number;
  text: string;
  /**
   * 输出被 `maxTokens` 截断（`outputTokens >= maxTokens`）。
   *
   * ⚠ 2026-09-22 实测：**推理模型的思维链也算进 maxTokens**——上限 1600 时正文只剩 195 字
   * 就断了，而 usage 显示 1600（预算被思维链吃掉）。截断必须显式报出，不许静默。
   */
  truncated: boolean;
  manifest: Manifest | null;
  manifestPath: string;
  /** A1: the body rebuilt from the persisted manifest equals the body we sent. */
  a1Ok: boolean;
  a1Detail: string;
  requestChars: number;
  messages: number;
  usage: CompletionUsage;
}

const EMPTY_USAGE: CompletionUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

/**
 * Seed a new session with the card's opening line as the first assistant message.
 * 开场白属于对话而非系统提示：落一次，之后靠「只追加」不变量自然保留。
 */
export async function ensureOpening(store: Store, sessionId: string, card: Pick<Card, 'firstMessage'>): Promise<ChatMessage[]> {
  const history = await store.readHistory(sessionId);
  if (history.length > 0 || card.firstMessage.length === 0) return history;
  const greeting: ChatMessage = { role: 'assistant', text: card.firstMessage };
  await store.appendHistory(sessionId, greeting);
  return [greeting];
}

/** Resolve the lore book for a turn: the card's own book plus the named world book. */
export async function resolveLorebook(
  store: Store,
  card: Card,
  worldbookName: string | undefined,
): Promise<{ entries: LorebookEntry[]; error: string }> {
  const entries: LorebookEntry[] = [...card.lorebook];
  if (worldbookName === undefined || worldbookName.trim().length === 0) return { entries, error: '' };
  const book = await store.importWorldbookFile(worldbookName.trim());
  if (book === null) return { entries, error: `找不到世界书「${worldbookName}」` };
  // 卡内条目与外部同名时以后者为准（外部显式指定优先），但保留卡内其余条目
  const externalIds = new Set(book.result.entries.map((e) => e.id));
  return { entries: [...entries.filter((e) => !externalIds.has(e.id)), ...book.result.entries], error: '' };
}

/** Run one prose turn end to end. Returns the text plus every reading A1/A4 need. */
export async function runTurn(deps: TurnDeps, request: TurnRequest): Promise<TurnResult> {
  const fail = (reason: string): TurnResult => ({
    ok: false, reason, turn: 0, text: '', truncated: false, manifest: null, manifestPath: '',
    a1Ok: false, a1Detail: '', requestChars: 0, messages: 0, usage: { ...EMPTY_USAGE },
  });

  const hit = await deps.store.readCard(request.cardId);
  if (hit === null) return fail(`找不到卡「${request.cardId}」`);

  const history = await ensureOpening(deps.store, request.session, hit.card);
  const turn = history.length + 1;
  const state = request.state ?? (await deps.store.readState(request.session));

  const { entries: lorebook, error } = await resolveLorebook(deps.store, hit.card, request.worldbook);
  if (error.length > 0) return fail(error);

  const base = deps.preset(deps.budgetChars);
  const effective: Preset = request.systemPromptOverride === undefined || request.systemPromptOverride.length === 0
    ? base
    : { ...base, blocks: [{ id: 'override', slot: 'system', priority: 999, text: request.systemPromptOverride }, ...base.blocks] };

  const { manifest, messages } = assemble({
    preset: effective, card: hit.card, lorebook, history, state, turnInput: request.input, turn,
  });
  await deps.store.snapshot(request.session, turn);
  const manifestPath = await deps.store.writeManifest(request.session, manifest);

  let completion: Completion;
  try {
    completion = await deps.complete(messages, { purpose: 'prose', maxTokens: deps.maxTokens, temperature: deps.temperature });
  } catch (err) {
    return fail(`模型调用失败：${(err as Error).message}`);
  }

  // A1 校验：从**磁盘回读**装配单重建 body，与实际发出的 body 比对
  const reread = await deps.store.readManifest(request.session, turn);
  const rebuildTarget = messagesFromManifest(reread ?? manifest);
  const verify = verifyAgainstActual(reread ?? manifest, rebuildTarget);

  await deps.store.appendHistory(request.session, { role: 'user', text: request.input });
  await deps.store.appendHistory(request.session, { role: 'assistant', text: completion.text });
  await deps.store.writeState(request.session, state);

  return {
    ok: true,
    reason: '',
    turn,
    text: completion.text,
    truncated: completion.usage.outputTokens >= deps.maxTokens,
    manifest,
    manifestPath,
    a1Ok: verify.ok,
    a1Detail: verify.ok
      ? `重建 hash 一致（${verify.rebuiltHash.slice(0, 12)}…）`
      : verify.differences.slice(0, 3).join('; '),
    requestChars: manifest.totalChars,
    messages: manifest.entries.length,
    usage: completion.usage,
  };
}

export interface AuxResult {
  ok: boolean;
  reason: string;
  text: string;
  manifestPath: string;
  a1Ok: boolean;
  requestChars: number;
  usage: CompletionUsage;
}

/**
 * Auxiliary agents (candidates / settlement) — 职责互斥的另一半。
 *
 * 与正文 Agent 的三点差别（判据 M4）：
 *  ① 用**不同的意图指令**，且不写正文；
 *  ② 结算 Agent 是**唯一的状态写者**；候选 Agent 对状态只读；
 *  ③ 三者共用 `assemble`（A7），故它们的装配单同样可逐字节复核。
 */
export async function runAuxTurn(
  deps: TurnDeps,
  request: TurnRequest & { instruction: string },
  purpose: 'candidates' | 'settle',
): Promise<AuxResult> {
  const miss = (reason: string): AuxResult => ({
    ok: false, reason, text: '', manifestPath: '', a1Ok: false, requestChars: 0, usage: { ...EMPTY_USAGE },
  });
  const hit = await deps.store.readCard(request.cardId);
  if (hit === null) return miss(`找不到卡「${request.cardId}」`);

  const history = await ensureOpening(deps.store, request.session, hit.card);
  const state = request.state ?? (await deps.store.readState(request.session));
  const { entries: lorebook, error } = await resolveLorebook(deps.store, hit.card, request.worldbook);
  if (error.length > 0) return miss(error);

  // 意图指令放在**末尾**（近因位），避免与卡/世界书争夺注意力
  const turn = history.length + 1;
  const { manifest, messages } = assemble({
    preset: deps.preset(deps.budgetChars),
    card: hit.card,
    lorebook,
    history,
    state,
    turnInput: `${request.input}\n\n${request.instruction}`,
    turn,
  });
  const manifestPath = await deps.store.writeManifest(request.session, manifest);

  let completion: Completion;
  try {
    completion = await deps.complete(messages, { purpose, maxTokens: deps.maxTokens, temperature: deps.temperature });
  } catch (err) {
    return miss(`模型调用失败：${(err as Error).message}`);
  }

  const reread = await deps.store.readManifest(request.session, turn);
  const verify = verifyAgainstActual(reread ?? manifest, messagesFromManifest(reread ?? manifest));
  return {
    ok: true,
    reason: '',
    text: completion.text,
    manifestPath,
    a1Ok: verify.ok,
    requestChars: manifest.totalChars,
    usage: completion.usage,
  };
}

/** Settle: the settlement agent returns JSON; only this path may write session state. */
export async function runSettlement(
  deps: TurnDeps,
  request: TurnRequest,
): Promise<{ ok: boolean; reason: string; state: Record<string, unknown>; raw: string; a1Ok: boolean }> {
  const instruction = [
    '下面的任务不是写故事，而是**结算**。',
    '只输出一个 JSON 对象，描述当前剧情之后的角色/世界状态；不要输出任何解释或代码块围栏。',
    '键名用简短中文或英文均可，值用字符串或数字。',
  ].join('\n');
  const result = await runAuxTurn(deps, { ...request, instruction }, 'settle');
  if (!result.ok) return { ok: false, reason: result.reason, state: {}, raw: result.text, a1Ok: result.a1Ok };
  const parsed = extractJsonObject(result.text);
  if (parsed === null) {
    return { ok: false, reason: `结算输出不是合法 JSON：${result.text.slice(0, 120)}`, state: {}, raw: result.text, a1Ok: result.a1Ok };
  }
  await deps.store.writeState(request.session, parsed);
  return { ok: true, reason: '', state: parsed, raw: result.text, a1Ok: result.a1Ok };
}

/** Candidates: action options, one per line; the prose agent never sees this call. */
export async function runCandidates(
  deps: TurnDeps,
  request: TurnRequest & { count: number },
): Promise<{ ok: boolean; reason: string; candidates: string[]; a1Ok: boolean }> {
  const instruction = [
    `下面的任务不是写故事，而是给出 ${request.count} 个**玩家此刻可以采取的行动**。`,
    `每行一个，不加序号、不加解释、每行不超过 20 字。只输出这 ${request.count} 行。`,
  ].join('\n');
  const result = await runAuxTurn(deps, { ...request, instruction }, 'candidates');
  if (!result.ok) return { ok: false, reason: result.reason, candidates: [], a1Ok: result.a1Ok };
  const candidates = result.text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, request.count);
  return { ok: true, reason: '', candidates, a1Ok: result.a1Ok };
}

/** Pull the first balanced JSON object out of a model reply (fences tolerated). */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1)) as unknown;
          return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
