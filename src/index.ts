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
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createAssistantMessage, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type { Message } from '@deepseek-ai/dsh-llm/message'
import { assemble, messagesFromManifest, verifyAgainstActual } from './assemble.ts'
import { ensureOpening, runTurn, type Completer, type TurnDeps } from './session.ts'
import { createTavernPanel } from './panel.ts'
import { defaultPreset } from './preset.ts'
import { Store } from './store.ts'
import { describeImport } from './worldbook.ts'
import type { ChatMessage, Manifest, Preset } from './types.ts'

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
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  dataDir: z.string().default('E:/alice/tavern/dream-tavern-data'),
  cardDirs: z.array(z.string()).default([
    'C:/Users/tr/AppData/Roaming/com.tauritavern.client/data/default-user/characters',
  ]),
  worldbookDirs: z.array(z.string()).default([
    'C:/Users/tr/AppData/Roaming/com.tauritavern.client/data/default-user/worlds',
  ]),
  provider: z.string().default('command'),
  model: z.string().default('deepseek/deepseek-v4.1-flash'),
  maxTokens: z.number().default(1600),
  temperature: z.number().default(0.9),
  budgetChars: z.number().default(24000),
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
        source: { kind: 'plugin', plugin: PLUGIN },
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
      source: { kind: 'plugin', plugin: PLUGIN },
    })
  })
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger(PLUGIN)
  const store = new Store({
    dataDir: config.dataDir,
    cardDirs: config.cardDirs,
    worldDirs: config.worldbookDirs,
  })
  const preset = (): Preset => defaultPreset(config.budgetChars)

  /**
   * 唯一的模型入口：把共享回合层的 `ChatMessage[]` 翻成 harness 消息并流式取回。
   * 工具、面板、三个 Agent 全部经过这里——没有第二条通往模型的路。
   */
  const complete: Completer = async (messages, options) => {
    const harnessMessages = toHarnessMessages(messages, config.provider, config.model)
    let text = ''
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
      else if (chunk.type === 'usage') {
        const usage = chunk.usage as unknown as Record<string, number | undefined>
        inputTokens = usage['inputTokens'] ?? usage['input'] ?? 0
        outputTokens = usage['outputTokens'] ?? usage['output'] ?? 0
        cacheReadTokens = usage['cacheReadTokens'] ?? usage['cacheRead'] ?? 0
      }
    }
    return { text, usage: { inputTokens, outputTokens, cacheReadTokens } }
  }

  /** 工具与面板共用同一份依赖（判据 A7：无旁路）。 */
  const deps: TurnDeps = {
    store,
    complete,
    preset,
    budgetChars: config.budgetChars,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
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
    async execute(args: { cardId: string; session?: string; input: string; turn?: number; worldbook?: string; state?: string }) {
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
        preset: preset(), card: hit.card, lorebook, history, state, turnInput: args.input, turn,
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
        },
      },
    },
    async execute(args: { cardId: string; session: string; input: string; worldbook?: string; state?: string; systemPrompt?: string }) {
      const fail = (reason: string): {
        ok: boolean; reason: string; session: string; turn: number; text: string; manifestHash: string;
        manifestPath: string; a1Ok: boolean; a1Detail: string; requestChars: number; messages: number;
        inputTokens: number; outputTokens: number; cacheReadTokens: number;
      } => ({
        ok: false, reason, session: args.session, turn: 0, text: '', manifestHash: '', manifestPath: '',
        a1Ok: false, a1Detail: '', requestChars: 0, messages: 0,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
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
        ...(stateArg === undefined ? {} : { state: stateArg }),
      })
      if (!result.ok) {
        logger.warn('tavern_play 失败：%s', result.reason)
        return fail(result.reason)
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

/** Template seed for the default preset; replaced by dataDir config once edited there. */
export function manifestSummary(manifest: Manifest): string {
  const kinds = new Map<string, number>()
  for (const entry of manifest.entries) kinds.set(entry.slot, (kinds.get(entry.slot) ?? 0) + 1)
  return `${manifest.entries.length} 条 / ${manifest.totalChars} 字 · ${[...kinds.entries()].map(([k, v]) => `${k}:${v}`).join(' ')}`
}
