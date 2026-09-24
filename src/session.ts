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
import { acceptsAfterRetries, judgeCompletion, type AttemptRecord, type CompletionJudge } from './completion-judge.ts';

export interface CompletionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

/**
 * `finish` chunk 里 `error` / `aborted` 携带的失败详情（`failure: { code, message }`）。
 *
 * ⚠ 2026-09-25 修（任务 t-91746d6a）：此前只取 `chunk.reason.kind`，把 `failure` **整个丢掉**——
 * 于是「某路由 5/5 finish=error」只留下一个 `error` 字样，**没有 message / code 可归因**。
 * 结束原因的形状见 harness 的 `FinishReasonMap`（`error` 与 `aborted` 两支都带 `failure`）。
 */
export interface FinishFailure {
  code: string
  message: string
}

export interface Completion {
  text: string;
  /**
   * 思维链原文（`reasoning-delta` 拼接；模型没产思维链时为空串）。
   *
   * ⚠ 2026-09-23 补：此前 `complete` 只接 `text-delta`，**思维链被整个丢弃**——
   * 而它同时又是 `maxTokens` 的消耗方（见 `TurnResult.truncated`），
   * 于是「预算被谁吃掉」既看不见也说不清。思维链是「预设 → 产出」的**因果中介**，
   * 不看它就只能把产出好坏归因到黑盒。
   */
  reasoning: string;
  /**
   * `finish` chunk 的结束原因 kind（`stop` / `max-tokens` / `tool-calls` / `aborted` / `error`）。
   * 空串 = 流里没收到 `finish`（异常中断）。这是**截断的权威判据**，取代按 token 数猜。
   */
  finishKind: string;
  /** `error` / `aborted` 的失败详情；其余结束原因与「流里没收到 finish」为 `null`。 */
  finishFailure: FinishFailure | null;
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
  /**
   * 按**路径**取预设（2026-09-23 新增，可选）：供 `TurnRequest.preset` 做**单轮预设覆盖**。
   *
   * 为什么需要：对照实验（改前 vs 改后）原先只能靠改插件配置 + 重启来换预设，
   * 而「迭代预设」这条环每转一圈都要这么来一次 —— 于是实验成本高到做不动。
   * 可选 ⇒ 不接线时行为**逐字节不变**（本插件的老调用方无需改）。
   */
  presetFor?: (path: string) => Preset;
  budgetChars: number;
  maxTokens: number;
  temperature: number;
  /**
   * 模型路由（provider/model）。落进 `turns/<turn>.json`，让每一轮的读数**可归因**——
   * 换过路由或参数之后，两轮读数就不是一回事，记录里必须看得出这一点。
   */
  route: { provider: string; model: string };
  /**
   * 形态判据的标记表（2026-09-25）：`proseMarkers` = 正文协议块标记；`chainMarkers` = 思考链标记。
   * **空数组 ⇒ 该项不检查**（插件不猜预设的协议约定；两者皆空时行为与旧版一致）。
   */
  proseMarkers: readonly string[];
  chainMarkers: readonly string[];
  /** 失败重试上限（**含首次**）：1 = 不重试（默认 ⇒ 老调用方行为逐字节不变）。 */
  retryMax: number;
}

