/* ============================================================
 * scripts/check-undeclared.js —— 静态检查「用了但从没声明的变量」
 *
 * 为什么需要它：
 *   线上真出过一次 —— ui.js 里写了
 *       lastActionSeq = ++localActionSeq;
 *   但 lastActionSeq 从来没声明过（某次编辑把它换成了 localActionSeq）。
 *   结果：点「出牌」按钮时抛 ReferenceError，浏览器只把错误打进控制台，
 *   界面上一点反应都没有 —— 用户看到的就是「点了没反应」。
 *
 *   这类错误躲过了当时所有的检查：
 *     · node --check 抓不到（语法完全合法）
 *     · DOM id 检查抓不到（不涉及 id）
 *     · 103 项单元测试也抓不到（没走到那条代码路径）
 *
 * 实现说明：
 *   本来想用 acorn 做正经的 AST 作用域分析，但 Node 并没有内置 acorn
 *   （试过 internal/deps/acorn、internal/acorn 都拿不到），而这个项目
 *   没有依赖、也不该为了一个检查引入依赖。所以这里用一个轻量词法扫描：
 *     1) 先剥掉注释、字符串、模板串、正则字面量
 *     2) 扫描所有「声明位置」收集已声明的名字
 *     3) 扫描所有「标识符出现」，排除属性访问和已知宿主全局
 *   它不做作用域嵌套分析（所以只需要「本文件声明过」就算数），
 *   宁可漏报不误报 —— 这一版足以抓住 lastActionSeq 那类问题。
 *
 * 跑法：node scripts/check-undeclared.js
 * ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var JS_DIR = path.join(ROOT, 'js');

/* 浏览器 / Node 提供的全局 */
var HOST_GLOBALS = new Set([
  'Object', 'Array', 'Function', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
  'Math', 'JSON', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'EvalError', 'ReferenceError', 'URIError', 'AggregateError', 'Promise', 'Proxy', 'Reflect',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  'Intl', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'NaN', 'Infinity', 'undefined',
  'globalThis', 'encodeURI', 'encodeURIComponent', 'decodeURI', 'decodeURIComponent',
  'escape', 'unescape', 'eval', 'arguments',
  'window', 'document', 'navigator', 'location', 'history', 'screen', 'console',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
  'requestAnimationFrame', 'cancelAnimationFrame', 'queueMicrotask', 'structuredClone',
  'alert', 'confirm', 'prompt', 'fetch', 'Headers', 'Request', 'Response', 'FormData',
  'Blob', 'File', 'FileReader', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'localStorage', 'sessionStorage', 'indexedDB', 'crypto', 'performance', 'atob', 'btoa',
  'Worker', 'SharedWorker', 'MessageChannel', 'MessagePort', 'BroadcastChannel',
  'WebSocket', 'EventSource', 'XMLHttpRequest', 'AbortController', 'AbortSignal',
  'RTCPeerConnection', 'RTCSessionDescription', 'RTCIceCandidate', 'RTCDataChannel',
  'MediaStream', 'Image', 'Audio', 'AudioContext', 'webkitAudioContext', 'OffscreenCanvas',
  'MutationObserver', 'IntersectionObserver', 'ResizeObserver', 'CustomEvent', 'Event',
  'Node', 'Element', 'HTMLElement', 'HTMLCanvasElement', 'DOMParser', 'CSS',
  'getComputedStyle', 'matchMedia', 'devicePixelRatio', 'innerWidth', 'innerHeight',
  'addEventListener', 'removeEventListener', 'dispatchEvent', 'self', 'top', 'parent', 'frames',
  'Peer',
  'require', 'module', 'exports', '__dirname', '__filename', 'process', 'Buffer', 'global'
]);

var RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'new', 'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof',
  'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'await', 'async', 'get', 'set',
  'of', 'as', 'from', 'true', 'false', 'null', 'enum', 'implements', 'interface', 'package',
  'private', 'protected', 'public'
]);

/* ---------------- 词法：剥掉注释 / 字符串 / 模板串 / 正则 ---------------- */

/**
 * 返回 { code, lineOf }：
 *   code   —— 把所有字符串/注释/正则替换成等长的空格（保持行列位置）
 *   lineOf —— 不单独返回；用索引算行号
 * 保持长度是为了让后续报错的行号准确。
 */
