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
  MarkerName, PresetBlock, Slot, TemplateScope,
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

/**
 * ST 宏渲染状态（2026-09-23 新增）：变量表按**装配顺序**累积。
 *
 * 为什么是「按顺序累积」而不是预扫描：ST 的语义就是顺序执行（与 `prompt_order` 同序），
 * 同名 `setvar` 后出现的**覆盖**先出现的（实测该预设 `rencheng_var` / `zishu_var` /
 * `qianghua_var` / `ban_word_var` / `thinking_budget` 都被 set 两次），
 * `addvar` 则**追加**（`dream_protocol` 由 4 次调用累积成协议清单）。
 */
export interface StMacroState {
  /** 变量表：`setvar` 写、`addvar` 追加、`getvar` 读。 */
  vars: Map<string, string>;
  /** `{{char}}` 的取值（角色名）；拿不到时该宏**原样保留**。 */
  charName?: string;
  /** `{{user}}` 的取值（玩家名）；拿不到时该宏**原样保留**。 */
  userName?: string;
}

/** 一次 ST 宏渲染的结果。 */
export interface StMacroRender {
  text: string;
  /** 文本里出现过 `{{trim}}` ⇒ 调用方应对**整块**做首尾去空白（ST 语义）。 */
  trimmed: boolean;
}

/**
 * 宏渲染最大轮数（迭代到不动点）。
 *
 * 为什么需要迭代：`setvar` 的值里可以**嵌套**别的宏，而正则 `[^{}]*` 只能匹配最内层。
 * 实测该预设就有：`{{setvar::thought_of_chain_var::…{{getvar::thinking_budget}}…}}`。
 * 上限只防病态输入（正常预设 2–3 轮收敛）。
 */
const MAX_MACRO_ROUNDS = 8;

/**
 * ST 宏渲染：补上预设的**变量/控制层**。
 *
 * ## 为什么必须有（2026-09-23 实测）
 * 启用块里有 **35 个 ST 宏，本插件原先一个都渲染不了**——`renderTemplate` 的键正则只认
 * `[a-zA-Z0-9_.]`，而 `{{setvar::x::v}}` 含冒号 ⇒ 不匹配 ⇒ 原样保留。
 * 失效的是**控制层**不是装饰：`{{setvar::rencheng_var::第三人称}}`（人称变量）、
 * `{{getvar::zishu_var}}`（字数档）、`{{getvar::thinking_budget}}`（思考预算）、
 * `{{setvar::dream_protocol::DREAM_PLOT_OUTPUT}}`（协议名）。
 * 产出侧可见后果：正文里出现字面量 `{{user}}`，且模型**无人称可依** ⇒ 在推理里来回摇摆。
 *
 * ## 语义表
 * | 宏 | 语义 |
 * |---|---|
 * | `{{setvar::k::v}}` | 写变量（**覆盖**，后出现的赢）→ 输出空 |
 * | `{{addvar::k::s}}` | 追加到已有值 → 输出空 |
 * | `{{getvar::k}}` | 读变量；**未定义时原样保留**（理由见下） |
 * | `{{//…}}` | 注释 → 输出空 |
 * | `{{trim}}` | 置 `trimmed`（该块首尾去空白）→ 输出空 |
 * | `{{char}}` / `{{user}}` | 角色名 / 玩家名；**拿不到时原样保留** |
 * | 其他（含 `lora_constant` 这类扩展宏） | 原样保留（不猜、不静默清空） |
 *
 * **未定义 `getvar` 为什么保留而不返回空**：ST 返回空串，但那会让「变量没被 set」这件事
 * **静默消失**——静默失败是本仓反复踩过的坑（AGENTS.md §5.10）。保留原文时，产出里出现的
 * 字面量就是**可观测证据**：2026-09-23 正是靠正文里的 `{{user}}` 才发现宏整层失效。
 *
 * 纯函数：只读 `state`（会就地更新变量表，调用方按顺序传入同一实例）。
 * @param text - 一个预设块的正文（未渲染）。
 * @param state - 装配期间累积的宏状态。
 * @returns 渲染后的文本 + 是否需要 trim。
 */
