#!/usr/bin/env node
/**
 * turn-report.mjs — 逐轮摊开「全流程」：条件 → 请求 → 响应 → 读数 → 落点。
 *
 * ## 为什么要有它（2026-09-23，主人要求「每次的请求要可见，相当于全流程透明」）
 * 证据其实**一直都在盘上**，但分成四个文件、彼此不指认：
 *   `manifests/<turn>.json`（请求，400KB 级 JSON）· `reasoning/<turn>.md`（思维链）
 *   · `history.jsonl`（正文）· `turns/<turn>.json`（条件 + 读数，本轮新加）
 * ⇒ 逐字节完整 ≠ 可见。本脚本把同一轮的四面摊在一屏里，并**显式标注每个数来自哪个文件**。
 *
 * ## 口径（写死，避免两轮读数不可比）
 * - 字符数一律**去空白**（`\s+` → 空），除非标注 `raw`。
 * - 「请求」按 `manifests/<turn>.json` 的 `entries[]` 逐条列（`--entries` 展开全文首段）。
 * - 缺 `turns/<turn>.json` 的会话（本功能上线前的）**照常可读**，只是「条件/读数」段标注缺失——
 *   不猜、不用默认值填。
 *
 * ## 用法
 *   node scripts/turn-report.mjs --session <会话id> [--dataDir <目录>] [--turn N] [--entries] [--json]
 *
 * 退出码：0 成功；2 会话目录不存在；3 该会话没有任何轮次记录。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes('--' + name)
const opt = (name, fallback) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}

if (flag('help') || argv.length === 0) {
  console.log('用法: node scripts/turn-report.mjs --session <会话id> [--dataDir <目录>] [--turn N] [--entries] [--json]')
  process.exit(0)
}

const session = opt('session', '')
if (session === '') {
  console.error('FATAL: 必须给 --session <会话id>')
  process.exit(2)
}
const dataDir = resolve(opt('dataDir', join(process.env['DSH_HOME'] ?? '.', 'dream-tavern-data')))
const sessionDir = join(dataDir, 'sessions', session)
if (!existsSync(sessionDir)) {
  console.error('FATAL: 会话目录不存在: ' + sessionDir)
  process.exit(2)
}

const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}
const turnFile = (turn) => join(sessionDir, 'turns', String(turn).padStart(4, '0') + '.json')
const manifestFile = (turn) => join(sessionDir, 'manifests', String(turn).padStart(4, '0') + '.json')
const reasoningFile = (turn) => join(sessionDir, 'reasoning', String(turn).padStart(4, '0') + '.md')
const chars = (s) => String(s ?? '').replace(/\s+/g, '').length
const num = (n) => typeof n === 'number' ? n.toLocaleString('en-US') : '—'

/** 轮次清单：以 turns/ 为准，缺则回退 manifests/（老会话照常可读）。 */
const turnsDir = join(sessionDir, 'turns')
const manifestsDir = join(sessionDir, 'manifests')
const fromTurns = existsSync(turnsDir) ? readdirSync(turnsDir).filter((f) => f.endsWith('.json')) : []
const fromManifests = existsSync(manifestsDir) ? readdirSync(manifestsDir).filter((f) => f.endsWith('.json')) : []
const source = fromTurns.length > 0 ? 'turns' : (fromManifests.length > 0 ? 'manifests' : 'none')
if (source === 'none') {
  console.error('FATAL: 该会话没有任何轮次记录（turns/ 与 manifests/ 皆空）')
  process.exit(3)
}
const turnNumbers = (source === 'turns' ? fromTurns : fromManifests)
  .map((f) => Number(f.replace(/\.json$/, '')))
  .filter((n) => Number.isFinite(n))
  .sort((a, b) => a - b)

const only = opt('turn', '')
const wanted = only === '' ? turnNumbers : turnNumbers.filter((n) => n === Number(only))
if (wanted.length === 0) {
  console.error('FATAL: 该会话没有第 ' + only + ' 轮（现有：' + turnNumbers.join(', ') + '）')
  process.exit(3)
}

// 正文与历史行号：assistant 行按顺序对应（开场白那条也算历史，故不按行号反推轮次）。
const historyLines = existsSync(join(sessionDir, 'history.jsonl'))
  ? readFileSync(join(sessionDir, 'history.jsonl'), 'utf8').split('\n').filter((l) => l.trim() !== '')
  : []
const assistantTexts = []
for (const line of historyLines) {
  try {
    const row = JSON.parse(line)
    if (String(row.role) === 'assistant') assistantTexts.push(String(row.text ?? ''))
  } catch { /* 坏行跳过：本脚本只做展示，不替持久化层报错 */ }
}

