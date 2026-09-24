# GGUF 嵌入模型合格性探测：中文/换行健壮性 + 相关-无关区分度（CLS/mean 两种池化都可跑）
import json, sys, math, urllib.request

PORT = sys.argv[1] if len(sys.argv) > 1 else '8902'

def emb(texts, pooling=None):
    body = json.dumps({"input": texts, "model": "bge-m3"}).encode('utf8')
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/v1/embeddings", data=body, headers={"Content-Type": "application/json"})
    try:
        r = urllib.request.urlopen(req, timeout=30)
        d = json.load(r)
        return [x['embedding'] for x in d['data']], None
    except Exception as e:
        return None, f"{getattr(e, 'code', '?')} {e.read()[:100] if hasattr(e, 'read') else e}"

def cos(a, b):
    return sum(x*y for x, y in zip(a, b)) / (math.sqrt(sum(x*x for x in a)) * math.sqrt(sum(y*y for y in b)))

print(f"=== port {PORT} ===")
for name, text in [("纯英文", "power module failure mechanisms"), ("中文", "功率模块的失效机理有哪些？"),
                   ("换行", "line one\nline two"), ("中英混合", "Bond wire lift-off（键合线脱落）是主要失效机理。\nSolder fatigue also matters."),
                   ("全角标点", "结温估算的方法有哪些？")]:
    v, err = emb([text])
    print(f"[{'OK ' if v else 'FAIL'}] {name}: dim {len(v[0]) if v else '-'} {err or ''}")

q, doc_r, doc_i = "power module junction temperature estimation", \
    "The junction temperature of the IGBT module is estimated using thermal sensitive electrical parameters.", \
    "Convolutional neural networks for image classification on ImageNet."
vs, err = emb([q, doc_r, doc_i])
if vs:
    print(f"区分度: cos(q,相关)={cos(vs[0], vs[1]):.4f}  cos(q,无关)={cos(vs[0], vs[2]):.4f}")
cq, cr = "功率模块结温怎么估算？", "利用热敏电参数（TSEP）可以在线估算 IGBT 模块的结温。"
vs2, err = emb([cq, cr, doc_i])
if vs2:
    print(f"中文区分度: cos(q,相关)={cos(vs2[0], vs2[1]):.4f}  cos(q,无关)={cos(vs2[0], vs2[2]):.4f}")
