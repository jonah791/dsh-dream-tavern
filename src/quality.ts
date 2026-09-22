/**
 * 装配质量判据（「装得**好**不好」）—— 与 `verifyAgainstActual`（即 A1，验「装得**对**不对」）分族。
 *
 * 为什么要有这一族：A1–A7 全部在验**机制正确性**（装配单是否逐字节等于实发请求、回退是否原子、
 * 往返是否丢字段…）。它们**全绿也不代表这次上下文是好的**——两条判据族回答的是两个问题：
 *   · 正确性：**我发出的东西，是不是我以为发出的那个？**
 *   · 质量：  **我以为发出的那个，是不是个好上下文？**
 *
 * ⚠ 边界（本模块刻意不做的事）：
 * - **不判断内容好不好**——那是内容层（预设作者）的判断，不是机制的判断。
 *   本模块只判**结构上已知会坏事**的形态。
 * - **不引入模型调用**：全部纯函数、离线可跑（研究循环要能廉价地反复跑）。
 *
 * 三条判据各自对应一次真实事故，不是凭空设的（§5.9 规则 1：判据要有来源）：
 * - `no-duplicate`  ← 2026-09-22 世界书重复注入事故（`assemble.ts` 内注：单卡请求被撑到近 20k 字）
 * - `norm-first`    ← 酒馆实战教训②：「格式漂移几乎全因规范太靠后」（`preset.ts` 头注）
 * - `within-budget` ← 超预算必须响亮记账，不得静默截断（`overBudget` 字段的存在理由）
 */
import type { Manifest, Preset } from './types.ts';

export type QualityId = 'no-duplicate' | 'norm-first' | 'within-budget';

export interface QualityVerdict {
  id: QualityId;
  ok: boolean;
  /** 一行可读证据；通过时也要给出**读数**（不是只说 ok）。 */
  detail: string;
}

export interface QualityReport {
  verdicts: QualityVerdict[];
  /** 全过才算好；空表视为通过（没有判据要说坏话）。 */
  ok: boolean;
}

export interface QualityInput {
  manifest: Manifest;
  preset: Preset;
  /**
   * 哪个/哪些 preset block 是「输出规范」（格式纪律、禁止事项）。
   * **由调用方指名**——本模块不替内容层判断「哪段文字是规范」。
   */
  normBlockIds: readonly string[];
}

/** 同一来源或同一文本被装进上下文两次 —— 纯浪费预算，且可能给出互相矛盾的指令。 */
function judgeNoDuplicate(manifest: Manifest): QualityVerdict {
  const bySource = new Map<string, string[]>();
  const byText = new Map<string, string[]>();
  for (const entry of manifest.entries) {
    for (const p of entry.parts) {
      const s = bySource.get(p.source) ?? [];
      s.push(p.id);
      bySource.set(p.source, s);
      const t = byText.get(p.sha256) ?? [];
      t.push(p.id);
      byText.set(p.sha256, t);
    }
  }
  const dupSources = [...bySource.entries()].filter(([, ids]) => ids.length > 1);
  const dupTexts = [...byText.entries()].filter(([, ids]) => ids.length > 1);
  const problems: string[] = [];
  for (const [source, ids] of dupSources) problems.push(`来源 ${source} 出现 ${ids.length} 次（${ids.join('、')}）`);
  for (const [, ids] of dupTexts) problems.push(`同文本片段出现 ${ids.length} 次（${ids.join('、')}）`);
  return {
    id: 'no-duplicate',
    ok: problems.length === 0,
    detail: problems.length === 0
      ? `无重复片段（检查 ${manifest.entries.reduce((n, e) => n + e.parts.length, 0)} 个片段）`
      : problems.join('；'),
  };
}

/**
 * 输出规范必须落在 system 区段**最前**。
 *
 * 判据取「最前」而非「在 system 里」：`SLOT_RANK` 只把 system 排到最前，**区内顺序由 priority 定**
 * ⇒ 规范块若 priority 低于其它 system 片段（如卡片的 description=99），它照样会被挤到后面，
 * 也就是那条教训说的「规范太靠后」。两条都要满足才算真的「写在最外层」。
 */
function judgeNormFirst(manifest: Manifest, preset: Preset, normBlockIds: readonly string[]): QualityVerdict {
  if (normBlockIds.length === 0) {
    return { id: 'norm-first', ok: true, detail: '未指名规范块（本判据不适用；指名后才会真正生效）' };
  }
  const problems: string[] = [];
  const systemParts = manifest.entries
    .flatMap((e) => e.parts)
    .filter((p) => p.slot === 'system');
  const topPriority = systemParts.reduce((n, p) => Math.max(n, p.priority), Number.NEGATIVE_INFINITY);
  for (const id of normBlockIds) {
    const block = preset.blocks.find((b) => b.id === id);
    if (block === undefined) { problems.push(`规范块 ${id} 不在预设里（名字写错或已被删）`); continue; }
    if (block.slot !== 'system') { problems.push(`规范块 ${id} 在 ${block.slot}，不在 system 区段`); continue; }
    if (block.priority < topPriority) {
      problems.push(`规范块 ${id} 的 priority=${block.priority} 低于 system 区段的最高 ${topPriority} ⇒ 会被挤到后面`);
    }
  }
  return {
    id: 'norm-first',
    ok: problems.length === 0,
    detail: problems.length === 0
      ? `规范块 ${normBlockIds.join('、')} 位于 system 区段最前（区段最高 priority=${topPriority}）`
      : problems.join('；'),
  };
}

function judgeWithinBudget(manifest: Manifest): QualityVerdict {
  return {
    id: 'within-budget',
    ok: !manifest.overBudget,
    detail: manifest.overBudget
      ? `超预算：${manifest.totalChars} 字 > 预设预算，且已裁 ${manifest.dropped.length} 条`
      : `预算内：${manifest.totalChars} 字，裁掉 ${manifest.dropped.length} 条（overBudget=false）`,
  };
}

/** 跑三条质量判据。纯函数：无 IO、无时钟、无随机、**不抛**。 */
export function judgeAssembly(input: QualityInput): QualityReport {
  const verdicts: QualityVerdict[] = [
    judgeNoDuplicate(input.manifest),
    judgeNormFirst(input.manifest, input.preset, input.normBlockIds),
    judgeWithinBudget(input.manifest),
  ];
  return { verdicts, ok: verdicts.every((v) => v.ok) };
}

/** 一行摘要（落轨迹 / 给研究层当标签用）。 */
export function describeQuality(report: QualityReport): string {
  const bad = report.verdicts.filter((v) => !v.ok).map((v) => v.id);
  return report.ok
    ? `质量判据全过（${report.verdicts.length} 条）`
    : `质量判据未过：${bad.join('、')}`;
}
