/**
 * 上下文控制面（Control Surface）—— **哪些旋钮可拨**。
 *
 * 这是 2026-09-21「最优上下文」命题三个限定中的**第一个**（另两个是「可测判据」与「搜索预算」）。
 * 命题说「最优上下文存在得太便宜」，工程化的第一步就是把**搜索空间定义出来**：
 * 不知道有哪些旋钮可拨，就无所谓「搜索循环」。
 *
 * 纪律（本模块的判据，见 `tests/control-surface.test.mjs`）：
 * 1. 每个旋钮必须标出「当前值 / 可拨范围 / 怎么量它的效果」三列。
 * 2. 每个旋钮必须**指认它在装配单里的落点**（`manifestField`）——指认不出即空谈；
 *    确实观测不到的，必须显式填 `gap` 说明**为什么**（而不是留空装作有落点）。
 * 3. `manifestField` 是**可解析路径**，测试会拿一份真装配单去解它——路径必须真能解出值。
 *
 * ⚠ 本模块是**数据不是机制**：它不改装配行为，只把既有行为里的可拨项说清楚。
 */
import type { ManifestEntry, ManifestPart } from './types.ts';

/** 旋钮按作用面分族。 */
export type DialFamily =
  | 'position'    // 注入在哪（槽位 / 深度）
  | 'order'       // 注入顺序（优先级）
  | 'trigger'     // 什么时候注入（关键词 / 常开）
  | 'probability' // 注入的概率门
  | 'budget'      // 预算与裁剪
  | 'card-tier'   // 卡片字段的五段分级（优先级写死在代码里）
  | 'template'    // 占位符替换
  | 'content';    // 内容本身（历史 / 状态）

export interface ControlDial {
  id: string;
  family: DialFamily;
  /** 本插件当前的缺省行为（即「不拨」时的值）。 */
  current: string;
  /** 可拨范围——说清楚边界，含「拨不动」的边界。 */
  range: string;
  /** 怎么量它的效果（读什么数、看装配单哪里）。 */
  measure: string;
  /**
   * 它在装配单里的落点（可解析路径）。
   * `null` = **装配单看不出**，此时 `gap` 必填（诚实标注观测缺口）。
   */
  manifestField: string | null;
  /** 仅当 `manifestField === null`：为什么观测不到。 */
  gap?: string;
}

/** 装配单里的可解析路径（供测试逐条解真数据验证）。 */
export const MANIFEST_FIELDS = {
  entrySlot: 'entries[].slot',
  entryRole: 'entries[].role',
  entrySource: 'entries[].source',
  entryPriority: 'entries[].priority',
  entryText: 'entries[].text',
  entryBytes: 'entries[].bytes',
  partSlot: 'entries[].parts[].slot',
  partSource: 'entries[].parts[].source',
  partPriority: 'entries[].parts[].priority',
  partTriggerHit: 'entries[].parts[].triggerHit',
  dropped: 'dropped[]',
  overBudget: 'overBudget',
  totalChars: 'totalChars',
} as const;

