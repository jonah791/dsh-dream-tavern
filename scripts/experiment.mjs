#!/usr/bin/env node
/**
 * experiment.mjs — **迭代回路**的编排器（2026-09-23 新增）。
 *
 * ## 为什么要有它
 * 「迭代预设」这条环此前每转一圈都要人手接三次：改预设 → 手工跑轮 → 手工导出 →
 * 手工跑 python 度量 → 手工把数字抄进对照表。手工环节越多，「快速迭代」越做不动，
 * 而且**导出口径无记录** ⇒ 两轮读数不可比（`export-draft.mjs` 头部记的就是这个痛点）。
 *
 * 本脚本把这条环变成两拍：
 *   ① `--emit`     ：从实验计划生成**待跑轮次清单**（含每轮该用的工具参数）
 *   ② `--collect`  ：跑完之后一条命令收口——逐轮导出（散文 + 思维链）→ 逐轮度量 →
 *                    **对照表**（markdown，落到 `<dataDir>/experiments/<name>/REPORT.md`）
 *
 * ## 它**不**做什么（边界，如实声明）
 * - **不调模型**：跑轮次必须走工具面（`tavern_play`），脚本只生成清单与收口。
 *   理由：模型调用是会话的能力，脚本里再开一条通路就等于第二条通往模型的路（违反 A7）。
 * - **不判好坏**：只出读数。内容层判断归作者（`context-effect-research` §七 反定位）。
 *
 * ## 实验计划格式（JSON）
 * ```json
 * {
 *   "name": "macro-render-v1",
 *   "cardId": "仙母种情",
 *   "inputs": ["第一轮输入", "第二轮输入", "第三轮输入"],
 *   "arms": [
 *     { "label": "V3.4", "preset": "E:/alice/tavern/色欲之罪V3.4.json" },
 *     { "label": "V3.5-macro", "preset": "E:/alice/tavern/色欲之罪.json" }
 *   ],
 *   "repeats": 3
 * }
 * ```
 * 每个 arm × repeats = 一个**独立会话**（会话隔离 ⇒ 历史不互相污染；同 arm 的多个会话
 * 是同一条件的重复样本 ⇒ 单场戏不下定论，n≥3）。
 *
 * ## 用法
 * ```
 * node scripts/experiment.mjs --plan exp.json --emit
 * node scripts/experiment.mjs --plan exp.json --collect [--json]
 * ```
 * 退出码：0 成功；2 计划文件不可读/不合法；3 收口时缺数据（会话目录不存在）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = (name) => argv.includes('--' + name)
const opt = (name, fallback) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}

if (flag('help') || argv.length === 0) {
  console.log('用法: node scripts/experiment.mjs --plan <计划.json> --emit | --collect [--json]')
  process.exit(0)
}

const planPath = opt('plan', '')
if (planPath === '') {
  console.error('FATAL: 必须给 --plan <实验计划.json>')
  process.exit(2)
}

/**
 * 路径归一（2026-09-23 实测需要）：脚本要在 Windows node 与 WSL node 下都能跑，
 * 而计划文件里写的是 Windows 形态（`E:/alice/…`，因为 `preset` 那一栏要交给
 * Windows 侧的工具面）。本机不存在的形态就换成另一种（`E:/x` ↔ `/mnt/e/x`）。
 * 夹具/工具不得依赖运行平台——`tests/*.test.mjs` 的 `pickRoot()` 是同一纪律。
 * @param p - 待归一的路径。
 * @returns 本机真实存在的形态；两者都不存在时原样返回（交给调用方响亮失败）。
 */
function normalizePath(p) {
  if (existsSync(p)) return p
  const wsl = p.replace(/^([A-Za-z]):[\\/]/, (_, drive) => `/mnt/${drive.toLowerCase()}/`)
  return existsSync(wsl) ? wsl : p
}

const planFile = normalizePath(planPath)
let plan
try {
  plan = JSON.parse(readFileSync(planFile, 'utf8'))
} catch (err) {
  console.error('FATAL: 计划文件不可读或不是合法 JSON：' + String(err))
  process.exit(2)
}

