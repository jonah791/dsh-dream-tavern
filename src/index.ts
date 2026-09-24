/**
 * agent-dream-tavern：梦境酒馆宿主插件。
 *
 * 与上游的根本差别不在功能数量，而在**可测量性**：每一次模型请求都由
 * `assemble()` 产出一份「装配单」，落盘后再从磁盘回读校验「发出去的 body
 * 确实等于装配单重建的 body」（判据 A1）。因此上下文编排的每一次变化
 * 都是可复核的字节账，而不是黑箱。
 *
 * 边界（不做什么）：不写回主人的酒馆目录（迁移源只读）；不追 ST 生态广度
 * （MVU/正则/小手机/生图）；不替主人裁决文风。
 * 2026-09-22 立：主人「9 点前要成品，全方位超越 flizzywine/dsh-tavern」+「全部自持」。
 */
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createAssistantMessage, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type { Message } from '@deepseek-ai/dsh-llm/message'
// 0.1.7：`Context.llm` 由 @deepseek-ai/dsh-llm 的根模块声明；只 import 子路径拿不到该增强。
import type {} from '@deepseek-ai/dsh-llm'
import { assemble, messagesFromManifest, verifyAgainstActual } from './assemble.ts'
import type { AttemptRecord } from './completion-judge.ts'
import { ensureOpening, playerNameFrom, runTurn, type Completer, type FinishFailure, type TurnDeps } from './session.ts'
import { createTavernPanel } from './panel.ts'
import { defaultPreset } from './preset.ts'
import { loadPresetFile } from './preset-file.ts'
import { Store } from './store.ts'
import { describeImport } from './worldbook.ts'
import type { ChatMessage, Manifest, Preset } from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'agent-dream-tavern': { kind: 'agent-dream-tavern' }
  }
}

export const name = 'agent-dream-tavern'
export const inject = ['tools', 'llm'] as const

export interface Config {
  enabled: boolean
  /** Where we write (sessions / manifests / snapshots). Never the migration source. */
  dataDir: string
  /** Read-only character card libraries. */
  cardDirs: string[]
  /** Read-only world book libraries. */
  worldbookDirs: string[]
  provider: string
  model: string
  maxTokens: number
  temperature: number
  /** Hard character budget for one assembled request. */
  budgetChars: number
  /**
   * 预设文件路径（JSON）。空 ⇒ 用内建默认预设。
   *
   * ⚠ 本字段是 2026-09-22 补上的：此前预设**写死**为 `defaultPreset(...)`，
   * 而同文件里却有一条注释宣称「放进 dataDir 就能改」——**那句话没有对应实现**。
   * 缺了它，本插件被指定的第一个目的（**迭代预设**）在代码上不可达。
   */
  presetPath: string
  /**
   * 形态判据的标记表（2026-09-25）——与下方 zod schema **同名同形**（类型与值两个声明必须同步改，
   * 漏一个就是「schema 认了、类型不认」或反过来的编译错：本次实测先只改了 schema，tsc 当场报
   * `Property 'proseMarkers' does not exist on type 'Config'`）。空数组 ⇒ 不检查该项。
   */
  proseMarkers: string[]
  chainMarkers: string[]
  /** 失败重试上限（含首次）：1 = 不重试（默认）。 */
  retryMax: number
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  /**
   * Where we write. Empty ⇒ resolved at load to `<DSH_HOME>/dream-tavern-data`.
   * 部署相关取值一律走配置，代码里不留任何一台机器的路径（宿主公约：插件不得硬编码可调项；
   * 且默认值若写死某个人的目录，公开仓库就会连带泄漏他的本机路径）。
   */
  dataDir: z.string().default(''),
  /** Read-only character card libraries（ST `characters/` 目录）。空 ⇒ 无卡可玩，工具会如实报 0。 */
  cardDirs: z.array(z.string()).default([]),
  /** Read-only world book libraries（ST `worlds/` 目录）。 */
  worldbookDirs: z.array(z.string()).default([]),
  /** Model route; empty ⇒ fail loud on the first turn rather than guess a provider. */
  provider: z.string().default(''),
  model: z.string().default(''),
  maxTokens: z.number().default(1600),
  temperature: z.number().default(0.9),
  /** Hard character budget for one assembled request. */
  budgetChars: z.number().default(24000),
  /** 预设文件路径（JSON）。空 ⇒ 内建默认。见 `Config` 上方的说明。 */
  presetPath: z.string().default(''),
  /**
   * 形态判据的标记表（2026-09-25）。**空数组 ⇒ 不检查该项**（默认与旧版逐字节一致）：
   * 插件不猜预设的协议约定——「正文块长什么样」「链长什么样」都是**预设侧**的知识，
   * 由部署侧在配置里声明（本机 web profile 已声明）。判据逻辑见 `completion-judge.ts`。
   */
  proseMarkers: z.array(z.string()).default([]),
  chainMarkers: z.array(z.string()).default([]),
  /**
   * 失败重试上限（**含首次**）：1 = 不重试（默认）。
   * 依据（课题 §6.13/§6.14）：直连网关已复现「链进正文/空正文」，且三个层八个干预**全部无改善**
   * ⇒ 单次调用约 50% 失败是模型×网关的固有倾向 ⇒ **重试是与病因无关的唯一可靠兜底**
   * （重试输入基本相同 ⇒ 大部分命中 prompt cache，增量成本低）。
   */
  retryMax: z.number().default(1),
})

