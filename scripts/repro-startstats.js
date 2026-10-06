/* ============================================================
 * scripts/repro-startstats.js —— 复现并锁死两个联机界面 bug：
 *
 *   1) 一局打完后，房主回到「开始界面」看到的战绩全是 0
 *      （0 胜 0 平 0 负 · 共 0 局）。
 *      根因：myRecordText() 在 state 已清空时退回用固定名「你」查战绩，
 *      可联机时战绩是按每个玩家的昵称累计的，于是查不到 → 全 0。
 *
 *   2) 非房主打完一局后只能停在结算画面，点「回到牌桌」也回不到开始界面，
 *      因此永远看不到累计战绩。
 *      修法：客户端也能回到「开始界面」，只是「开始游戏」置灰、文案变成
 *      「等待房主开始游戏…」；房主一发新牌，界面自动收回牌桌。
 *
 * 跑法：node scripts/repro-startstats.js
 *
 * 用最小 DOM 桩（scripts/dom-shim.js）加载真正的 ui.js，两个场景：
 *   A. ui.js 当客户端 —— 完整打一局 → 点「回到牌桌」→ 断言开始界面 + 战绩；
 *   B. ui.js 当房主   —— 完整打一局 → 点「回到牌桌」→ 断言战绩不是 0。
 * 定时器换成可控队列，结算那一帧（setTimeout 700ms）由测试手动 flush，
 * 全程同步、确定性，不受真实时钟影响。
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
   一、迷你浏览器环境（含可控定时器）
   ============================================================ */

var doc = shim.createDocument(path.join(ROOT, 'index.html'));
var store = {};
var consoleErrors = [];

// 可控定时器：ui.js / room.js 里的 setTimeout 全部进队列，由 flushTimers 手动跑。
// setInterval（自动追同步）直接吞掉，测试里不需要它。
var timers = [];
var timerSeq = 1;
function fakeSetTimeout(fn, ms) { var id = timerSeq++; timers.push({ id: id, fn: fn }); return id; }
function fakeClearTimeout(id) { timers = timers.filter(function (t) { return t.id !== id; }); }
function flushTimers(max) {
  var n = 0;
  while (timers.length && n++ < (max || 2000)) {
    var t = timers.shift();
    try { t.fn(); }
    catch (e) { consoleErrors.push('timer: ' + ((e && e.stack) || e)); }
  }
}

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
  setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout,
  setInterval: function () { return 0; }, clearInterval: function () {},
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
  /* 刻意【不提供】module / exports / require：浏览器里它们是 undefined，
     各脚本才会走「全局变量」那条分支。 */
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

/* ---------------- 二、传输层换成邮箱 ---------------- */

var realNet = sandbox.Net;
var realRoom = sandbox.Room;

var uiOutbox = [];           // 客户端房间发给房主的消息
var seatInbox = {};          // seat -> 房主发给该座位的消息

function deepCopy(m) { return JSON.parse(JSON.stringify(m)); }

