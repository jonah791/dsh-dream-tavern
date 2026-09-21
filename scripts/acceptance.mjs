#!/usr/bin/env node
/**
 * 验收总闸 —— 一条命令给出「七条判据 + 真实数据读数」的裁决。
 *
 * 设计取向：**测试是唯一真源**，本脚本不重复实现判据，只做三件测试做不到的事：
 *  ① 把测试名映射回判据编号（A1…A7），让「哪条判据被测到」可核对；
 *  ② 报告真实数据规模，并在数据**不可达**时响亮降级（而不是静默跳过）；
 *  ③ 静态检查「有没有第二条通往模型的装配路径」（A7 的旁路面）。
 *
 * ⚠ 平台纪律（2026-09-22 实测）：默认路径是 Windows 形式；在 WSL 里跑会**不可达**，
 * 于是真数据判据整组跳过、PASS 静默降强。本脚本因此显式换算路径，并把跳过计入裁决。
 *
 * 跑法：
 *   node scripts/acceptance.mjs
 *   DREAM_TAVERN_CARDS=... DREAM_TAVERN_WORLDS=... node scripts/acceptance.mjs
 * 退出码：0 = 全判据通过且真数据可达；1 = 测试失败；2 = 测试通过但真数据不可达。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const DEFAULT_CARDS = '';
const DEFAULT_WORLDS = '';

/** Translate `C:/x` into the WSL mount path when not running on Windows. */
function nativePath(input) {
  if (process.platform === 'win32') return input;
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(input);
  if (match === null) return input;
  return `/mnt/${(match[1] ?? 'c').toLowerCase()}/${(match[2] ?? '').replace(/\\/g, '/')}`;
}

const cardsDir = nativePath(process.env.DREAM_TAVERN_CARDS ?? DEFAULT_CARDS);
const worldsDir = nativePath(process.env.DREAM_TAVERN_WORLDS ?? DEFAULT_WORLDS);

const env = { ...process.env, DREAM_TAVERN_CARDS: cardsDir, DREAM_TAVERN_WORLDS: worldsDir };

/** 判据 → 覆盖它的测试名片段（用于回答「这条判据到底被测到没有」）。 */
const CRITERIA = [
  ['A1', '装配单即事实（逐字节可重建）', ['A1 条目与消息 1:1', 'A1 篡改实际请求', 'A1 少发一条']],
  ['A2', '确定性（同输入同 hash）', ['A2 确定性', 'A2：同输入不同会话']],
  ['A3', '原子回退（字节级 + 行为级）', ['A3：回退把正文与状态', 'A3 反例']],
  ['A4', '缓存命中可读（真模型轮回报 usage）', ['usage']],
  ['A5', 'ST 卡往返不丢字段/不改卡', ['A5 真实卡库：全部卡的字段集往返不丢', 'A5 真实卡库：字节往返']],
  ['A6', '世界书匹配为纯函数', ['A6 纯函数']],
  ['A7', '各路径共用装配器（无旁路）', ['A7：面板动作与工具走同一条装配路径']],
];

/** 依赖真数据的判据：数据不可达时这组会整组跳过，裁决强度必须随之降级。 */
const REALDATA_TESTS = 4;

function listFiles(dir, ext) {
  if (!existsSync(dir)) return null;
  try {
    return readdirSync(dir).filter((f) => f.toLowerCase().endsWith(ext))
      .filter((f) => { try { return statSync(join(dir, f)).isFile(); } catch { return false; } });
  } catch { return null; }
}

function totalBytes(dir, files) {
  if (files === null) return 0;
  return files.reduce((n, f) => { try { return n + statSync(join(dir, f)).size; } catch { return n; } }, 0);
}

console.log('═'.repeat(72));
console.log('梦境酒馆 · 验收总闸（dsh-dream-tavern）');
console.log('═'.repeat(72));
console.log(`  平台 ${process.platform} · 卡库 ${cardsDir === '' ? '(未配置)' : cardsDir}`);
console.log(`  世界书 ${worldsDir === '' ? '(未配置)' : worldsDir}`);

console.log('\n[1/3] 运行判据测试 …\n');
const run = spawnSync(process.execPath, ['--test', 'tests/*.test.mjs'], {
  cwd: root, env, stdio: 'inherit', shell: true,
});
const testStatus = run.status ?? 1;

console.log('\n[2/3] 判据覆盖表');
const testSource = ['tests/assemble.test.mjs', 'tests/card.test.mjs', 'tests/lorebook.test.mjs', 'tests/session.test.mjs', 'tests/worldbook.test.mjs']
  .filter((p) => existsSync(join(root, p)))
  .map((p) => readFileSync(join(root, p), 'utf8'))
  .join('\n');
let covered = 0;
for (const [id, title, needles] of CRITERIA) {
  const hit = needles.filter((n) => testSource.includes(n));
  if (hit.length > 0) covered += 1;
  console.log(`  ${id}  ${hit.length > 0 ? '覆盖' : '⚠ 未见测试'}  ${title}${hit.length > 0 ? `（${hit.length} 处）` : ''}`);
}
console.log(`  判据覆盖 ${covered}/${CRITERIA.length}`);

console.log('\n[3/3] 真实数据读数');
const cards = listFiles(cardsDir, '.png');
const worlds = listFiles(worldsDir, '.json');
const realDataReachable = cards !== null && worlds !== null;
if (cards === null) console.log(cardsDir === ''
  ? '  卡库：未配置 DREAM_TAVERN_CARDS —— 真数据判据（A5/迁移实测）整组跳过'
  : `  ⚠ 卡库不可达：${cardsDir} —— 真数据判据（A5/迁移实测）将整组跳过`);
else console.log(`  卡库：${cards.length} 张 PNG，${(totalBytes(cardsDir, cards) / 1048576).toFixed(1)} MB`);
if (worlds === null) console.log(worldsDir === ''
  ? '  世界书：未配置 DREAM_TAVERN_WORLDS —— 世界书迁移实测跳过'
  : `  ⚠ 世界书不可达：${worldsDir} —— 世界书迁移实测将跳过`);
else console.log(`  世界书：${worlds.length} 本，${(totalBytes(worldsDir, worlds) / 1048576).toFixed(1)} MB`);

const allowed = new Set(['src/assemble.ts', 'src/session.ts', 'src/index.ts']);
const offenders = [];
for (const file of readdirSync(join(root, 'src'))) {
  if (!file.endsWith('.ts')) continue;
  if (allowed.has(`src/${file}`)) continue;
  if (/\bassemble\s*\(/.test(readFileSync(join(root, 'src', file), 'utf8'))) offenders.push(`src/${file}`);
}
console.log(offenders.length === 0
  ? '  A7 旁路面：src/ 下除装配器与回合层外无其它 assemble( 调用点 ✓'
  : `  ⚠ A7 旁路面：${offenders.join('、')} 也在调用 assemble(——须确认是否旁路`);

if (testStatus === 0 && !realDataReachable) {
  console.log(`  ⚠ 真数据不可达 ⇒ 约 ${REALDATA_TESTS} 项判据被跳过：本次 PASS 的强度**低于**全量验收`);
}

console.log('\n' + '═'.repeat(72));
if (testStatus !== 0) console.log(`裁决：FAIL（测试退出码 ${testStatus}）`);
else if (!realDataReachable) console.log('裁决：PASS（降级）—— 判据全过，但真数据判据被跳过');
else console.log('裁决：PASS（全量）—— 判据全过且真数据实测');
console.log('═'.repeat(72));
process.exit(testStatus !== 0 ? testStatus : (realDataReachable ? 0 : 2));