export function renderStMacros(text: string, state: StMacroState): StMacroRender {
  let trimmed = false;
  let current = text;
  // **迭代到不动点**：`setvar` 的值里可以嵌套别的宏（实测该预设就有——
  // `{{setvar::thought_of_chain_var::…{{getvar::thinking_budget}}…}}`），而正则只能匹配
  // 「不含 `{` / `}` 的最内层」。于是必须：先渲染内层，再渲染外层。ST 的宏替换同样是多轮的。
  for (let round = 0; round < MAX_MACRO_ROUNDS; round += 1) {
    let changed = false;
    const next = current.replace(/\{\{([^{}]*)\}\}/g, (whole, body: string) => {
      // ⚠ **不对 `body` 整体 trim**（2026-09-23 实测修正）：`setvar` 的值必须**原样保留**，
      // 整体 trim 会吃掉多行值末尾的换行 —— 那等于静默改写预设内容（§5.10）。
      // 只用 trim 后的探针**识别宏名**，取值一律回到原文。
      const raw = body;
      const probe = raw.trim();
      if (probe.startsWith('//')) {
        changed = true;
        return '';
      }
      if (probe === 'trim') {
        trimmed = true;
        changed = true;
        return '';
      }
      if (probe === 'char') return state.charName ?? whole;
      if (probe === 'user') return state.userName ?? whole;
      const sep = raw.indexOf('::');
      if (sep < 0) return whole;
      const macro = raw.slice(0, sep).trim();
      const rest = raw.slice(sep + 2);
      if (macro === 'getvar') {
        const value = state.vars.get(rest.trim());
        if (value === undefined) return whole;
        changed = true;
        return value;
      }
      if (macro !== 'setvar' && macro !== 'addvar') return whole;
      const inner = rest.indexOf('::');
      // `{{setvar::k}}`（无值形态）⇒ 置空串；`{{setvar::k::v}}` ⇒ 置 v
      const key = (inner < 0 ? rest : rest.slice(0, inner)).trim();
      const value = inner < 0 ? '' : rest.slice(inner + 2);
      if (key === '') return whole;
      state.vars.set(key, macro === 'addvar' ? (state.vars.get(key) ?? '') + value : value);
      changed = true;
      return '';
    });
    current = next;
    if (!changed) break;
  }
  return { text: current, trimmed };
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
  const { preset, card, lorebook, history, state, turnInput, turn, script, playerName } = input;
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

  /**
   * **marker 落位表**（2026-09-22）：预设可声明某个卡片/运行时字段插在哪一段。
   * ST 预设用 marker 做这件事，而本插件原先**写死**在下面几行里 ⇒ 表达力差距。
   * **向后兼容**：没有 marker 块的预设 ⇒ 本表为空 ⇒ 下面的缺省行为**逐字节不变**。
   */
  const markerPlacement = new Map<MarkerName, { slot: Slot; priority: number }>();
  for (const block of preset.blocks as PresetBlock[]) {
    if (block.marker === undefined || block.enabled === false) continue;
    markerPlacement.set(block.marker, { slot: block.slot, priority: block.priority });
  }
  const place = (name: MarkerName, dSlot: Slot, dPriority: number): { slot: Slot; priority: number } =>
    markerPlacement.get(name) ?? { slot: dSlot, priority: dPriority };

  // 1) preset blocks (declared order; unknown placeholders stay visible)
  // ⚠ **marker 块是声明不是片段**（它只说「某字段放哪」，内容来自卡片）⇒ 不进 parts。
  //
  // ST 宏按**块顺序**渲染（2026-09-23）：`setvar` 写进 `macroState.vars`、`getvar` 读，
  // 于是「变量初始化块 → 后续块引用」这套控制层第一次真正生效（原先 35 个宏一个都渲染不了）。
  // 停用块与 marker 块**不执行**其宏——与 ST 一致（未注入的条目不产生副作用）。
  const macroState: StMacroState = {
    vars: new Map<string, string>(),
    charName: card.name === '' ? undefined : card.name,
    userName: playerName === undefined || playerName === '' ? undefined : playerName,
  };
  for (const block of preset.blocks as PresetBlock[]) {
    if (block.enabled === false || block.marker !== undefined) continue;
    const rendered = renderStMacros(block.text, macroState);
    const text = renderTemplate(rendered.text, scope);
    parts.push(part(
      `preset:${block.id}`, block.slot, `preset:${block.id}`, block.priority,
      rendered.trimmed ? text.trim() : text,
    ));
  }

  // 2) card definition / persona / system override as first-class system fragments
  //
  // ⚠ `description` 必须进上下文：在 ST 里它是**主定义**（人设/世界观），`personality`
  // 只是摘要字段。2026-09-22 实测：只注入 persona 时，一张 description=2844 字的卡
  // 装配出来只有 1146 字——主定义整段丢失。
  // ⚠ `source` 必须是**身份**（能唯一指认一段内容）：2026-09-22 质量判据（no-duplicate）第一次跑就抓到
  // persona 与 scenario 共用裸 `'card'` ⇒ 两个**不同**字段看起来像「同一来源被注入两遍」。
  // 同族标签里 preset 用 `preset:<blockId>`、lorebook 用 `lorebook:<id>`，card 也应细到字段。
  /**
   * 卡片字段的 ST 宏渲染（2026-09-23 新增，**独立于预设块**的变量表）。
   *
   * 为什么需要（实测）：卡「仙母种情」的字段里带 `{{user}}`，而宏渲染原先只作用于**预设块**
   * ⇒ 字面量直接进了 system prompt，模型**照抄**到正文（实测第一轮正文出现「{{user}} 的手
   * 还搭在门沿上」）。
   *
   * 为什么用**独立**变量表：卡片字段与预设块是两个来源，各自的 `setvar` 不应互相污染；
   * 它们共享的只有 `char` / `user` 两个名字（来自卡片与会话，不是字段内部状态）。
   * `{{user}}` 拿不到玩家名时**原样保留**——不编一个名字（那会静默改变角色身份）。
   */
  const cardMacroState: StMacroState = {
    vars: new Map<string, string>(),
    charName: card.name === '' ? undefined : card.name,
    userName: playerName === undefined || playerName === '' ? undefined : playerName,
  };
  const renderCardMacros = (text: string): string => {
    const r = renderStMacros(text, cardMacroState);
    return r.trimmed ? r.text.trim() : r.text;
  };

  const pushCard = (name: MarkerName, id: string, source: string, dSlot: Slot, dPriority: number, text: string): void => {
    if (text.length === 0) return;
    const p = place(name, dSlot, dPriority);
    parts.push(part(id, p.slot, source, p.priority, renderCardMacros(text)));
  };
  pushCard('description', 'card:description', 'card:description', 'system', 99, card.description);
  pushCard('persona', 'card:persona', 'card:persona', 'persona_prefix', 100, card.persona);
  pushCard('systemPrompt', 'card:sysprompt', 'card:system_prompt', 'system', 98, card.systemPrompt);
  pushCard('scenario', 'card:scenario', 'card:scenario', 'system', 90, card.scenario);
  // 对话样例只作文风参考，且必须在文本里说清楚它不是当前剧情（否则会被当成已发生的事）
  pushCard(
    'exampleDialogue', 'card:example', 'card:example', 'system', 45,
    card.exampleDialogue.length === 0
      ? ''
      : `【对话样例（仅供文风与语气参考，**不是**当前剧情的一部分）】\n${card.exampleDialogue}`,
  );

  // 3) live state — the model must see exactly what the settlement agent wrote
  {
    const p = place('state', 'system', 80);
    parts.push(part('state', p.slot, 'state', p.priority, stateText));
  }

  // 4) script segment (optional main-line anchor)
  if (script !== undefined && script.segment.length > 0) {
    const p = place('script', 'system', 70);
    parts.push(part('script', p.slot, 'script', p.priority, script.segment));
  }

  // 5) lorebook hits — 条目清单由**调用方唯一给出**（`resolveLorebook` 已合并卡内世界书）。
  // ⚠ 2026-09-22 冒烟实测：首版在此自行追加 `[...card.lorebook, ...lorebook]`，而调用方
  // 传入的清单里**已经**含卡内条目 ⇒ 每一轮把整本卡内世界书**注入两遍**
  // （`parts` 里每个 `lorebook:<id>` 都出现两次，单卡请求被撑到近 20k 字）。
  // 装配器不得自行加源——多源合并是调用方的职责，这里只按给定清单装。
  const hits = matchLorebook(lorebook, { history, turnInput, turn });
  for (const hit of hits) {
    parts.push(part(`lore:${hit.entry.id}`, hit.slot, `lorebook:${hit.entry.id}`, hit.priority, hit.entry.content, hit.triggerHit));
  }

  // 6) card-level post-history instructions (ST semantics: after the transcript, before the reply)
  if (card.postHistoryInstructions.length > 0) {
    const p = place('postHistoryInstructions', 'after_history', 50);
    parts.push(part('card:posthist', p.slot, 'card:post_history_instructions', p.priority, card.postHistoryInstructions));
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
