'use strict';

// ============================================================================
// clean-output.js —— 打完安装包后，清掉成品目录里用不到的副产品，只留干净的安装包。
// 这些文件都是「自动更新 / 调试」用的元数据，本产品没接自动更新，纯属碍眼：
//   · *.blockmap          —— 增量更新索引
//   · latest.yml          —— 自动更新版本清单
//   · builder-debug.yml   —— 构建调试信息
// win-unpacked/（免安装的程序文件夹）保留：偶尔可直接双击里面的 exe 免装运行。
// 由 package.json 的 "dist" 脚本在 electron-builder 之后自动调用。
// ============================================================================

const fs = require('fs');
const path = require('path');

// 成品目录：build/ 在项目根下，再上一级就是 D:\文档资料\AI讨论，成品在其下 AI讨论会_V1.0。
const OUTPUT_DIR = path.join(__dirname, '..', '..', 'AI讨论会_V1.0');

if (!fs.existsSync(OUTPUT_DIR)) {
  console.log('[clean-output] 未找到成品目录，跳过：' + OUTPUT_DIR);
  process.exit(0);
}

let removed = 0;
for (const f of fs.readdirSync(OUTPUT_DIR)) {
  if (f.endsWith('.blockmap') || f === 'latest.yml' || f === 'builder-debug.yml') {
    fs.rmSync(path.join(OUTPUT_DIR, f));
    console.log('[clean-output] 已删除 ' + f);
    removed++;
  }
}
console.log(`[clean-output] 清理完成，删除 ${removed} 个副产品。成品目录现在只剩安装包 + win-unpacked。`);
