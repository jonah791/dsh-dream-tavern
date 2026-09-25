/**
 * store 的写入落点 —— 判据来源：2026-09-25 主人「不要让程序代替你做判断」。
 *
 * 病根：`attempts[]` 只留 `verdict` / `contentChars` 这类**读数**，产出本身不落盘 ⇒
 * 判据说 `no-prose` 时，判断者（爱丽丝）**既不能确认也不能推翻**。真实案例：某轮 attempt 1
 * 产出 3,823 字符被判不合格，事后翻遍 history / snapshots / manifests / trace 都找不到——永久丢失。
 * **判据可以标记，但不许销毁证据。**
 *
 * 纪律：夹具只写 `os.tmpdir()` 下的临时目录，**绝不触碰生产 dataDir**
 * （见技能 dsh-plugin-testability：测试能删库 = 最坏的一类夹具）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/store.js'

const mkStore = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tavern-store-'))
  return { store: new Store({ dataDir: dir, cardDirs: [], worldDirs: [] }), dir }
}

test('writeAttempt：产出落盘到 attempts/<turn 四位>-<attempt>.md，且逐字可回读', async () => {
  const { store, dir } = await mkStore()
  try {
    const p = await store.writeAttempt('s1', 2, 1, '正文样本 ABC\n第二行')
    assert.ok(p.endsWith(join('attempts', '0002-1.md')), '落点必须是 attempts/0002-1.md，实际：' + p)
    assert.equal(await readFile(p, 'utf8'), '正文样本 ABC\n第二行', '内容必须逐字一致（不 trim、不加料）')
    // 对照组：不同 attempt 必须不同文件（否则后一次会覆盖前一次 = 又一次销毁证据）
    const p3 = await store.writeAttempt('s1', 2, 3, '第三次')
    assert.ok(p3.endsWith('0002-3.md'))
    assert.notEqual(p, p3)
    assert.equal(await readFile(p, 'utf8'), '正文样本 ABC\n第二行', '写第三次不得动第一次的文件')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('writeAttempt：**空产出也落盘**（空文件本身就是「这次真的一字未出」的证据）', async () => {
  const { store, dir } = await mkStore()
  try {
    const p = await store.writeAttempt('s1', 5, 2, '')
    assert.ok(p.length > 0, '空产出也必须返回路径——否则「没产出」与「没留证」事后不可区分')
    assert.equal((await stat(p)).size, 0, '空产出落成 0 字节文件（存在即证据）')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('writeAttempt 与 writeReasoning 的语义差异（后者空内容不落盘——旧语义，不改）', async () => {
  const { store, dir } = await mkStore()
  try {
    assert.equal(await store.writeReasoning('s1', 1, '   '), '', 'writeReasoning 空白内容不落盘')
    const p = await store.writeAttempt('s1', 1, 1, '   ')
    assert.ok(p.length > 0, 'writeAttempt 对空白产出仍落盘（证据不可省）')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