/** 计划校验：缺项即响亮失败（不猜默认值——猜出来的实验条件没有可比性）。 */
const problems = []
if (typeof plan.name !== 'string' || plan.name.trim() === '') problems.push('缺少 name')
if (typeof plan.cardId !== 'string' || plan.cardId.trim() === '') problems.push('缺少 cardId')
if (!Array.isArray(plan.inputs) || plan.inputs.length === 0) problems.push('缺少 inputs（至少 1 条）')
if (!Array.isArray(plan.arms) || plan.arms.length < 1) problems.push('缺少 arms（至少 1 条）')
for (const [i, arm] of (plan.arms ?? []).entries()) {
  if (typeof arm?.label !== 'string' || arm.label.trim() === '') problems.push(`arms[${i}] 缺少 label`)
  if (typeof arm?.preset !== 'string' || arm.preset.trim() === '') problems.push(`arms[${i}] 缺少 preset`)
}
if (problems.length > 0) {
  console.error('FATAL: 实验计划不合法：\n  - ' + problems.join('\n  - '))
  process.exit(2)
}

const repeats = Number.isInteger(plan.repeats) && plan.repeats > 0 ? plan.repeats : 1
// ⚠ **顺序：先归一（`E:/x` → `/mnt/e/x`）再 resolve**。反过来时 `resolve('E:/x')` 在 Linux 下
// 会把 `E:` 当成相对路径段拼到 cwd 上（实测：得到 `<插件目录>/E:/alice/...`），此后归一再也
// 匹配不到那个形态，于是「缺数据」的假象就出现了。
// dataDir 的优先级：CLI `--dataDir` > 计划文件里的 `dataDir` > `$DSH_HOME/dream-tavern-data`。
const dataDirRaw = opt('dataDir', typeof plan.dataDir === 'string' && plan.dataDir.trim() !== ''
  ? plan.dataDir
  : join(process.env['DSH_HOME'] ?? '.', 'dream-tavern-data'))
const dataDir = resolve(normalizePath(dataDirRaw))
const outDir = join(dataDir, 'experiments', plan.name)

/** 会话 id：`<实验名>-<arm 序号>-r<重复号>`——可反解出 arm 与重复号（收口时靠它分组）。 */
function sessionIdFor(armIndex, repeatIndex) {
  return `${plan.name}-a${armIndex + 1}-r${repeatIndex + 1}`
}

/** 待跑轮次：每个 arm × repeats 个会话 × inputs 序列。 */
function buildRuns() {
  const runs = []
  for (const [ai, arm] of plan.arms.entries()) {
    for (let r = 0; r < repeats; r += 1) {
      const session = sessionIdFor(ai, r)
      for (const [ti, input] of plan.inputs.entries()) {
        runs.push({
          arm: arm.label,
          armIndex: ai,
          repeat: r + 1,
          session,
          turn: ti + 1,
          input,
          preset: arm.preset,
          // arm 级 system 追加（可选）：`tavern_play` 的 systemPrompt 参数是**追加一个最高
          // 优先级 system 块**（不是替换），所以它天然适合做「加一段纪律」这类单变量对照。
          ...(typeof arm.systemPrompt === 'string' && arm.systemPrompt.trim() !== ''
            ? { systemPrompt: arm.systemPrompt }
            : {}),
        })
      }
    }
  }
  return runs
}

const runs = buildRuns()

// ── --emit：待跑轮次清单 ──────────────────────────────────────────────────
if (flag('emit')) {
  if (flag('json')) {
    console.log(JSON.stringify({ plan: plan.name, cardId: plan.cardId, dataDir, outDir, runs }, null, 2))
    process.exit(0)
  }
  console.log(`实验 ${plan.name} · 卡「${plan.cardId}」· ${plan.arms.length} 臂 × ${repeats} 重复 × ${plan.inputs.length} 轮 = ${runs.length} 轮`)
  console.log('（跑轮次走工具面 `tavern_play`；下面每行就是该轮的参数）\n')
  let lastSession = ''
  for (const run of runs) {
    if (run.session !== lastSession) {
      lastSession = run.session
      console.log(`── arm=${run.arm}  会话=${run.session} ──`)
    }
    console.log(`  轮 ${run.turn}: tavern_play { cardId: "${plan.cardId}", session: "${run.session}", preset: "${run.preset}",${run.systemPrompt === undefined ? '' : ' systemPrompt: <arm 追加>, '} input: <第 ${run.turn} 条输入> }`)
  }
  console.log(`\n跑完后收口：node scripts/experiment.mjs --plan ${planPath} --collect`)
  process.exit(0)
}

// ── --collect：导出 + 度量 + 对照表 ───────────────────────────────────────
const pythonCmd = process.env['PYTHON'] ?? (process.platform === 'win32' ? 'python' : 'python3')
const sampleReport = normalizePath(process.env['SAMPLE_REPORT']
  ?? resolve(HERE, '..', '..', '..', 'tavern', '文风', '位格统计', 'sample_report.py'))

