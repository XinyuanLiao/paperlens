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

技术栈：Electron + React + pdf.js + better-sqlite3(FTS5) + transformers.js。
