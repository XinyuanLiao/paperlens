// 注入论文页面的元数据提取。由 popup 经 chrome.scripting 注入（运行在扩展的隔离环境里：
// 读得到页面的 DOM，页面脚本读不到它），注入后调用 window.__paperLensExtract()。
// 整个文件自包含，不依赖任何其它文件。
//
// 提取顺序（前者优先）：Highwire citation_* 标签 → JSON-LD（schema.org 的学术条目）→ 页面里的 PDF 链接。
// IEEE Xplore、arXiv、ACM、Springer、Wiley、Nature 等都有完整的 citation_* 标签；
// Elsevier、Semantic Scholar 等靠 JSON-LD；都没有时至少把 PDF 链接带回去，由应用按文件名识别。
// 不拿页面标题凑数：把搜索结果页、期刊首页的标题当成论文名会污染文献库。
(() => {
  const metas = (n) =>
    Array.from(document.querySelectorAll('meta[name="' + n + '"], meta[property="' + n + '"]'))
      .map((m) => (m.content || '').trim())
      .filter(Boolean)
  const one = (n) => metas(n)[0] || ''
  const squash = (s) => (s || '').replace(/\s+/g, ' ').trim()
  const abs = (u) => {
    try {
      return new URL(u, location.href).href
    } catch (e) {
      return ''
    }
  }
  // 依次取第一个非空值
  const first = (...vals) => {
    for (const v of vals) {
      const t = squash(typeof v === 'string' ? v : '')
      if (t) return t
    }
    return ''
  }
  const pdfLike = (u) => /\.pdf(\?|#|$)/i.test(u) || /\/(pdf|stampPDF|getPDF|downloadPDF|document\/download)(\/|\?|$)/i.test(u)

  // ---------- JSON-LD（schema.org）----------
  // 没有Highwire标签的站点靠它。结构五花八门（单个对象 / @graph 数组 / 相互引用），
  // 先把所有节点摊平再找「像论文的那一个」

  const SCHOLARLY_TYPES = ['ScholarlyArticle', 'Article', 'Thesis', 'Report', 'Paper', 'Chapter', 'Book', 'ScholarlyPreprint', 'Preprint', 'Publication']

  // 取节点上的文字：字符串原样；数组逐项；对象取它的 name
  const text = (v) => {
    if (v == null) return ''
    if (typeof v === 'string') return v
    if (Array.isArray(v)) return v.map(text).filter(Boolean).join(', ')
    if (typeof v === 'object') return text(v.name || v.alternateName || v.givenName || '')
    return String(v)
  }

  const fromJsonLd = () => {
    const out = { title: '', creators: '', date: '', doi: '', venue: '', pdf: [] }
    const nodes = []
    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const walk = (x) => {
          if (Array.isArray(x)) x.forEach(walk)
          else if (x && typeof x === 'object') {
            nodes.push(x)
            // 常见的嵌套写法：@graph、mainEntity、itemListElement
            if (x['@graph']) walk(x['@graph'])
            if (x.mainEntity) walk(x.mainEntity)
            if (Array.isArray(x.itemListElement)) walk(x.itemListElement)
          }
        }
        walk(JSON.parse(el.textContent))
      } catch (e) {
        /* 不是合法 JSON 的脚本块：跳过 */
      }
    }
    const typesOf = (n) => [].concat(n['@type'] || []).map((t) => String(t).split('/').pop())
    // 越靠前的类型越像「论文本身」：优先选它，避免选中网页（WebPage）或列表页（CollectionPage）
    let doc = null
    let bestRank = Infinity
    for (const n of nodes) {
      const rank = typesOf(n).reduce((m, t) => Math.min(m, SCHOLARLY_TYPES.indexOf(t)), Infinity)
      if (rank < bestRank && (n.name || n.headline)) {
        bestRank = rank
        doc = n
      }
    }
    if (!doc) return out

    out.title = squash(text(doc.name || doc.headline))
    out.creators = []
      .concat(doc.author || doc.creator || [])
      .map((a) => {
        if (typeof a === 'string') return a
        if (!a || typeof a !== 'object') return ''
        const given = text(a.givenName)
        const family = text(a.familyName)
        return given || family ? [given, family].filter(Boolean).join(' ') : text(a.name)
      })
      .filter(Boolean)
      .join(', ')
    out.date = text(doc.datePublished || doc.dateCreated)
    out.doi = text(doc.doi)

    // 期刊 / 会议名：沿着 isPartOf 往上找（论文 → 卷 → 期 → 期刊 → 出版方），
    // 取第一个不与出版方同名的——最外层常是出版方（如 "Springer"），不是期刊
    const publisher = squash(text(doc.publisher && typeof doc.publisher === 'object' ? doc.publisher.name : doc.publisher))
    const names = []
    for (let cur = doc.isPartOf, i = 0; cur && typeof cur === 'object' && i < 5; cur = cur.isPartOf, i++) {
      const n = squash(text(cur.name))
      if (n && !names.includes(n)) names.push(n)
    }
    out.venue = names.find((n) => n !== publisher) || names[0] || ''

    out.pdf = []
      .concat(doc.encoding || doc.associatedMedia || [])
      .map((e) => (typeof e === 'string' ? e : e && typeof e === 'object' ? e.contentUrl || e.embedUrl : ''))
      .filter((u) => u && pdfLike(u))
      .map(abs)
      .filter(Boolean)
    return out
  }

  window.__paperLensExtract = () => {
    const ld = fromJsonLd()
    const links = Array.from(document.querySelectorAll('a[href]'))
      .map((a) => a.getAttribute('href') || '')
      .filter((h) => h && !/^(javascript:|mailto:|#|data:)/i.test(h))
      .map(abs)
      .filter(Boolean)
    const attachments = Array.from(new Set([...metas('citation_pdf_url').map(abs).filter(Boolean), ...ld.pdf, ...links.filter(pdfLike)])).slice(0, 8)
    const title = first(one('citation_title'), one('dc.title'), one('DC.Title'), ld.title)
    return {
      title,
      creators: first(metas('citation_author').join(', '), metas('DC.creator').join(', '), ld.creators),
      date: first(one('citation_publication_date'), one('citation_date'), one('citation_online_date'), one('dc.date'), one('DC.Date'), ld.date),
      doi: first(one('citation_doi'), one('prism.doi'), ld.doi).replace(/^(doi:\s*|https?:\/\/(dx\.)?doi\.org\/)/i, ''),
      venue: first(
        one('citation_journal_title'),
        one('citation_conference_title'),
        one('citation_technical_report_institution'),
        one('citation_technical_report_university'),
        one('prism.publicationName'),
        ld.venue
      ),
      url: location.href,
      pageTitle: squash(document.title),
      // 什么信号都没有（没有标题也找不到 PDF 链接）就返回空：这不是论文页
      attachments: title || attachments.length ? attachments : []
    }
  }
})()
