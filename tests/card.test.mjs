/**
 * A5 — 真实人物卡往返不丢字段。
 *
 * 夹具纪律：**绝不写回主人的卡库**（只读其目录）；且不得依赖运行平台——
 * 卡库路径由环境变量 `DREAM_TAVERN_CARDS` 提供，未设置时整组跳过（不假绿）。
 *
 * 跑法：
 *   DREAM_TAVERN_CARDS="<你的 ST characters/ 目录>" node --test tests/card.test.mjs
 *   （WSL 下用 /mnt/c/... 形式；Windows 下用 C:/... 形式）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fromSt, toSt, readStPng, writeStPng, slugify } from '../lib/card.js';
import { readFileSync } from 'node:fs';

const CARDS_DIR = process.env.DREAM_TAVERN_CARDS ?? '';
const realCards = (() => {
  if (!CARDS_DIR) return [];
  try {
    return readdirSync(CARDS_DIR)
      .filter((f) => f.toLowerCase().endsWith('.png'))
      .map((f) => join(CARDS_DIR, f))
      .filter((p) => { try { return statSync(p).isFile(); } catch { return false; } });
  } catch {
    return [];
  }
})();

test('slugify 生成文件系统安全的 id', () => {
  assert.equal(slugify('Living With Slaves V1.41'), 'Living_With_Slaves_V1.41');
  assert.equal(slugify('a/b:c*d?e'), 'a_b_c_d_e');
  assert.equal(slugify('   '), 'card');
});

test('非 PNG 输入要响亮报错，不静默返回空卡', () => {
  assert.throws(() => readStPng(Buffer.from('not a png')), /不是 PNG 文件/);
});

test('PNG 里没有 chara 块要报错', () => {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const iend = Buffer.concat([Buffer.alloc(4), Buffer.from('IEND'), Buffer.alloc(4)]);
  assert.throws(() => readStPng(Buffer.concat([sig, iend])), /没有 chara 元数据块/);
});

test('合成卡：写入后重读，JSON 完全一致（含中文与多字节）', () => {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0); ihdrData.writeUInt32BE(1, 4);
  ihdrData[8] = 8; ihdrData[9] = 6;
  const ihdr = Buffer.concat([Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), ihdrData, Buffer.alloc(4)]);
  const iend = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from('IEND'), Buffer.alloc(4)]);
  const card = { name: '测试·角色', description: '描述 emoji 🗡', tags: ['a', 'b'], data: { nested: { x: 1 } } };
  const out = writeStPng(Buffer.concat([sig, ihdr, iend]), card);
  assert.deepEqual(readStPng(out), card);
  // 幂等：再写一次仍一致，且不会堆积多个 chara 块
  const out2 = writeStPng(out, card);
  assert.deepEqual(readStPng(out2), card);
  const count = (buf) => buf.toString('latin1').split('chara').length - 1;
  assert.equal(count(out2), 1, 'chara 块必须只有一个');
});

test('A5 真实卡库：全部卡的字段集往返不丢', { skip: realCards.length === 0 ? `未设置 DREAM_TAVERN_CARDS（找到 ${realCards.length} 张）` : false }, () => {
  assert.ok(realCards.length > 0, '真实卡库不应为空');
  const failures = [];
  let checked = 0;
  for (const path of realCards) {
    try {
      const raw = readStPng(readFileSync(path));
      const back = toSt(fromSt(raw), raw);
      const keysRaw = Object.keys(raw).sort();
      const keysBack = Object.keys(back).sort();
      if (JSON.stringify(keysRaw) !== JSON.stringify(keysBack)) {
        failures.push(`${path}: 键集变化 ${keysRaw.length} -> ${keysBack.length}`);
        continue;
      }
      const diff = keysRaw.filter((k) => JSON.stringify(raw[k]) !== JSON.stringify(back[k]));
      if (diff.length > 0) failures.push(`${path}: 值不一致 ${diff.join(',')}`);
      checked += 1;
    } catch (err) {
      failures.push(`${path}: ${err.message}`);
    }
  }
  assert.equal(failures.length, 0, `共 ${realCards.length} 张，${failures.length} 张失败：\n${failures.slice(0, 5).join('\n')}`);
  assert.equal(checked, realCards.length);
});

test('A5 真实卡库：字节往返（写回内存 PNG 后重读一致）', { skip: realCards.length === 0 ? '未设置 DREAM_TAVERN_CARDS' : false }, () => {
  const path = realCards[0];
  const buf = readFileSync(path);
  const raw = readStPng(buf);
  const rewritten = writeStPng(buf, raw);
  assert.deepEqual(readStPng(rewritten), raw);
});

test('V3 布局：顶层为空时回落到 data.*（真数据里 44/58 张卡是这个形态）', () => {
  const v3 = {
    name: '甲', spec: 'chara_card_v3',
    description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
    data: {
      description: '来自 data 的描述',
      personality: '来自 data 的性格',
      scenario: '来自 data 的场景',
      first_mes: '来自 data 的开场',
      mes_example: '来自 data 的示例',
      system_prompt: '来自 data 的系统提示',
      post_history_instructions: '来自 data 的历史后指令',
    },
  };
  const parsed = fromSt(v3);
  assert.equal(parsed.description, '来自 data 的描述');
  assert.equal(parsed.persona, '来自 data 的性格');
  assert.equal(parsed.scenario, '来自 data 的场景');
  assert.equal(parsed.firstMessage, '来自 data 的开场');
  assert.equal(parsed.exampleDialogue, '来自 data 的示例');
  assert.equal(parsed.systemPrompt, '来自 data 的系统提示');
  assert.equal(parsed.postHistoryInstructions, '来自 data 的历史后指令');
});

test('顶层非空时优先用顶层（不被 data 覆盖）', () => {
  const parsed = fromSt({ name: '乙', description: '顶层', data: { description: '嵌套' } });
  assert.equal(parsed.description, '顶层');
});

test('卡内嵌世界书 data.character_book 会被导入', () => {
  const parsed = fromSt({
    name: '丙',
    data: { character_book: { entries: { '1': { uid: 1, key: ['铃'], content: '铃铛会响' } } } },
  });
  assert.equal(parsed.lorebook.length, 1);
  assert.equal(parsed.lorebook[0].content, '铃铛会响');
});

test('卡内世界书坏掉时不阻断读卡，也不假装导入成功', () => {
  const parsed = fromSt({ name: '丁', data: { character_book: '这不是对象' } });
  assert.deepEqual(parsed.lorebook, []);
  assert.equal(parsed.name, '丁');
});

test('迁移实测：真卡库的内容确实被读到（不是空角色）', { skip: realCards.length === 0 ? '未设置 DREAM_TAVERN_CARDS' : false }, () => {
  let withPersona = 0;
  let withOpening = 0;
  let withLorebook = 0;
  let loreOnly = 0;
  let empty = 0;
  let totalOpening = 0;
  const empties = [];
  for (const path of realCards) {
    const parsed = fromSt(readStPng(readFileSync(path)));
    const personaish = parsed.persona.length + parsed.description.length + parsed.scenario.length;
    if (personaish > 0) withPersona += 1;
    if (parsed.firstMessage.length > 0) { withOpening += 1; totalOpening += parsed.firstMessage.length; }
    if (parsed.lorebook.length > 0) withLorebook += 1;
    if (personaish === 0 && parsed.firstMessage.length === 0 && parsed.lorebook.length > 0) loreOnly += 1;
    // 「空」的判据必须含卡内世界书：有 30 条世界书的卡不是空卡（首版判据漏了这一维，误报 1 张）
    if (personaish === 0 && parsed.firstMessage.length === 0 && parsed.lorebook.length === 0) {
      empty += 1;
      empties.push(path.split(/[\\/]/).pop());
    }
  }
  console.log(`    [读数] ${realCards.length} 张：有设定 ${withPersona} / 有开场 ${withOpening}（合计 ${totalOpening} 字）/ 含卡内世界书 ${withLorebook} / 仅世界书承载 ${loreOnly} / 完全空 ${empty}`);
  assert.equal(empty, 0, `读出来完全为空的卡：${empties.join('、')}`);
  assert.ok(withOpening >= realCards.length * 0.9, `开场白读出率过低：${withOpening}/${realCards.length}`);
});
