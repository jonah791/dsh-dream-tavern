#!/usr/bin/env node
/**
 * export-draft.mjs — 把一次酒馆会话的**模型产出**导出成可分析稿（每轮一个 .md）。
 *
 * ## 为什么要有它（2026-09-23）
 * `tavern_play` 把正文落在 `sessions/<会话>/history.jsonl`（一行 `{role,text}`），
 * 而质量度量装置（`tavern/文风/位格统计/sample_report.py`）吃的是 **.md 稿**。
 * 缺口就在这里：产出→度量之间原先靠**手工导出**，于是「迭代预设」这条环每转一圈都要人手接一次，
 * 且导出口径（取哪几轮、要不要去空白）无记录 ⇒ 两轮读数不可比。
 * 本脚本把这一步变成一条命令，并把**口径打进输出**（每轮字数、来源会话、行号）。
 *
 * ## 口径（显式写死，避免两轮不可比）
 * - 只取 `role === 'assistant'` 的行；**第 1 个 assistant 轮通常是卡自带的开场白**（`first_mes`），
 *   不是模型产出 ⇒ 默认**跳过**，`--keep-opening` 可保留。
 * - 一轮 = history 里一个 assistant 行（不合并、不切分）。
 * - 文本**原样落盘**（不 trim 内部空白）；文件末尾补一个换行。
 *
 * ## 用法
 *   node scripts/export-draft.mjs --session <会话id> [--dataDir <目录>] [--outDir <目录>]
 *                                [--keep-opening] [--json]
 *
 * 退出码：0 成功；2 会话目录/历史缺失（响亮失败，不静默产出空稿）；3 没有可导出的轮。
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes('--' + name)
const opt = (name, fallback) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}

if (flag('help') || argv.length === 0) {
  console.log('用法: node scripts/export-draft.mjs --session <会话id> [--dataDir <目录>] [--outDir <目录>] [--keep-opening] [--json]')
  process.exit(0)
}

const session = opt('session', '')
if (session === '') {
  console.error('FATAL: 必须给 --session <会话id>（会话目录名，见 sessions/ 下）')
  process.exit(2)
}
const dataDir = resolve(opt('dataDir', join(process.env['DSH_HOME'] ?? '.', 'dream-tavern-data')))
const sessionDir = join(dataDir, 'sessions', session)
const historyPath = join(sessionDir, 'history.jsonl')

if (!existsSync(sessionDir)) {
  console.error('FATAL: 会话目录不存在: ' + sessionDir)
  process.exit(2)
}
if (!existsSync(historyPath)) {
  console.error('FATAL: 历史缺失: ' + historyPath + '（该会话尚未落过一轮？）')
  process.exit(2)
}

const lines = readFileSync(historyPath, 'utf8').split('\n').filter((l) => l.trim() !== '')
const rows = []
for (const [i, line] of lines.entries()) {
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch (e) {
    console.error('FATAL: history.jsonl 第 ' + (i + 1) + ' 行不是合法 JSON: ' + String(e))
    process.exit(2)
  }
  rows.push({ line: i + 1, role: String(parsed.role ?? ''), text: String(parsed.text ?? '') })
}

const assistantRows = rows.filter((r) => r.role === 'assistant')
if (assistantRows.length === 0) {
  console.error('FATAL: 该会话没有任何 assistant 轮——没有可导出的产出')
  process.exit(3)
}

const keepOpening = flag('keep-opening')
// 第 1 个 assistant 轮默认视为卡自带开场白（不是模型产出）——跳过，并在报告里如实标注。
const skipped = keepOpening || assistantRows.length === 0 ? null : assistantRows[0]
const picked = keepOpening ? assistantRows : assistantRows.slice(1)

if (picked.length === 0) {
  console.error('FATAL: 除开场白外没有模型产出轮（只有 1 个 assistant 行）。'
    + '要么再跑一轮，要么用 --keep-opening 连开场白一起导。')
  process.exit(3)
}

const outDir = resolve(opt('outDir', join(sessionDir, 'drafts')))
mkdirSync(outDir, { recursive: true })

/**
 * 从协议文档里取出**散文**部分（`--prose-only`）。
 * 先截 `<dream_body>` 内层；再去掉非散文的协议块（`<dream_scene>` 的 date/time/location）；
 * 最后剥掉剩余协议标签本身，**保留其内的散文**（`<dream_narrate>` 是罪司的凝视，属散文）。
 * 找不到 `<dream_body>` 时原样返回——不猜、不静默产出空稿。
 * @param text - 一轮的原始正式输出。
 * @returns 供度量器统计的散文文本。
 */
const toProse = (text) => {
  const m = text.match(/<dream_body>([\s\S]*?)<\/dream_body>/)
  const body = m === null ? text : m[1]
  return body
    .replace(/<dream_scene>[\s\S]*?<\/dream_scene>/g, '')
    .replace(/<\/?[a-zA-Z_][\w-]*>/g, '')
    .trim()
}
const wantProseOnly = flag('prose-only')

