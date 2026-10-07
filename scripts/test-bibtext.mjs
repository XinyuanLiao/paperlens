// bibtext.ts 纯函数回归测试（解析/渲染/key/转义/去重）——导出矫正链的地基。
// 运行：node scripts/test-bibtext.mjs（esbuild 现编译 src/main/bibtext.ts 后执行）
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outDir = path.join(root, '.zcode', 'tmp')
mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, 'bibtext.test.mjs')
await build({
  entryPoints: [path.join(root, 'src/main/bibtext.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})
const { parseBibtexEntry, renderBibtexEntry, makeCiteKey, firstAuthorFamily, dedupeKeys, latexEscape, foldUnicode } = await import(
  'file://' + outFile.replace(/\\/g, '/')
)

let pass = 0
const fail = []
const eq = (name, got, want) => {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) pass++
  else fail.push(`${name}\n  got:  ${g}\n  want: ${w}`)
}

// ---- 解析：CrossRef 官方风格（嵌套括号、双引号值、多字段） ----
const official = `@article{Wang_2023,
  doi = {10.1109/TPEL.2023.1234567},
  url = {https://doi.org/10.1109/TPEL.2023.1234567},
  year = 2023,
  publisher = {IEEE},
  volume = {38},
  number = {4},
  pages = {4561--4572},
  author = {Wang, Xiao and Li, Ming and MÃ¼ller, Jan},
  title = {Junction Temperature Estimation of {IGBT} Modules},
  journal = {IEEE Transactions on Power Electronics}
}`
const e1 = parseBibtexEntry(official)
eq('parse type', e1?.type, 'article')
eq('parse key', e1?.key, 'Wang_2023')
eq('parse nested-brace title', e1?.fields.title, 'Junction Temperature Estimation of {IGBT} Modules')
eq('parse bare year', e1?.fields.year, '2023')
eq('parse pages', e1?.fields.pages, '4561--4572')
eq('parse author unicode kept raw', e1?.fields.author, 'Wang, Xiao and Li, Ming and MÃ¼ller, Jan')
eq('field count', Object.keys(e1?.fields ?? {}).length, 10)

// ---- 解析：@inproceedings + 双引号值 + 圆括号条目 ----
const inproc = `@inproceedings("k1", author = "A. B. Cee", title = "Quoted {Value}")`
const e2 = parseBibtexEntry(inproc)
eq('paren entry type', e2?.type, 'inproceedings')
eq('paren entry quoted author', e2?.fields.author, 'A. B. Cee')

// ---- 解析失败：截断 / 无 @ / 括号不配平 ----
eq('truncated -> null', parseBibtexEntry('@article{k, title = {Unclosed'), null)
eq('no @ -> null', parseBibtexEntry('plain text'), null)
eq('empty -> null', parseBibtexEntry(''), null)

// ---- 渲染 → 解析往返一致 ----
const r1 = renderBibtexEntry({ type: 'article', key: 'k2024x', fields: { title: 'T {X} Y', author: 'A and B', year: '2024', doi: '10.1/x' } })
const back = parseBibtexEntry(r1)
eq('roundtrip type', back?.type, 'article')
eq('roundtrip key', back?.key, 'k2024x')
const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))
eq('roundtrip fields', sortObj(back?.fields ?? {}), sortObj({ title: 'T {X} Y', author: 'A and B', year: '2024', doi: '10.1/x' }))
eq('render field order author first', /^@article\{k2024x,\n  author = \{A and B\}/.test(r1), true)

// ---- key 生成 ----
eq(
  'key from comma-joined authors',
  makeCiteKey('Xiao Wang, Ming Li', 2023, 'A Novel Approach to Junction Temperature Estimation'),
  'wang2023approach'
)
eq('key from bibtex and-form', makeCiteKey('Zhang, San and Li, Si', 2020, 'Thermal Network Model'), 'zhang2020thermal')
eq('key no year', makeCiteKey('San Zhang', null, 'IGBT Lifetime'), 'zhangigbt')
eq('key stopword skip', makeCiteKey('A. B. Cee', 1999, 'The Design of something'), 'cee1999something')
eq('key no authors -> anon', makeCiteKey('', 2021, 'Cooling'), 'anon2021cooling')
eq('key unicode author folded', makeCiteKey('Müller, Jan', 2015, 'Ein Test'), 'muller2015ein')

// ---- 第一作者姓 ----
eq('family comma-joined multi', firstAuthorFamily('San Zhang, Si Li'), 'Zhang')
eq('family bibtex form', firstAuthorFamily('Zhang, San and Li, Si'), 'Zhang')
eq('family single plain', firstAuthorFamily('San Zhang'), 'Zhang')
eq('family empty', firstAuthorFamily(''), '')

// ---- 去重 ----
const es = [{ key: 'a2020x' }, { key: 'a2020x' }, { key: 'a2020x' }, { key: 'b' }]
dedupeKeys(es)
eq('dedupe', es.map((x) => x.key), ['a2020x', 'a2020x-2', 'a2020x-3', 'b'])

// ---- 转义与折叠 ----
eq('latex escape', latexEscape('A & B 100% C_D #x $y {z}'), 'A \\& B 100\\% C\\_D \\#x \\$y \\{z\\}')
eq('fold unicode accents', foldUnicode('Café ünïcode Ångström'), 'Caf\\\'{e} \\\'{u}n\\\'{i}code {\\AA}ngstr\\\'{o}m')
eq('fold dash/ellipsis/times', foldUnicode('a—b–c… 5×7'), 'a--b--c\\ldots{} 5$\\times$7')
eq('fold strips CJK noise', foldUnicode('功率电子 thermal'), ' thermal')

console.log(`bibtext tests: ${pass} passed, ${fail.length} failed`)
if (fail.length) {
  console.error(fail.join('\n'))
  process.exit(1)
}
