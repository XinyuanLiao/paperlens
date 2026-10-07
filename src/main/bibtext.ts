// BibTeX 文本层：单条解析 / 统一渲染 / 引用 key 生成 / LaTeX 转义与 Unicode 折叠。
// 零依赖纯函数（不 import electron/db），可单独打包测试——它是导出矫正链的最后一道闸：
// 官方取回的 BibTeX 要 parse 得回来才能用，最终文件要能被本模块完整 parse 才允许写盘。

export interface ParsedEntry {
  type: string // article / inproceedings / ...
  key: string
  fields: Record<string, string> // 字段名一律小写
}

// 渲染时的字段顺序：作者/标题在前、定位信息在后，符合主流样式习惯；
// 不在表内的字段（doi/url/note 等）保持原相对顺序追加
const FIELD_ORDER = [
  'author', 'editor', 'title', 'journal', 'booktitle', 'year', 'month',
  'volume', 'number', 'pages', 'chapter', 'edition', 'series',
  'publisher', 'address', 'institution', 'school', 'note'
]

// ---------- 解析 ----------

// 解析单条 BibTeX（@type{key, field = {v}, ...}）。花括号值支持任意嵌套，双引号值支持 {} 内嵌。
// 解析失败（截断/括号不配平/无字段名）返回 null——官方接口返回的东西不能盲信。
export function parseBibtexEntry(src: string): ParsedEntry | null {
  const s = src.replace(/\r\n/g, '\n')
  const at = s.indexOf('@')
  if (at < 0) return null
  let i = at + 1
  // 类型名：字母
  let m = /^([A-Za-z]+)\s*[({]/.exec(s.slice(i))
  if (!m) return null
  const type = m[1].toLowerCase()
  i += m[0].length
  const closeCh = m[0].endsWith('(') ? ')' : '}'
  // key：到首个逗号（圆括号形式的 key 语法上可省略，这里要求存在逗号）
  const comma = s.indexOf(',', i)
  if (comma < 0) return null
  const key = s.slice(i, comma).trim()
  i = comma + 1
  const fields: Record<string, string> = {}
  const n = s.length
  while (i < n) {
    // 跳过空白与残留逗号
    while (i < n && /[\s,]/.test(s[i])) i++
    if (i >= n) break
    if (s[i] === closeCh) {
      i++
      return { type, key, fields }
    }
    // 字段名：wordchars 与连字符
    m = /^([A-Za-z][\w-.+]*)\s*=\s*/.exec(s.slice(i))
    if (!m) return null
    const name = m[1].toLowerCase()
    i += m[0].length
    // 值：{...}（嵌套）/ "..." / 裸 token
    let val = ''
    if (s[i] === '{') {
      let depth = 0
      const start = i
      while (i < n) {
        if (s[i] === '{') depth++
        else if (s[i] === '}') {
          depth--
          if (depth === 0) break
        }
        i++
      }
      if (depth !== 0) return null
      val = s.slice(start + 1, i)
      i++
    } else if (s[i] === '"') {
      const start = i + 1
      let depth = 0
      while (i + 1 < n) {
        const c = s[i + 1]
        if (c === '{') depth++
        else if (c === '}') depth--
        else if (c === '"' && depth === 0) break
        i++
      }
      if (i + 1 >= n) return null
      val = s.slice(start, i + 1)
      i += 2
    } else {
      m = /^[^\s,}]+/.exec(s.slice(i))
      if (!m) return null
      val = m[0]
      i += m[0].length
    }
    if (val.trim()) fields[name] = val.trim()
    // 值后要么逗号要么收尾括号，由下一轮循环统一处理
  }
  return null // 没等到收尾括号就跑完了：截断
}

// ---------- 渲染 ----------

export function renderBibtexEntry(e: ParsedEntry): string {
  const names = Object.keys(e.fields)
  const ordered = [
    ...FIELD_ORDER.filter((f) => f in e.fields),
    ...names.filter((f) => !FIELD_ORDER.includes(f))
  ]
  const lines = ordered.map((f) => `  ${f} = {${e.fields[f]}},`)
  return `@${e.type}{${e.key},\n${lines.join('\n')}\n}\n`
}

// ---------- 引用 key ----------

// key 里的非字母数字（含中文/变音/标点）折叠成 ascii：去变音失败则整体丢弃该词。
// Unicode 正式分解（NFD）后去掉组合变音符，剩下的拉丁字母直接可用
export function asciiFold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w-]/g, '')
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'on', 'of', 'for', 'and', 'or', 'in', 'to', 'via', 'with', 'without',
  'novel', 'new', 'study', 'design', 'analysis', 'toward', 'towards', 'using', 'based',
  'research', 'review', 'application', 'applications', 'effect', 'effects', 'performance'
])

