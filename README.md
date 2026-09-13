# PaperLens

macOS / Windows 桌面文献阅读器：PDF 阅读 + 划词翻译 + LLM 问答 + 全库 RAG。

## 功能

- **文献库**：扫描工作区自动建立索引，AI 自动归类（可创建新分类），右键导出/分享
- **PDF 阅读**：标签页、缩略缩放（触控板捏合 / Ctrl±）、划词高亮（持久化，点击删除）
- **划词翻译**：选中 → 翻译，术语结合当前页上下文（bond wire → 键合线）
- **LLM 问答**：智谱 / DeepSeek / 通义 / Kimi / OpenAI 等预设，流式输出
- **全库 RAG**：本地嵌入（e5-small / Ollama）+ BM25 混合检索，回答带页码引用可跳转
- 深浅色主题（跟随系统）

## 开发

```bash
npm install
npm run rebuild   # 重建 better-sqlite3 的 Electron 绑定
npm run dev
```

前置要求：Node 20+；macOS 另需 Xcode Command Line Tools（`xcode-select --install`，编译 better-sqlite3 用），Windows 需 VS Build Tools + Python 3。首次建索引时本地嵌入模型（multilingual-e5-small，约 130 MB）会自动下载到 userData 目录。

## 打包安装包

```bash
npm run dist:win   # Windows：dist/PaperLens Setup <版本>.exe（NSIS，可选安装目录 + 桌面快捷方式）
npm run dist:mac   # macOS：dist/PaperLens-<版本>-arm64.dmg / -x64.dmg
```

- **macOS 必须在 Mac 上执行**（苹果工具链不支持交叉编译），Windows 上执行 `dist:win` 即可；打包会自动按目标平台重编 better-sqlite3，无需手动 rebuild。
- 两个平台均未做代码签名：Windows 首次运行 SmartScreen 提示时选「仍要运行」；macOS 首次打开若提示无法验证开发者，右键 App → 打开，或执行 `xattr -cr /Applications/PaperLens.app`。
- 版本号取自 package.json 的 `version`，发新版改它即可。

技术栈：Electron + React + pdf.js + better-sqlite3(FTS5) + transformers.js。
