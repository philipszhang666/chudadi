/* ============================================================
 * scripts/repro-botsettle.js —— 复现：只剩电脑在收尾时，非房主收不到结算。
 *
 * 和 repro-settle.js 的区别：那里是「同步地替每个座位出牌」，
 * 电脑位也由脚本代劳，所以走不到房主 pump() 那条异步路径。
 * 这里改成：真人座位（房主 0 / 客户端 1）由脚本驱动，
 * 电脑座位交给【房主 room.pump() 自己跑】，然后看客户端浮层出没出来。
 *
 * 跑法：node scripts/repro-botsettle.js
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

/* 客户端那台「机器」用的 Net：send 出去的消息丢进 uiOutbox，
   房主发给某个座位的消息丢进 seatInbox[seat]。 */
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
  getRole: function () { return 'client'; }, getCode: function () { return 'TEST'; },
  seatOfCode: function () { return null; },
  iceServers: realNet.iceServers, available: function () { return true; }
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

// ---- 房主：真实权威房间，config 用 A3 地主（电脑会打到末游才结束） ----
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
  config: { playerCount: 4, landlord: true, nonA3ToLast: false, difficulty: 'normal', speed: 'fast' }
});
hostRoom.__clientConn = { __seat: undefined, close: function () {} };

// ---- 客户端（ui.js）加入 ----
G.join('ABCD');
var hello = uiOutbox.filter(function (m) { return m.type === P.C2H.HELLO; })[0];
if (!hello) { hello = { type: P.C2H.HELLO, code: 'ABCD', name: '我', seat: null }; uiOutbox.length = 0; }
hostRoom.onData(hello, hostRoom.__clientConn);
deliverToClient();
console.log('客户端座位 = ' + G.seat + '（房主 0，客户端 1，座位 2/3 是电脑）');

function driveHostSeat0() {
  var legal = Game.legalMoves(P.makeView(hostRoom.state, 0));
  var r = legal.length
    ? hostRoom.applyAction(0, 'play', legal[0].cards.map(function (c) { return c.id; }))
    : hostRoom.applyAction(0, 'pass');
  return r;
}
function driveClient() {
  if (!G.state || G.state.phase !== 'playing' || G.state.turn !== 1) return;
  var legal = G.legal();
  if (!legal || !legal.length) {
    doc.getElementById('btnPass').click();
  } else {
    doc.getElementById('btnHint').click();
    doc.getElementById('btnPlay').click();
  }
}

var pass = 0, fail = 0;
function ok(c, label, detail) {
  if (c) { pass++; console.log('  \u2713 ' + label); }
  else { fail++; console.log('  \u2717 ' + label + (detail ? ('  → ' + detail) : '')); }
}

async function playOnce() {
  hostRoom.startGame();
  deliverToClient();
  var t0 = Date.now();
  var guard = 0;
  while (hostRoom.state.phase === 'playing' && Date.now() - t0 < 20000 && guard++ < 4000) {
    deliverToClient();
    if (hostRoom.state.phase !== 'playing') break;
    var t = hostRoom.state.turn;
    if (t === 0) { driveHostSeat0(); }
    else if (t === 1) { driveClient(); }
    else { await sleep(6); }        // 电脑座位：交给房主 pump() 自己跑
    deliverToHost();
    await sleep(2);
  }
  deliverToClient();
  await sleep(900);                 // scheduleResult = later(showResult, 700)
  deliverToClient();

  var hostPhases = hostRoom.state && hostRoom.state.phase;
  var clientPhase = G.state && G.state.phase;
  var overlayHidden = doc.getElementById('overlay').hidden;
  return { hostPhase: hostPhases, clientPhase: clientPhase, overlayHidden: overlayHidden };
}

(async function () {
  var ROUNDS = 6;
  for (var i = 1; i <= ROUNDS; i++) {
    var r = await playOnce();
    console.log('第 ' + i + ' 局：host.phase=' + r.hostPhase +
      '  客户端 phase=' + r.clientPhase + '  结算浮层 hidden=' + r.overlayHidden);
    ok(r.hostPhase === 'over', '第 ' + i + ' 局房主打完了');
    ok(r.clientPhase === 'over', '第 ' + i + ' 局客户端也进入了 over', 'phase=' + r.clientPhase);
    ok(r.overlayHidden === false, '第 ' + i + ' 局客户端显示了结算浮层', 'hidden=' + r.overlayHidden);
    // 下一局：回候场再开（顺便把客户端 lastViewSeq 归零）
    hostRoom.backToLobby();
    deliverToClient();
  }
  console.log('\nconsole.error 次数=' + consoleErrors.length);
  if (consoleErrors.length) console.log(consoleErrors.slice(0, 3).join('\n---\n'));
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