// 第一作者姓：输入两种形态——库内/学术库的 "Given Family, Given Family"（逗号连接多作者）
// 与 BibTeX 惯例的 "Family, Given and Family, Given"。统一取首作者段，再取末词为姓
//（"San Zhang, Si Li" → "San Zhang" → "Zhang"；"Zhang, San and ..." → "Zhang"）。
export function firstAuthorFamily(authors: string): string {
  const first = authors
    .split(/\s+and\s+/i)[0]
    .split(',')[0]
    .trim()
  const words = first.split(/\s+/).filter(Boolean)
  return words[words.length - 1] ?? ''
}

// key 形如 wang2023thermal：首作者姓 + 年份（缺失留空）+ 标题首个非停用词。
// 词里没有可折叠的 ascii 时跳过该词；全空兜底 "paper"。
export function makeCiteKey(authors: string, year: number | null, title: string): string {
  const fam = asciiFold(firstAuthorFamily(authors)).toLowerCase() || 'anon'
  const yr = year != null && Number.isFinite(year) ? String(year) : ''
  const word =
    title
      .split(/[^\w-]+/)
      .map((w) => asciiFold(w))
      .filter(Boolean)
      .map((w) => w.toLowerCase())
      .find((w) => !STOPWORDS.has(w)) ?? 'paper'
  return `${fam}${yr}${word}`
}

// 同 key 加 -2/-3 后缀去重（原地修改）
export function dedupeKeys(entries: Array<{ key: string }>): void {
  const seen = new Map<string, number>()
  for (const e of entries) {
    const n = seen.get(e.key) ?? 0
    seen.set(e.key, n + 1)
    if (n > 0) e.key = `${e.key}-${n + 1}`
  }
}

// ---------- 转义与 Unicode 折叠（拼装字段用；官方条目已是 LaTeX 形态不再转义） ----------

// LaTeX 特殊字符转义（用于库内/检索原始文本写入字段值时）
export function latexEscape(s: string): string {
  return s
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
}

// 常见非 ASCII → LaTeX 命令：pdflatex（IEEE 投稿主用）遇到裸 Unicode 会编译报错。
// 覆盖拉丁变音/常见符号即可，生僻字符保守替换为最近的 ascii 而不是删除（宁损精度不损编译）。
const UNICODE_MAP: Array<[RegExp, string]> = [
  [/[‘’‚‛]/g, "'"],
  [/[“”„]/g, "''"],
  [/[–—]/g, '--'],
  [/…/g, '\\ldots{}'],
  [/[àáâãäå]/g, "\\'{a}"],
  [/[èéêë]/g, "\\'{e}"],
  [/[ìíîï]/g, "\\'{i}"],
  [/[òóôõö]/g, "\\'{o}"],
  [/[ùúûü]/g, "\\'{u}"],
  [/[ÀÁÂÃÄ]/g, "\\'{A}"],
  [/[ÈÉÊË]/g, "\\'{E}"],
  [/[ÌÍÎÏ]/g, "\\'{I}"],
  [/[ÒÓÔÕÖ]/g, "\\'{O}"],
  [/[ÙÚÛÜ]/g, "\\'{U}"],
  [/ç/g, '\\c{c}'],
  [/Ç/g, '\\c{C}'],
  [/ñ/g, '\\~{n}'],
  [/Ñ/g, '\\~{N}'],
  [/ß/g, '{\\ss}'],
  [/ø/g, '{\\o}'],
  [/Ø/g, '{\\O}'],
  [/å/g, '{\\aa}'],
  [/Å/g, '{\\AA}'],
  [/[≈∼]/g, '$\\sim$'],
  [/×/g, '$\\times$'],
  [/μ/g, '$\\mu$'],
  [/°/g, '\\textdegree{}'],
  [/±/g, '$\\pm$'],
  [/→/g, '$\\rightarrow$']
]

// 折叠 Unicode；映射表之外的非 ASCII（中日韩等）直接剔除——出现在英文题录里
// 通常是从 PDF 抽取的噪声，剔除比保留编译失败更安全
export function foldUnicode(s: string): string {
  let out = s
  for (const [re, rep] of UNICODE_MAP) out = out.replace(re, rep)
  return out.replace(/[^\x00-\x7F]/g, '')
}
