// 加速设备自动选择：显卡优先（Windows CUDA→DirectML、Linux CUDA、macOS 运行时自检），
// 不可用才落 CPU（低端配置自然走 CPU）。
// ONNX 侧事实（onnxruntime-node 预编译）：Windows x64 仅 DirectML、Linux x64 仅 CUDA、
// macOS 暂无 GPU 后端——CUDA/DirectML 逐级尝试由加载方捕获回退；torch/marker 侧由
// PyTorch 自行检测 CUDA/MPS，无需干预。

export type TfDevice = 'cuda' | 'dml' | 'gpu' | 'cpu'

// transformers.js 的设备尝试链（顺序即优先级）
export function tfDeviceChain(): TfDevice[] {
  if (process.platform === 'win32') return ['cuda', 'dml', 'cpu']
  if (process.platform === 'linux') return ['cuda', 'cpu']
  if (process.platform === 'darwin') return ['gpu', 'cpu']
  return ['cpu']
}

export function deviceLabel(d: TfDevice | string): string {
  if (d === 'cuda') return 'CUDA (GPU)'
  if (d === 'dml') return 'DirectML (GPU)'
  if (d === 'gpu') return 'GPU'
  return 'CPU'
}
