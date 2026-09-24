/**
 * 一轮产出的**形态判定**（纯函数，无 I/O、无宿主依赖）——可离线单测。
 *
 * ## 为什么单独一个模块（2026-09-25）
 * 插件原判据只有一条：`text.trim().length === 0` ⇒ 空正文。实测（课题 §6.13/§6.14）暴露出
 * 它**过弱**：模型有时把**思考链本身**当正文输出（content 里有 5K 字符、却没有故事），
 * 旧判据会判成功并**把链写进历史**（污染其后每一轮）。
 *
 * ## 判据由**配置声明**，插件不猜预设的协议约定
 * 「正文块长什么样」与「链长什么样」都是**预设侧**的约定 ⇒ 本模块只接受调用方给的标记表：
 * 标记表为空 ⇒ **该项不检查**（默认行为与今日一致，老调用方无需改）。
 *
 * ## 顺序（判定优先级）
 * 空 → 带链 → 无正文块 → ok
 * 先判「带链」再判「无正文」：纯链输出两者都命中，归为**更具体**的 `chain-in-content`（诊断更好）。
 */

/** 一轮产出的形态。`ok` = 可用；其余三种都是缺陷（`chain-in-content` 是**软**缺陷）。 */
export type CompletionVerdict = 'ok' | 'empty-text' | 'no-prose' | 'chain-in-content'

export interface JudgeOptions {
  /** 正文协议块标记（如 `<dream_plot>`）。空数组 ⇒ 不检查「无正文」。 */
  proseMarkers: readonly string[]
  /** 思考链标记（锚句 / 步骤标题）。空数组 ⇒ 不检查「带链」。 */
  chainMarkers: readonly string[]
}

/** 形态的**中文标签**（面向人的原因串用它——主人读的原因里不该出现 `empty-text` 这类枚举名）。 */
export const VERDICT_LABEL: Record<CompletionVerdict, string> = {
  ok: '可用',
  'empty-text': '空正文',
  'no-prose': '有内容但缺正文块',
  'chain-in-content': '把思考链当正文',
}

export interface CompletionJudge {
  kind: CompletionVerdict
  /** 面向人的中文标签（`VERDICT_LABEL[kind]`，随判定一起给出 ⇒ 调用方不必自己拼词表）。 */
  label: string
  /** content 里是否出现正文协议块（`proseMarkers` 为空时恒为 true）。 */
  hasProse: boolean
  /** 命中的链标记（诊断留痕）；未命中为空串。 */
  chainHit: string
}

/**
 * 链标记只在**开头**找：链泄漏的特征是「一开口就是链」。
 * 正文里偶然出现同样的字（例如对白里引了某句话）不该被判成泄漏 ⇒ 只看前 400 字符。
 */
const CHAIN_HEAD_CHARS = 400

export function judgeCompletion(text: string, opts: JudgeOptions): CompletionJudge {
  const label = (kind: CompletionVerdict): string => VERDICT_LABEL[kind]

  if (text.trim().length === 0) {
    return { kind: 'empty-text', label: label('empty-text'), hasProse: false, chainHit: '' }
  }

  const hasProse = opts.proseMarkers.length === 0
    ? true
    : opts.proseMarkers.some((m) => m.length > 0 && text.includes(m))

  const head = text.slice(0, CHAIN_HEAD_CHARS)
  const chainHit = opts.chainMarkers.find((m) => m.length > 0 && head.includes(m)) ?? ''

  if (chainHit !== '') {
    return { kind: 'chain-in-content', label: label('chain-in-content'), hasProse, chainHit }
  }
  if (!hasProse) {
    return { kind: 'no-prose', label: label('no-prose'), hasProse, chainHit: '' }
  }
  return { kind: 'ok', label: label('ok'), hasProse, chainHit: '' }
}

/** 单次尝试的留痕（重试时**逐次**记，不许只留最后一次——否则「重试了几次、每次什么形态」查不到）。 */
export interface AttemptRecord {
  /** 第几次尝试（1 起）。 */
  attempt: number
  verdict: CompletionVerdict
  /** 正文字符数（去空白）。 */
  contentChars: number
  /** 思维链字符数（去空白）。 */
  reasoningChars: number
  finishKind: string
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number }
}

/**
 * 用尽重试后的**接受规则**（本模块唯一的策略判断，其余都是形态识别）。
 *
 * - `ok` ⇒ 接受。
 * - `chain-in-content` **且**有正文块 ⇒ **接受并标记**：故事确实交付了，丢掉更亏（链是硬伤，
 *   但比「整轮白烧」好）——由调用方记 `chainInContent: true` 让报告单列。
 * - `chain-in-content` 且**无**正文块 ⇒ 不接受（等价于纯链输出，没有交付物）。
 * - `empty-text` / `no-prose` ⇒ 不接受。
 */
export function acceptsAfterRetries(judge: CompletionJudge): boolean {
  if (judge.kind === 'ok') return true
  return judge.kind === 'chain-in-content' && judge.hasProse
}
