// bibresolve.ts 联网真实测试：验证矫正链三层降级与官方 BibTeX 二次比对。
// 需要外网（CrossRef/doi.org）；运行：node scripts/test-bibresolve-live.mjs
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outDir = path.join(root, '.zcode', 'tmp')
mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, 'bibresolve.test.mjs')
const btFile = path.join(outDir, 'bibtext.test.mjs')
await Promise.all([
  build({
    entryPoints: [path.join(root, 'src/main/bibresolve.ts')],
    outfile: outFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  }),
  build({
    entryPoints: [path.join(root, 'src/main/bibtext.ts')],
    outfile: btFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
])
const { resolvePaperEntry } = await import('file://' + outFile.replace(/\\/g, '/'))
const { renderBibtexEntry, parseBibtexEntry } = await import('file://' + btFile.replace(/\\/g, '/'))

// diceBigram 在 refmeta.ts 里；测试里内联同款（bigram Dice）
function diceBigram(a, b) {
  if (a.length < 2 || b.length < 2) return 0
  const ga = new Set()
  for (let i = 0; i < a.length - 1; i++) ga.add(a.slice(i, i + 2))
  const gb = new Set()
  for (let i = 0; i < b.length - 1; i++) gb.add(b.slice(i, i + 2))
  let hit = 0
  for (const g of ga) if (gb.has(g)) hit++
  return (2 * hit) / (ga.size + gb.size)
}

let pass = 0
const fail = []
const check = (name, ok, detail = '') => {
  if (ok) pass++
  else fail.push(`${name}${detail ? ' — ' + detail : ''}`)
}

// ---- 1. 真实存在的 TPEL 论文：应命中 official（DOI 官方 BibTeX + 二次比对） ----
const r1 = await resolvePaperEntry({
  title: 'An industry-based survey of reliability in power electronic converters',
  authors: 'Shaoyong Yang, et al.',
  year: 2011,
  venue: 'IEEE Transactions on Power Electronics'
})
console.log('--- case1 (真实论文) ---')
console.log('source:', r1.source, '| key:', r1.entry.key, '| type:', r1.entry.type)
console.log(renderBibtexEntry(r1.entry))
check('case1 命中联网层', r1.source === 'official' || r1.source === 'web', `got ${r1.source}`)
check('case1 title 相似', diceBigram((r1.entry.fields.title ?? '').replace(/[{}]/g, '').toLowerCase(), 'an industry-based survey of reliability in power electronic converters') >= 0.6)
check('case1 有年份', !!r1.entry.fields.year)
check('case1 渲染可往返', parseBibtexEntry(renderBibtexEntry(r1.entry))?.key === r1.entry.key)

// ---- 2. 不存在的标题：应安静降级 local + unverified 警告 ----
const r2 = await resolvePaperEntry({
  title: 'Zzzqqq Xvvv utterly nonexistent paper about nothing at all 98765',
  authors: 'Nobody Here',
  year: 1998,
  venue: ''
})
console.log('--- case2 (伪造标题) ---')
console.log('source:', r2.source, '| warnings:', r2.warnings.join(','), '| key:', r2.entry.key)
check('case2 降级 local', r2.source === 'local')
check('case2 挂 unverified', r2.warnings.includes('unverified'))
check('case2 缺出处挂 no-venue', r2.warnings.includes('no-venue'))

// ---- 3. 标题对但年份差 5 年：严格门槛应拒绝联网命中（防蹭错版本） ----
const r3 = await resolvePaperEntry({
  title: 'An industry-based survey of reliability in power electronic converters',
  authors: '',
  year: 2025,
  venue: ''
})
console.log('--- case3 (年份错位) ---')
console.log('source:', r3.source, '| warnings:', r3.warnings.join(','))
check('case3 年份错位拒绝联网层', r3.source === 'local')

console.log(`\nbibresolve live tests: ${pass} passed, ${fail.length} failed`)
if (fail.length) {
  console.error(fail.join('\n'))
  process.exit(1)
}
