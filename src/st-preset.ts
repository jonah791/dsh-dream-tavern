/**
 * ST 预设 → 本插件 `Preset` 的桥接（**纯函数**）。
 *
 * 背景（2026-09-22）：本插件被指定的第一个目的是「**迭代预设**」，而预设的**正本**是主人的
 * ST 预设（`tavern/色欲之罪预设/`）。此前 `presetPath` 只做到「通道打通」——它读的是**本插件的
 * JSON 形状**，读不了 ST 预设。本模块补上格式桥接。
 *
 * ⚠ 两种形状**不是同一个东西**，差异必须逐条说清而不是抹平：
 *
 * | 维度 | ST 预设（真实读数，2026-09-22 自 `色欲之罪V3.1.json`） | 本插件 `Preset` |
 * |---|---|---|
 * | 条目 | `prompts[]` 73 条（内容 62 + **marker 11**） | `blocks[]` |
 * | 顺序 | **独立一张表** `prompt_order[0].order[]`，按 identifier 引用 | `priority` 字段（越大越前） |
 * | 卡片字段位置 | 由 **marker** 占位（`charDescription`/`scenario`/…）⇒ **预设可拨** | **写死在代码里**（§4.5 `card-tier` 的硬边界） |
 * | 角色 | 每条带 `role`（system 28 / user 45） | **无 role 维度** |
 * | 采样 | 顶层 46 字段（temperature/top_p/penalties/max_tokens…） | 不承载（由宿主与插件配置决定） |
 *
 * ⇒ 桥接的产物不只是 `Preset`，还有一张**对账表**：映射了什么、没建模什么、**为什么**。
 * **未建模项逐条登记，绝不静默丢弃**——「静默丢字段」正是本仓今天刚修过的那类缺陷
 * （卡内世界书 1223 条因词汇不匹配被静默丢弃，命中 0）。
 */
import type { Preset, PresetBlock, Slot } from './types.ts';

/** ST 预设里被识别但**本层不建模**的顶层字段 → 理由（逐条，不是一句「不支持」）。 */
const TOP_UNMODELED: Record<string, string> = {
  temperature: '采样参数：本插件的模型调用由宿主与插件配置决定，预设不承载采样',
  top_p: '采样参数：同上',
  top_k: '采样参数：同上',
  top_a: '采样参数：同上',
  min_p: '采样参数：同上',
  n: '采样参数：同上',
  seed: '采样参数：同上',
  frequency_penalty: '采样参数：同上',
  presence_penalty: '采样参数：同上',
  repetition_penalty: '采样参数：同上',
  openai_max_tokens: '生成上限：本插件用 `maxTokens`（插件配置），不读预设里的该值',
  openai_max_context: '上下文上限：本插件用 `budgetChars`（插件配置），口径也不同（字符 vs token）',
  max_context_unlocked: '上下文上限开关：同上',
  squash_system_messages: '消息折叠策略：本插件的装配位置模型是显式槽位（§3.2），不引入折叠',
  use_sysprompt: '系统提示开关：本插件的 system 槽位是显式的，无此开关',
  enable_web_search: '外部能力开关：本插件不管工具面',
  function_calling: '外部能力开关：同上',
  request_images: '图像请求开关：同上',
  request_image_aspect_ratio: '图像参数：同上',
  request_image_resolution: '图像参数：同上',
  inline_image_quality: '图像参数：同上',
  media_inlining: '媒体内联：同上',
  stream_openai: '传输细节：由宿主决定',
  show_thoughts: '展示层：本插件不建模展示',
  reasoning_effort: '推理强度：宿主/模型路由的职责',
  verbosity: '展示层：同上',
  tool_reasoning_mode: '工具与推理模式：宿主职责',
  tool_call_recurse_limit: '工具递归上限：宿主职责',
  continue_prefill: '续写细节：本插件无「续写」动作',
  continue_postfix: '续写细节：同上',
  continue_nudge_prompt: '续写细节：同上',
  assistant_prefill: '预填助手回复：本插件无此动作',
  assistant_impersonation: '扮演用户：本插件不允许（正文 Agent 不得替玩家决定行动）',
  impersonation_prompt: '扮演提示：同上',
  group_nudge_prompt: '群聊：本插件单角色',
  new_group_chat_prompt: '群聊：同上',
  names_behavior: '名字呈现策略：展示层',
  personality_format: '卡字段格式串：本插件的卡片字段注入是显式分级（§4.5 card-tier）',
  scenario_format: '卡字段格式串：同上',
  wi_format: '世界书格式串：同上',
  send_if_empty: '空输入兜底：本插件要求非空输入',
  bias_preset_selected: 'bias 机制：本插件不建模',
  extensions: '扩展区：第三方扩展的私有数据，原样留档',
  new_chat_prompt: '开场提示：本插件用卡片的 first_mes，不读预设',
  new_example_chat_prompt: '样例提示：同上',
};