/** 全部可拨的上下文旋钮（2026-09-22 由实现逐条核对，不是照文档措辞抄的）。 */
export const CONTROL_SURFACE: readonly ControlDial[] = [
  {
    id: 'slot',
    family: 'position',
    current: '每个片段按 `slot` 决定落点：前四类（system / persona_prefix / before_history / persona_suffix）**并入开头同一条 system 消息**（`\\n\\n` 连接），depth-N 插进历史内部，after_history 落在历史之后、本轮输入之前',
    range: '6 类固定枚举（`Slot` 类型）。**注意语义**：前 4 类不是 4 条消息，而是同一条消息里的 4 个区段',
    measure: '数 `entries[].slot` 的分布；数 `entries[].parts[].slot` 看每个区段各由谁贡献',
    manifestField: MANIFEST_FIELDS.entrySlot,
  },
  {
    id: 'order',
    family: 'order',
    current: 'system 区段内按 `(SLOT_RANK, priority 降序, id 升序)` 排；lorebook 命中按 `(slotRank, order 降序, id 升序)` 排',
    range: '`priority` 为任意数（越大越靠前）。⚠ **只在同一 slot 内生效**——跨 slot 由 SLOT_RANK 决定，所以「提高优先级」**越不过**槽位边界',
    measure: '读 `entries[].parts[].priority` 的实际排列；与预期顺序做逐位比对',
    manifestField: MANIFEST_FIELDS.partPriority,
  },
  {
    id: 'trigger',
    family: 'trigger',
    current: 'lorebook 条目：`constant:true` 必中；否则小写子串匹配 `keywords` 于「末尾 `scanDepth` 条历史 + 本轮输入」；`enabled:false` 永不触发',
    range: 'keywords 任意字符串列表；scanDepth ≥ 0（缺省 = 全历史）。⚠ **keywords 为空且非 constant ⇒ 永不触发，且不报错**（静默陷阱）',
    measure: '看 `entries[].parts[].triggerHit` 记录了**命中的那个关键词**（constant 条目为 undefined）',
    manifestField: MANIFEST_FIELDS.partTriggerHit,
  },
  {
    id: 'probability',
    family: 'probability',
    current: '凡声明 `probability` 的条目，用 `deterministicUnit(entry.id + ":" + turn)` 做门：`unit < probability` 才注入',
    range: '0..1。**同轮必同结果**（可复现），但**跨轮会变** ⇒ 这是「内容随轮次漂移」的旋钮',
    measure: '同轮重跑必得同装配单（可用 A2 的 hash 判）；跨轮命中率需**多轮采样**统计',
    manifestField: null,
    gap: '装配单只记录**中了**什么，不记录**没中**什么 ⇒ 概率门的作用在单份装配单里**不可观测**。要量它必须做多轮对照（同一条目在 n 轮里的命中频次）。**这是控制面目前的一个真实观测缺口**，不是遗漏。',
  },
  {
    id: 'budget',
    family: 'budget',
    current: '`preset.budgetChars` 为硬预算（字符）；超预算时**只裁 lorebook 来源的 system 片段**，按 priority 升序（最低先裁）；裁到不能再裁仍超 ⇒ `overBudget:true`',
    range: 'budgetChars 任意正数或 undefined（= 不限）。⚠ **裁剪的覆盖面很窄**：depth-N / after_history / 历史 **都不参与裁剪**',
    measure: '读 `dropped[]`（被裁的 id）、`overBudget`、`totalChars`',
    manifestField: MANIFEST_FIELDS.dropped,
  },
  {
    id: 'card-tier',
    family: 'card-tier',
    current: '卡片字段按**写死的**优先级分级注入：persona→persona_prefix(100) · description→system(99) · systemPrompt→system(98) · scenario→system(90) · state→system(80) · script→system(70) · exampleDialogue→system(45) · postHistoryInstructions→after_history(50)',
    range: '⚠ **不可拨**——这些优先级与槽位**硬编码在 `assemble.ts` 里**，不是配置项。想调必须改代码 ⇒ 这是控制面当前的**硬边界**，如实标注',
    measure: '看 `entries[].parts[].source`（细到字段：`card:description` / `card:persona` / `card:sysprompt` / `card:scenario` / `card:example` / `card:posthist` / `state` / `script`）与其 priority',
    manifestField: MANIFEST_FIELDS.partSource,
  },
  {
    id: 'template',
    family: 'template',
    current: '预设块文本支持 `{{key}}`；可用 scope：`card.name` / `card.persona` / `card.scenario` / `input` / `state` / `script` / `turn`；**未匹配的占位符原样保留**（不静默清空）',
    range: 'scope 键集固定（上列 7 个）。新增可用键须改 `assemble.ts` 的 `scope` 构造',
    measure: '把装配单里的 `entries[].text` 与**模板原文**对账：能看出哪些占位符被替换、哪些原样留存',
    manifestField: null,
    gap: '装配单只存**渲染后**的文本，不存模板原文，也不记录替换了哪些键 ⇒ 单看装配单**分不清**「占位符被替换成了同名文本」与「占位符没被替换」。量它需要**同时持有模板**（或让装配单增记 `resolvedKeys`）。',
  },
  {
    id: 'history',
    family: 'content',
    current: '游历历史按 `history:i` 顺序注入，各成一条消息；**只追加，不重写**（不变量 4）',
    range: '只追加。任何「重写历史前缀」的设计都会破坏缓存 ⇒ 须显式标注',
    measure: '数 `entries[].source` 里 `history:*` 的条数与顺序；配合 A4 的缓存读数看「只追加」是否兑现',
    manifestField: MANIFEST_FIELDS.entrySource,
  },
  {
    id: 'state',
    family: 'content',
    current: '后台结算 Agent 写入的状态，经 `canonicalJson` 后作为一条 system 片段注入（priority 80）；正文与候选**只读**',
    range: '状态形状目前是**自由 JSON**（§9 未决 4）⇒ 可拨范围 = 任意键值；代价是**不可校验**',
    measure: '看 `entries[].parts[].source === "state"` 的那段文本，与结算写入逐字节比对',
    manifestField: MANIFEST_FIELDS.partSource,
  },
];

/**
 * 解析装配单路径（测试用它验证「每个旋钮都真指认到了一个能解出来的落点」）。
 * 支持 `a.b` 与 `a[].b` 两种形态；解析不出返回 `undefined`。**不抛**。
 *
 * ⚠ 数组段的语义是「**至少一个元素**解得出」，**不是**「每个元素都解得出」——这是本函数
 * 首版的错，且当场被自己的判据抓住（2026-09-22）：`entries[].parts[].triggerHit` 里，
 * 历史条目的 `parts` 是空数组，若要求「每个都解出」则该路径恒为 undefined，
 * 于是**所有 parts 级落点都会假红**。这里的问法是「**这个字段在某处可观测吗**」，
 * 存在性即可满足（哪个元素有值不影响「可观测」这个结论）。
 */
export function resolveManifestPath(root: unknown, path: string): unknown {
  const segments = path.split('.');
  let current: unknown = root;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] as string;
    const isArray = segment.endsWith('[]');
    const key = isArray ? segment.slice(0, -2) : segment;
    if (current === null || typeof current !== 'object') return undefined;
    const value = (current as Record<string, unknown>)[key];
    if (!isArray) { current = value; continue; }
    if (!Array.isArray(value) || value.length === 0) return undefined;
    const rest = segments.slice(i + 1).join('.');
    if (rest === '') { current = value; continue; }
    const resolved = value
      .map((item) => resolveManifestPath(item, rest))
      .filter((r) => r !== undefined);
    return resolved.length === 0 ? undefined : resolved;
  }
  return current;
}

/** 装配单里被本表引用到的结构（仅供类型自检，运行时不使用）。 */
export type ReferencedManifestShape = { entry: ManifestEntry; part: ManifestPart };
