/**
 * 面板贡献 —— 梦境酒馆的界面层。
 *
 * 与 `dsh-panel` 宿主的关系：只**提交一份声明**（视图规格 + 动作表），由宿主渲染与派发。
 * 按本仓生态公约**不跨插件导入内部路径**，故此处自带一份最小结构类型（鸭子类型）；
 * 宿主是可选服务（`ctx.get('panel')`），面板不在时其余工具照常可用。
 */
import type { TurnDeps, TurnRequest } from './session.ts';
import { runCandidates, runSettlement, runTurn } from './session.ts';
import type { ChatMessage } from './types.ts';

// ── 宿主契约的最小结构类型（不导入 dsh-panel，避免跨插件耦合） ──────────────
export interface PanelBlock {
  kind: string;
  [key: string]: unknown;
}
export interface PanelView {
  blocks: PanelBlock[];
}
export interface PanelActionContext {
  sessionId?: string;
  now: string;
}
export interface PanelActionResult {
  ok: boolean;
  data?: unknown;
  message?: string;
}
export interface PanelActionSpec {
  label: string;
  level: 'read' | 'write' | 'destructive';
  params?: Record<string, 'string' | 'number' | 'boolean'>;
  requiresApproval?: boolean;
  run: (params: Record<string, unknown>, ctx: PanelActionContext) => Promise<PanelActionResult> | PanelActionResult;
}
export interface PanelContribution {
  id: string;
  title: string;
  order?: number;
  icon?: string;
  description?: string;
  view: (params: Record<string, string>) => Promise<PanelView> | PanelView;
  actions?: Record<string, PanelActionSpec>;
  style?: { accent?: string; density?: 'comfortable' | 'compact' };
}

const DEFAULT_SESSION = 'default';
const STORY_TAIL = 8;

function asString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  return '';
}

function roleLabel(role: ChatMessage['role']): string {
  if (role === 'assistant') return '旁白／角色';
  if (role === 'user') return '你';
  return '系统';
}

