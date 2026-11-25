// refmeta.ts 纯函数回归测试（标题同一性判定）——元信息回填与 BibTeX 联网核对共用的采纳门槛。
// 运行：node scripts/test-refmeta.mjs（esbuild 现编译 src/main/refmeta.ts 后执行；不联网）
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outDir = path.join(root, '.zcode', 'tmp')
mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, 'refmeta.test.mjs')
await build({ entryPoints: [path.join(root, 'src/main/refmeta.ts')], outfile: outFile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
const { sameTitle, diceBigram, cleanPdfUrls } = await import('file://' + outFile.replace(/\\/g, '/'))

let pass = 0
const fail = []
const eq = (name, got, want) => {
  if (got === want) pass++
  else fail.push(`${name}\n  got:  ${got}\n  want: ${want}`)
}

// 采纳门槛 0.6（enrich.ts / bibresolve.ts 的 DICE_MIN）
const same = (a, b) => sameTitle(a, b, 0.6)
eq('同一标题：只有大小写 / 标点差异', same('A Calibration-Free Junction Temperature Estimation Method Using Gate Voltage Plateau', 'A calibration-free junction temperature estimation method using gate voltage plateau.'), true)
eq('同一标题：复数形式略有出入', same('Thermal-sensitive electrical parameters for power modules', 'Thermal-sensitive electrical parameters for power module'), true)
eq('同一标题：库里是中文、学术库是英文 → 只靠 bigram（词太少）', sameTitle('功率模块结温估算方法研究', '功率模块结温估算方法研究', 0.6), true)
// 真实事故：bigram 0.625 越过门槛，但两边说的不是一回事
eq('短而泛的标题撞门槛：Categorised By Connector Paper ≠ Companies Categorised by Sector', same('Categorised By Connector Paper', 'Companies Categorised by Sector'), false)
eq('bigram 本身就过不了线', same('Gate Voltage Plateau as a Temperature Indicator', 'Deep learning for image classification on ImageNet'), false)
eq('bigram 过线但实词几乎不同', same('A Review of Deep Learning Methods for Power Electronics', 'A Review of Deep Learning Methods for Image Processing'), false)
eq('bigram 很高、实词也大多相同（多一个副标题）', same('Online Junction Temperature Monitoring via Gate Charge Characteristics', 'Online junction temperature monitoring via gate charge characteristics for IGBT modules'), true)
eq('dice 参考值（事故样本）', diceBigram('companies categorised by sector', 'categorised by connector paper') >= 0.6, true)

// PDF 候选清洗：去重、排序权重、数量上限
eq('PDF 候选：去重', cleanPdfUrls([{ url: 'https://a.org/x.pdf' }, { url: 'https://A.org/x.pdf' }]).length, 1)
eq('PDF 候选：Unpaywall 优先于直链', cleanPdfUrls([{ url: 'https://a.org/x.pdf' }, { url: 'https://b.org/y', fromUnpaywall: true }])[0], 'https://b.org/y')
eq('PDF 候选：非 http(s) 丢弃', cleanPdfUrls([{ url: 'ftp://a.org/x.pdf' }, { url: 'javascript:alert(1)' }]).length, 0)
eq('PDF 候选：最多 5 个', cleanPdfUrls(Array.from({ length: 9 }, (_, i) => ({ url: `https://a.org/${i}.pdf` }))).length, 5)

console.log(`refmeta tests: ${pass} passed, ${fail.length} failed`)
if (fail.length) {
  console.error(fail.join('\n'))
  process.exit(1)
}
