# PaperLens Connector

把 IEEE Xplore、arXiv 等网站上的论文一键保存到本地 PaperLens 文献库的浏览器扩展。工作方式参考 Zotero Connector：

```
浏览器扩展  ──(本机 HTTP，127.0.0.1:23420)──▶  PaperLens 桌面应用
   │ 读取论文页面的元数据（标题 / 作者 / 期刊 / DOI / PDF 地址）           │
   │ 用浏览器当前的登录状态把 PDF 取下来                                    │ └─ 入库、建索引、在阅读区打开
   └─ 把元数据 + PDF 一起交给应用 ─────────────────────────────────────────▶
```

PDF 由浏览器下载，所以机构账号、校园网认证都是现成的，不需要在应用里再登录一次。

## 安装（只需一次）

适用于 Chrome、Edge 等 Chromium 内核浏览器（Manifest V3）。

1. 在 PaperLens 里打开「文件 → 通过浏览器扩展导入…」，点「复制路径」或「打开文件夹」，找到扩展目录
   （安装包版本在应用的资源目录 `resources/connector/`，从源码运行就是本目录）。
2. 在浏览器的扩展管理页打开「开发者模式」：
   - Chrome：地址栏输入 `chrome://extensions`
   - Edge：地址栏输入 `edge://extensions`
3. 点「加载已解压的扩展程序」，选择上一步的文件夹。

目前是未打包上架的开发者模式安装；上架应用商店后可以省掉这一步。

## 使用

1. 在浏览器里打开论文页面——IEEE Xplore 的 Document 页、arXiv 的摘要页、ACM / Springer / Wiley / Nature 等。
2. 点工具栏上的 PaperLens 图标，弹窗里会显示识别到的标题、作者、期刊、年份、DOI。
3. 选好分类，点「保存到 PaperLens」。

也可以直接在 PDF 页面上点扩展：整份 PDF 原样存进文库。

- 每个站点**第一次**保存时，浏览器会询问「是否允许扩展读取和更改该站点的数据」——请点「允许」。
  PDF 要靠这个权限带着登录状态去下载。拒绝过的话可以在扩展管理页里重新授权。
- 保存成功后回到 PaperLens，新文献已经自动在阅读区打开。同一篇不会重复入库。

## 识别不到论文？

- 扩展读的是页面上的 `citation_*` 元数据标签（IEEE、arXiv、ACM、Springer、Wiley、Nature 等都有），
  其次是 JSON-LD（Elsevier、Semantic Scholar 等）。搜索结果页、期刊首页不是论文页。
- 页面上只有 PDF 链接、没有元数据时也能保存，标题按文件名识别（之后由应用补全）。
- 取不到全文：先在浏览器里登录机构账号；仍然不行就先用浏览器打开 PDF 页面，再点扩展保存。

## 它能访问什么

| 权限 | 用途 |
| --- | --- |
| `activeTab` | 点扩展图标时，读取当前标签页的地址、注入元数据提取脚本 |
| `scripting` | 向当前论文页面注入 `extract.js` |
| `storage` | 记住上次选的分类 |
| 站点访问权限（按需、逐站申请） | 保存时带着登录状态下载该站点的 PDF |

扩展不上传任何数据：所有请求只发往本机的 PaperLens（`127.0.0.1`）和当前论文站点本身。

## 文件

| 文件 | 作用 |
| --- | --- |
| `manifest.json` | 扩展清单 |
| `extract.js` | 注入论文页面的元数据提取（Highwire 标签 → JSON-LD → PDF 链接） |
| `background.js` | 后台：探测本机的 PaperLens、下载 PDF、与应用通信 |
| `popup.html` / `popup.js` / `popup.css` | 点击图标后的弹窗 |

应用一侧的实现与安全边界见 [`src/main/connector.ts`](../src/main/connector.ts)。