const out = []
for (const turn of wanted) {
  const rec = readJson(turnFile(turn))
  const man = readJson(manifestFile(turn))
  const rPath = reasoningFile(turn)
  const reasoning = existsSync(rPath) ? readFileSync(rPath, 'utf8') : null
  const text = assistantTexts.length >= turn / 2 ? (assistantTexts[Math.floor(turn / 2)] ?? '') : ''

  const entries = Array.isArray(man?.entries)
    ? man.entries.map((e) => ({
      slot: String(e.slot ?? '?'),
      role: String(e.role ?? '?'),
      source: String(e.source ?? '?'),
      priority: e.priority,
      chars: chars(e.text),
      head: String(e.text ?? '').slice(0, 60).replace(/\n/g, '⏎'),
    }))
    : []

  out.push({
    turn,
    conditions: rec === null ? null : {
      card: rec.cardName, cardId: rec.cardId, preset: rec.presetName, presetId: rec.presetId,
      provider: rec.provider, model: rec.model, maxTokens: rec.maxTokens,
      temperature: rec.temperature, budgetChars: rec.budgetChars, atMs: rec.atMs,
    },
    request: man === null ? null : {
      totalChars: man.totalChars, messages: Array.isArray(man.entries) ? man.entries.length : null,
      hash: String(man.hash ?? ''), overBudget: man.overBudget === true,
      droppedChars: typeof man.dropped === 'number' ? man.dropped : null,
      entries,
    },
    response: {
      textChars: chars(text), textRawChars: text.length,
      reasoningChars: reasoning === null ? null : chars(reasoning),
      reasoningFile: reasoning === null ? null : rPath,
    },
    readings: rec === null ? null : {
      ok: rec.ok === true, failure: rec.failure ?? null, finishKind: rec.finishKind,
      truncated: rec.truncated === true, usage: rec.usage, a1Ok: rec.a1Ok, a1Detail: rec.a1Detail,
      turnRecordFile: turnFile(turn),
    },
    files: { turn: existsSync(turnFile(turn)) ? turnFile(turn) : null, manifest: existsSync(manifestFile(turn)) ? manifestFile(turn) : null, reasoning: existsSync(rPath) ? rPath : null },
  })
}

if (flag('json')) {
  console.log(JSON.stringify({ session, dataDir, sessionDir, turnSource: source, turns: out }, null, 2))
} else {
  console.log('会话 ' + session)
  console.log('目录 ' + sessionDir)
  if (source === 'manifests') {
    console.log('⚠ 该会话没有 turns/（轮次记录功能上线前跑的）——「条件 / 读数」段缺失，不猜不填默认值')
  }
  for (const t of out) {
    console.log('')
    console.log('══ 轮 ' + t.turn + ' ' + '═'.repeat(46))
    if (t.conditions === null) {
      console.log('条件  （缺 turns/' + String(t.turn).padStart(4, '0') + '.json）')
    } else {
      const c = t.conditions
      console.log('条件  卡=' + String(c.card) + '（' + String(c.cardId) + '） · 预设=' + String(c.preset))
      console.log('      路由=' + String(c.provider) + '/' + String(c.model) + ' · maxTokens=' + num(c.maxTokens)
        + ' · temperature=' + String(c.temperature) + ' · budgetChars=' + num(c.budgetChars))
    }
    if (t.request === null) {
      console.log('请求  （缺装配单）')
    } else {
      const r = t.request
      console.log('请求  ' + num(r.totalChars) + ' 字符 / ' + String(r.messages) + ' 条消息 · hash ' + r.hash.slice(0, 12)
        + (r.overBudget ? ' · ⚠ 超预算' : ''))
      for (const e of r.entries) {
        console.log('      [' + e.slot.padEnd(15) + '] ' + e.source.padEnd(14) + ' ' + String(e.chars).padStart(7) + ' 字符  「' + e.head + '…」')
      }
    }
    console.log('响应  正文 ' + num(t.response.textChars) + ' 字符' + (t.response.textChars === 0 ? ' ⚠ 空' : '')
      + ' · 思维链 ' + (t.response.reasoningChars === null ? '（无文件）' : num(t.response.reasoningChars) + ' 字符'))
    if (t.readings === null) {
      console.log('读数  （缺轮次记录）')
    } else {
      const g = t.readings
      const u = g.usage ?? {}
      console.log('读数  ' + (g.ok ? 'ok' : '✖ 失败' + (g.failure === null ? '' : '（' + g.failure + '）'))
        + ' · finish=' + (g.finishKind === '' || g.finishKind === null ? '无' : String(g.finishKind))
        + ' · truncated=' + String(g.truncated)
        + ' · in ' + num(u.inputTokens) + ' / out ' + num(u.outputTokens) + ' / cache ' + num(u.cacheReadTokens)
        + ' · A1 ' + (g.a1Ok ? '✓' : '✖ ' + String(g.a1Detail)))
    }
    console.log('落点  turns/' + (t.files.turn === null ? '—' : '✓') + ' · manifests/' + (t.files.manifest === null ? '—' : '✓')
      + ' · reasoning/' + (t.files.reasoning === null ? '—' : '✓'))
  }
  console.log('')
  console.log('下一步：python E:/alice/tavern/文风/位格统计/sample_report.py <导出稿目录>')
}