const PLUGIN = 'agent-dream-tavern'

/**
 * Model-facing rendering：把已验证的规范值原样交给模型（不截断、不美化）。
 * 研究线要求「模型看到的」与「装配单记的」是同一份事实，故不做摘要压缩。
 */
const jsonRender = (_args: unknown, value: unknown): { type: 'text'; text: string }[] =>
  [{ type: 'text', text: JSON.stringify(value, null, 2) }]

/**
 * Our assembled messages -> the harness message vocabulary.
 *
 * system 走 `createMessage`（已发布 lib 未透出 `createSystemMessage`，而 `createMessage`
 * 本身要求显式给出 role 与 source，语义等价且不依赖未发布的导出面）。
 */
function toHarnessMessages(messages: ChatMessage[], provider: string, model: string): Message[] {
  return messages.map((message): Message => {
    if (message.role === 'system') {
      return createMessage({
        role: 'system',
        content: [{ type: 'text', text: message.text }],
        // 0.1.7：system 角色的 source 必须是生产者自有的 `system-prompt`（v3 的 plugin 包装已移除）。
        source: { kind: 'system-prompt' },
      })
    }
    if (message.role === 'assistant') {
      return createAssistantMessage({
        content: [{ type: 'text', text: message.text }],
        source: { provider, model },
      })
    }
    return createUserMessage({
      content: [{ type: 'text', text: message.text }],
      source: { kind: 'agent-dream-tavern' },
    })
  })
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger(PLUGIN)

  /** Explicit resolve step: the config carries either a deployment value or nothing. */
  const dataDir = config.dataDir.trim().length > 0
    ? config.dataDir.trim()
    : join(process.env['DSH_HOME'] ?? '.', 'dream-tavern-data')

  const cardDirs = config.cardDirs.filter((d) => d.trim().length > 0)
  const worldDirs = config.worldbookDirs.filter((d) => d.trim().length > 0)
  const store = new Store({ dataDir, cardDirs, worldDirs })
  if (cardDirs.length === 0) {
    logger.warn('未配置 cardDirs：卡库为空，tavern_cards 会如实报 0（请在 cordis.yml 里指向 ST characters/ 目录）')
  }
  if (worldDirs.length === 0) {
    logger.warn('未配置 worldbookDirs：世界书库为空（tavern_worldbooks 会如实报 0）')
  }
  if (config.provider.trim().length === 0 || config.model.trim().length === 0) {
    logger.warn('未配置 provider/model：tavern_play 会在第一轮响亮失败（不猜默认模型）')
  }
  const presetLogged = new Set<string>()
  const presetCache = new Map<string, Preset>()
  /**
   * 取预设。`override` 给定时用**那一份**（单轮覆盖，对照实验用），否则用配置的 `presetPath`。
   *
   * 缓存按路径键（2026-09-23）：一场对照实验里同一份预设会被取几十次，每次重新解析
   * 1.6MB JSON 是纯浪费；缓存也让「未建模清单只播报一次」有稳定的键
   * （原先用单个布尔量 ⇒ 换预设后不再播报，静默丢了那份对账表）。
   */
  const preset = (override?: string): Preset => {
    const path = override !== undefined && override.trim() !== '' ? override.trim() : config.presetPath.trim()
    const cached = presetCache.get(path)
    if (cached !== undefined) return cached
    const built = buildPreset(path)
    presetCache.set(path, built)
    return built
  }
  const buildPreset = (path: string): Preset => {
    if (path === '') return defaultPreset(config.budgetChars)
    // 配了预设文件却加载不了 ⇒ **响亮失败，绝不静默退回默认**：静默退回会让研究结论张冠李戴
    // （与「未配置 provider/model ⇒ 第一轮响亮失败，不猜」同一族纪律）。
    const loaded = loadPresetFile(path, config.budgetChars)
    if (loaded.preset === undefined) {
      throw new Error(`预设加载失败（${path}）：${loaded.errors.join('；')}`)
    }
    // 桥接的**未建模清单**必须被看见（不许静默丢字段——这正是今天修过的卡内世界书那类缺陷）。
    if (!presetLogged.has(path)) {
      presetLogged.add(path)
      const b = loaded.bridge
      if (b === undefined) {
        logger.info('预设已加载：%s（本插件格式，%d 块）', loaded.preset.name, loaded.preset.blocks.length)
      } else {
        logger.info('预设已加载：%s（ST 桥接 · %d 块 · ST prompts %d 条 / marker %d）· **未建模 %d 条**（逐条理由见 scripts/quality-sweep.mjs --preset 的对账表）',
          loaded.preset.name, loaded.preset.blocks.length, b.stats.prompts, b.stats.markers, b.unmodeled.length)
        if (b.stats.markers > 0) {
          logger.warn('该预设含 %d 个 marker（卡片/历史字段占位）：本插件里这些字段的位置**由代码写死**，预设不可拨（§4.5 card-tier 硬边界）', b.stats.markers)
        }
      }
    }
    return loaded.preset
  }

  /** 把 `finish` 的失败详情渲染成一行（`code: message`）；无详情 = 空串。 */
  const renderFinishFailure = (f: FinishFailure | null): string =>
    f === null ? '' : (f.code === '' ? f.message : f.code + ': ' + f.message)

  /**
   * 唯一的模型入口：把共享回合层的 `ChatMessage[]` 翻成 harness 消息并流式取回。
   * 工具、面板、三个 Agent 全部经过这里——没有第二条通往模型的路。
   */
  const complete: Completer = async (messages, options) => {
    if (config.provider.trim().length === 0 || config.model.trim().length === 0) {
      // fail loud：不猜默认模型——猜错会静默改变研究结论的可比性
      throw new Error('未配置 provider/model：请在 cordis.yml 的 agent-dream-tavern.config 里指定')
    }
    const harnessMessages = toHarnessMessages(messages, config.provider, config.model)
    let text = ''
    let reasoning = ''
    // 多段思维链（`reasoning-delta` 带 index）：换段时补一个空行，保留分段结构，
    // 否则各段会粘成一句，分析时看不出「模型分了几次想」。
    let reasoningIndex = -1
    let finishKind = ''
    // fail-loud（t-91746d6a）：`error` / `aborted` 的失败详情必须捕下来——它是唯一的归因线索。
    let finishFailure: FinishFailure | null = null
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    for await (const chunk of ctx.llm.stream({
      provider: config.provider,
      model: config.model,
      messages: harnessMessages,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'reasoning-delta') {
        if (reasoningIndex >= 0 && chunk.index !== reasoningIndex) reasoning += '\n\n'
        reasoningIndex = chunk.index
        reasoning += chunk.text
      }
      // `finish.reason.kind` 是提供方给的**权威**结束原因（含 `max-tokens`）——
      // 用它判截断，比 `outputTokens >= maxTokens` 这个代理量可靠。
      else if (chunk.type === 'finish') {
        finishKind = chunk.reason.kind
        // 结束原因的形状见 harness `FinishReasonMap`：只有 `error` / `aborted` 两支带 `failure`。
        const failure = (chunk.reason as { failure?: { code?: unknown; message?: unknown } }).failure
        finishFailure = failure === undefined
          ? null
          : { code: String(failure.code ?? ''), message: String(failure.message ?? '') }
      }
      else if (chunk.type === 'usage') {
        const usage = chunk.usage as unknown as Record<string, number | undefined>
        inputTokens = usage['inputTokens'] ?? usage['input'] ?? 0
        outputTokens = usage['outputTokens'] ?? usage['output'] ?? 0
        cacheReadTokens = usage['cacheReadTokens'] ?? usage['cacheRead'] ?? 0
      }
    }
    return { text, reasoning, finishKind, finishFailure, usage: { inputTokens, outputTokens, cacheReadTokens } }
  }

  /** 工具与面板共用同一份依赖（判据 A7：无旁路）。 */
  const deps: TurnDeps = {
    store,
    complete,
    // 参数适配：`TurnDeps.preset` 的签名是 `(budgetChars) => Preset`（历史接口，参数未被使用——
    // 预算取自 config），而本插件的 `preset` 现按**路径**取（单轮覆盖）。
    preset: () => preset(),
    // 单轮预设覆盖（2026-09-23）：让「改前 vs 改后」的对照实验不必改配置+重启。
    presetFor: (path: string) => preset(path),
    budgetChars: config.budgetChars,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    // 路由随轮次落盘（turns/<turn>.json）——读数可归因的前提。
    proseMarkers: config.proseMarkers,
    chainMarkers: config.chainMarkers,
    retryMax: config.retryMax,
    route: { provider: config.provider, model: config.model },
  }
  const turnDeps = (): TurnDeps => deps

  ctx.tools.register(defineTool({
    name: 'tavern_cards',
    description: '酒馆卡库清点（只读）：列出配置的卡目录里全部人物卡（id/文件名/字节/来源格式）。用于确认迁移源规模与寻址，不读卡内容。',
    parameters: {
      limit: { type: 'number', description: '最多返回多少条（缺省 200）' },
    },
    output: {
      render: jsonRender,
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          dirs: { type: 'array', items: { type: 'string' } },
          count: { type: 'number' },
          totalBytes: { type: 'number' },
          unreadable: { type: 'array', items: { type: 'string' } },
          cards: {
            type: 'array', items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string' }, name: { type: 'string' },
                bytes: { type: 'number' }, source: { type: 'string' },
              },
            },
          },
        },
      },
    },
    async execute(args: { limit?: number }) {
      const { cards, unreadable } = await store.scanCards()
      const limit = Math.max(1, Math.min(args.limit ?? 200, 5000))
      return {
        dirs: config.cardDirs,
        count: cards.length,
        totalBytes: cards.reduce((n, c) => n + c.bytes, 0),
        unreadable,
        cards: cards.slice(0, limit).map((c) => ({ id: c.id, name: c.name, bytes: c.bytes, source: c.source })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'tavern_card',
    description: '读取一张人物卡（只读）：解释后的字段（名称/人设/场景/开场/示例）+ 原始字段名全集 + 文件 sha256。用于迁移核对与开局。',
    parameters: {
      id: { type: 'string', description: '卡 id 或文件名（来自 tavern_cards）' },
    },
    output: {
      render: jsonRender,
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          found: { type: 'boolean' },
          file: { type: 'string' },
          sha256: { type: 'string' },
          name: { type: 'string' },
          personaChars: { type: 'number' },
          scenarioChars: { type: 'number' },
          firstMessageChars: { type: 'number' },
          descriptionChars: { type: 'number' },
          exampleChars: { type: 'number' },
          rawKeys: { type: 'array', items: { type: 'string' } },
          extraFieldCount: { type: 'number' },
          personaPreview: { type: 'string' },
          firstMessagePreview: { type: 'string' },
        },
      },
    },
    async execute(args: { id: string }) {
      const hit = await store.readCard(args.id)
      if (hit === null) {
        return {
          found: false, file: '', sha256: '', name: '', personaChars: 0, scenarioChars: 0,
          firstMessageChars: 0, descriptionChars: 0, exampleChars: 0,
          rawKeys: [], extraFieldCount: 0, personaPreview: '', firstMessagePreview: '',
        }
      }
      const raw = await store.readCardRaw(args.id)
      const { card } = hit
      return {
        found: true,
        file: hit.file,
        sha256: hit.sha256,
        name: card.name,
        personaChars: card.persona.length,
        scenarioChars: card.scenario.length,
        firstMessageChars: card.firstMessage.length,
        descriptionChars: card.description.length,
        exampleChars: card.exampleDialogue.length,
        rawKeys: Object.keys(raw?.raw ?? {}).sort(),
        extraFieldCount: card.fields.length,
        personaPreview: card.persona.slice(0, 400),
        firstMessagePreview: card.firstMessage.slice(0, 400),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'tavern_worldbooks',
    description: '世界书清点/导入（只读源）：不给 name 时列出全部世界书；给 name 时按 ST 格式导入并回报「多少条被解释、多少条跳过、哪些字段未建模但已原样保留」。',
    parameters: {
      name: { type: 'string', description: '世界书名（不含 .json）；缺省=只列清单' },
      limit: { type: 'number', description: '清单上限（缺省 200）' },
    },
    output: {
      render: jsonRender,
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          count: { type: 'number' },
          totalBytes: { type: 'number' },
          books: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, bytes: { type: 'number' } } } },
          imported: { type: 'boolean' },
          file: { type: 'string' },
          summary: { type: 'string' },
          entries: { type: 'number' },
          skipped: { type: 'number' },
          unknownKeys: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    async execute(args: { name?: string; limit?: number }) {
      const books = await store.scanWorldbooks()
      const base = {
        count: books.length,
        totalBytes: books.reduce((n, b) => n + b.bytes, 0),
        books: books.slice(0, Math.max(1, Math.min(args.limit ?? 200, 5000))).map((b) => ({ name: b.name, bytes: b.bytes })),
        imported: false, file: '', summary: '', entries: 0, skipped: 0, unknownKeys: [] as string[],
      }
      if (args.name === undefined || args.name.trim().length === 0) return base
      const hit = await store.importWorldbookFile(args.name.trim())
      if (hit === null) return { ...base, summary: `未找到世界书「${args.name}」` }
      return {
        ...base,
        imported: true,
        file: hit.file,
        summary: describeImport(hit.result),
        entries: hit.result.entries.length,
        skipped: hit.result.skipped.length,
        unknownKeys: hit.result.unknownKeys,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'tavern_assemble',
    description: '装配一轮请求并落盘装配单（不调模型）：给卡/会话/输入，产出「哪些片段进哪个槽位、命中什么关键词、各占多少字节」的字节账，并自检「装配单重建的 body 是否逐字节等于将要发出的 body」。',
    parameters: {
      cardId: { type: 'string', description: '卡 id' },
      session: { type: 'string', description: '会话 id（缺省 assemble-only）' },
      input: { type: 'string', description: '本轮玩家输入' },
      turn: { type: 'number', description: '轮次（缺省 1）' },
      worldbook: { type: 'string', description: '可选：导入的世界书名' },
      state: { type: 'string', description: '可选：状态 JSON 文本（缺省 {}）' },
      preset: { type: 'string', description: '可选：本次装配使用的预设（文件路径，或 presets/ 下的 id）。缺省用插件配置的 presetPath。' },
    },
    output: {
      render: jsonRender,
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          reason: { type: 'string' },
          manifestPath: { type: 'string' },
          hash: { type: 'string' },
          turn: { type: 'number' },
          messages: { type: 'number' },
          totalChars: { type: 'number' },
          overBudget: { type: 'boolean' },
          dropped: { type: 'array', items: { type: 'string' } },
          a1RebuildOk: { type: 'boolean' },
          a1Detail: { type: 'string' },
          slots: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { slot: { type: 'string' }, entries: { type: 'number' }, chars: { type: 'number' } } } },
          parts: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { source: { type: 'string' }, trigger: { type: 'string' }, chars: { type: 'number' } } } },
        },
      },
    },
    async execute(args: { cardId: string; session?: string; input: string; turn?: number; worldbook?: string; state?: string; preset?: string }) {
      const hit = await store.readCard(args.cardId)
      if (hit === null) {
        return { ok: false, reason: `找不到卡「${args.cardId}」`, manifestPath: '', hash: '', turn: 0, messages: 0, totalChars: 0, overBudget: false, dropped: [], a1RebuildOk: false, a1Detail: '', slots: [], parts: [] }
      }
      const sessionId = args.session ?? 'assemble-only'
      const history = await ensureOpening(store, sessionId, hit.card)
      const turn = args.turn ?? history.length + 1
      let state: Record<string, unknown> = {}
      if (args.state !== undefined && args.state.trim().length > 0) {
        try { state = JSON.parse(args.state) as Record<string, unknown> } catch (err) {
          return { ok: false, reason: `state 不是合法 JSON：${(err as Error).message}`, manifestPath: '', hash: '', turn, messages: 0, totalChars: 0, overBudget: false, dropped: [], a1RebuildOk: false, a1Detail: '', slots: [], parts: [] }
        }
      }
      let lorebook: import('./types.ts').LorebookEntry[] = []
      if (args.worldbook !== undefined && args.worldbook.trim().length > 0) {
        const book = await store.importWorldbookFile(args.worldbook.trim())
        if (book === null) {
          return { ok: false, reason: `找不到世界书「${args.worldbook}」`, manifestPath: '', hash: '', turn, messages: 0, totalChars: 0, overBudget: false, dropped: [], a1RebuildOk: false, a1Detail: '', slots: [], parts: [] }
        }
        lorebook = book.result.entries
      }

      const { manifest, messages } = assemble({
        preset: preset(args.preset), card: hit.card, lorebook, history, state, turnInput: args.input, turn,
        // 2026-09-23 修复：本条路径原先**漏传** playerName ⇒ 开场白的 `{{user}}` 拿不到名字，
        // 只能原样保留进上下文。`tavern_play` 那条路是传的（session.ts:217/414），两条必须一致。
        playerName: playerNameFrom(state),
      })
      const manifestPath = await store.writeManifest(sessionId, manifest)
      // A1：从**磁盘回读**的装配单重建 body，与将要发出的 body 比对（能抓出序列化漂移）
      const reread = await store.readManifest(sessionId, turn)
      const built = reread === null ? messages : messagesFromManifest(reread)
      const verify = verifyAgainstActual(reread ?? manifest, built)

      const slotMap = new Map<string, { entries: number; chars: number }>()
      for (const entry of manifest.entries) {
        const acc = slotMap.get(entry.slot) ?? { entries: 0, chars: 0 }
        acc.entries += 1
        acc.chars += entry.text.length
        slotMap.set(entry.slot, acc)
      }
      const parts = manifest.entries.flatMap((e) => e.parts).map((p) => ({
        source: p.source, trigger: p.triggerHit ?? '', chars: p.text.length,
      }))

      return {
        ok: verify.ok,
        reason: verify.ok ? '' : verify.differences.slice(0, 3).join('; '),
        manifestPath,
        hash: manifest.hash,
        turn: manifest.turn,
        messages: manifest.entries.length,
        totalChars: manifest.totalChars,
        overBudget: manifest.overBudget,
        dropped: manifest.dropped,
        a1RebuildOk: verify.ok,
        a1Detail: verify.ok ? `重建 hash 一致（${verify.rebuiltHash.slice(0, 12)}…）` : verify.differences.slice(0, 3).join('; '),
        slots: [...slotMap.entries()].sort().map(([slot, v]) => ({ slot, entries: v.entries, chars: v.chars })),
        parts,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'tavern_play',
    description: '玩一轮：装配 → 真实调用模型 → 落盘装配单/历史/快照，并把这一轮的 token 与缓存读数回报。落地后「说出来的上下文」与「装配单记的上下文」必须逐字节一致（判据 A1），否则本轮标记为不一致。',
    parameters: {
      cardId: { type: 'string', description: '卡 id' },
      session: { type: 'string', description: '会话 id（同名会话续玩）' },
      input: { type: 'string', description: '本轮玩家输入' },
      worldbook: { type: 'string', description: '可选：世界书名' },
      state: { type: 'string', description: '可选：状态 JSON 文本' },
      systemPrompt: { type: 'string', description: '可选：本轮 system 覆盖（用于实验对照）' },
      preset: { type: 'string', description: '可选：本轮使用的预设（文件路径，或 presets/ 下的 id）。缺省用插件配置的 presetPath。用于**单轮预设对照**——改前 vs 改后不必改配置+重启。' },
      temperature: { type: 'number', description: '可选：本轮采样温度覆盖（缺省用插件配置）。**采样参数只有逐轮覆盖才能同批对照**——跨批比较已被实测证伪（同一逐字节请求跨批波动剧烈）。' },
      maxTokens: { type: 'number', description: '可选：本轮输出上限覆盖（缺省用插件配置）。' },
    },
    output: {
      render: jsonRender,
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          reason: { type: 'string' },
          session: { type: 'string' },
          turn: { type: 'number' },
          text: { type: 'string' },
          manifestHash: { type: 'string' },
          manifestPath: { type: 'string' },
          a1Ok: { type: 'boolean' },
          a1Detail: { type: 'string' },
          requestChars: { type: 'number' },
          messages: { type: 'number' },
          inputTokens: { type: 'number' },
          outputTokens: { type: 'number' },
          cacheReadTokens: { type: 'number' },
          truncated: { type: 'boolean' },
          finishKind: { type: 'string' },
          finishFailure: { type: 'string' },
          reasoningChars: { type: 'number' },
          reasoningPath: { type: 'string' },
          turnRecordPath: { type: 'string' },
          // 重试与形态的**可见性**（任务 t-1b8be614）：此前「三次重试后勉强接受」的轮次在返回体里
          // 与「一次干净的成功」长得一模一样（都是 ok:true / reason:''）——标记不可见 = 没标记。
          attempts: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                attempt: { type: 'number' },
                verdict: { type: 'string' },
                contentChars: { type: 'number' },
                reasoningChars: { type: 'number' },
                finishKind: { type: 'string' },
                // `AttemptRecord.usage` 必须声明：output.schema 是**严格**校验
                // （additionalProperties: false），漏一个字段整条工具调用就被判无效——
                // 2026-09-25 真机验收当场抓到（`value.attempts[0].usage is not a declared property`）。
                usage: {
                  type: 'object', additionalProperties: false,
                  properties: {
                    inputTokens: { type: 'number' },
                    outputTokens: { type: 'number' },
                    cacheReadTokens: { type: 'number' },
                  },
                },
              },
            },
          },
          chainInContent: { type: 'boolean' },
          chainHit: { type: 'string' },
        },
      },
    },
    async execute(args: { cardId: string; session: string; input: string; worldbook?: string; state?: string; systemPrompt?: string; preset?: string; temperature?: number; maxTokens?: number }) {
      const fail = (reason: string): {
        ok: boolean; reason: string; session: string; turn: number; text: string; manifestHash: string;
        manifestPath: string; a1Ok: boolean; a1Detail: string; requestChars: number; messages: number;
        inputTokens: number; outputTokens: number; cacheReadTokens: number; truncated: boolean;
        finishKind: string; reasoningChars: number; reasoningPath: string;
        attempts: AttemptRecord[]; chainInContent: boolean; chainHit: string; finishFailure: string;
      } => ({
        ok: false, reason, session: args.session, turn: 0, text: '', manifestHash: '', manifestPath: '',
        a1Ok: false, a1Detail: '', requestChars: 0, messages: 0,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, truncated: false,
        finishKind: '', reasoningChars: 0, reasoningPath: '',
        attempts: [], chainInContent: false, chainHit: '', finishFailure: '',
      })

      let stateArg: Record<string, unknown> | undefined
      if (args.state !== undefined && args.state.trim().length > 0) {
        try { stateArg = JSON.parse(args.state) as Record<string, unknown> } catch (err) {
          return fail(`state 不是合法 JSON：${(err as Error).message}`)
        }
      }

      const result = await runTurn(turnDeps(), {
        session: args.session,
        cardId: args.cardId,
        input: args.input,
        ...(args.worldbook === undefined ? {} : { worldbook: args.worldbook }),
        ...(args.systemPrompt === undefined ? {} : { systemPromptOverride: args.systemPrompt }),
        ...(args.preset === undefined ? {} : { preset: args.preset }),
        ...(args.temperature === undefined ? {} : { temperature: args.temperature }),
        ...(args.maxTokens === undefined ? {} : { maxTokens: args.maxTokens }),
        ...(stateArg === undefined ? {} : { state: stateArg }),
      })
      if (!result.ok) {
        logger.warn('tavern_play 失败：%s', result.reason)
        // 失败也要把**诊断面**透出去。裸 `fail()` 只给固定字段，会把「哪一轮 / 思维链落在哪个文件 /
        // 结束原因 / 花了多少 token」全部丢掉——而这几项正是事后追因唯一的抓手。
        // 2026-09-23 空正文事故实测：reason 里写着「思维链已落盘供诊断」，但工具返回值里
        // `reasoningPath` 是空串，调用者**根本找不到那个文件**（自己写的诊断被自己丢掉了）。
        return {
          ...fail(result.reason),
          turn: result.turn,
          manifestHash: result.manifest === null ? '' : result.manifest.hash,
          manifestPath: result.manifestPath,
          requestChars: result.requestChars,
          messages: result.messages,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cacheReadTokens: result.usage.cacheReadTokens,
          truncated: result.truncated,
          finishKind: result.finishKind,
          finishFailure: renderFinishFailure(result.finishFailure),
          reasoningChars: result.reasoningChars,
          reasoningPath: result.reasoningPath,
          turnRecordPath: result.turnRecordPath,
          attempts: result.attempts,
          chainInContent: result.chainInContent,
          chainHit: result.chainHit,
        }
      }
      return {
        ok: true,
        reason: '',
        session: args.session,
        turn: result.turn,
        text: result.text,
        manifestHash: result.manifest === null ? '' : result.manifest.hash,
        manifestPath: result.manifestPath,
        a1Ok: result.a1Ok,
        a1Detail: result.a1Detail,
        requestChars: result.requestChars,
        messages: result.messages,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        truncated: result.truncated,
        finishKind: result.finishKind,
        finishFailure: renderFinishFailure(result.finishFailure),
        reasoningChars: result.reasoningChars,
        reasoningPath: result.reasoningPath,
        turnRecordPath: result.turnRecordPath,
        attempts: result.attempts,
        chainInContent: result.chainInContent,
        chainHit: result.chainHit,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'tavern_rollback',
    description: '原子回退：把会话的正文与状态一起还原到第 N 轮的快照（两文件同生共死）。没有完整快照时响亮拒绝，不做部分回退。',
    parameters: {
      session: { type: 'string', description: '会话 id' },
      turn: { type: 'number', description: '回退到第几轮（快照编号，即那轮开始前）' },
    },
    output: {
      render: jsonRender,
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, historyMessages: { type: 'number' }, stateKeys: { type: 'number' } },
      },
    },
    async execute(args: { session: string; turn: number }) {
      try {
        const out = await store.rollback(args.session, args.turn)
        return { ok: true, reason: '', historyMessages: out.history, stateKeys: out.stateTurns }
      } catch (err) {
        return { ok: false, reason: (err as Error).message, historyMessages: 0, stateKeys: 0 }
      }
    },
  }))

  // 面板是**可选服务**：用 cordis 的等待语义 `ctx.inject`，而非 apply 期一次性 `ctx.get`。
  // ⚠ 2026-09-22 实测教训：patch 文件里 dsh-panel(242) 排在 dream-tavern(302) **之前**，
  // 但加载顺序由依赖图决定 ⇒ apply 期 `ctx.get('panel')` 取不到，贡献**静默丢失**
  // （面板注册表上有宿主自带的 5 个面板、唯独没有我的）。`ctx.inject` 在服务就绪时才回调。
  ctx.inject(['panel'], (panelCtx) => {
    const host = panelCtx.get('panel' as never) as { register: (contribution: unknown) => () => void } | undefined
    if (host === undefined) {
      logger.warn('panel 服务已就绪但取不到宿主实例：面板贡献跳过')
      return
    }
    panelCtx.effect(() => host.register(createTavernPanel(deps)), 'dream-tavern: /panel 贡献')
    logger.info('面板贡献已注册：id=dream-tavern（/panel → 梦境酒馆）')
  })

  logger.info('梦境酒馆已装载：dataDir=%s cards=%d dirs worlds=%d dirs model=%s/%s',
    config.dataDir, config.cardDirs.length, config.worldbookDirs.length, config.provider, config.model)
}

/** 装配单的一行摘要（落轨迹 / 工具面渲染用）。 */
export function manifestSummary(manifest: Manifest): string {
  const kinds = new Map<string, number>()
  for (const entry of manifest.entries) kinds.set(entry.slot, (kinds.get(entry.slot) ?? 0) + 1)
  return `${manifest.entries.length} 条 / ${manifest.totalChars} 字 · ${[...kinds.entries()].map(([k, v]) => `${k}:${v}`).join(' ')}`
}
