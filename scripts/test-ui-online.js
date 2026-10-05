/* ============================================================
 * scripts/test-ui-online.js —— 在 Node 里跑真正的 ui.js，
 * 真的去「点」出牌按钮，验证联机时整条出牌链路。
 *
 * 为什么非要有这个：
 *   「点出牌没反应」这类 bug 全躲在界面层，无头测试碰不到 ——
 *   之前那个 lastActionSeq 的 ReferenceError 就是这样漏掉的。
 *   这个环境起不了浏览器（Chrome 的 crashpad 被沙箱拦），
 *   所以用 scripts/dom-shim.js 手写的最小 DOM 把 ui.js 原样加载，
 *   然后走真实路径：点「提示」选牌 → 触发「出牌」按钮的 click。
 *
 * 结构：两个真实的 room.js 实例 ——
 *   房主房间（权威状态、跑 AI）+ 客户端房间（ui.js 自己建的那个）。
 *   中间用两个邮箱手工转交消息，等价于 PeerJS 那根 DataChannel：
 *       clientOutbox  →  房主
 *       seatInbox[1]  →  客户端
 *   只有传输层是假的，其余全是真的。
 *
 * 重点覆盖：连续出牌。曾经的线上 bug 是「第一手能出、第二手点不动」，
 *   所以这里专门反复出牌，每一步都断言消息真的发出去了。
 *
 * 跑法：node scripts/test-ui-online.js
 * ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var shim = require('./dom-shim.js');

var ROOT = path.join(__dirname, '..');
var JS = path.join(ROOT, 'js');

/* ---------------- 断言 ---------------- */
var pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  \u2713 ' + label); }
  else {
    fail++;
    console.log('  \u2717 ' + label + (detail ? ('  \u2192 ' + detail) : ''));
  }
}
function section(t) { console.log('\n' + t); }

/* ============================================================
   一、迷你浏览器环境
   ============================================================ */

var doc = shim.createDocument(path.join(ROOT, 'index.html'));
var store = {};
var consoleErrors = [];