function stripNonCode(src) {
  var out = src.split('');
  var i = 0, n = src.length;

  function blank(from, to) {
    for (var k = from; k < to && k < n; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  }

  // 判断 / 是正则还是除号：看它前面最近的非空白字符
  function regexAllowed(pos) {
    for (var k = pos - 1; k >= 0; k--) {
      var c = src[k];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
      // 这些字符后面出现 / 一定是正则
      return '(,=:[!&|?{};+-*%~^<>'.indexOf(c) >= 0;
    }
    return true;
  }

  while (i < n) {
    var c = src[i], c2 = src[i + 1];

    if (c === '/' && c2 === '/') {                    // 行注释
      var e = src.indexOf('\n', i);
      if (e < 0) e = n;
      blank(i, e); i = e; continue;
    }
    if (c === '/' && c2 === '*') {                    // 块注释
      var e2 = src.indexOf('*/', i + 2);
      e2 = (e2 < 0) ? n : e2 + 2;
      blank(i, e2); i = e2; continue;
    }
    if (c === '"' || c === "'") {                     // 普通字符串
      var j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { j++; break; }
        if (src[j] === '\n') break;                   // 未闭合，别吃掉后面
        j++;
      }
      blank(i, j); i = j; continue;
    }
    if (c === '`') {                                  // 模板串（含 ${} 里也一并涂掉，够用）
      var k2 = i + 1;
      while (k2 < n) {
        if (src[k2] === '\\') { k2 += 2; continue; }
        if (src[k2] === '`') { k2++; break; }
        k2++;
      }
      blank(i, k2); i = k2; continue;
    }
    if (c === '/' && regexAllowed(i)) {               // 正则字面量
      var m = i + 1, inClass = false, ok = false;
      while (m < n) {
        var ch = src[m];
        if (ch === '\\') { m += 2; continue; }
        if (ch === '\n') break;
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { ok = true; m++; break; }
        m++;
      }
      if (ok) {
        while (m < n && /[a-z]/.test(src[m])) m++;    // flags
        blank(i, m); i = m; continue;
      }
    }
    i++;
  }
  return out.join('');
}

function lineAt(src, index) {
  var n = 1;
  for (var k = 0; k < index && k < src.length; k++) if (src[k] === '\n') n++;
  return n;
}

/** 极简标识符扫描：返回 [{name, index, prevNonSpace}] */
function scanIdentifiers(code) {
  var out = [];
  var re = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  var m;
  while ((m = re.exec(code))) {
    var idx = m.index;
    // 找前一个非空白字符，用来判断是不是属性访问 obj.name
    var p = idx - 1;
    while (p >= 0 && /\s/.test(code[p])) p--;
    out.push({ name: m[0], index: idx, prev: p >= 0 ? code[p] : '' });
  }
  return out;
}

function listJsFiles() {
  return fs.readdirSync(JS_DIR)
    .filter(function (f) { return /\.js$/.test(f); })
    .map(function (f) { return path.join(JS_DIR, f); })
    .sort();
}

/* ---------------- 收集声明 ---------------- */

/** 从某个位置开始，把一段「声明目标」里的标识符都收集起来（支持解构）
    要处理的形态：
      var a = 1, b = 2, c;           ← 同行多声明（之前这里漏了 b、c）
      var { x, y: z } = obj;         ← 解构，z 才是声明
      var f = function () { ... };   ← 初始化里含函数体/对象字面量，跳过得算清括号深度
      var t = { a: 1, b: 2 };        ← 同上
    遇到 ; 或换行就停，避免越界吃到后面的代码。 */