const report = []
// 思维链（响应侧证据，`reasoning/<turn>.md`）与 assistant 轮**按顺序配对**。
// 不靠 history 行号反推轮次——开场白有无会让 `行号 ↔ 轮次` 的映射变两种（实测过），
// 靠顺序配对 + 数量对账才稳：数量不齐就响亮报出，不猜。
const reasoningDir = join(sessionDir, 'reasoning')
const reasoningFiles = existsSync(reasoningDir)
  ? readdirSync(reasoningDir).filter((f) => f.endsWith('.md')).sort()
  : []
const wantReasoning = flag('reasoning')
let reasoningMismatch = ''
if (wantReasoning && reasoningFiles.length !== picked.length) {
  reasoningMismatch = '思维链文件 ' + reasoningFiles.length + ' 个，而模型产出轮 ' + picked.length
    + ' 轮 —— 数量不齐，无法按顺序配对（可能含未落思维链的轮，或会话来自本功能上线前）'
}

for (const [n, row] of picked.entries()) {
  const name = 'assistant-' + String(n + 1).padStart(2, '0') + '.md'
  const dest = join(outDir, name)
  // `--prose-only`：只导出 `<dream_body>` 内的散文。
  //
  // 为什么需要（2026-09-23 实测，第三次口径修正）：本预设的正式输出是**协议文档**——
  // `<dream_plot>` 包着 `<dream_scene>`（date/time/location 元数据）、`<dream_body>`（散文）、
  // `<dream_option>`（选项）、`<UpdateVariable>`/`<Analysis>`/`<JSONPatch>`（英文状态补丁）。
  // 直接把整份输出喂给度量器，等于把**元数据与 JSON 当散文统计** ⇒ 位配比被稀释、
  // 复读判据在 JSON 行上误报（实测命中 `- Time passed: roughly one evening` 与 `{"op":"replace"…}`）。
  // 度量必须落在**被量对象**（散文）上，否则读数不成立。
  const prose = wantProseOnly ? toProse(row.text) : row.text
  writeFileSync(dest, prose + '\n', 'utf8')
  if (wantProseOnly) {
    const rawDir = join(outDir, 'raw')
    mkdirSync(rawDir, { recursive: true })
    writeFileSync(join(rawDir, name), row.text + '\n', 'utf8')
  }
  const entry = {
    file: dest,
    historyLine: row.line,
    chars: prose.replace(/\s+/g, '').length,
    rawChars: row.text.length,
    ...(wantProseOnly ? { proseOnly: true, rawFile: join(outDir, 'raw', name) } : {}),
    head: prose.slice(0, 40).replace(/\n/g, '⏎'),
  }
  if (wantReasoning && reasoningMismatch === '' && reasoningFiles[n] !== undefined) {
    const src = join(reasoningDir, reasoningFiles[n])
    const text = readFileSync(src, 'utf8')
    // ⚠ 思维链必须落在**子目录**，不能与正文同层（2026-09-23 实测抓到的自伤）：
    // 度量器 `sample_report.py` 用 `glob(os.path.join(path,'*.md'))` **非递归**收集语料，
    // 同层放思维链会让它把推演文字当正文统计 —— 实测读数直接被污染
    // （位数中位 1.0、关位 10%，全是假的）。子目录既同层不可见，又保持配套可寻。
    const rDir = join(outDir, 'reasoning')
    mkdirSync(rDir, { recursive: true })
    const rDest = join(rDir, 'reasoning-' + String(n + 1).padStart(2, '0') + '.md')
    writeFileSync(rDest, text.endsWith('\n') ? text : text + '\n', 'utf8')
    entry.reasoningFile = rDest
    entry.reasoningChars = text.replace(/\s+/g, '').length
    entry.reasoningFrom = reasoningFiles[n]
  }
  report.push(entry)
}

if (flag('json')) {
  console.log(JSON.stringify({
    session,
    dataDir,
    historyPath,
    outDir,
    openingSkipped: skipped === null ? null : { historyLine: skipped.line, rawChars: skipped.text.length },
    reasoning: wantReasoning
      ? { requested: true, files: reasoningFiles.length, mismatch: reasoningMismatch }
      : { requested: false, available: reasoningFiles.length },
    drafts: report,
  }, null, 2))
} else {
  console.log('会话 ' + session + '（' + historyPath + '）')
  if (skipped !== null) {
    console.log('已跳过第 1 个 assistant 轮（视为卡自带开场白，history 行 ' + skipped.line + '，' + skipped.text.length + ' 字符）——要保留请加 --keep-opening')
  }
  console.log('导出 ' + report.length + ' 轮 → ' + outDir)
  for (const r of report) {
    const rs = r.reasoningChars === undefined ? '' : '  思维链 ' + r.reasoningChars + ' 字'
    console.log('  ' + r.file.split(/[\\/]/).pop() + '  history 行 ' + r.historyLine + '  ' + r.chars + ' 字（去空白）' + rs + '  「' + r.head + '…」')
  }
  if (wantReasoning && reasoningMismatch !== '') console.error('⚠ ' + reasoningMismatch)
  if (!wantReasoning && reasoningFiles.length > 0) {
    console.log('（该会话有 ' + reasoningFiles.length + ' 份思维链；加 --reasoning 一并导出）')
  }
  console.log('下一步：python E:/alice/tavern/文风/位格统计/sample_report.py ' + outDir)
}
