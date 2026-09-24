<div align="center">

# 🔍 PaperLens

### 让 AI 陪你读文献 —— 划词翻译 · 论文问答 · 全库对话

**PaperLens** 是一个面向科研人的本地文献阅读器：把 PDF 文献库变成一个**可以对话的知识库**。

[![Release](https://img.shields.io/github/v/release/XinyuanLiao/paperlens?style=flat-square&color=c96442)](https://github.com/XinyuanLiao/paperlens/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-555555?style=flat-square)](https://github.com/XinyuanLiao/paperlens/releases)
[![License](https://img.shields.io/badge/License-PolyForm%20Noncommercial-c96442?style=flat-square)](./LICENSE)

</div>

---

## ✨ 功能

### 阅读
- **PDF 阅读**：多开折叠管理、页内全文搜索（Ctrl+F，全部命中高亮 + 逐个跳转）、缩放、翻页
- **划词操作**：选中文字浮条一键 高亮 / 复制 / 解释 / 翻译；翻译结合当前页上下文消歧（`bond wire` → 键合线）
- **划词高亮持久化**，点击即可删除
- **文献库管理**：分类视图 + 最近视图、拖拽归类、右键重命名/移动/导出、AI 导入时逐篇推荐分类
- **自动索引**：导入后台自动建立检索索引，iCloud / OneDrive 多设备同步后自动重扫

### 问答与对话
- **论文问答**（阅读页右侧）：针对当前文献或全库提问，回答流式输出，页码引用可点击跳回原文并高亮命中段落
- **全库对话**（对话模式）：不打开 PDF 直接跨文献提问；**勾选任意文献加入检索范围**，回答只在所选文献内取证
- **对话历史**：每个话题自动命名保存，可重命名、删除、继续追问；支持复制/编辑已发问题并重新生成回答
- **渲染**：Markdown / 代码高亮复制 / 表格 / LaTeX 公式（KaTeX）
- **检索**：查询预处理（术语扩展 / 指代消解）→ 向量 + BM25 混合召回（RRF 融合）→ 交叉编码器精排（bge-reranker-v2-m3），章节感知分块，文献级兜底不漏强相关论文

### 通用
- Claude 风格界面：暖色纸面 + 陶土红点缀，深 / 浅色主题跟随系统
- 全局字体自定义（选本机字体，缺字自动回退）+ 对话字号调节
- `Ctrl/Cmd+K` 命令面板；模型 / 思考等级 / 检索范围在界面内随时切换
- 多服务商配置：智谱 / DeepSeek / 通义 / Kimi / OpenAI / 小米 MiMo / 任意 OpenAI 兼容接口

---

## 📦 安装

到 [**Releases**](https://github.com/XinyuanLiao/paperlens/releases) 下载：

| 平台 | 文件 |
|---|---|
| Windows (x64) | `PaperLens Setup <版本>.exe` |
| macOS（Apple Silicon / Intel） | `PaperLens-<版本>-arm64.dmg` / `-x64.dmg` |

> 未做代码签名：Windows 首次运行 SmartScreen 提示时选「仍要运行」；macOS 首次打开若提示无法验证开发者，右键 App →「打开」，或执行 `xattr -cr /Applications/PaperLens.app`。

---

## 🚀 快速上手

1. **首次启动向导**：选择一个文件夹作为文献库 → 填大模型 API Key（不填也能阅读与管理，只是没有 AI 功能）。嵌入模型由 Ollama 管理，PDF 结构化解析已内置
2. **导入文献**：把 PDF 拖进窗口，或点「添加文献」；AI 自动识别标题并推荐分类，可逐篇调整
3. **阅读**：左侧列表点开论文；划词试试点「翻译」
4. **问答**：阅读页右侧直接问当前论文；点回答里的 `p.N` 引用跳回原文
5. **全库对话**：切到「对话」模式直接提问；或在阅读模式勾选文献 → 点底部「加入对话检索」→ 回到对话模式，回答只在勾选范围内取证

### 常用快捷键

| 快捷键 | 功能 |
|---|---|
| `Ctrl/Cmd + K` | 命令面板（搜索文献 / 执行命令） |
| `Ctrl/Cmd + F` | PDF 页内搜索 |
| `Ctrl/Cmd + +/-/0` | 缩放 / 适应宽度 |
| `Enter` / `Shift+Enter` | 发送 / 换行（输入框内） |

---

## 🛠 从源码构建

```bash
npm install
npm run rebuild   # 重建 better-sqlite3 的 Electron 绑定
npm run dev       # 开发运行
npm run dist:win  # Windows 安装包（NSIS）
npm run dist:mac  # macOS DMG
```

前置要求：Node 20+；Windows 需 VS Build Tools + Python 3，macOS 需 Xcode Command Line Tools。

---

## 🔐 隐私与数据

- API Key、文献库、索引、高亮、对话记录**全部保存在本地**（SQLite + 本地文件），不上传任何服务器
- 嵌入模型由 [Ollama](https://ollama.com) 管理（`ollama pull` 即用）；PDF 结构化解析 liteparse（无 OCR，~百毫秒/篇）与重排模型内置

---

## 📄 许可证

[PolyForm Noncommercial 1.0.0](./LICENSE) —— 个人学习、科研、教学免费使用与修改；**不可用于商业目的**。商业授权请通过 GitHub 联系作者。

<div align="center">

**如果 PaperLens 对你的科研有用，欢迎点一个 ⭐ Star**

</div>
