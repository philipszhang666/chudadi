/* ============================================================
 * scripts/check-dom.js —— 静态检查：界面代码引用的 DOM id 是否都存在
 *
 * 这类错误最阴：`$('lobbyCode')` 打错一个字不会报错，只会在真机上
 * 「点了没反应」。这里把 ui.js 里所有 $('xxx') / getElementById('xxx')
 * 抠出来，和 index.html 里实际定义的 id 对一遍。
 *
 * 只做「引用了但页面里没有」这一个方向的检查 —— 反向（页面里有但没人用）
 * 大量是正常的（布局容器、样式钩子）。
 *
 * 跑法：node scripts/check-dom.js
 * ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');

var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* index.html 里定义的所有 id */
var defined = {};
(html.match(/\bid="([^"]+)"/g) || []).forEach(function (m) {
  defined[/id="([^"]+)"/.exec(m)[1]] = true;
});

/* 所有会被浏览器加载的脚本（vendor 里那个压缩包跳过） */
var scripts = ['protocol.js', 'net.js', 'room.js', 'ui.js', 'orientation.js',
  'cards.js', 'game.js', 'ai.js', 'sound.js', 'determinize.js', 'endgame.js', 'mcts.js'];

var refs = {};      // id -> [哪个文件用到]
var reDirect = /getElementById\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)/g;
var reHelper = /\$\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)/g;

scripts.forEach(function (f) {
  var p = path.join(ROOT, 'js', f);
  if (!fs.existsSync(p)) return;
  var src = fs.readFileSync(p, 'utf8');
  [reDirect, reHelper].forEach(function (re) {
    re.lastIndex = 0;
    var m;
    while ((m = re.exec(src))) {
      if (!refs[m[1]]) refs[m[1]] = [];
      if (refs[m[1]].indexOf(f) < 0) refs[m[1]].push(f);
    }
  });
});

var missing = Object.keys(refs).filter(function (id) { return !defined[id]; }).sort();

console.log('index.html 里定义的 id：' + Object.keys(defined).length + ' 个');
console.log('脚本里引用到的 id：' + Object.keys(refs).length + ' 个');

if (missing.length) {
  console.log('\n✗ 下面这些 id 被脚本引用了，但 index.html 里没有：');
  missing.forEach(function (id) {
    console.log('   ' + id + '   （' + refs[id].join(', ') + '）');
  });
  console.log('\n失败：' + missing.length + ' 个悬空引用');
  process.exit(1);
}

console.log('\n✓ 没有悬空引用：脚本引用的每个 id 都真实存在');

/* 额外查一下：联机相关的新脚本有没有被 index.html 真的加载 */
var required = ['js/protocol.js', 'js/net.js', 'js/room.js', 'vendor/peerjs.min.js'];
var notLoaded = required.filter(function (s) {
  return html.indexOf(s) < 0;
});
if (notLoaded.length) {
  console.log('\n✗ 这些脚本没有被 index.html 加载：' + notLoaded.join(', '));
  process.exit(1);
}
console.log('✓ 联机的四个脚本都已挂到 index.html 上');

/* ------------------------------------------------------------
   加载顺序：这些脚本之间是「后加载的用先加载的全局变量」的关系，
   顺序反了就会在运行时炸 undefined。这条静态规则能挡住这类改动。
   ------------------------------------------------------------ */
var order = (html.match(/<script src="([^"]+)"/g) || []).map(function (m) {
  return /src="([^"]+)"/.exec(m)[1].split('?')[0];
});

var mustBefore = [
  ['js/cards.js', 'js/game.js'],
  ['js/game.js', 'js/room.js'],
  ['js/protocol.js', 'js/net.js'],
  ['js/protocol.js', 'js/room.js'],
  ['js/cards.js', 'js/ai.js'],
  ['js/game.js', 'js/ai.js'],
  ['vendor/peerjs.min.js', 'js/net.js'],
  ['js/protocol.js', 'js/ui.js'],
  ['js/net.js', 'js/ui.js'],
  ['js/room.js', 'js/ui.js'],
  ['js/cards.js', 'js/ui.js'],
  ['js/game.js', 'js/ui.js'],
  ['js/ai.js', 'js/ui.js'],
  ['js/sound.js', 'js/ui.js']
];

var orderBad = [];
mustBefore.forEach(function (pair) {
  var a = order.indexOf(pair[0]);
  var b = order.indexOf(pair[1]);
  if (a < 0 || b < 0) { orderBad.push(pair[0] + ' 或 ' + pair[1] + ' 没被加载'); return; }
  if (a > b) orderBad.push(pair[0] + ' 必须在 ' + pair[1] + ' 之前加载');
});

if (orderBad.length) {
  console.log('\n✗ 脚本加载顺序有问题：');
  orderBad.forEach(function (s) { console.log('   ' + s); });
  process.exit(1);
}
console.log('✓ 脚本加载顺序正确（共 ' + order.length + ' 个 script）');

/* 所有静态资源必须真实存在，别出现 404 */
var assets = order.concat(
  (html.match(/(?:href|src)="((?!https?:|\/\/)[^"?]+)/g) || []).map(function (m) {
    return /="([^"]+)/.exec(m)[1];
  })
);
var missingAsset = assets.filter(function (a) {
  return a && !/^#/.test(a) && !fs.existsSync(path.join(ROOT, a));
});
if (missingAsset.length) {
  console.log('\n✗ 这些静态资源在磁盘上不存在（会 404）：');
  missingAsset.forEach(function (a) { console.log('   ' + a); });
  process.exit(1);
}
console.log('✓ 所有引用的静态资源都存在');
