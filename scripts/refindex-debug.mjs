// buildRefIndex 解析质量诊断：对真实 PDF 跑生产代码，审计编号覆盖/假条目/行键自洽
// 用法：先 npx esbuild src/renderer/src/reflink.ts --bundle --format=esm --outfile=.reflink-bundle.mjs
//      再 node scripts/refindex-debug.mjs <pdf1> [pdf2 ...]
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
const reflink = await import(pathToFileURL(path.resolve('.reflink-bundle.mjs')).href)

for (const file of process.argv.slice(2)) {
  const data = new Uint8Array(fs.readFileSync(file))
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise
  const idx = await reflink.buildRefIndex(doc)
  const nums = idx.entries.map((e) => e.num)
  const maxNum = Math.max(...nums, 0)
  const missing = []
  for (let n = 1; n <= maxNum; n++) if (!idx.byNum.has(n)) missing.push(n)
  // 假条目特征：raw 以小写字母/连字符/右括号开头（像续行）、或异常短
  const suspicious = idx.entries.filter((e) => /^[a-z\)\]}]/.test(e.raw) || e.raw.length < 25)
  // 行键自洽：每条目自己的行键必须精确反查回自己
  let selfOk = 0
  const selfBad = []
  for (const e of idx.entries) {
    let ok = true
    for (const k of e.lineKeys) {
      if (idx.byLine.get(k) !== e) { ok = false; break }
    }
    if (ok) selfOk++
    else selfBad.push(e.num)
  }
  console.log('=====', path.basename(file), `(${doc.numPages} 页)`)
  console.log(`entries=${idx.entries.length} maxNum=${maxNum} byNum缺失=[${missing.join(',')}] parsed=${idx.parsed}`)
  console.log(`行键自洽: ${selfOk}/${idx.entries.length}`, selfBad.length ? `异常=[${selfBad.join(',')}]` : '')
  // 模糊反查：把每个条目最长行键截掉 18% 模拟 DOM 组成差异，lookupEntry 应回到同一条目
  let fuzzyOk = 0
  const fuzzyBad = []
  for (const e of idx.entries) {
    const k = e.lineKeys.reduce((a, b) => (b.length > a.length ? b : a), '')
    if (k.length < 12) continue
    const mangled = k.slice(0, Math.floor(k.length * 0.82))
    const hit = reflink.lookupEntry(idx, null, mangled)
    if (hit === e) fuzzyOk++
    else fuzzyBad.push(e.num)
  }
  console.log(`模糊反查: ${fuzzyOk}/${idx.entries.length}`, fuzzyBad.length ? `异常=[${fuzzyBad.slice(0, 10).join(',')}${fuzzyBad.length > 10 ? '…' : ''}]` : '')
  console.log(`可疑条目(${suspicious.length}):`, JSON.stringify(suspicious.slice(0, 6).map((e) => `[${e.num}] ${e.raw.slice(0, 48)}`)))
  const sample = [...idx.entries.slice(0, 6), ...idx.entries.slice(-3)]
  for (const e of sample) console.log(`  [${e.num}] p${e.page} ${e.raw.slice(0, 70)}`)
  await doc.destroy()
}
