// LLM 请求层回归：打包 src/main/llm.ts（连同 db / http / shared/providers），
// 在真实 Electron 里启动 scripts/llm-stub-main.cjs（本地桩服务 + 场景断言）。
// 用法：node scripts/test-llm-stub.mjs      （需要已为本机 Electron 构建好 better-sqlite3，见 README 的 npm run rebuild）
import { build } from 'esbuild'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outDir = path.join(root, '.smoke-llm') // .smoke-* 已在 .gitignore
mkdirSync(outDir, { recursive: true })

const entry = path.join(outDir, 'entry.mjs')
writeFileSync(
  entry,
  [
    `export * as db from ${JSON.stringify(path.join(root, 'src/main/db.ts'))}`,
    `export * as llm from ${JSON.stringify(path.join(root, 'src/main/llm.ts'))}`,
    `export * as http from ${JSON.stringify(path.join(root, 'src/main/http.ts'))}`,
    `export * as providers from ${JSON.stringify(path.join(root, 'src/shared/providers.ts'))}`,
    ''
  ].join('\n')
)
const bundle = path.join(outDir, 'bundle.mjs')
await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: bundle,
  external: ['electron', 'better-sqlite3'],
  logLevel: 'error'
})

const resultFile = path.join(outDir, 'result.json')
rmSync(resultFile, { force: true }) // 只认本次运行写出的结果
const electron = createRequire(import.meta.url)('electron')
const env = { ...process.env, PL_LLM_BUNDLE: bundle, PL_LLM_RESULT: resultFile }
delete env.ELECTRON_RUN_AS_NODE
const run = spawnSync(electron, [path.join(root, 'scripts/llm-stub-main.cjs')], { cwd: root, env, stdio: 'inherit', timeout: 180_000 })

// 没有结果文件（进程崩溃 / 被超时杀掉）一律算失败，绝不因为「读不到失败项」而通过
const produced = existsSync(resultFile)
const failed = produced ? JSON.parse(readFileSync(resultFile, 'utf8')).filter((x) => !x.ok) : [{ name: '没有产出结果文件', detail: `signal=${run.signal} status=${run.status}` }]
if (run.status !== 0 || run.error || failed.length) {
  console.error(`\nFAIL：${failed.length} 项未通过（退出码 ${run.status}${run.signal ? `，信号 ${run.signal}` : ''}）`)
  process.exit(1)
}
console.log('PASS')