sandbox.Net = {
  on: function () {},
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

try {
  load('ui.js');
} catch (err) {
  console.log('\u2717 加载 ui.js 就抛错了：' + err.message);
  console.log(err.stack);
  process.exit(1);
}

var G = sandbox.__game;
var P = sandbox.ProtocolNS;
var Game = sandbox.Game;

function deliverToClient(seat) {
  var msgs = seatInbox[seat] || [];
  seatInbox[seat] = [];
  msgs.forEach(function (m) { realClientRoom.onData(m, null); });
  return msgs.length;
}

function resetTransport() {
  uiOutbox.length = 0;
  seatInbox = {};
  timers.length = 0;
}

function readRecord() {
  var el = doc.getElementById('startRecord');
  return (el && el.textContent) || '';
}

/* ============================================================
   三、开跑
   ============================================================ */

section('0. 加载与初始化');
ok(!!G, 'ui.js 初始化完成（window.__game 存在）');
ok(consoleErrors.length === 0, '加载过程没有 console.error', consoleErrors.slice(0, 2).join(' | '));
var mustHave = ['startScreen', 'startRecord', 'startHint', 'startTitle', 'btnStart',
  'overlay', 'btnAgain', 'btnPlay', 'btnPass', 'btnHint', 'hand', 'selInfo'];
var missing = mustHave.filter(function (id) { return !doc.getElementById(id); });
ok(missing.length === 0, 'DOM 桩解析出所有关键元素（' + mustHave.length + ' 个）', missing.join(', '));

/* ---------- 场景 A：ui.js 当客户端 ---------- */
section('A. 客户端：打完一局 → 回到开始界面看战绩');

resetTransport();

// 房主一侧：真实的权威房间（无界面）
var hostRoom = realRoom.create({
  net: sandbox.Net,
  ai: {
    decide: function (st, idx, diff, o) { return sandbox.AI.decide(st, idx, diff, o || {}); },
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
var hello = { type: P.C2H.HELLO, code: 'ABCD', name: '我', seat: null };
resetTransport();
var clientConn = { __seat: undefined, close: function () {} };
hostRoom.onData(hello, clientConn);
ok(clientConn.__seat === 1, '房主把客户端分到 1 号座位（实际 ' + clientConn.__seat + '）');
deliverToClient(1);
ok(G.seat === 1, '客户端座位是 1（实际 ' + G.seat + '）');

var sr = hostRoom.startGame();
ok(sr.ok, '房主开局成功' + (sr.ok ? '' : ('（' + sr.reason + '）')));
deliverToClient(1);
ok(!!G.state && G.state.phase === 'playing', '客户端牌桌进入进行中');

// 把整局打完：轮到客户端就点按钮，其余座位由测试直接落到房主房间上
var mySeat = 1;
var guard = 0;
while (hostRoom.state.phase === 'playing' && guard++ < 400) {
  // 房主侧推进到「轮到客户端」
  var g1 = 0;
  while (hostRoom.state.phase === 'playing' && hostRoom.state.turn !== mySeat && g1++ < 400) {
    var s = hostRoom.state.turn;
    var lg = Game.legalMoves(P.makeView(hostRoom.state, s));
    var r = lg.length
      ? hostRoom.applyAction(s, 'play', lg[0].cards.map(function (c) { return c.id; }))
      : hostRoom.applyAction(s, 'pass');
    if (!r.ok) break;
  }
  deliverToClient(mySeat);
  if (hostRoom.state.phase !== 'playing') break;
  if (hostRoom.state.turn !== mySeat) break;

  var legal = Game.legalMoves(P.makeView(hostRoom.state, mySeat));
  if (legal && legal.length) {
    doc.getElementById('btnHint').click();
    doc.getElementById('btnPlay').click();
  } else {
    doc.getElementById('btnPass').click();
  }
  var acts = uiOutbox.filter(function (m) { return m.type === P.C2H.ACTION; });
  uiOutbox.length = 0;
  acts.forEach(function (m) { hostRoom.onData(m, clientConn); });
  deliverToClient(mySeat);
}
ok(hostRoom.state.phase === 'over', '客户端这一局打完（phase=' + hostRoom.state.phase + '）');

flushTimers();   // 触发客户端那帧结算（scheduleResult 的 700ms）
ok(doc.getElementById('overlay').hidden === false, '客户端弹出了结算浮层');

// —— 关键：点「回到牌桌」应回到开始界面，而不是干留在结算上 ——
doc.getElementById('btnAgain').click();
ok(doc.getElementById('startScreen').hidden === false, '客户端点「回到牌桌」回到了开始界面');
var cs = doc.getElementById('btnStart');
ok(cs && cs.disabled === true, '客户端的「开始游戏」按钮被置灰（不能自己开局）');
ok(cs && /等待房主/.test(cs.textContent || ''), '按钮文案是「等待房主开始游戏…」（实际：' + (cs && cs.textContent) + '）');
var crec = readRecord();
ok(!/\u5171 0 \u5c40/.test(crec), '客户端战绩不是空的（' + crec + '）');
ok(/\u5171 1 \u5c40/.test(crec), '客户端战绩记了这 1 局（' + crec + '）');

// —— 房主一开新局，界面要自动收回牌桌（退出「等待房主」）——
hostRoom.backToLobby();
deliverToClient(mySeat);
hostRoom.startGame();
deliverToClient(mySeat);
ok(doc.getElementById('startScreen').hidden === true, '房主开新局后，客户端自动收回牌桌');
ok(!!G.state && G.state.phase === 'playing', '客户端已进入新一局（phase=' + (G.state && G.state.phase) + '）');
ok(cs.disabled === false, '重新开局后「开始游戏」按钮状态复原');

/* ---------- 场景 B：ui.js 当房主 ---------- */
section('B. 房主：打完一局 → 回到开始界面看战绩');

resetTransport();
G.host('HOST');
var uiRoom = realClientRoom;
ok(!!uiRoom && G.flags.netIsHost === true, 'ui.js 现在以房主身份运行');

uiRoom.startHost({
  name: '我',
  config: { playerCount: 3, landlord: false, nonA3ToLast: false, difficulty: 'normal', speed: 'fast' }
});
var peerConn = { __seat: undefined, close: function () {} };
uiRoom.onData({ type: P.C2H.HELLO, code: 'HOST', name: '客人', seat: null }, peerConn);
var sr2 = uiRoom.startGame({ playerCount: 3, landlord: false, nonA3ToLast: false, difficulty: 'normal', speed: 'fast' });
ok(sr2.ok, '房主开局成功');

var g2 = 0;
while (uiRoom.state && uiRoom.state.phase === 'playing' && g2++ < 400) {
  var st = uiRoom.state.turn;
  var lg2 = Game.legalMoves(P.makeView(uiRoom.state, st));
  var r2 = lg2.length
    ? uiRoom.applyAction(st, 'play', lg2[0].cards.map(function (c) { return c.id; }))
    : uiRoom.applyAction(st, 'pass');
  if (!r2.ok) break;
}
ok(uiRoom.state.phase === 'over', '房主这一局打完（phase=' + uiRoom.state.phase + '）');

flushTimers();
ok(doc.getElementById('overlay').hidden === false, '房主弹出了结算浮层');

doc.getElementById('btnAgain').click();
ok(doc.getElementById('startScreen').hidden === false, '房主点「回到牌桌」回到了开始界面');
var hs = doc.getElementById('btnStart');
ok(hs && hs.disabled === false, '房主的「开始游戏」按钮可点（房主当然能开局）');
var hrec = readRecord();
ok(!/\u5171 0 \u5c40/.test(hrec), '房主战绩不是 0（' + hrec + '）');

/* ---------- 全程无报错 ---------- */
section('C. 全程无 JS 报错');
ok(consoleErrors.length === 0, '整轮交互没有 console.error', consoleErrors.slice(0, 3).join(' | '));

console.log('\n' + '='.repeat(54));
console.log('开始界面 / 战绩回归：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('='.repeat(54));
process.exit(fail ? 1 : 0);
