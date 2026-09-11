// npm postinstall：把 Silero VAD（@ricky0123/vad-web）与其 ONNX Runtime 资产
// 拷贝到 public/vad/，使前端纯本地加载、无任何 CDN 依赖（AGENTS.md「不接云端 API」约定）。
//
// 产物布局（与 DesktopAssistant.jsx 中 VAD_BASE_PATH / VAD_ORT_PATH 对应）：
//   public/vad2/silero_vad_v5.onnx        Silero VAD v5 模型（~2.3MB）
//   public/vad2/vad.worklet.bundle.min.js  人声判定 AudioWorklet
//   public/vad2/ort/*.wasm + *.mjs         onnxruntime-web 的 wasm 二进制及其 .mjs 加载胶水
//                                          （.mjs 由运行时动态 import、必须与 wasm 同目录，
//                                            漏拷会报 "no available backend / initWasm failed"）
// 目录带版本号（vad2）：VAD 资产 URL 换版本即整体换新，可绕开浏览器对旧 URL 的错误 MIME
// 缓存（no-cache 只能约束新响应、清不掉已存条目，2026-09-03 踩坑）。
//
// 源文件来自 node_modules（@ricky0123/vad-web 的 dist 自带模型；onnxruntime-web 是其依赖）。
// 依赖未安装完成/版本结构变化时只 warn 不报错，避免 npm install 因缺文件整体失败。

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '..');

const VAD_PKG = join(root, 'node_modules', '@ricky0123', 'vad-web', 'dist');
const ORT_PKG = join(root, 'node_modules', 'onnxruntime-web', 'dist');
// 目标目录带版本号（vad2）：见文件头注释（换版本绕开浏览器旧缓存）
const DEST_VAD = join(root, 'public', 'vad2');
const DEST_ORT = join(DEST_VAD, 'ort');

const copyOne = (src, dest) => {
  if (!existsSync(src)) {
    console.warn(`[copy-vad-assets] 源文件缺失，跳过：${src}`);
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`[copy-vad-assets] ${src.replace(root, '.')} -> ${dest.replace(root, '.')}`);
};

// 1) Silero 模型 + worklet（vad-web 加载路径为 baseAssetPath + 固定文件名）
copyOne(join(VAD_PKG, 'silero_vad_v5.onnx'), join(DEST_VAD, 'silero_vad_v5.onnx'));
copyOne(join(VAD_PKG, 'vad.worklet.bundle.min.js'), join(DEST_VAD, 'vad.worklet.bundle.min.js'));

// 2) onnxruntime-web 的 wasm 二进制 + .mjs 胶水（加载路径为 onnxWASMBasePath，
//    运行时按需 fetch wasm / import .mjs；.mjs 与 wasm 一一对应、必须同目录）
if (existsSync(ORT_PKG)) {
  const ortFiles = readdirSync(ORT_PKG).filter((f) => /^ort-wasm.*\.(wasm|mjs)$/.test(f));
  if (ortFiles.length === 0) {
    console.warn('[copy-vad-assets] onnxruntime-web/dist 下未找到 ort-wasm 资产（.wasm/.mjs），跳过拷贝');
  } else {
    mkdirSync(DEST_ORT, { recursive: true });
    for (const f of ortFiles) {
      copyFileSync(join(ORT_PKG, f), join(DEST_ORT, f));
    }
  }
} else {
  console.warn('[copy-vad-assets] 未找到 onnxruntime-web/dist（@ricky0123/vad-web 未安装时发生）');
}
