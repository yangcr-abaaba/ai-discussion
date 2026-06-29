'use strict';

// ============================================================================
// afterPack.js —— electron-builder「打包后、生成安装包前」钩子，用来给成品瘦身。
// 此时 Electron 运行时已复制到 win-unpacked（context.appOutDir），但安装包还没打，
// 在这里删掉的文件不会进安装包，故能同时缩小「安装目录」和「安装包」。
// 只删两类对本产品无用的东西：
//   1) 用不到的语言包：Electron 默认带 55 个 locales/*.pak（≈43MB），本产品只用
//      简体中文 + 英文兜底，其余全删。
//   2) Chromium 许可证文本 LICENSES.chromium.html（≈14.6MB）：纯说明文档，不影响运行。
// 合计省 ≈55MB。其余大头（195MB 的 Chromium 本体、各 dll）是运行必需，删不得。
// ============================================================================

const fs = require('fs');
const path = require('path');

// 要保留的语言包文件名（其余 locales/*.pak 一律删除）。
const KEEP_LOCALES = new Set(['zh-CN.pak', 'en-US.pak']);

exports.default = async function afterPack(context) {
  const out = context.appOutDir;

  // 1) 精简语言包
  const localesDir = path.join(out, 'locales');
  let removedLocales = 0;
  if (fs.existsSync(localesDir)) {
    for (const f of fs.readdirSync(localesDir)) {
      if (f.endsWith('.pak') && !KEEP_LOCALES.has(f)) {
        fs.rmSync(path.join(localesDir, f));
        removedLocales++;
      }
    }
  }

  // 2) 删 Chromium 许可证文本（仅文档，不影响运行）
  const lic = path.join(out, 'LICENSES.chromium.html');
  if (fs.existsSync(lic)) fs.rmSync(lic);

  console.log(`[afterPack] 已删除 ${removedLocales} 个多余语言包 + 许可证文本，给成品瘦身。`);
};
