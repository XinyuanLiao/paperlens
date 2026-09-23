import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

// ---------- 本地字体枚举 ----------
// 解析 TTF/OTF/TTC 的 name 表取字体家族名（Windows UTF-16BE：0x409 英文 + 0x804 中文），
// 比读注册表（GBK 编码问题）/ 文件名猜测可靠。结果进程内缓存。
interface FontNameRec {
  platform: number
  encoding: number
  lang: number
  nameId: number
  length: number
  offset: number
}

// 解码字符串记录：buf 已经是读出的完整字符串字节（abs() 按 rec.offset/length 裁好），
// 不要再按 rec.offset 二次切片（曾导致全部名字为空/残片）
function decodeName(buf: Buffer, rec: FontNameRec): string {
  if (rec.platform === 3 || rec.platform === 0) {
    // UTF-16BE
    let out = ''
    for (let i = 0; i + 1 < buf.length; i += 2) out += String.fromCharCode(buf.readUInt16BE(i))
    return out
  }
  return buf.toString('latin1')
}

// 从打开的 fd 读取一个 font header（TTC 取第 index 个）的家族名
function familyFromFd(fd: number, headerOffset: number, nameCache: Map<string, string>): string | null {
  const head = Buffer.alloc(12)
  if (fs.readSync(fd, head, 0, 12, headerOffset) < 12) return null
  const numTables = head.readUInt16BE(4)
  const dir = Buffer.alloc(numTables * 16)
  if (fs.readSync(fd, dir, 0, dir.length, headerOffset + 12) < dir.length) return null
  let nameOff = -1
  for (let t = 0; t < numTables; t++) {
    const tag = dir.subarray(t * 16, t * 16 + 4).toString('latin1')
    if (tag === 'name') {
      nameOff = dir.readUInt32BE(t * 16 + 8)
      break
    }
  }
  if (nameOff < 0) return null
  const nh = Buffer.alloc(6)
  if (fs.readSync(fd, nh, 0, 6, headerOffset + nameOff) < 6) return null
  const count = nh.readUInt16BE(2)
  const storageOff = nh.readUInt16BE(4)
  const recs: FontNameRec[] = []
  const rt = Buffer.alloc(count * 12)
  if (fs.readSync(fd, rt, 0, rt.length, headerOffset + nameOff + 6) < rt.length) return null
  for (let i = 0; i < count; i++) {
    recs.push({
      platform: rt.readUInt16BE(i * 12),
      encoding: rt.readUInt16BE(i * 12 + 2),
      lang: rt.readUInt16BE(i * 12 + 4),
      nameId: rt.readUInt16BE(i * 12 + 6),
      length: rt.readUInt16BE(i * 12 + 8),
      offset: rt.readUInt16BE(i * 12 + 10)
    })
  }
  const abs = (r: FontNameRec): string | null => {
    if (r.length > 512) return null
    const buf = Buffer.alloc(r.length)
    try {
      if (fs.readSync(fd, buf, 0, r.length, headerOffset + nameOff + storageOff + r.offset) < r.length) return null
    } catch {
      return null
    }
    return decodeName(buf, r)
  }
  // 优先 typographic family(16)，回退 family(1)；语言优先中文(0x804)，回退英文(0x409)
  const pick = (nameId: number, lang: number): string | null => {
    const r = recs.find((x) => x.nameId === nameId && x.lang === lang && (x.platform === 3 || x.platform === 0))
    return r ? abs(r) : null
  }
  const zh = pick(16, 0x804) ?? pick(1, 0x804)
  const en = pick(16, 0x409) ?? pick(1, 0x409)
  const name = zh || en
  if (!name) return null
  if (zh && en && zh !== en) nameCache.set(name, en)
  return name
}

function scanFontDir(dir: string, out: Map<string, string>): void {
  let entries: string[] = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const f of entries) {
    if (!/\.(ttf|otf|ttc)$/i.test(f)) continue
    let fd: number | null = null
    try {
      fd = fs.openSync(path.join(dir, f), 'r')
      if (/\.ttc$/i.test(f)) {
        // TTC：取第一个字体（同族变体共享 name）。头 16 字节：tag(4)+ver(4)+numFonts(4)+首个偏移(4)
        const h = Buffer.alloc(16)
        if (fs.readSync(fd, h, 0, 16, 0) === 16 && h.toString('latin1', 0, 4) === 'ttcf') {
          const firstOff = h.readUInt32BE(12)
          const name = familyFromFd(fd, firstOff, out)
          if (name) out.set(name, name)
        }
      } else {
        const name = familyFromFd(fd, 0, out)
        if (name) out.set(name, name)
      }
    } catch {
      /* 单个字体解析失败跳过 */
    } finally {
      if (fd !== null) try { fs.closeSync(fd) } catch { /* noop */ }
    }
  }
}

let fontCache: string[] | null = null
export function listLocalFonts(): string[] {
  if (fontCache) return fontCache
  const found = new Map<string, string>()
  if (process.platform === 'win32') {
    const windir = process.env.WINDIR || 'C:\\Windows'
    scanFontDir(path.join(windir, 'Fonts'), found)
    scanFontDir(path.join(app.getPath('home'), 'AppData', 'Local', 'Microsoft', 'Windows', 'Fonts'), found)
  } else if (process.platform === 'darwin') {
    scanFontDir('/System/Library/Fonts', found)
    scanFontDir('/Library/Fonts', found)
    scanFontDir(path.join(app.getPath('home'), 'Library', 'Fonts'), found)
  } else {
    scanFontDir('/usr/share/fonts', found)
    scanFontDir(path.join(app.getPath('home'), '.fonts'), found)
  }
  // 中文优先排序（带中文名的靠前），同级按 locale 排序
  fontCache = [...found.keys()].sort((a, b) => {
    const ac = /[\u4e00-\u9fff]/.test(a) ? 0 : 1
    const bc = /[\u4e00-\u9fff]/.test(b) ? 0 : 1
    if (ac !== bc) return ac - bc
    return a.localeCompare(b, 'zh-Hans-CN')
  })
  return fontCache
}
