/**
 * 输出质量判据（「模型表现」族）—— 判**模型输出的形态**，不是判内容好不好。
 *
 * 为什么需要这一族：`quality.ts` 判的是**装配的结构**（重复 / 规范位置 / 预算），
 * 它回答「我发出去的东西好不好」；但主人给本插件定的第二个目的是
 * **研究上下文内容对模型表现的影响** —— 那必须有「**表现**」的读数，
 * 而表现的第一个可测面就是**输出形态是否漂移**。缺了这一族，研究循环只有左半边。
 *
 * 判据来源（都是本仓记录过的真实漂移形态，不是凭空设的）：
 * - `no-option-list` / `no-heading` / `no-meta` ← `preset.ts` 头注：「格式漂移（加小标题、加选项、复述上轮）
 *   几乎全因规范太靠后」；默认预设的 `role` 块正是显式禁止这三样的
 * - `no-repeat-prev`  ← 同上（「复述上轮」）；也是「只追加」设计要防的表现层症状
 *
 * ⚠ 边界（刻意不做的事）：
 * - **不判文笔、不判是否好看**——那是内容层的事，机器判不了也不该判。
 * - **不调模型**：本模块是纯函数，输入是「已经拿到的输出文本」。
 */
import type { ChatMessage } from './types.ts';

export type OutputId = 'no-option-list' | 'no-heading' | 'no-meta' | 'no-repeat-prev';

export interface OutputVerdict {
  id: OutputId;
  ok: boolean;
  detail: string;
}

export interface OutputReport {
  verdicts: OutputVerdict[];
  ok: boolean;
}

export interface OutputInput {
  /** 本轮模型输出的正文。 */
  text: string;
  /** 上一轮正文（用于「复述上轮」判定）；首轮传 undefined。 */
  previous?: string;
}

/** 判断某一行是否像「选项/清单」行：编号、项目符号、圈码。 */
function isListLine(line: string): boolean {
  return /^\s*(?:\d+[.、)]|[-*·•]|①|②|③|④|⑤)/.test(line);
}

/** 判「复述上轮」：存在足够长的连续公共片段（默认 40 字）。 */
function repeatedSpan(prev: string, next: string, minLen: number): string | null {
  if (prev.length < minLen || next.length < minLen) return null;
  for (let i = 0; i + minLen <= prev.length; i += 1) {
    const window = prev.slice(i, i + minLen);
    if (next.includes(window)) return window;
  }
  return null;
}

/** 跑输出形态判据。纯函数：无 IO、无时钟、无随机、**不抛**。 */
export function judgeOutput(input: OutputInput): OutputReport {
  const text = input.text;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');

  // ① 选项列表：≥2 行像清单（单行可能是正常的对话里的「1.」偶然）
  const listLines = lines.filter(isListLine);
  const optionOk = listLines.length < 2;

  // ② 小标题：markdown 标题 或 【…】式小标题（独占一行的方括号抬头）
  const headingLines = lines.filter((l) => /^#{1,6}\s/.test(l) || /^【[^】]{1,30}】$/.test(l));

  // ③ 元说明：OOC / 「注：」「旁白：」「系统：」/ 括号里写创作说明 / 开头的加粗
  // ⚠ 全角 `（` 是**字面量**，不能再配一个半角 `)` —— 那是孤立的右括号（TS1508）。
  const metaHits = text.match(/OOC|（\s*(?:注|旁白|系统|作者|说明)\s*[:：]|\(\s*(?:note|OOC)\s*[:：]|^\s*\*\*[^*]{1,40}\*\*\s*$/m) ?? [];

  // ④ 复述上轮
  const span = input.previous === undefined ? null : repeatedSpan(input.previous, text, 40);

  const verdicts: OutputVerdict[] = [
    {
      id: 'no-option-list',
      ok: optionOk,
      detail: optionOk
        ? `无选项列表（清单式行 ${listLines.length} 行，阈值 <2）`
        : `出现清单式行 ${listLines.length} 行，例如「${listLines[0]?.slice(0, 30)}」`,
    },
    {
      id: 'no-heading',
      ok: headingLines.length === 0,
      detail: headingLines.length === 0
        ? '无小标题行'
        : `出现小标题 ${headingLines.length} 处，例如「${headingLines[0]?.slice(0, 30)}」`,
    },
    {
      id: 'no-meta',
      ok: metaHits.length === 0,
      detail: metaHits.length === 0 ? '无 OOC / 元说明' : `出现元说明 ${metaHits.length} 处：${JSON.stringify(metaHits.slice(0, 3))}`,
    },
    {
      id: 'no-repeat-prev',
      ok: span === null,
      detail: span === null
        ? (input.previous === undefined ? '首轮，不适用' : '与上一轮无 ≥40 字连续重复')
        : `与上一轮有 ${span.length} 字连续重复：「${span.slice(0, 30)}…」`,
    },
  ];
  return { verdicts, ok: verdicts.every((v) => v.ok) };
}

/** 一行摘要。 */
export function describeOutput(report: OutputReport): string {
  const bad = report.verdicts.filter((v) => !v.ok).map((v) => v.id);
  return report.ok ? `输出形态无漂移（${report.verdicts.length} 条）` : `输出形态漂移：${bad.join('、')}`;
}

/** 便利：从消息数组里取最后一条 assistant 正文（研究层常要上一轮正文）。 */
export function lastAssistantText(messages: readonly ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m !== undefined && m.role === 'assistant') return m.text;
  }
  return undefined;
}
