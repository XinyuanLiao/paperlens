# 隔离冒烟环境准备：临时 userData + 复制真实 DB（清文献）+ staging 小库
# 用法：python scripts/smoke-ref-prep.py   → 输出 staging 目录，供 PAPERLENS_DATA_DIR 使用
import json
import os
import shutil
import sqlite3
import sys
import tempfile

TMP = os.path.join(tempfile.gettempdir(), 'pl-smoke-ref')
REAL_DB = os.path.join(os.environ['APPDATA'], 'paperlens', 'paperlens.db')

shutil.rmtree(TMP, ignore_errors=True)
os.makedirs(TMP, exist_ok=True)

# 1) 复制真实 DB（backup API 自动处理 WAL）
src = sqlite3.connect(REAL_DB)
dst = sqlite3.connect(os.path.join(TMP, 'paperlens.db'))
src.backup(dst)
src.close()

# 2) 选 2 篇真实 PDF 拷进 staging（优先小文件；一篇 Time-LLM（arXiv 风、[n] 引用）+ 一篇页数适中的）
row = dst.execute("SELECT path FROM papers WHERE title LIKE '%Time-LLM%' LIMIT 1").fetchone()
picks = []
if row:
    picks.append(row[0])
rows = dst.execute(
    "SELECT path, n_pages FROM papers WHERE path NOT IN (%s) AND n_pages BETWEEN 8 AND 24 ORDER BY n_pages ASC LIMIT 4"
    % (','.join('?' for _ in picks) or "''"),
    picks,
).fetchall()
for p, _ in rows:
    if len(picks) < 2 and os.path.exists(p):
        picks.append(p)
picks = [p for p in picks if os.path.exists(p)]
if len(picks) < 2:
    print('FAIL: 只找到 %d 篇可用 PDF' % len(picks))
    sys.exit(1)

lib = os.path.join(TMP, 'lib', 'papers')
os.makedirs(lib, exist_ok=True)
for p in picks:
    # 库内约定：<分类>/<slug>/paper.pdf，且所有 PDF 同名 paper.pdf——必须各自独立 slug 目录
    slug = os.path.basename(os.path.dirname(os.path.normpath(p)))
    d = os.path.join(lib, '00-smoke', slug)
    os.makedirs(d, exist_ok=True)
    shutil.copyfile(p, os.path.join(d, 'paper.pdf'))

# 3) 清空文献/索引/高亮（保留 settings：apiKey、模型配置），指到 staging 库，关重排降负载
cur = dst.cursor()
for t in ['papers', 'chunks', 'chunks_fts', 'papers_fts', 'highlights']:
    try:
        cur.execute(f'DELETE FROM {t}')
    except Exception as e:
        print(f'warn: 清 {t}: {e}')
row = cur.execute("SELECT value FROM meta WHERE key='settings'").fetchone()
s = json.loads(row[0])
s['libraryPath'] = os.path.join(TMP, 'lib')
s['rerankProvider'] = 'off'
s['rerankDevice'] = 'cpu'
s['setupDone'] = True
cur.execute("UPDATE meta SET value=? WHERE key='settings'", (json.dumps(s, ensure_ascii=False),))
dst.commit()
dst.close()

print('STAGING=' + TMP)
print('LIB=' + os.path.join(TMP, 'lib'))
for p in picks:
    print('PDF=' + p)