function collectTarget(code, start, out) {
  var i = start;
  var depth = 0;
  var n = code.length;

  while (i < n) {
    var c = code[i];

    if (c === ';' || c === '\n') break;

    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }

    // 进入解构 { ... } 或 [ ... ]
    if (c === '{' || c === '[') { depth++; i++; continue; }
    if (c === '}') { depth--; i++; continue; }
    if (c === ']') { depth--; i++; continue; }

    // 括号（默认值的函数调用等）——只在 depth 内跟踪
    if (c === '(') { depth++; i++; continue; }
    if (c === ')') { depth--; i++; continue; }

    // 顶层逗号：下一个声明目标
    if (c === ',' && depth <= 0) { i++; continue; }

    // 等号：跳过初始化表达式，到本层级的下一个逗号 / 分号 / 换行为止
    if (c === '=' && code[i + 1] !== '=') {
      var d2 = 0, j = i + 1;
      while (j < n) {
        var ch = code[j];
        if (ch === '\n' && d2 === 0) break;
        if (ch === '(' || ch === '[' || ch === '{') d2++;
        else if (ch === ')' || ch === ']') { if (d2 === 0) break; d2--; }
        else if (ch === '}') { if (d2 === 0) break; d2--; }
        else if ((ch === ',' || ch === ';') && d2 === 0) break;
        j++;
      }
      // 停在逗号上：它是下一个声明目标的分隔符
      i = (code[j] === ',') ? j + 1 : j;
      continue;
    }

    // 标识符
    if (/[A-Za-z_$]/.test(c)) {
      var m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(code.slice(i));
      var name = m[0];
      // 解构里的 `{ key: value }`：key 不是声明，value 才是。
      // 判据：名字后面紧跟 ':'（且不是 '::'）就当它是 key 跳过。
      var after = code.slice(i + name.length);
      var isKey = depth > 0 && /^\s*:(?!:)/.test(after);
      if (!isKey) out.push({ name: name, index: i });
      i += name.length;
      continue;
    }

    // 其它字符（冒号、点、运算符……）跳过
    i++;
  }
}

function collectDeclarations(code) {
  var decls = [];      // [{name, index}]

  // var / let / const
  var reVar = /\b(var|let|const)\b/g;
  var m;
  while ((m = reVar.exec(code))) {
    collectTarget(code, m.index + m[0].length, decls);
  }

  // function 名字 + 参数
  var reFn = /\bfunction\b\s*([A-Za-z_$][A-Za-z0-9_$]*)?\s*\(/g;
  while ((m = reFn.exec(code))) {
    if (m[1]) decls.push({ name: m[1], index: m.index });
    var open = code.indexOf('(', m.index);
    collectParams(code, open, decls);
  }

  // 箭头函数参数：(...) => / x =>
  var reArrow = /\(([^()]*)\)\s*=>/g;
  while ((m = reArrow.exec(code))) {
    collectTarget(code, m.index + 1, decls);
  }

  // class 名字
  var reClass = /\bclass\b\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  while ((m = reClass.exec(code))) decls.push({ name: m[1], index: m.index });

  // catch (e)
  var reCatch = /\bcatch\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)/g;
  while ((m = reCatch.exec(code))) decls.push({ name: m[1], index: m.index });

  // import 的默认/具名（这个项目没有 import，保险起见）
  var reImport = /\bimport\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  while ((m = reImport.exec(code))) decls.push({ name: m[1], index: m.index });

  // 给每个声明标出它所在的大括号深度，后面用来区分「顶层声明」和「函数内声明」
  var depth = (arguments.length > 1 && arguments[1]) ? arguments[1] : makeDepthIndex(code);
  decls.forEach(function (d) { d.depth = depth[Math.min(d.index, code.length)]; });
  return decls;
}

/** 预计算每个位置的大括号净深度（用于判断是不是顶层声明） */
function makeDepthIndex(code) {
  var arr = new Int32Array(code.length + 1);
  var d = 0;
  for (var i = 0; i < code.length; i++) {
    arr[i] = d;
    if (code[i] === '{') d++;
    else if (code[i] === '}') { if (d > 0) d--; }
  }
  arr[code.length] = d;
  return arr;
}