export interface TurnRequest {
  session: string;
  cardId: string;
  input: string;
  worldbook?: string;
  state?: Record<string, unknown>;
  /** Experimental override: replaces the preset's system block for this turn only. */
  systemPromptOverride?: string;
  /**
   * 单轮预设覆盖（2026-09-23 新增）：预设文件路径（或 `presets/` 下的 id）。
   *
   * 缺省 ⇒ 用 `deps.preset`（插件配置的 `presetPath`）。落进 `turns/<turn>.json` 的
   * `presetId`/`presetName` 会自动反映**实际用到的那一份**，所以对照实验的两条臂
   * 在记录里可区分（读数自带范围标注）。
   */
  preset?: string;
  /**
   * 逐轮采样参数覆盖（2026-09-25 新增，可选）：供**同批对照**实验。
   *
   * 为什么必须有：`temperature` / `maxTokens` 此前只能走插件配置（改配置 + 重启才生效）
   * ⇒ 采样参数无法在**同一批**里对照，只能跨批比较；而实测（2026-09-25）同一**逐字节
   * 相同**的请求跨批波动剧烈（control 链泄漏 0/5 → 4/5）⇒ 跨批比较不可靠，温度这类
   * 问题于是根本问不出来（**仪器缺口**，不是实验设计问题）。
   *
   * 语义：缺省不传 ⇒ 取插件配置值（行为逐字节不变，老调用方无需改）；传了 ⇒ 以传的为准，
   * 且落进 `turns/<轮>.json` 的是**实际生效值**（读数自带范围标注）。
   * 范围：本覆盖作用于**正文轮**（`purpose: 'prose'`）；候选 / 结算轮仍用配置值。
   */
  temperature?: number;
  maxTokens?: number;
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
  /** 思维链落盘路径（`reasoning/<turn>.md`）；模型没产思维链时为 `''`。 */
  reasoningPath: string;
  /** 思维链字符数（去空白）；0 = 本回合无思维链。 */
  reasoningChars: number;
  /** `finish` chunk 的结束原因 kind；空串 = 流里没收到 `finish`。 */
  finishKind: string;
  /** `error` / `aborted` 的失败详情（`code` / `message`）；无详情为 `null`。 */
  finishFailure: FinishFailure | null;
  /**
   * 逐次尝试的形态与读数（**含失败的那几次**）。
   *
   * ⚠ 2026-09-25（任务 t-1b8be614）：此前它**没有进 `TurnResult` 的类型**——运行时靠对象展开塞进去、
   * 类型层不存在 ⇒ 工具层理所当然地看不见它，「三次重试后勉强接受」与「一次干净的成功」在返回体里
   * 完全同形（都是 `ok:true` / `reason:''`）。**标记不可见 = 没标记。**
   */
  attempts: AttemptRecord[];
  /** 本轮接受的是**带链产出**（重试用尽后的降级接受，真有正文）——报告里必须能单列。 */
  chainInContent: boolean;
  /** 命中的链标记（`chainInContent` 为真时非空）。 */
  chainHit: string;
  /**
   * 本轮的**条件 + 读数**记录落盘路径（`turns/<turn>.json`）。
   * 把「哪张卡 / 哪个预设 / 哪个模型 / 什么参数」与「finish / usage / 字数」钉在一起，
   * 让产出读数可归因、失败可事后追因。
   */
  turnRecordPath: string;
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

/**
 * 选本轮用哪一份预设（2026-09-23 新增）。
 *
 * - `request.preset` 未给 ⇒ `deps.preset(budgetChars)`（插件配置的 `presetPath`，原行为）
 * - 给了 ⇒ `deps.presetFor(path)`（单轮覆盖，对照实验用）
 *
 * **显式指定却拿不到**时**抛错**（由调用方转成响亮失败）：绝不静默退回配置预设——
 * 那会让对照实验的两条臂实际跑同一份预设，而读数看起来像「两种配置的差异」，结论张冠李戴。
 * @param deps - 回合依赖。
 * @param request - 本轮的请求（含可选预设覆盖）。
 * @returns 本轮实际使用的预设。
 */
function resolveTurnPreset(deps: TurnDeps, request: TurnRequest): Preset {
  const path = request.preset?.trim() ?? '';
  if (path === '') return deps.preset(deps.budgetChars);
  if (deps.presetFor === undefined) {
    throw new Error(`本轮指定了预设「${path}」，但调用方未接线 presetFor（单轮预设覆盖不可用）`);
  }
  return deps.presetFor(path);
}

/**
 * 玩家名（`{{user}}` 的取值来源）：从**会话状态**里读约定键；读不到就返回 `undefined`
 * ⇒ 该宏**原样保留**（不编一个名字——那会静默改变角色身份）。
 *
 * 为什么从 state 而不是插件配置：玩家名是**每场会话**的属性（不同卡不同主角），
 * 而配置是插件级的。卡片/预设可以通过 `<UpdateVariable>` 把它写进 state。
 * @param state - 本轮的会话状态。
 * @returns 玩家名；三个约定键都取不到时 `undefined`。
 */
export function playerNameFrom(state: Record<string, unknown>): string | undefined {
  for (const key of ['userName', 'playerName', 'user']) {
    const value = state[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/** Run one prose turn end to end. Returns the text plus every reading A1/A4 need. */
export async function runTurn(deps: TurnDeps, request: TurnRequest): Promise<TurnResult> {
  const fail = (reason: string): TurnResult => ({
    ok: false, reason, turn: 0, text: '', truncated: false, reasoningPath: '', reasoningChars: 0,
    finishKind: '', finishFailure: null, turnRecordPath: '', manifest: null, manifestPath: '',
    attempts: [], chainInContent: false, chainHit: '',
    a1Ok: false, a1Detail: '', requestChars: 0, messages: 0, usage: { ...EMPTY_USAGE },
  });

  const hit = await deps.store.readCard(request.cardId);
  if (hit === null) return fail(`找不到卡「${request.cardId}」`);

  const history = await ensureOpening(deps.store, request.session, hit.card);
  const turn = history.length + 1;
  const state = request.state ?? (await deps.store.readState(request.session));

  const { entries: lorebook, error } = await resolveLorebook(deps.store, hit.card, request.worldbook);
  if (error.length > 0) return fail(error);

  let base: Preset;
  try {
    base = resolveTurnPreset(deps, request);
  } catch (err) {
    // 预设覆盖失败 ⇒ 响亮失败（不静默退回配置预设：那会让对照实验的两条臂跑同一份）
    return fail((err as Error).message);
  }
  const effective: Preset = request.systemPromptOverride === undefined || request.systemPromptOverride.length === 0
    ? base
    : { ...base, blocks: [{ id: 'override', slot: 'system', priority: 999, text: request.systemPromptOverride }, ...base.blocks] };

  const { manifest, messages } = assemble({
    preset: effective, card: hit.card, lorebook, history, state, turnInput: request.input, turn,
    playerName: playerNameFrom(state),
  });
  await deps.store.snapshot(request.session, turn);
  const manifestPath = await deps.store.writeManifest(request.session, manifest);

  /**
   * 本轮的**实验条件**（不随结果变）。读数在各分支里补齐后与它一起落盘，
   * 于是「这一轮是哪张卡/哪个预设/哪个模型/什么参数跑的」永远与读数钉在一起（可归因）。
   */
  /**
   * 逐轮采样参数覆盖（缺省取配置）：`conditions` 与模型调用**共用同一对值**——
   * 两处各算一次，迟早会对不上（读数与实发参数不一致 = 归因失效）。
   */
  const temperature = request.temperature ?? deps.temperature;
  const maxTokens = request.maxTokens ?? deps.maxTokens;

  const conditions = {
    turn,
    atMs: Date.now(),
    cardId: request.cardId,
    cardName: hit.card.name,
    /**
     * 本轮输入的摘要（2026-09-23 新增）：**逐轮可对齐**的钥匙。
     *
     * 为什么必须有（实测事故）：turn record 按 turn 号落盘 ⇒ **同一 turn 的重试会覆盖**
     * 前一次的失败记录。而空正文轮拒绝写历史 ⇒ 稿序会整体前移。两者叠加时，收口脚本
     * 只能按「第 n 条记录 ↔ 第 n 个输入」对齐，于是 discipline 臂（第 1 轮失败、第 2 轮
     * 同 turn 成功）的**第 2 次产出被误当成第 1 轮的读数**，报告还会说「第 2 轮没跑」。
     * 记下输入摘要后，收口脚本能按**内容**对齐，覆盖与偏移都不再影响归因。
     */
    inputChars: request.input.length,
    inputHead: request.input.slice(0, 40),
    presetId: effective.id,
    presetName: effective.name,
    provider: deps.route.provider,
    model: deps.route.model,
    maxTokens,
    temperature,
    budgetChars: deps.budgetChars,
    requestChars: manifest.totalChars,
    messages: manifest.entries.length,
    manifestHash: manifest.hash,
    manifestPath,
    ...(request.systemPromptOverride === undefined || request.systemPromptOverride.length === 0
      ? {}
      : { systemPromptOverrideChars: request.systemPromptOverride.length }),
  };

  /**
   * 调模型 → **形态判定** →（可选）**重试**（2026-09-25）。
   *
   * 为什么不满足于「调一次、判空」：实测（课题 §6.13/§6.14）模型对这份提示形状**每次约 50% 概率**
   * 把思考链当正文输出（或干脆只产思维链），而三个层八个干预**全部改不动它** ⇒
   * **重试是与病因无关的唯一可靠兜底**。逐次留痕（`attempts[]`）：不许只留最后一次，
   * 否则「重试了几次、每次什么形态」事后查不到。
   */
  const maxAttempts = Math.max(1, deps.retryMax);
  const attempts: AttemptRecord[] = [];
  // `!`：循环体保证至少执行一次（`maxAttempts >= 1`）⇒ 出口时 `completion` 必然已赋值；
  // TS 的确定性赋值分析证明不了这一点，故**显式**断言（不改可选类型——那会让后面每处都判空）。
  let completion!: Completion;
  // 初值也走同一个判定函数（空串 ⇒ 必然是 empty-text）——**不在调用方重复拼词表**。
  let judge: CompletionJudge = judgeCompletion('', { proseMarkers: deps.proseMarkers, chainMarkers: deps.chainMarkers });
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      completion = await deps.complete(messages, { purpose: 'prose', maxTokens, temperature });
    } catch (err) {
      return fail(`模型调用失败：${(err as Error).message}`);
    }
    judge = judgeCompletion(completion.text, { proseMarkers: deps.proseMarkers, chainMarkers: deps.chainMarkers });
    attempts.push({
      attempt,
      verdict: judge.kind,
      contentChars: completion.text.replace(/\s+/g, '').length,
      reasoningChars: completion.reasoning.replace(/\s+/g, '').length,
      finishKind: completion.finishKind,
      usage: { ...completion.usage },
    });
    if (judge.kind === 'ok') break;          // 完全可用
    if (attempt === maxAttempts) break;      // 次数用尽 ⇒ 交给下面的接受/失败裁决
    // 其余形态（空正文 / 无正文块 / 带链）都值得再试一次——同一请求的失败是**随机**的。
  }

  // 产出不可用 = **失败**，不是「成功但没内容」。
  //
  // 2026-09-23 实测（会话 real-v34-s1 第 4 轮）：模型把整个输出预算烧在推演上——思维链 192 行、
  // 反复说「开始写/开写」，正文一个字都没产出，而 `finishKind` 仍是 `stop` ⇒ **按 token 判据完全
  // 看不出来**。旧代码判它 ok:true，于是一条 0 字符的 assistant 行被写进 history，**污染其后每一轮**。
  // 2026-09-25 追加：还有一种「**非空但只有链**」（直连网关实测 4/5，课题 §6.13）——旧判据同样放过它。
  //
  // 纪律（§5.10 静默失败 = 死亡温床）：拒绝写入历史，并把失败原因说清（含**形态**与**尝试次数**）。
  // 思维链即使在这一路也要落盘——它是这次失败**唯一的诊断证据**（不落就等于把真因丢掉）。
  if (!acceptsAfterRetries(judge)) {
    const diagPath = await deps.store.writeReasoning(request.session, turn, completion.reasoning);
    const reasoningChars = completion.reasoning.replace(/\s+/g, '').length;
    // 侧车轨迹（t-91746d6a）：失败详情一行一次尝试落盘——这一类轮次是「不可用产出」，
    // 详情只活在工具返回值里翻页即失（§5.22：关键机制必须落侧车轨迹，不能只写 logger）。
    await deps.store.appendFinishTrace(request.session, {
      at: Date.now(), turn, attempt: attempts.length, ok: false,
      failure: judge.kind, finishKind: completion.finishKind,
      finishFailure: completion.finishFailure,
      outputTokens: completion.usage.outputTokens, reasoningChars,
    });
    // 失败也要留完整记录：事后追因靠的是「当时的条件 + 形态 + 逐次尝试 + 结束原因 + 思维链字数」。
    const turnRecordPath = await deps.store.writeTurnRecord(request.session, turn, {
      ...conditions,
      ok: false,
      failure: judge.kind,
      textChars: completion.text.replace(/\s+/g, '').length,
      reasoningChars,
      reasoningPath: diagPath,
      finishKind: completion.finishKind,
      finishFailure: completion.finishFailure,
      truncated: false,
      usage: completion.usage,
      attempts,
      chainHit: judge.chainHit,
      a1Ok: false,
      a1Detail: '未校验（无正文可交付）',
    });
    return {
      ...fail(`模型产出不可用（${judge.label} / ${judge.kind}）`
        + '（尝试 ' + String(attempts.length) + '/' + String(maxAttempts) + ' 次'
        + '，finish=' + (completion.finishKind === '' ? '无 finish' : completion.finishKind)
        + '，思维链 ' + String(reasoningChars) + ' 字，outputTokens ' + String(completion.usage.outputTokens) + '）'
        + '——已拒绝写入历史，避免污染后续轮次；思维链已落盘供诊断'),
      turn,
      reasoningPath: diagPath,
      reasoningChars,
      finishKind: completion.finishKind,
      finishFailure: completion.finishFailure,
      attempts,
      chainInContent: false,
      chainHit: judge.chainHit,
      turnRecordPath,
      usage: completion.usage,
      manifest,
      manifestPath,
      requestChars: manifest.totalChars,
      messages: manifest.entries.length,
    };
  }

  // A1 校验：从**磁盘回读**装配单重建 body，与实际发出的 body 比对
  const reread = await deps.store.readManifest(request.session, turn);
  const rebuildTarget = messagesFromManifest(reread ?? manifest);
  const verify = verifyAgainstActual(reread ?? manifest, rebuildTarget);

  await deps.store.appendHistory(request.session, { role: 'user', text: request.input });
  await deps.store.appendHistory(request.session, { role: 'assistant', text: completion.text });
  await deps.store.writeState(request.session, state);

  // 思维链单独落盘（响应侧证据，与 manifests/ 的请求侧证据并列）——落盘失败不该毁掉这一轮，
  // 但也不许静默：路径为空即「本回合没有思维链」，异常则原样冒泡给调用方。
  const reasoningPath = await deps.store.writeReasoning(request.session, turn, completion.reasoning);
  const reasoningChars = completion.reasoning.replace(/\s+/g, '').length;
  // 权威判据优先：提供方说 max-tokens 就是截断；只有没收到 finish 时才回退到 token 代理量。
  const truncated = completion.finishKind === 'max-tokens'
    || (completion.finishKind === '' && completion.usage.outputTokens >= deps.maxTokens);

  const turnRecordPath = await deps.store.writeTurnRecord(request.session, turn, {
    ...conditions,
    ok: true,
    textChars: completion.text.replace(/\s+/g, '').length,
    textRawChars: completion.text.length,
    reasoningChars,
    reasoningPath,
    finishKind: completion.finishKind,
    finishFailure: completion.finishFailure,
    truncated,
    usage: completion.usage,
    // 重试与形态留痕（2026-09-25）：`attempts` 逐次记（含失败的那几次），
    // `chainInContent` 让「带链但确有正文」在报告里**可单列**（此前只能靠人眼读首行判）。
    attempts,
    chainInContent: judge.kind === 'chain-in-content',
    chainHit: judge.chainHit,
    a1Ok: verify.ok,
    a1Detail: verify.ok
      ? `重建 hash 一致（${verify.rebuiltHash.slice(0, 12)}…）`
      : verify.differences.slice(0, 3).join('; '),
  });

  // 成功但**结束原因不是 stop**（如 `max-tokens`）也要落侧车：这类轮次「有正文但不完整」，
  // 是产出质量的**可疑样本**，必须在轨迹里可查（t-91746d6a）。
  if (completion.finishKind !== 'stop') {
    await deps.store.appendFinishTrace(request.session, {
      at: Date.now(), turn, attempt: attempts.length, ok: true,
      finishKind: completion.finishKind,
      finishFailure: completion.finishFailure,
      outputTokens: completion.usage.outputTokens, reasoningChars,
    });
  }

  return {
    ok: true,
    reason: '',
    turn,
    text: completion.text,
    truncated,
    reasoningPath,
    reasoningChars,
    finishKind: completion.finishKind,
    finishFailure: completion.finishFailure,
    attempts,
    chainInContent: judge.kind === 'chain-in-content',
    chainHit: judge.chainHit,
    turnRecordPath,
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
  let auxPreset: Preset;
  try {
    auxPreset = resolveTurnPreset(deps, request);
  } catch (err) {
    return miss((err as Error).message);
  }
  const { manifest, messages } = assemble({
    preset: auxPreset,
    card: hit.card,
    lorebook,
    history,
    state,
    turnInput: `${request.input}\n\n${request.instruction}`,
    turn,
    playerName: playerNameFrom(state),
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
