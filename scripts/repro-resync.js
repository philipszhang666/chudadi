/* ============================================================
 * scripts/repro-resync.js —— 回归：客户端掉帧 / 卡住时，「重新同步」能自愈。
 *
 * 场景：客户端一直收不到房主的视图（等价于连接半死 / 切后台太久），
 * 牌局在房主那边已经打到结束。此时客户端点「同步」→ 发 RESYNC，
 * 房主把当前权威局面（这里是结算帧）重发一份，客户端应能画出结算。
 *
 * 本次再加三条「网络抖动」下的自愈回归（对应线上那个
 * 「A 和 B 互相干等出牌、点同步也没反应」的卡死）：
 *   ① 通道已断，RESYNC 根本发不出去 → 立刻强制重连，不再干等；
 *   ② 通道「半死」（发得出、没回音）→ 超时兜底重连；
 *      且房主正常回包时绝不能乱重连（否则正常牌局被反复打断）；
 *   ③ 重连回来要坐回原座位 —— 房主可能还没察觉掉线，座位仍标记在线。
 *
 * 跑法：node scripts/repro-resync.js
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
function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }

var uiOutbox = [];
var seatInbox = {};
var netHandlers = {};
var rejoinCalls = 0, pokeCalls = 0;

sandbox.Net = {
  on: function (name, fn) { netHandlers[name] = fn; },
  sendOk: true,       // 置 false 模拟「通道已断：消息发不出去」
  send: function (msg) { uiOutbox.push(deepCopy(msg)); return sandbox.Net.sendOk !== false; },
  sendToSeat: function (seat, msg) {
    if (!seatInbox[seat]) seatInbox[seat] = [];
    seatInbox[seat].push(deepCopy(msg));
    return true;
  },
  broadcast: function (msg) {
    Object.keys(seatInbox).forEach(function (s) { seatInbox[s].push(deepCopy(msg)); });
  },
  attach: function () {}, detachSeat: function () {},
  host: function () {}, join: function () {}, close: function () {},
  poke: function () { pokeCalls++; },
  rejoin: function () { rejoinCalls++; },
  setMySeat: function () {}, getMySeat: function () { return 0; },
  getRole: function () { return 'client'; }, getCode: function () { return 'TEST'; },
  seatOfCode: function () { return null; },
  iceServers: realNet.iceServers, available: function () { return true; }
};
var clientRoomNet = {
  sendToSeat: function () { return true; }, broadcast: function () {},
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
      ai: (opts && opts.ai) || {}, on: opts && opts.on
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

// 把「同步后等回包」的上限调小，测试不用真等 3.5 秒
G.resyncFallbackMs = 150;

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function deliverToHost() {
  var msgs = uiOutbox.splice(0, uiOutbox.length);
  msgs.forEach(function (m) { hostRoom.onData(m, hostRoom.__clientConn); });
}
function deliverToClient() {
  var msgs = seatInbox[1] || [];
  seatInbox[1] = [];
  msgs.forEach(function (m) { realClientRoom.onData(m, null); });
  return msgs.length;
}

// 房主：speedMs 调很大 —— 本测试手动替所有座位出牌，不需要 pump 来插一脚
var hostRoom = realRoom.create({
  net: sandbox.Net,
  ai: {
    decide: function (st, idx, diff, o) { return AI.decide(st, idx, diff, o || {}); },
    algo: function () { return { diff: 'normal' }; },
    speedMs: function () { return 1e7; }
  },
  on: {}
});
hostRoom.startHost({
  name: '房主',
  config: { playerCount: 3, landlord: false, nonA3ToLast: false, difficulty: 'normal', speed: 'slow' }
});
hostRoom.__clientConn = { __seat: undefined, close: function () {} };

var pass = 0, fail = 0;
function ok(c, label, detail) {
  if (c) { pass++; console.log('  \u2713 ' + label); }
  else { fail++; console.log('  \u2717 ' + label + (detail ? ('  → ' + detail) : '')); }
}

(async function () {
  G.join('ABCD');
  var hello = uiOutbox.filter(function (m) { return m.type === P.C2H.HELLO; })[0];
  if (!hello) { hello = { type: P.C2H.HELLO, code: 'ABCD', name: '我', seat: null }; uiOutbox.length = 0; }
  var clientName = hello.name || '我';     // 后面验证「重连坐回原座位」要用同一名字
  hostRoom.onData(hello, hostRoom.__clientConn);
  deliverToClient();

  hostRoom.startGame();
  deliverToClient();
  ok(G.state && G.state.phase === 'playing', '开局后客户端拿到了第一帧');

  // ---- 房主那边把所有座位打完（客户端【不再收到】任何帧）----
  var guard = 0;
  while (hostRoom.state.phase === 'playing' && guard++ < 500) {
    var s = hostRoom.state.turn;
    var legal = Game.legalMoves(P.makeView(hostRoom.state, s));
    var r = legal.length
      ? hostRoom.applyAction(s, 'play', legal[0].cards.map(function (c) { return c.id; }))
      : hostRoom.applyAction(s, 'pass');
    if (!r.ok) break;
  }
  ok(hostRoom.state.phase === 'over', '房主那边已经打完（phase=over）');

  // 模拟「客户端整局掉帧」：把这些帧全丢掉，客户端还停在开局那一帧
  seatInbox[1] = [];
  ok(G.state && G.state.phase === 'playing', '掉帧期间客户端卡在旧局面（playing）');
  ok(doc.getElementById('overlay').hidden === true, '掉帧期间客户端没有结算浮层');

  // ---- 点「同步」：客户端发 RESYNC，房主补一帧 ----
  uiOutbox.length = 0;
  doc.getElementById('btnResync').click();
  var sent = uiOutbox.filter(function (m) { return m.type === P.C2H.RESYNC; });
  ok(sent.length === 1, '点「同步」后客户端发出了 RESYNC');

  deliverToHost();       // RESYNC → 房主
  deliverToClient();     // 房主补发的视图 → 客户端
  await sleep(900);      // scheduleResult = later(showResult, 700)
  deliverToClient();

  ok(G.state && G.state.phase === 'over', '同步后客户端追上了（phase=over）', 'phase=' + (G.state && G.state.phase));
  ok(doc.getElementById('overlay').hidden === false, '同步后客户端弹出了结算浮层');

  /* ============================================================
     网络抖动导致「同步」失效时的自愈（本次修复的回归）
     线上现象：A 和 B 互相干等出牌，点「同步」也没反应，牌局卡死。
     ============================================================ */
  console.log('\n重连自愈：同步发不出去 / 石沉大海 / 重连拿回原座位');

  // ① 通道已断：Net.send 返回 false → 立刻强制重连，不再干等
  sandbox.Net.sendOk = false;
  rejoinCalls = 0;
  uiOutbox.length = 0;
  doc.getElementById('btnResync').click();
  ok(rejoinCalls === 1, '同步请求发不出去时，立刻触发一次强制重连（rejoin）');
  sandbox.Net.sendOk = true;

  // ②a 房主正常回包：不该误重连（否则正常牌局会被反复重连打断）
  rejoinCalls = 0;
  uiOutbox.length = 0;
  doc.getElementById('btnResync').click();
  deliverToHost();        // RESYNC → 房主
  deliverToClient();      // 房主立刻回一帧
  await sleep(400);       // 超过 fallback（150ms）
  ok(rejoinCalls === 0, '房主正常回包时，不会误触发重连');

  // ②b 半死通道：请求发出去了，房主却永远不回 → 兜底到点强制重连
  rejoinCalls = 0;
  uiOutbox.length = 0;
  await sleep(200);                              // 让「最后一帧」早于本次请求
  doc.getElementById('btnResync').click();       // send 成功，但房主不回
  ok(rejoinCalls === 0, '刚发出同步请求时先不重连（给房主留时间）');
  await sleep(500);                              // > 150ms fallback
  ok(rejoinCalls === 1, '迟迟等不到房主回音 → 兜底强制重连一次');

  // ③ 重连坐回原座位：房主仍以为该座位在线，也必须还给老玩家
  var conn2 = { __seat: undefined, close: function () {}, send: function () {} };
  hostRoom.onData({ type: P.C2H.HELLO, name: clientName, seat: 1 }, conn2);
  ok(conn2.__seat === 1, '重连（房主仍以为在线）也坐回 1 号座位，不会被「房间满了」挡住',
     '实际座位=' + conn2.__seat);

  console.log('\nconsole.error 次数=' + consoleErrors.length);
  if (consoleErrors.length) console.log(consoleErrors.slice(0, 3).join('\n---\n'));
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