/** 收集一对括号里的参数名 */
function collectParams(code, openParen, out) {
  if (openParen < 0) return;
  var depth = 0, i = openParen, end = -1;
  for (; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return;
  var body = code.slice(openParen + 1, end);
  if (!body.trim()) return;
  // 逐段按顶层逗号切开
  var parts = [], d = 0, cur = '';
  for (var k = 0; k < body.length; k++) {
    var c = body[k];
    if ('([{'.indexOf(c) >= 0) d++;
    if (')]}'.indexOf(c) >= 0) d--;
    if (c === ',' && d === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  parts.forEach(function (p) {
    var name = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(p)
            || /[{[,]\s*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(p);
    if (name) out.push({ name: name[1], index: openParen });
  });
}

/* ---------------- 主流程 ---------------- */

var files = listJsFiles();
var problems = [];

/* 第一趟：把「所有脚本的顶层声明」汇总成一份跨文件全局表。
   浏览器里这些脚本共享同一个全局作用域（`var CD = ...` 挂在 window 上），
   所以 ai.js 用 CD、ui.js 用 Game 都是合法的 —— 只看单文件会满屏误报。 */
var crossFileGlobals = new Set();
var stripped = {};      // file -> 剥掉字符串后的代码
var topDecls = {};      // file -> Set(顶层声明的名字)

files.forEach(function (f) {
  var src = fs.readFileSync(f, 'utf8');
  var code = stripNonCode(src);
  var depth = makeDepthIndex(code);
  stripped[f] = { src: src, code: code, depth: depth };

  var top = new Set();
  collectDeclarations(code, depth).forEach(function (d) {
    if (d.depth === 0) { top.add(d.name); crossFileGlobals.add(d.name); }
  });
  topDecls[f] = top;
});

/* 顶层声明之外，还有几种「跨文件可见」的名字，手工补上 */
['CD', 'Game', 'AI', 'Sound', 'MCTS', 'Endgame', 'AIv1', 'ProtocolNS', 'Net', 'Room', 'Game',
 'importScripts', 'self', 'onmessage', 'postMessage'].forEach(function (n) {
  crossFileGlobals.add(n);
});

/* 第二趟：逐文件找「本文件声明过 或 全局表里有」之外的引用 */
files.forEach(function (f) {
  var code = stripped[f].code;
  var src = stripped[f].src;
  var declared = new Set();

  // 本文件里所有层级的声明都算（不区分作用域，宁可漏报不误报）
  collectDeclarations(code, stripped[f].depth).forEach(function (d) { declared.add(d.name); });

  var ids = scanIdentifiers(code);
  var reported = new Set();

  ids.forEach(function (id) {
    var name = id.name;
    if (RESERVED.has(name)) return;
    if (HOST_GLOBALS.has(name)) return;
    if (declared.has(name)) return;
    if (crossFileGlobals.has(name)) return;
    if (id.prev === '.') return;                 // 属性访问 obj.name

    // 作为对象字面量的 key：形如 { name: ... } 或 { name, ... }
    var after = code.slice(id.index + name.length);
    if (/^\s*:/.test(after) && !/^\s*::/.test(after)) return;

    // getter / setter 的名字：{ get code() {...} } 里的 code 是属性名，不是变量
    if (/^\s*\(/.test(after)) {
      var before = code.slice(0, id.index).match(/([A-Za-z_$][A-Za-z0-9_$]*)\s*$/);
      if (before && (before[1] === 'get' || before[1] === 'set')) return;
      // 方法简写 { foo() {...} }：上一层如果是 { 或 , 也算属性名
      var prevCh = (function () {
        var p = id.index - 1;
        while (p >= 0 && /\s/.test(code[p])) p--;
        return p >= 0 ? code[p] : '';
      })();
      if (prevCh === '{' || prevCh === ',') return;
    }

    var line = lineAt(src, id.index);
    var key = name + '@' + line;
    if (reported.has(key)) return;
    reported.add(key);
    problems.push({ file: path.basename(f), name: name, line: line });
  });
});

console.log('扫描 ' + files.length + ' 个脚本：' + files.map(function (f) {
  return path.basename(f);
}).join(', '));
console.log('');

if (problems.length) {
  console.log('✗ 下面这些标识符被引用，但在同一个文件里找不到任何声明：');
  problems.forEach(function (p) {
    console.log('    ' + p.file + ':' + p.line + '   ' + p.name);
  });
  console.log('');
  console.log('这类问题运行时会抛 ReferenceError：事件处理器里抛的话，');
  console.log('表现就是「点了按钮没反应」（错误只在控制台，界面上毫无提示）。');
  process.exit(1);
}

console.log('✓ 没有未声明的标识符');
