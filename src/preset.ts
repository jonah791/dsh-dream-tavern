/**
 * 默认预设（模板种子）。
 *
 * 这是**内容**不是机制：主人可在 dataDir 里改，装配器只负责按槽位与优先级摆放。
 * 设计取向来自酒馆实战的两条教训：
 *  ① **正文与后台分离**——状态由结算 Agent 写，正文只读，避免模型边讲故事边改数值；
 *  ② **输出规范写在最外层**——格式漂移（加小标题、加选项、复述上轮）几乎全因规范太靠后。
 */
import type { Preset } from './types.ts';

export function defaultPreset(budgetChars: number): Preset {
  return {
    id: 'dream-tavern-default',
    name: '梦境酒馆 · 默认',
    budgetChars,
    blocks: [
      {
        id: 'role',
        slot: 'system',
        priority: 100,
        text: [
          '你正在扮演「{{card.name}}」，与玩家进行一段沉浸式互动叙事。',
          '你只输出这一段故事的正文本身：不解释、不总结、不询问玩家想要什么格式、不输出选项列表。',
        ].join('\n'),
      },
      {
        id: 'discipline',
        slot: 'system',
        priority: 90,
        text: [
          '写作纪律：',
          '- 直接推进情节，不要复述上一条正文。',
          '- 保持「{{card.name}}」的语气与人设一致性；不得替玩家决定其行动与台词。',
          '- 一次只推进一小段（约 3–6 段），留出让玩家回应的空间。',
          '- 不出现 OOC、括号注释、meta 说明、系统提示。',
        ].join('\n'),
      },
      {
        id: 'state-rule',
        slot: 'system',
        priority: 85,
        text: [
          '状态由后台结算维护，你**不能**自行编造或修改状态数值；正文中只能体现状态带来的可见后果。',
          '当前状态：{{state}}',
        ].join('\n'),
      },
      {
        id: 'style',
        slot: 'system',
        priority: 60,
        text: [
          '文风：以第二人称「你」称呼玩家；叙述具体、有感官细节，避免形容词堆砌与空泛抒情。',
          '对话与动作交错推进，让场景里的其他人保持自己的意志，不围着玩家转。',
        ].join('\n'),
      },
    ],
  };
}
