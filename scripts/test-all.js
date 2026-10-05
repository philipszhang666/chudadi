/* ============================================================
 * scripts/test-all.js —— 一把跑完所有无头检查
 *
 *   node scripts/test-all.js
 *
 * 检查内容：
 *   1) 语法检查：用 vm.Script 编译每个 js（等价于 node --check，但不启子进程）
 *   2) 静态检查：DOM id 悬空引用 / 脚本加载顺序 / 静态资源是否存在
 *   3) 联机逻辑测试：信息隐藏 / 权威校验 / 三种玩法整局跑通 / 视角旋转
 *
 * 注意：这里刻意不用 child_process。本项目的运行环境在受限沙箱下
 * 不允许子进程通过管道回传输出（spawnSync 会报 EPERM），所以所有检查
 * 都在同一个 Node 进程里跑完。
 *
 * 不含：真浏览器端到端（scripts/e2e-browser.js，需要本机能启动 Chrome）。
 * ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.join(__dirname, '..');
var failed = 0;

/* ---------------- 1. 语法检查 ---------------- */
console.log('语法检查（vm 编译，不执行）：');

var SYNTAX_FILES = [
  'js/protocol.js', 'js/net.js', 'js/room.js', 'js/ui.js', 'js/ai_v1.js',
  'js/cards.js', 'js/game.js', 'js/ai.js', 'js/sound.js',
  'server.js', 'scripts/test-room.js', 'scripts/check-dom.js',
  'scripts/check-undeclared.js'
];

SYNTAX_FILES.forEach(function (f) {
  var p = path.join(ROOT, f);
  if (!fs.existsSync(p)) { console.log('  --   ' + f + '（不存在，跳过）'); return; }
  try {
    new vm.Script(fs.readFileSync(p, 'utf8'), { filename: f });
    console.log('  ok   ' + f);
  } catch (err) {
    failed++;
    console.log('  BAD  ' + f + '  → ' + err.message);
  }
});

/* ---------------- 2. 静态检查 ---------------- */
console.log('\n' + '='.repeat(56));
console.log('静态检查：DOM id / 脚本加载顺序 / 静态资源');
console.log('='.repeat(56));

/**
 * check-dom.js / test-room.js 为了能单独跑，自己会调 process.exit。
 * 这里跑它们的时候把 exit 拦下来，只记结果，不要让脚本提前结束。
 */
function runInProcess(relPath) {
  var EXIT_SENTINEL = {};
  var realExit = process.exit;
  var code = 0;
  process.exit = function (c) { code = (c === undefined ? 0 : c); throw EXIT_SENTINEL; };
  try {
    delete require.cache[require.resolve(relPath)];
    require(relPath);
  } catch (err) {
    if (err !== EXIT_SENTINEL) {
      failed++;
      console.log('运行 ' + relPath + ' 出错：' + (err && err.message));
    }
  } finally {
    process.exit = realExit;
  }
  return code;
}

if (runInProcess('./check-dom.js') !== 0) failed++;

/* 用了但从没声明的变量。这一项是补上来的：ui.js 里曾出现
   `lastActionSeq = ++localActionSeq;`（lastActionSeq 从未声明），
   点「出牌」按钮时抛 ReferenceError，界面上毫无反应。
   语法检查、DOM 检查、单元测试当时全都没抓到它。 */
if (runInProcess('./check-undeclared.js') !== 0) failed++;

/* ---------------- 3. 联机逻辑测试 ---------------- */
console.log('\n' + '='.repeat(56));
console.log('联机逻辑测试：信息隐藏 / 权威校验 / 整局跑通');
console.log('='.repeat(56));

if (runInProcess('./test-room.js') !== 0) failed++;

console.log('\n' + '='.repeat(56));
if (failed) {
  console.log('有 ' + failed + ' 组检查失败');
  process.exit(1);
}
console.log('全部无头检查通过 ✓');
console.log('');
console.log('（真浏览器端到端：node scripts/e2e-browser.js，需要本机能启动 Chrome）');