/** ST 的 marker 条目 → 本插件里由**代码**注入的对应物（诚实说明为什么不可拨）。 */
const MARKER_REASONS: Record<string, string> = {
  charDescription: '卡片主定义：本插件以代码固定优先级注入（system@99）',
  charPersonality: '卡片人设摘要：同上（persona_prefix@100）',
  scenario: '卡片场景：同上（system@90）',
  dialogueExamples: '对话样例：同上（system@45）',
  personaDescription: '用户人设：本插件无 user persona 面',
  worldInfoBefore: '世界书（前）：本插件由装配器按关键词命中注入，位置由条目 `position` 决定',
  worldInfoAfter: '世界书（后）：同上',
  chatHistory: '对话历史：本插件按历史顺序注入（与预设无关）',
  agentTask: 'ST 侧 agent 机制：本插件不建模',
  agentSystemPrompt: 'ST 侧 agent 机制：同上',
  agentResults: 'ST 侧 agent 机制：同上',
};

export interface StBridgeMapped { from: string; to: string }
export interface StBridgeUnmodeled { field: string; reason: string }
export interface StBridgeStats {
  prompts: number;
  markers: number;
  enabledInPrompts: number;
  blocks: number;
  disabledByOrder: number;
  orderSource: 'prompt_order' | 'prompts-array';
}

export interface StBridgeResult {
  preset?: Preset;
  mapped: StBridgeMapped[];
  unmodeled: StBridgeUnmodeled[];
  errors: string[];
  stats: StBridgeStats;
}

interface AnyPrompt { [k: string]: unknown }

function asString(v: unknown): string { return typeof v === 'string' ? v : ''; }

/**
 * 把 ST 预设 JSON 桥接为 `Preset`。**纯函数、不抛**：所有问题收进 `errors`，零错误才给出 `preset`。
 *
 * @param st 已 JSON.parse 的 ST 预设
 * @param opts.budgetChars 本插件的预算（ST 的上下文上限口径不同，不沿用）
 */