/** 用 node 直接跑子脚本（不经 shell：路径含空格时 shell 会拆开——2026-09-22 的假红灯教训）。 */
function runNode(args) {
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }
}

/**
 * 解析 `sample_report.py` 的单篇输出。
 * 口径：只取**可复算**的几项；解析不到就记 `null`（不猜、不用 0 冒充）。
 */
function parseReport(stdout) {
  const num = (re) => {
    const m = stdout.match(re)
    return m === null ? null : Number(m[1])
  }
  const slot = (name) => {
    const m = stdout.match(new RegExp('\\n\\s*' + name + ' \\|\\s*(\\d+)%'))
    return m === null ? null : Number(m[1])
  }
  const repeat = stdout.match(/④ 复读[^:]*:\s*(\S+)/)
  return {
    chars: num(/① 字数:\s*(\d+)/),
    medianSlots: (() => {
      const m = stdout.match(/位数中位 = ([\d.]+)/)
      return m === null ? null : Number(m[1])
    })(),
    fourPlusPct: num(/≥4 位占\s*(\d+)%/),
    avgSegLen: num(/平均段长\s*(\d+)\s*字/),
    relationPct: slot('关'),
    bodyPct: slot('体'),
    actionPct: slot('动'),
    repeatVerdict: repeat === null ? null : repeat[1],
  }
}

const rows = []
const missing = []
for (const run of runs) {
  const sessionDir = join(dataDir, 'sessions', run.session)
  if (!existsSync(sessionDir)) {
    missing.push(run.session)
    continue
  }
  const exportRes = runNode([join(HERE, 'export-draft.mjs'), '--session', run.session, '--dataDir', dataDir, '--prose-only', '--reasoning', '--json'])
  if (exportRes.status !== 0) {
    rows.push({ ...run, error: 'export 失败：' + (exportRes.stderr.trim() || exportRes.stdout.trim()) })
    continue
  }
  let exported
  try {
    exported = JSON.parse(exportRes.stdout)
  } catch (err) {
    rows.push({ ...run, error: 'export 输出不是合法 JSON：' + String(err) })
    continue
  }
  // ── 对齐：第 n 个输入 ↔ 第 n 条 **turn record**（不是第 n 份稿）──────────
  // 为什么用 turn record 而不是稿序：空正文轮**拒绝写历史**（避免 0 字符行污染其后每一轮），
  // 所以「稿序」在第一次失败后整体前移 ⇒ 拿稿序对齐会把第 3 轮的稿当成第 2 轮的读数。
  // turn record 每轮都写（无论成败），是唯一**逐轮**的记录。
  // ⚠ 已知边界（诚实标注）：record 按 turn 号落盘 ⇒ **同一 turn 的重试会覆盖**前一次的失败
  //   记录（实测 discipline 臂：第 1 轮失败、第 2 轮同 turn 成功，只留成功那条）。
  //   因此「这一轮曾经失败过」在覆盖后不可测；根治需让 record 记 input 摘要（已列待办）。
  const turnsDir = join(sessionDir, 'turns')
  const recordFiles = existsSync(turnsDir)
    ? readdirSync(turnsDir).filter((f) => f.endsWith('.json')).sort()
    : []
  const readRecord = (f) => {
    try {
      return JSON.parse(readFileSync(join(turnsDir, f), 'utf8'))
    } catch {
      return null
    }
  }
  const allRecords = recordFiles.map((f) => ({ file: f, rec: readRecord(f) }))
  const hasInputHeads = allRecords.some((x) => typeof x.rec?.inputHead === 'string' && x.rec.inputHead !== '')
  // ① 首选**按内容**对齐（record 带 inputHead，2026-09-23 起）：同一输入被重试多次时取
  //    **最后一条**（它代表该输入的最终结果）。
  const byContent = allRecords.filter((x) => typeof x.rec?.inputHead === 'string'
    && x.rec.inputHead !== '' && run.input.startsWith(x.rec.inputHead))
  let picked = byContent.length > 0 ? byContent[byContent.length - 1] : null
  let alignedBy = 'input'
  if (picked === null && hasInputHeads) {
    // ② record 里有 inputHead 但**没有一条匹配本轮输入** ⇒ 本轮的记录**不存在**
    //    （典型成因：该轮失败后，同 turn 的后续尝试**覆盖**了它）。此时**必须报缺失**——
    //    退回顺序对齐会把别人的产出当成本轮的读数（实测误报：「第 2 轮没跑」）。
    rows.push({
      ...run,
      noRecord: true,
      recordCount: recordFiles.length,
      note: `该会话 ${recordFiles.length} 条轮次记录里没有一条匹配本轮输入 ⇒ 本轮记录缺失（多半被同 turn 的后续尝试覆盖）`,
    })
    continue
  }
  if (picked === null) {
    // ③ 老数据（record 无 inputHead）⇒ 退回顺序对齐，并**如实标注**这是弱对齐
    const f = recordFiles[run.turn - 1]
    if (f === undefined) {
      rows.push({
        ...run,
        noRecord: true,
        recordCount: recordFiles.length,
        note: `该会话只有 ${recordFiles.length} 条轮次记录，第 ${run.turn} 轮没有记录 ⇒ 该轮没跑`,
      })
      continue
    }
    picked = { file: f, rec: readRecord(f) }
    alignedBy = 'order'
  }
  const record = picked.file
  const rec = picked.rec
  if (rec === null) {
    rows.push({ ...run, error: `轮次记录不可解析：${record}` })
    continue
  }
  if (rec.ok !== true) {
    rows.push({
      ...run,
      emptyBody: true,
      turnRecord: record,
      reasoningChars: rec.reasoningChars ?? null,
      note: `轮次记录 ${record} 标 ok=false（空正文/失败）⇒ 该轮无产出`,
    })
    continue
  }
  // 成功轮 ↔ 稿：drafts 只含成功轮，按**成功次序**索引（在 picked 之前有几条 ok）
  const pickedIndex = recordFiles.indexOf(record)
  const successIndex = recordFiles.slice(0, pickedIndex + 1)
    .map((f) => readRecord(f)?.ok === true)
    .filter(Boolean).length - 1
  const draft = exported.drafts?.[successIndex]
  if (draft === undefined) {
    rows.push({
      ...run,
      error: `轮次记录 ${record} 标成功，但导出里取不到第 ${successIndex + 1} 份成功稿（导出 ${exported.drafts?.length ?? 0} 份）`,
    })
    continue
  }
  const reportRes = spawnSync(pythonCmd, [sampleReport, draft.file], { encoding: 'utf8' })
  if (reportRes.status !== 0) {
    rows.push({ ...run, draftFile: draft.file, error: '度量失败：' + (reportRes.stderr ?? '').trim().slice(0, 200) })
    continue
  }
  rows.push({
    ...run,
    alignedBy,
    draftFile: draft.file,
    chars: draft.chars,
    reasoningChars: draft.reasoningChars ?? null,
    ...parseReport(reportRes.stdout ?? ''),
  })
}