/** 面板 id 前缀用于 action id，宿主据此路由。 */
export function createTavernPanel(deps: TurnDeps): PanelContribution {
  const turnRequest = (params: Record<string, unknown>, session: string): TurnRequest | null => {
    const cardId = asString(params, 'cardId');
    const input = asString(params, 'input');
    if (cardId.length === 0 || input.length === 0) return null;
    const worldbook = asString(params, 'worldbook');
    return {
      session,
      cardId,
      input,
      ...(worldbook.length > 0 ? { worldbook } : {}),
    };
  };

  return {
    id: 'dream-tavern',
    title: '梦境酒馆',
    order: 35,
    icon: '🎭',
    description: '人物卡文字游戏 + 上下文装配单逐字节可验',
    style: { accent: '#c9a227', density: 'compact' },

    async view(params) {
      const session = (params['session'] ?? '').trim() || DEFAULT_SESSION;
      const { cards } = await deps.store.scanCards();
      const books = await deps.store.scanWorldbooks();
      const history = await deps.store.readHistory(session);
      const state = await deps.store.readState(session);
      const latest = await deps.store.readLatestManifest(session);
      const manifest = latest === null ? null : latest.manifest;

      const story: string[] = [];
      for (const message of history.slice(-STORY_TAIL)) {
        story.push(`【${roleLabel(message.role)}】${message.text.trim()}`);
        story.push('');
      }

      const blocks: PanelBlock[] = [
        {
          kind: 'metrics',
          title: `会话 ${session}`,
          items: [
            { label: '历史消息', value: String(history.length) },
            { label: '卡库', value: `${cards.length} 张` },
            { label: '世界书', value: `${books.length} 本` },
            {
              label: '上轮请求',
              value: manifest === null ? '—' : `${manifest.totalChars} 字 / ${manifest.entries.length} 条`,
              tone: manifest !== null && manifest.overBudget ? 'bad' : 'ok',
              hint: manifest === null || latest === null
                ? '本会话还没有装配单'
                : `第 ${latest.turn} 轮 · hash ${manifest.hash.slice(0, 12)}…`,
            },
          ],
        },
        {
          kind: 'text',
          title: history.length === 0 ? '（本会话还没有正文——先「开局」）' : '正文（最近若干条）',
          lines: story.length > 0 ? story : ['开局会把卡的开场白写成第一条消息。'],
        },
        {
          kind: 'form',
          title: '继续这一轮',
          actionId: 'play',
          submitLabel: '发送',
          note: '发送后本面板会记录装配单；「读数」里可逐条核对字节账。',
          fields: [
            { name: 'cardId', label: '人物卡', type: 'select', required: true, options: cards.map((c) => c.id), hint: '与本会话首次开局一致即可' },
            { name: 'input', label: '你的行动', type: 'textarea', required: true, wide: true, placeholder: '例如：我推门进去，环顾四周。' },
            { name: 'worldbook', label: '世界书（可选，填名字）', type: 'text', placeholder: books[0]?.name ?? '' },
          ],
        },
        {
          kind: 'form',
          title: '开局（新会话）',
          actionId: 'start',
          submitLabel: '开始',
          note: '开局会把卡的开场白落成第一条消息，之后逐轮追加。',
          fields: [
            { name: 'cardId', label: '人物卡', type: 'select', required: true, options: cards.map((c) => c.id) },
            { name: 'worldbook', label: '世界书（可选）', type: 'text', placeholder: books[0]?.name ?? '' },
          ],
        },
        { kind: 'actions', title: '更多', items: [
          { actionId: 'candidates', label: '生成行动候选', level: 'read' },
          { actionId: 'settle', label: '后台结算状态', level: 'write' },
          { actionId: 'readings', label: '装配单读数', level: 'read' },
        ] },
      ];

      const stateEntries = Object.entries(state);
      if (stateEntries.length > 0) {
        blocks.splice(2, 0, {
          kind: 'kv',
          title: '状态（由后台结算写入）',
          pairs: stateEntries.slice(0, 20).map(([key, value]) => ({
            key,
            value: typeof value === 'string' ? value : JSON.stringify(value),
          })),
        });
      }

      return { blocks };
    },

    actions: {
      start: {
        label: '开局',
        level: 'write',
        params: { session: 'string', cardId: 'string', worldbook: 'string' },
        async run(params) {
          const session = asString(params, 'session') || DEFAULT_SESSION;
          const cardId = asString(params, 'cardId');
          const hit = await deps.store.readCard(cardId);
          if (hit === null) return { ok: false, message: `找不到卡「${cardId}」` };
          const existing = await deps.store.readHistory(session);
          if (existing.length > 0) {
            return { ok: false, message: `会话「${session}」已有 ${existing.length} 条历史——开新会话请换 session 名` };
          }
          const greeting: ChatMessage = { role: 'assistant', text: hit.card.firstMessage };
          if (greeting.text.length === 0) return { ok: false, message: `卡「${cardId}」没有开场白，无法开局` };
          await deps.store.appendHistory(session, greeting);
          await deps.store.writeState(session, {});
          return { ok: true, data: { session, card: hit.card.name, openingChars: greeting.text.length } };
        },
      },

      play: {
        label: '玩一轮',
        level: 'write',
        params: { session: 'string', cardId: 'string', input: 'string', worldbook: 'string' },
        async run(params) {
          const session = asString(params, 'session') || DEFAULT_SESSION;
          const request = turnRequest(params, session);
          if (request === null) return { ok: false, message: '需要人物卡与行动文本' };
          const result = await runTurn(deps, request);
          if (!result.ok) return { ok: false, message: result.reason };
          return {
            ok: true,
            data: {
              turn: result.turn,
              textChars: result.text.length,
              requestChars: result.requestChars,
              messages: result.messages,
              a1Ok: result.a1Ok,
              a1Detail: result.a1Detail,
              cacheReadTokens: result.usage.cacheReadTokens,
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              /** 思维链也算进 maxTokens：截断必须显式报出，不许静默。 */
              truncated: result.truncated,
            },
          };
        },
      },

      candidates: {
        label: '行动候选',
        level: 'read',
        params: { session: 'string', cardId: 'string', worldbook: 'string', count: 'number' },
        async run(params) {
          const session = asString(params, 'session') || DEFAULT_SESSION;
          const cardId = asString(params, 'cardId');
          const countRaw = params['count'];
          const count = typeof countRaw === 'number' && Number.isFinite(countRaw) ? Math.max(1, Math.min(6, countRaw)) : 3;
          const history = await deps.store.readHistory(session);
          const lastUser = [...history].reverse().find((m) => m.role === 'user');
          if (lastUser === undefined) return { ok: false, message: '本会话还没有你的行动，先生成一轮正文' };
          const worldbook = asString(params, 'worldbook');
          const result = await runCandidates(deps, {
            session, cardId, input: lastUser.text, count,
            ...(worldbook.length > 0 ? { worldbook } : {}),
          });
          if (!result.ok) return { ok: false, message: result.reason };
          return { ok: true, data: { candidates: result.candidates, a1Ok: result.a1Ok } };
        },
      },

      settle: {
        label: '后台结算',
        level: 'write',
        params: { session: 'string', cardId: 'string', worldbook: 'string' },
        async run(params) {
          const session = asString(params, 'session') || DEFAULT_SESSION;
          const cardId = asString(params, 'cardId');
          const history = await deps.store.readHistory(session);
          const lastUser = [...history].reverse().find((m) => m.role === 'user');
          if (lastUser === undefined) return { ok: false, message: '本会话还没有内容可结算' };
          const worldbook = asString(params, 'worldbook');
          const result = await runSettlement(deps, {
            session, cardId, input: lastUser.text,
            ...(worldbook.length > 0 ? { worldbook } : {}),
          });
          if (!result.ok) return { ok: false, message: result.reason };
          return { ok: true, data: { state: result.state, a1Ok: result.a1Ok } };
        },
      },

      readings: {
        label: '装配单读数',
        level: 'read',
        params: { session: 'string', turn: 'number' },
        async run(params) {
          const session = asString(params, 'session') || DEFAULT_SESSION;
          const turnRaw = params['turn'];
          const latest = await deps.store.readLatestManifest(session);
          const turn = typeof turnRaw === 'number' && Number.isFinite(turnRaw)
            ? Math.max(1, turnRaw)
            : (latest === null ? 0 : latest.turn);
          if (turn === 0) return { ok: false, message: '本会话还没有装配单' };
          const manifest = turn === (latest === null ? -1 : latest.turn)
            ? (latest === null ? null : latest.manifest)
            : await deps.store.readManifest(session, turn);
          if (manifest === null) return { ok: false, message: `第 ${turn} 轮没有装配单` };
          const slotMap = new Map<string, { entries: number; chars: number }>();
          for (const entry of manifest.entries) {
            const acc = slotMap.get(entry.slot) ?? { entries: 0, chars: 0 };
            acc.entries += 1;
            acc.chars += entry.text.length;
            slotMap.set(entry.slot, acc);
          }
          return {
            ok: true,
            data: {
              turn,
              hash: manifest.hash,
              totalChars: manifest.totalChars,
              overBudget: manifest.overBudget,
              dropped: manifest.dropped.length,
              slots: [...slotMap.entries()].map(([slot, v]) => `${slot}:${v.entries}条/${v.chars}字`),
              entries: manifest.entries.map((e) => ({
                slot: e.slot, role: e.role, source: e.source, chars: e.text.length, sha256: e.sha256.slice(0, 12),
                triggers: e.parts.map((p) => p.triggerHit).filter((t): t is string => typeof t === 'string' && t.length > 0),
              })),
            },
          };
        },
      },

      rollback: {
        label: '回退到某轮',
        level: 'destructive',
        params: { session: 'string', turn: 'number' },
        async run(params) {
          const session = asString(params, 'session') || DEFAULT_SESSION;
          const turnRaw = params['turn'];
          if (typeof turnRaw !== 'number' || !Number.isFinite(turnRaw)) return { ok: false, message: '需要轮次号' };
          try {
            const out = await deps.store.rollback(session, Math.max(1, Math.floor(turnRaw)));
            return { ok: true, data: { historyMessages: out.history, stateKeys: out.stateTurns } };
          } catch (err) {
            return { ok: false, message: (err as Error).message };
          }
        },
      },
    },
  };
}
