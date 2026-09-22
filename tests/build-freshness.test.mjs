/**
 * 产物新鲜度 · 判据（2026-09-22 新增）
 *
 * 事故：`npm run build` 跑的是 `tsc -p tsconfig.json`，而本仓 `node_modules/.bin/tsc`
 * **不存在**（typescript 包在，但垫片缺失）⇒ `npm run build` **静默什么都没做**，
 * 而 `node --test` 从 `lib/` 导入 ⇒ **测试验的是旧产物**。用 `Select-String 'error TS'`
 * 检查构建结果时，什么都搜不到（因为失败不是 TS 错误，是命令起不来）。
 *
 * 判据族声明：本文件验「**跑测试的那份代码是不是真的源自当前源码**」——
 * 它不属于 A1–A7（那些验装配行为），但**没有它，A1–A7 的绿可能是过期的绿**。
 *
 * 跑法：先 `npm run build` 再 `npm test`。**未构建 ⇒ 本判据红**（这是刻意的：
 * 缺席的产物应当响亮失败，而不是让上游判据对着旧 lib 得出「通过」）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 纯判据：给定「源文件列表」与「产物列表」，返回违规项。
 * 抽成纯函数是为了能喂**合成样本**证明它会红——否则「现在恰好新鲜」会让它恒绿。
 *
 * @param {{name:string,mtimeMs:number}[]} sources
 * @param {{name:string,mtimeMs:number}[]} artifacts
 */
export function freshnessViolations(sources, artifacts) {
  const byName = new Map(artifacts.map((a) => [a.name, a]));
  const bad = [];
  for (const src of sources) {
    const expected = src.name.replace(/\.ts$/, '.js');
    const art = byName.get(expected);
    if (art === undefined) { bad.push(`${expected} 缺失（源 ${src.name} 未构建）`); continue; }
    if (art.mtimeMs < src.mtimeMs) {
      bad.push(`${expected} 比 ${src.name} 旧（产物 ${new Date(art.mtimeMs).toISOString()} < 源 ${new Date(src.mtimeMs).toISOString()}）`);
    }
  }
  return bad;
}

function stamp(dir, ext) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .map((f) => ({ name: f, mtimeMs: statSync(join(dir, f)).mtimeMs }));
}

test('对照组：新鲜度判据必须**会红**——否则上一条判据只是恒绿装饰', () => {
  const older = freshnessViolations(
    [{ name: 'a.ts', mtimeMs: 200 }],
    [{ name: 'a.js', mtimeMs: 100 }],
  );
  assert.equal(older.length, 1, '产物比源旧必须被抓出');
  const missing = freshnessViolations([{ name: 'b.ts', mtimeMs: 100 }], []);
  assert.equal(missing.length, 1, '产物缺失必须被抓出');
  const fresh = freshnessViolations([{ name: 'c.ts', mtimeMs: 100 }], [{ name: 'c.js', mtimeMs: 100 }]);
  assert.deepEqual(fresh, [], '等 mtime 视为新鲜（边界不得误报）');
});

test('★ 真读数：lib/ 的每个产物都不得比 src/ 的源旧，且不得有源未构建', () => {
  const sources = stamp(join(root, 'src'), '.ts');
  const artifacts = stamp(join(root, 'lib'), '.js');
  assert.ok(sources.length > 0, 'src 下应有 .ts 源文件');
  const bad = freshnessViolations(sources, artifacts);
  assert.deepEqual(bad, [],
    '测试跑的是过期产物（或源未构建）——先 `npm run build`：\n' + bad.join('\n'));
});