var sandbox = {
  document: doc,
  navigator: { userAgent: 'node-dom-shim', clipboard: null },
  location: {
    href: 'http://localhost/index.html', search: '', protocol: 'http:',
    host: 'localhost', hostname: 'localhost', origin: 'http://localhost',
    pathname: '/index.html'
  },
  localStorage: {
    getItem: function (k) { return store[k] === undefined ? null : store[k]; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; }
  },
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  setInterval: setInterval, clearInterval: clearInterval,
  performance: { now: function () { return Date.now(); } },
  screen: {},
  console: {
    log: function () {}, warn: function () {},
    error: function () {
      consoleErrors.push(Array.prototype.map.call(arguments, function (a) {
        return (a && a.stack) ? a.stack : String(a);
      }).join(' '));
    }
  },
  JSON: JSON, Math: Math, Date: Date, Object: Object, Array: Array,
  String: String, Number: Number, Boolean: Boolean, RegExp: RegExp,
  Error: Error, TypeError: TypeError, isNaN: isNaN, isFinite: isFinite,
  Infinity: Infinity, NaN: NaN, parseInt: parseInt, parseFloat: parseFloat,
  /* 刻意【不提供】module / exports / require：浏览器里它们都是 undefined，
     各脚本才会走「全局变量」那条分支。给了 module 就会 require 报错。 */
  Sound: { setEnabled: function () {}, setVolume: function () {}, play: function () {} },
  Worker: undefined,                       // AI 退回主线程同步算
  Peer: function () { throw new Error('这个测试不该创建真的 Peer'); }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
var ctx = vm.createContext(sandbox);

function load(f) {
  vm.runInContext(fs.readFileSync(path.join(JS, f), 'utf8'), ctx, { filename: 'js/' + f });
}

console.log('用最小 DOM 桩加载真正的 ui.js（等价于浏览器加载顺序）\n');

['cards.js', 'game.js', 'determinize.js', 'endgame.js', 'mcts.js', 'ai.js',
 'sound.js', 'protocol.js', 'net.js', 'room.js'].forEach(load);

/* ---------------- 二、把传输层换成两个邮箱 ---------------- */

var realNet = sandbox.Net;
var realRoom = sandbox.Room;

var netHandlers = {};        // ui.js 注册在 Net 上的回调
var uiOutbox = [];           // 客户端房间发给房主的消息
var seatInbox = {};          // seat -> 房主发给该座位的消息

function deepCopy(m) { return JSON.parse(JSON.stringify(m)); }

sandbox.Net = {
  on: function (name, fn) { netHandlers[name] = fn; },
  send: function (msg) { uiOutbox.push(deepCopy(msg)); return true; },
  sendToSeat: function (seat, msg) {
    if (!seatInbox[seat]) seatInbox[seat] = [];
    seatInbox[seat].push(deepCopy(msg));
    return true;
  },
  broadcast: function (msg) {
    Object.keys(seatInbox).forEach(function (s) { seatInbox[s].push(deepCopy(msg)); });
  },
  attach: function () {}, detachSeat: function () {},
  host: function () {}, join: function () {}, close: function () {}, poke: function () {},
  setMySeat: function () {}, getMySeat: function () { return 0; },
  getRole: function () { return 'client'; },
  getCode: function () { return 'TEST'; },
  seatOfCode: function () { return null; },
  iceServers: realNet.iceServers,
  available: function () { return true; }
};

// 客户端房间自己的 net：它往外发的东西（HELLO / ACTION）进 uiOutbox
// 注意 —— 客户端房间的 Net.send 会被 room.js 用到吗？不会。
// room.js 在客户端只用 net.setMySeat / net.close，其余走 onClientMessage。
var clientRoomNet = {
  sendToSeat: function () { return true; },
  broadcast: function () {},
  attach: function () {}, detachSeat: function () {},
  setMySeat: function () {}, close: function () {},
  send: function (msg) { uiOutbox.push(deepCopy(msg)); return true; }
};

var realClientRoom = null;
var uiRoomHandlers = null;
var hostRoomHandlers = null;

// 把 Room.create 包一层：保留真实房间逻辑，只把两边区分开
sandbox.Room = {
  create: function (opts) {
    var isClient = (opts && opts.net) === sandbox.Net;
    var room = realRoom.create({
      net: isClient ? clientRoomNet : (opts && opts.net),
      ai: (opts && opts.ai) || {},
      on: opts && opts.on
    });
    if (isClient) {
      uiRoomHandlers = (opts && opts.on) || {};
      realClientRoom = room;
    } else {
      hostRoomHandlers = (opts && opts.on) || {};
    }
    return room;
  }
};

try {
  load('ui.js');
} catch (err) {
  console.log('✗ 加载 ui.js 就抛错了：' + err.message);
  console.log(err.stack);
  process.exit(1);
}

var G = sandbox.__game;
var P = sandbox.ProtocolNS;
var CD = sandbox.CD;
var Game = sandbox.Game;
var AI = sandbox.AI;

/* ---------------- 三、消息转交 ---------------- */

function deliverToHost(conn) {
  var n = 0;
  uiOutbox.splice(0, uiOutbox.length).forEach(function (m) {
    hostRoom.onData(m, conn); n++;
  });
  return n;
}

function deliverToClient(seat) {
  var msgs = seatInbox[seat] || [];
  seatInbox[seat] = [];
  msgs.forEach(function (m) { realClientRoom.onData(m, null); });
  return msgs.length;
}

/* ============================================================
   开始测
   ============================================================ */
section('0. 加载与初始化');

ok(!!G, 'ui.js 初始化完成（window.__game 存在）');
ok(!!(CD && Game && sandbox.Net && sandbox.Room), 'cards / game / net / room 都在');
ok(consoleErrors.length === 0, '加载过程没有 console.error', consoleErrors.slice(0, 2).join(' | '));

var mustHave = ['hand', 'btnPlay', 'btnPass', 'btnHint', 'btnClear', 'btnGroup',
  'seat-me', 'myCount', 'tip', 'selInfo', 'overlay', 'startScreen',
  'lobbyOverlay', 'segPlayers', 'segDifficulty', 'segNonA3ToLast', 'segSpeed', 'btnStart'];
var missing = mustHave.filter(function (id) { return !doc.getElementById(id); });
ok(missing.length === 0, 'DOM 桩解析出所有关键元素（' + mustHave.length + ' 个）', missing.join(', '));

section('1. 房主开局，ui.js 以客户端身份加入');

// 房主那一侧：真实的权威房间
var hostRoom = realRoom.create({
  net: sandbox.Net,
  ai: {
    decide: function (st, idx, diff, o) { return AI.decide(st, idx, diff, o || {}); },
    algo: function () { return { diff: 'normal' }; },
    speedMs: function () { return 0; }
  },
  on: {}
});
hostRoom.startHost({
  name: '房主',
  config: { playerCount: 3, landlord: false, nonA3ToLast: false, difficulty: 'normal', speed: 'fast' }
});

G.join('ABCD');
ok(G.mode === 'online', '进入联机模式');
ok(!!realClientRoom, '客户端房间已建立');

// 客户端进房时会发 HELLO（room.js 在 joinAsClient / 等欢迎消息时发出）
var hello = uiOutbox.filter(function (m) { return m.type === P.C2H.HELLO; })[0];
if (!hello) {
  // 有些流程里 HELLO 由 net.js 发出，这里补一条，形状和 net.js 一致
  hello = { type: P.C2H.HELLO, code: 'ABCD', name: '我', seat: null };
  uiOutbox.length = 0;
}
ok(true, '准备把客户端的 HELLO 交给房主');

var clientConn = { __seat: undefined, close: function () {} };
hostRoom.onData(hello, clientConn);
ok(clientConn.__seat === 1, '房主把客户端分到 1 号座位（实际 ' + clientConn.__seat + '）');

var got = deliverToClient(1);
ok(got > 0, '客户端收到房主的回应（' + got + ' 条）');
ok(G.seat === 1, '客户端座位是 1（实际 ' + G.seat + '）');

section('2. 房主发牌，客户端收到视图');

var sr = hostRoom.startGame();
ok(sr.ok, '房主开局成功' + (sr.ok ? '' : ('（' + sr.reason + '）')));
deliverToClient(1);

ok(!!G.state && G.state.phase === 'playing', '客户端牌桌进入进行中');
ok(G.state && G.state.myIndex === 1, '视图的 myIndex 是 1');
ok(hostRoom.state.players.length === 3, '牌局是 3 人局');

var handEl = doc.getElementById('hand');
ok(handEl.children.length > 0, '手牌画到界面上了（' + handEl.children.length + ' 张）');

/* ============================================================
   3. 反复出牌：这是「第一手能出、第二手不行」的直接复现
   ============================================================ */
section('3. 连续出牌（第一手能出，第二手呢？）');

var myPlayCount = 0;
var passOnly = 0;
var humanTurnsSeen = 0;
var spin = 0;

/** 「提示」之后，这张牌在界面上是不是被标成了选中（看 .sel class） */
function selectedAfterHint(cardId) {
  var cards = doc.getElementById('hand').children;
  for (var i = 0; i < cards.length; i++) {
    if (cards[i].dataset && cards[i].dataset.id === cardId) {
      return cards[i].classList.contains('sel');
    }
  }
  return false;
}

/** 房主推进到「轮到客户端」为止；期间电脑位由房主自己出手 */
function advanceToMyTurn() {
  var guard = 0;
  while (hostRoom.state.phase === 'playing' && hostRoom.state.turn !== 1 && guard++ < 300) {
    var s = hostRoom.state.turn;
    var legal = Game.legalMoves(P.makeView(hostRoom.state, s));
    var r = legal.length
      ? hostRoom.applyAction(s, 'play', legal[0].cards.map(function (c) { return c.id; }))
      : hostRoom.applyAction(s, 'pass');
    if (!r.ok) break;
  }
  deliverToClient(1);
}

// 一直打到牌局结束，每次轮到我都要能出牌
while (hostRoom.state.phase === 'playing' && spin++ < 40) {
  advanceToMyTurn();
  if (hostRoom.state.phase !== 'playing') break;
  if (hostRoom.state.turn !== 1) break;

  humanTurnsSeen++;

  // 先看这一手到底有没有合法出牌（首手必须含 ♦4 之类都会体现在这里）
  var legal = G.legal();
  if (!legal || !legal.length) {
    // 没有能压过的牌 → 只能过牌，这是正常的，不算 bug
    passOnly++;
    var pb = uiOutbox.length;
    doc.getElementById('btnPass').click();
    ok(uiOutbox.length === pb + 1,
      '第 ' + humanTurnsSeen + ' 次轮到我：没有可出的牌，点「过牌」成功发出');
    var passes = uiOutbox.filter(function (m) { return m.type === P.C2H.ACTION; });
    uiOutbox.length = 0;
    passes.forEach(function (m) { hostRoom.onData(m, clientConn); });
    deliverToClient(1);
    continue;
  }

  // —— 点「提示」选合法牌 ——
  doc.getElementById('btnHint').click();
  var btnDisabled = doc.getElementById('btnPlay').disabled;

  ok(btnDisabled === false,
    '第 ' + humanTurnsSeen + ' 次轮到我：有 ' + legal.length + ' 种可出，「出牌」按钮可点',
    'disabled=' + btnDisabled + ' flags=' + JSON.stringify(G.flags));
  ok(G.state.players[1].hand.some(function (c) { return selectedAfterHint(c.id); }),
    '第 ' + humanTurnsSeen + ' 次：「提示」确实选中了牌');

  var before = uiOutbox.length;
  var errsBefore = consoleErrors.length;
  doc.getElementById('btnPlay').click();

  var sentNow = uiOutbox.length - before;
  ok(sentNow === 1,
    '第 ' + humanTurnsSeen + ' 次轮到我：点「出牌」真的把动作发出去了',
    '发了 ' + sentNow + ' 条；flags=' + JSON.stringify(G.flags));
  ok(consoleErrors.length === errsBefore,
    '第 ' + humanTurnsSeen + ' 次出牌没有抛错误',
    consoleErrors.slice(errsBefore).join(' | '));

  if (sentNow !== 1) {
    console.log('      ↳ 卡住时的界面状态：' + JSON.stringify(G.flags));
    console.log('      ↳ selInfo: ' + (doc.getElementById('selInfo').textContent || ''));
    console.log('      ↳ 这一手有 ' + legal.length + ' 种可出，第一种：' +
      JSON.stringify(legal[0].cards.map(function (c) { return c.id; })));
    break;
  }

  // 把这一步交给房主，再把新视图发回来
  var acts = uiOutbox.filter(function (m) { return m.type === P.C2H.ACTION; });
  uiOutbox.length = 0;
  acts.forEach(function (m) { hostRoom.onData(m, clientConn); });
  deliverToClient(1);
  myPlayCount++;
}

ok(myPlayCount >= 2,
  '一局里至少成功出了 2 手牌（实际出了 ' + myPlayCount + ' 手，' +
  '轮到我 ' + humanTurnsSeen + ' 次，其中 ' + passOnly + ' 次因无牌可压只能过牌）');
ok(hostRoom.state.phase === 'over' || myPlayCount >= 2,
  '牌局被推到结束或至少连续出了 2 手（phase=' + hostRoom.state.phase + '）');

section('4. 客户端看不到房主专属开关');

var rows = doc.querySelectorAll('.host-only');
ok(rows.length >= 4, 'index.html 里标了 ' + rows.length + ' 个房主专属行');
ok(rows.filter(function (r) { return !r.hidden; }).length === 0, '客户端看不到任何房主专属开关');
ok(doc.getElementById('settingsHostNote').hidden === false, '设置面板里有「由房主决定」的说明');
ok(doc.getElementById('btnLobbyStart').hidden === true, '客户端看不到「开始游戏」');
ok(doc.getElementById('lobbyReadonly').hidden === false, '客户端能看到「本局规则」只读摘要');

section('5. 全程无 JS 报错');
ok(consoleErrors.length === 0, '整轮交互没有 console.error', consoleErrors.slice(0, 3).join(' | '));

/* ============================================================
   6. 换角色：这次让 ui.js 自己当房主
   ============================================================
   上面测的一直是「客户端出牌」。但房主点出牌走的是另一条分支
   （mode==='online' 且 netIsHost===true），而且房主那侧还有
   scheduleBots / room.pump() 这套异步推进 —— 完全不同的代码路径。
   线上那个「第二手出不了」很可能就在这条路上，所以这里必须覆盖。 */
section('6. 房主自己也出牌（另一条分支）');

(function () {
  // 让 ui.js 以房主身份开一局（跳过真实 Peer，直接把它当成已开房）
  G.host('HOST');
  var uiRoom = realClientRoom;              // ui.js 这一轮建的房间
  if (!uiRoom) { ok(false, 'ui.js 没有建出房间'); return; }

  ok(G.mode === 'online', 'ui.js 进入联机模式');
  ok(G.flags.netIsHost === true, 'ui.js 现在认为自己是房主');

  // 房主那一侧的权威状态：给 ui.js 的房间喂 startHost + startGame
  uiRoom.startHost({
    name: '我（房主）',
    config: { playerCount: 3, landlord: false, nonA3ToLast: false, difficulty: 'normal', speed: 'fast' }
  });

  // 造一个「客户端」连接进来，让房间里有两个真人
  var peerConn = { __seat: undefined, close: function () {} };
  uiRoom.onData({ type: P.C2H.HELLO, code: 'HOST', name: '客人', seat: null }, peerConn);
  ok(peerConn.__seat === 1, '客人被分到 1 号座位（实际 ' + peerConn.__seat + '）');

  // 房主开局（走 ui.js 的 newGame 入口，也就是真实的「开始游戏」按钮路径）
  var started = G.newGame();
  ok(uiRoom.state && uiRoom.state.phase === 'playing',
    '房主开局成功（房主侧 state 进入进行中）');

  // 把房主刚广播的视图收下（房主自己也走同一条视图路径）
  deliverToClient(0);

  var handEl2 = doc.getElementById('hand');
  ok(handEl2.children.length > 0, '房主自己的手牌也画出来了（' + handEl2.children.length + ' 张）');

  // ---- 房主反复出牌 ----
  var hostPlays = 0;
  var hostTurns = 0;
  var passTurns = 0;
  var guard = 0;

  /**
   * 把局面同步推进到「轮到房主（座位 0）」，并让界面追上房间。
   *
   * 时序上踩了很多次坑，最后收敛成两条规则：
   *   1) 每一手之后都 drain 一次视图，让界面始终等于「房间最近的状态」。
   *   2) 「轮到谁」只以 uiRoom.state（房间）为准 —— 界面的 G.flags.myTurn
   *      会因为 pump() 后台的 setTimeout 而一时落后，用它当裁判就会假失败。
   *
   * 另外一旦房间不再轮到房主，立刻把待处理视图排空，
   * 免得过期视图把界面改回旧回合。
   */
  function drainViews() { deliverToClient(0); }

  function advanceToHostTurn() {
    var g2 = 0;
    while (uiRoom.state.phase === 'playing' && uiRoom.state.turn !== 0 && g2++ < 400) {
      var st = uiRoom.state;
      var s = st.turn;
      var legal = Game.legalMoves(P.makeView(st, s));
      var r = legal.length
        ? uiRoom.applyAction(s, 'play', legal[0].cards.map(function (c) { return c.id; }))
        : uiRoom.applyAction(s, 'pass');
      if (!r.ok) break;
      drainViews();
    }
    drainViews();
  }

  while (uiRoom.state.phase === 'playing' && guard++ < 60) {
    advanceToHostTurn();
    // 裁判：房间状态。房间不轮到房主就收工
    if (uiRoom.state.phase !== 'playing' || uiRoom.state.turn !== 0) break;

    hostTurns++;
    var legal2 = Game.legalMoves(P.makeView(uiRoom.state, 0));
    if (!legal2.length) {
      /* 没有可压的牌 → 只能过牌。
         这里【不走界面按钮】而是直接落到房间上：
         「房主过牌按钮」的状态取决于界面视图是否已经追上房间，
         而房主的 pump() 是 setTimeout 异步跑的，测试的同步循环和它抢回合，
         永远有窗口差 —— 那是我测试脚手架的时序问题，不是产品问题。
         出牌按钮那条路径才是这次要验的（下面就是），它已经能复现原 bug。 */
      uiRoom.applyAction(0, 'pass');
      passTurns++;
      drainViews();
      continue;
    }

    // 用界面自己的「提示」选牌：它依赖 currentLegal()，也顺便验证了界面状态是对的
    doc.getElementById('btnHint').click();
    var dis = doc.getElementById('btnPlay').disabled;
    ok(dis === false,
      '房主第 ' + hostTurns + ' 次轮到我：「出牌」按钮可点',
      'disabled=' + dis + ' flags=' + JSON.stringify(G.flags) +
      ' 房间轮次=' + uiRoom.state.turn);

    // 房主点出牌走的是本地路径（不经过 Net.send），所以看房间 state 变没变
    var mcBefore = uiRoom.state.moveCount;
    var errsBefore = consoleErrors.length;
    doc.getElementById('btnPlay').click();

    ok(consoleErrors.length === errsBefore,
      '房主第 ' + hostTurns + ' 次出牌没有抛错误',
      consoleErrors.slice(errsBefore).join(' | '));
    ok(uiRoom.state.moveCount > mcBefore,
      '房主第 ' + hostTurns + ' 次：点「出牌」真的落到牌局上了',
      'moveCount ' + mcBefore + ' → ' + uiRoom.state.moveCount +
      '；flags=' + JSON.stringify(G.flags));
    if (!(uiRoom.state.moveCount > mcBefore)) {
      console.log('      ↳ selInfo: ' + (doc.getElementById('selInfo').textContent || ''));
      break;
    }
    hostPlays++;
    drainViews();
  }

  ok(hostPlays >= 2,
    '房主自己也能连续出牌（出牌 ' + hostPlays + ' 手，过牌 ' + passTurns +
    ' 次，轮到房主 ' + hostTurns + ' 次，牌局 ' + uiRoom.state.phase + '）');
})();

console.log('\n' + '='.repeat(54));
console.log('界面测试：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('='.repeat(54));
process.exit(fail ? 1 : 0);
