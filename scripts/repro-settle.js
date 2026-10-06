/* ============================================================
 * scripts/repro-settle.js —— 复现：联机时「除房主外的真人玩家看不到结算」。
 *
 * 做法沿用 test-ui-online.js 的迷你浏览器：真的加载 ui.js，
 * 用两个真实 room.js（房主 + ui 自己的客户端房间），中间用邮箱转交消息。
 * 跑到牌局 over，然后等 700ms（scheduleResult 的延时）看客户端
 * 的结算浮层 #overlay 到底出没出来。
 *
 * 跑法：node scripts/repro-settle.js
 * ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var shim = require('./dom-shim.js');

var ROOT = path.join(__dirname, '..');
var JS = path.join(ROOT, 'js');

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
  Sound: { setEnabled: function () {}, setVolume: function () {}, play: function () {} },
  Worker: undefined,
  Peer: function () { throw new Error('这个测试不该创建真的 Peer'); }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
var ctx = vm.createContext(sandbox);

function load(f) {
  vm.runInContext(fs.readFileSync(path.join(JS, f), 'utf8'), ctx, { filename: 'js/' + f });
}

['cards.js', 'game.js', 'determinize.js', 'endgame.js', 'mcts.js', 'ai.js',
 'sound.js', 'protocol.js', 'net.js', 'room.js'].forEach(load);

var realNet = sandbox.Net;
var realRoom = sandbox.Room;

var netHandlers = {};
var uiOutbox = [];
var seatInbox = {};

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

var clientRoomNet = {
  sendToSeat: function () { return true; },
  broadcast: function () {},
  attach: function () {}, detachSeat: function () {},
  setMySeat: function () {}, close: function () {},
  send: function (msg) { uiOutbox.push(deepCopy(msg)); return true; }
};

var realClientRoom = null;

sandbox.Room = {
  create: function (opts) {
    var isClient = (opts && opts.net) === sandbox.Net;
    var room = realRoom.create({
      net: isClient ? clientRoomNet : (opts && opts.net),
      ai: (opts && opts.ai) || {},
      on: opts && opts.on
    });
    if (isClient) realClientRoom = room;
    return room;
  }
};

load('ui.js');

var G = sandbox.__game;
var P = sandbox.ProtocolNS;
var Game = sandbox.Game;
var AI = sandbox.AI;

function deliverToHost(conn) {
  uiOutbox.splice(0, uiOutbox.length).forEach(function (m) { hostRoom.onData(m, conn); });
}

function deliverToClient(seat) {
  var msgs = seatInbox[seat] || [];
  seatInbox[seat] = [];
  msgs.forEach(function (m) { realClientRoom.onData(m, null); });
  return msgs.length;
}

// ---- 房主：真实权威房间 ----
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
  config: { playerCount: 3, landlord: true, nonA3ToLast: false, difficulty: 'normal', speed: 'fast' }
});

// ---- ui.js 以客户端身份加入 ----
G.join('ABCD');
var hello = uiOutbox.filter(function (m) { return m.type === P.C2H.HELLO; })[0];
if (!hello) {
  hello = { type: P.C2H.HELLO, code: 'ABCD', name: '我', seat: null };
  uiOutbox.length = 0;
}
var clientConn = { __seat: undefined, close: function () {} };
hostRoom.onData(hello, clientConn);
deliverToClient(1);

hostRoom.startGame();
deliverToClient(1);
console.log('客户端入座 seat=' + G.seat + '  phase=' + (G.state && G.state.phase));

// ---- 推进到客户端回合，客户端点“提示 + 出牌”，一直打到结束 ----
function advanceToMyTurn() {
  var guard = 0;
  while (hostRoom.state.phase === 'playing' && hostRoom.state.turn !== 1 && guard++ < 400) {
    var s = hostRoom.state.turn;
    var legal = Game.legalMoves(P.makeView(hostRoom.state, s));
    var r = legal.length
      ? hostRoom.applyAction(s, 'play', legal[0].cards.map(function (c) { return c.id; }))
      : hostRoom.applyAction(s, 'pass');
    if (!r.ok) break;
  }
  deliverToClient(1);
}

var spin = 0, plays = 0;
while (hostRoom.state.phase === 'playing' && spin++ < 80) {
  advanceToMyTurn();
  if (hostRoom.state.phase !== 'playing' || hostRoom.state.turn !== 1) break;

  var legal = G.legal();
  if (!legal || !legal.length) {
    var pb = uiOutbox.length;
    doc.getElementById('btnPass').click();
    if (uiOutbox.length !== pb + 1) { console.log('过牌没发出'); break; }
    var ps = uiOutbox.filter(function (m) { return m.type === P.C2H.ACTION; });
    uiOutbox.length = 0;
    ps.forEach(function (m) { hostRoom.onData(m, clientConn); });
    deliverToClient(1);
    continue;
  }

  doc.getElementById('btnHint').click();
  var before = uiOutbox.length;
  doc.getElementById('btnPlay').click();
  if (uiOutbox.length !== before + 1) { console.log('出牌没发出'); break; }
  var acts = uiOutbox.filter(function (m) { return m.type === P.C2H.ACTION; });
  uiOutbox.length = 0;
  acts.forEach(function (m) { hostRoom.onData(m, clientConn); });
  deliverToClient(1);
  plays++;
}

console.log('打到结束：host.phase=' + hostRoom.state.phase +
  '  客户端 state.phase=' + (G.state && G.state.phase) +
  '  客户端出了 ' + plays + ' 手');

var ov = doc.getElementById('overlay');
console.log('驱动结束后（立刻）：overlay.hidden=' + (ov && ov.hidden) +
  '  state.result=' + !!(G.state && G.state.result));

// scheduleResult = later(showResult, 700)，等 1000ms 再看
setTimeout(function () {
  var ok1 = doc.getElementById('overlay').hidden === false;
  console.log('\n[1] 第一局结算：客户端浮层可见 = ' + ok1 +
    '（state.phase=' + (G.state && G.state.phase) + '）');

  // ===== 第二局：房主【不】走候场大厅，直接再开局 → 房间把 seq 归零 =====
  hostRoom.startGame();               // phase=over，允许；seq 归零到 1
  deliverToClient(1);
  console.log('\n[2] 第二局（不开候场，直接 startGame）：');
  console.log('    host.seq=' + hostRoom.seq +
    '  客户端 lastViewSeq=' + G.flags.lastViewSeq +
    '  客户端 state.round=' + (G.state && G.state.round));

  var s2 = 0;
  while (hostRoom.state.phase === 'playing' && hostRoom.state.turn !== 1 && s2++ < 5) {
    var t2 = hostRoom.state.turn;
    var l2 = Game.legalMoves(P.makeView(hostRoom.state, t2));
    var r2 = l2.length ? hostRoom.applyAction(t2, 'play', l2[0].cards.map(function (c) { return c.id; }))
                       : hostRoom.applyAction(t2, 'pass');
    if (!r2.ok) break;
    deliverToClient(1);
  }
  var synced = !!(G.state && G.state.round === hostRoom.state.round &&
    G.state.phase === hostRoom.state.phase);
  console.log('    推进后 客户端 round=' + (G.state && G.state.round) +
    ' host round=' + hostRoom.state.round + ' → 客户端跟上了 = ' + synced);

  console.log('\n结论：' +
    ((ok1 && synced) ? '两局客户端都同步 ✅' : '客户端没跟上 ❌（这就是「卡在最后、看不到结算」）'));
  process.exit((ok1 && synced) ? 0 : 1);
}, 1000);