/** 按 arm 聚合（中位数；单场戏不下定论 ⇒ 报告里显式写 n）。 */
function median(values) {
  const xs = values.filter((v) => typeof v === 'number').sort((a, b) => a - b)
  if (xs.length === 0) return null
  const mid = Math.floor(xs.length / 2)
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2
}

const byArm = new Map()
for (const row of rows) {
  if (row.error !== undefined) continue
  const list = byArm.get(row.arm) ?? []
  list.push(row)
  byArm.set(row.arm, list)
}

const summary = [...byArm.entries()].map(([arm, list]) => ({
  arm,
  // `n` = 该臂**全部尝试轮数**（含空正文轮）——分母必须是尝试数，不能只数成功的，
  // 否则「一半轮次空正文」会被中位数掩盖成「一切正常」。
  n: list.length,
  emptyBody: list.filter((r) => r.emptyBody === true).length,
  charsMedian: median(list.map((r) => r.chars)),
  medianSlots: median(list.map((r) => r.medianSlots)),
  fourPlusPct: median(list.map((r) => r.fourPlusPct)),
  relationPct: median(list.map((r) => r.relationPct)),
  bodyPct: median(list.map((r) => r.bodyPct)),
  reasoningCharsMedian: median(list.map((r) => r.reasoningChars)),
  repeatFail: list.filter((r) => r.repeatVerdict !== null && r.repeatVerdict !== 'PASS').length,
}))