export function bridgeStPreset(st: unknown, opts: { budgetChars: number }): StBridgeResult {
  const errors: string[] = [];
  const mapped: StBridgeMapped[] = [];
  const unmodeled: StBridgeUnmodeled[] = [];
  const stats: StBridgeStats = {
    prompts: 0, markers: 0, enabledInPrompts: 0, blocks: 0, disabledByOrder: 0, orderSource: 'prompts-array',
  };

  if (st === null || typeof st !== 'object' || Array.isArray(st)) {
    return { mapped, unmodeled, errors: ['顶层必须是对象'], stats };
  }
  const obj = st as Record<string, unknown>;
  const promptsRaw = obj['prompts'];
  if (!Array.isArray(promptsRaw)) return { mapped, unmodeled, errors: ['缺少 prompts 数组'], stats };
  if (promptsRaw.length === 0) return { mapped, unmodeled, errors: ['prompts 为空'], stats };
  stats.prompts = promptsRaw.length;

  const prompts = promptsRaw.filter((p): p is AnyPrompt => p !== null && typeof p === 'object');
  const byId = new Map<string, AnyPrompt>();
  for (const p of prompts) {
    const id = asString(p['identifier']);
    if (id !== '') byId.set(id, p);
    if (p['marker'] === true) stats.markers += 1;
    if (p['enabled'] === true) stats.enabledInPrompts += 1;
  }

  // 顺序真源：`prompt_order[0].order`（实测：该预设只有一组，character_id=100001）
  let orderItems: Array<{ identifier: string; enabled: boolean }> | null = null;
  const orderRaw = obj['prompt_order'];
  if (Array.isArray(orderRaw) && orderRaw.length > 0) {
    const groups = orderRaw.filter((g): g is Record<string, unknown> => g !== null && typeof g === 'object');
    if (groups.length > 1) {
      // 多组 ⇒ 取第一组并**如实记账**（不静默）
      unmodeled.push({ field: 'prompt_order[1..]', reason: `该文件有 ${groups.length} 组顺序表；只用了第 1 组（character_id=${String(groups[0]?.['character_id'] ?? '?')}）` });
    }
    const first = groups[0];
    const order = first?.['order'];
    if (Array.isArray(order)) {
      orderItems = order
        .filter((o): o is Record<string, unknown> => o !== null && typeof o === 'object')
        .map((o) => ({ identifier: asString(o['identifier']), enabled: o['enabled'] !== false }));
      stats.orderSource = 'prompt_order';
      mapped.push({ from: 'prompt_order[0].order[]', to: 'blocks[] 的顺序与 priority', });
    }
  }
  if (orderItems === null) {
    orderItems = prompts.map((p) => ({ identifier: asString(p['identifier']), enabled: p['enabled'] !== false }));
    unmodeled.push({ field: 'prompt_order', reason: '缺失或为空 ⇒ 退回按 prompts 数组顺序装配（顺序语义可能与该预设的意图不同）' });
  }

  const blocks: PresetBlock[] = [];
  const n = orderItems.length;
  orderItems.forEach((item, i) => {
    const p = byId.get(item.identifier);
    if (p === undefined) {
      errors.push(`prompt_order 引用了不存在的 identifier：${item.identifier}`);
      return;
    }
    const isMarker = p['marker'] === true;
    const promptEnabled = p['enabled'] !== false;
    const enabled = item.enabled && promptEnabled;
    if (!item.enabled) stats.disabledByOrder += 1;

    if (isMarker) {
      const key = item.identifier;
      unmodeled.push({ field: `prompt(marker):${key}`, reason: MARKER_REASONS[key] ?? '未知 marker（原样留档，不假装支持）' });
      return;
    }
    const content = asString(p['content']);
    if (content.length === 0) {
      unmodeled.push({ field: `prompt:${item.identifier}`, reason: '内容为空（无注入价值）' });
      return;
    }

    // 位置：ST `injection_position === 1` 才是「按深度」；0（实测 66 条）是相对位置 ⇒ 归入 system 区段
    const pos = Number(p['injection_position']);
    const depthRaw = Number(p['injection_depth']);
    const slot: Slot = pos === 1
      ? (`depth-${Number.isFinite(depthRaw) && depthRaw >= 1 ? Math.floor(depthRaw) : 1}` as Slot)
      : 'system';

    blocks.push({
      // 用 identifier 作 id：它与装配单里的 `preset:<blockId>` 对应，可追溯回原预设
      id: item.identifier,
      slot,
      // 顺序即优先级：越靠前越大（本插件的 priority 语义是「同 slot 内越大越前」）
      priority: (n - i) * 10,
      text: content,
      enabled,
    });
    stats.blocks += 1;
  });

  if (stats.blocks === 0) errors.push('没有任何可映射的内容条目（全是 marker 或内容为空）');

  // 逐条登记未建模的顶层字段（识别过的给理由；未识别的原样留档，不假装支持）
  const known = new Set(['name', 'prompts', 'prompt_order']);
  for (const key of Object.keys(obj)) {
    if (known.has(key)) continue;
    const reason = TOP_UNMODELED[key];
    unmodeled.push({
      field: `top:${key}`,
      reason: reason ?? '未识别字段（原样留档，不假装支持）',
    });
  }
  mapped.push({ from: 'name', to: 'Preset.name' });
  mapped.push({ from: 'prompts[].content', to: 'blocks[].text' });
  mapped.push({ from: 'prompts[].enabled × order[].enabled', to: 'blocks[].enabled（两者都启用才启用）' });
  mapped.push({ from: 'prompts[].injection_position=1 + injection_depth', to: 'blocks[].slot = depth-N' });
  mapped.push({ from: '（位置即顺序）', to: 'blocks[].priority = (总条数 − 序位) × 10' });

  if (errors.length > 0) return { mapped, unmodeled, errors, stats };

  const name = asString(obj['name']);
  return {
    preset: {
      id: 'st-' + (name === '' ? 'preset' : name),
      name: name === '' ? 'ST 预设' : name,
      blocks,
      budgetChars: opts.budgetChars,
    },
    mapped,
    unmodeled,
    errors: [],
    stats,
  };
}