mkdirSync(outDir, { recursive: true })
const fmt = (v) => (v === null || v === undefined ? '—' : String(v))
const lines = []
lines.push(`# 实验报告 · ${plan.name}`)
lines.push('')
lines.push(`> 卡「${plan.cardId}」· ${plan.arms.length} 臂 × ${repeats} 重复 × ${plan.inputs.length} 轮 · 计划 \`${planPath}\``)
lines.push(`> 口径：散文 = \`<dream_body>\` 内层（\`export-draft --prose-only\`）；位判据 = \`sample_report.py\` 的现算词表；`)
lines.push('> 每臂的多个会话是**独立重复样本**（会话隔离，历史不互相污染）。')
lines.push('> **空正文轮**：插件拒绝写入历史 ⇒ 该轮无稿。它计入 `n`（分母＝尝试数），不计入中位数。')
lines.push('')
lines.push('## 对照（每格为该臂全部**有产出轮**的中位数）')
lines.push('')
lines.push('| 臂 | 尝试轮 n | **空正文轮** | 正文字数 | 思维链字数 | 位数中位 | ≥4位% | 关位% | 体位% | 复读非PASS |')
lines.push('|---|---|---|---|---|---|---|---|---|---|')
for (const s of summary) {
  lines.push(`| ${s.arm} | ${s.n} | **${s.emptyBody}** | ${fmt(s.charsMedian)} | ${fmt(s.reasoningCharsMedian)} | ${fmt(s.medianSlots)} | ${fmt(s.fourPlusPct)} | ${fmt(s.relationPct)} | ${fmt(s.bodyPct)} | ${s.repeatFail} |`)
}
lines.push('')
lines.push('## 逐轮明细')
lines.push('')
lines.push('| 臂 | 会话 | 轮 | 正文字数 | 思维链 | 位数中位 | 关位% | 复读 | 稿 |')
lines.push('|---|---|---|---|---|---|---|---|---|')
for (const row of rows) {
  if (row.error !== undefined) {
    lines.push(`| ${row.arm} | ${row.session} | ${row.turn} | — | — | — | — | — | ⚠ ${row.error} |`)
    continue
  }
  if (row.noRecord === true) {
    lines.push(`| ${row.arm} | ${row.session} | ${row.turn} | — | — | — | — | — | ${row.note} |`)
    continue
  }
  if (row.emptyBody === true) {
    lines.push(`| ${row.arm} | ${row.session} | ${row.turn} | **空正文** | — | — | — | — | ${row.note} |`)
    continue
  }
  lines.push(`| ${row.arm} | ${row.session} | ${row.turn} | ${fmt(row.chars)} | ${fmt(row.reasoningChars)} | ${fmt(row.medianSlots)} | ${fmt(row.relationPct)} | ${fmt(row.repeatVerdict)} | \`${row.draftFile.split(/[\\/]/).pop()}\`${row.alignedBy === 'order' ? ' ⚠顺序对齐' : ''} |`)
}
if (missing.length > 0) {
  lines.push('')
  lines.push(`⚠ **缺数据**：${[...new Set(missing)].join(' / ')} —— 会话目录不存在（那几轮没跑）。`)
}
lines.push('')
lines.push('## 诚实边界')
lines.push('')
lines.push('- 本报告**不给总分、不判好坏**：只出可复算读数，内容层判断归作者。')
lines.push('- 单臂 n < 3 时只能说趋势，不能下结论（§3 口径纪律）。')
lines.push('- 跨题材比较无效：素材的位配比是**题材的函数**，必须同题材对照。')
lines.push('')

const reportPath = join(outDir, 'REPORT.md')
writeFileSync(reportPath, lines.join('\n'), 'utf8')

if (flag('json')) {
  console.log(JSON.stringify({ plan: plan.name, reportPath, summary, rows, missing: [...new Set(missing)] }, null, 2))
} else {
  console.log(`实验 ${plan.name}：收口 ${rows.length} 轮 → ${reportPath}`)
  for (const s of summary) {
    console.log(`  ${s.arm}: 尝试 ${s.n} 轮（空正文 ${s.emptyBody}）正文字数中位=${fmt(s.charsMedian)} 位数中位=${fmt(s.medianSlots)} 关位%=${fmt(s.relationPct)} 思维链中位=${fmt(s.reasoningCharsMedian)}`)
  }
  const failed = rows.filter((r) => r.error !== undefined)
  if (failed.length > 0) console.log(`  ⚠ ${failed.length} 轮有错误（见报告逐轮明细）`)
  if (missing.length > 0) console.log(`  ⚠ 缺 ${[...new Set(missing)].length} 个会话的数据`)
}

// 缺数据即响亮失败（否则「读数少了一半」会被当成「实验做完了」）
if (missing.length > 0) process.exit(3)
