/* ============================================================
 * scripts/repro-seat.js —— 回归：候场留下「座位空洞」后开局，
 * 座位号必须在房主和客户端之间重新对齐。
 *
 * 背景（线上 bug）：
 *   房主 + 客户端 A(1)、B(2)、C(3)。A 在候场退出 → roster 变成 [0,2,3]。
 *   房主开局时把 roster 补成连续号 [0,1,2]（原 B→1、原 C→2），
 *   但 net 里的连接、以及每个客户端记的自己的座位号，都还挂在旧号上。
 *   结果：
 *     · sendToSeat(新座位) 找不到连接 → 那个真人此后再也收不到视图
 *       （表现：卡在最后一帧、看不到结算）；
 *     · 有的连接收到「别的座位」的视图 → 轮次对不上，
 *       两个玩家互相干等对方出牌。
 *
 * 本脚本断言修复后：
 *   1. 每条连接都收到开局视图；
 *   2. 视图的 myIndex 和这条连接的新座位一致；
 *   3. 被挪动的客户端收到 SEAT 通知，且 conn.__seat 同步更新
 *      （handleAction / onDisconn 靠 conn.__seat 认人）。
 *
 * 跑法：node scripts/repro-seat.js
 * ============================================================ */
'use strict';

var path = require('path');
var DIR = path.join(__dirname, '..', 'js');

require(path.join(DIR, 'ai_v1.js'));
var P = require(path.join(DIR, 'protocol.js'));
var Room = require(path.join(DIR, 'room.js'));

var pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  \u2713 ' + label); }
  else { fail++; console.log('  \u2717 ' + label + (detail ? ('  → ' + detail) : '')); }
}

/* 假传输层：和 net.js 对外形状一致。
   · sendToSeat 只在「该座位确实挂着连接」时才投递（真 net.js 就是这样，
     座位对不上时消息静默丢掉 —— 这正是原 bug 的关键）；
   · detachSeat 要返回被摘下的连接（真 net.js 会返回），
     否则重排座位时连接一摘就找不回来了。 */
function makeFakeNet() {
  var seats = {};          // seat -> conn（等价 net.js 的 conns）
  var inbox = {};          // seat -> [msg]
  return {
    seats: seats,
    inbox: inbox,
    attach: function (seat, conn) { seats[seat] = conn || { __seat: seat }; },
    detachSeat: function (seat) { var c = seats[seat]; delete seats[seat]; return c; },
    sendToSeat: function (seat, msg) {
      if (!seats[seat]) return false;              // 没人挂在这个座位 → 丢掉
      (inbox[seat] = inbox[seat] || []).push(JSON.parse(JSON.stringify(msg)));
      return true;
    },
    broadcast: function (msg) {
      Object.keys(seats).forEach(function (s) {
        (inbox[s] = inbox[s] || []).push(JSON.parse(JSON.stringify(msg)));
      });
    },
    close: function () {}
  };
}

var net = makeFakeNet();
var room = Room.create({
  net: net,
  ai: {
    decide: function () { return { action: 'pass' }; },
    algo: function () { return { diff: 'hardv2' }; },
    speedMs: function () { return 0; }
  },
  on: { lobby: function () {}, view: function () {}, started: function () {}, finished: function () {} }
});

room.startHost({ name: '房主', config: { playerCount: 4 } });

// A→seat1, B→seat2, C→seat3（conn 各自记下来，后面查它收到什么）
var conns = {};
[{ n: 'A' }, { n: 'B' }, { n: 'C' }].forEach(function (c, i) {
  var conn = { close: function () {} };
  conns[c.n] = conn;
  room.onData({ type: P.C2H.HELLO, name: c.n }, conn);
});
console.log('入座后 roster = ' + JSON.stringify(room.roster.map(function (r) { return r.seat + ':' + r.name; })) +
  '  连接座位 = ' + JSON.stringify(Object.keys(net.seats).map(Number).sort()));

// A 在候场退出 → 座位 1 空出来，留下空洞 [0,2,3]
room.onDisconn({ __seat: 1 });
console.log('A 退出后 roster = ' + JSON.stringify(room.roster.map(function (r) { return r.seat + ':' + r.name; })) +
  '  连接座位 = ' + JSON.stringify(Object.keys(net.seats).map(Number).sort()));

Object.keys(net.inbox).forEach(function (s) { net.inbox[s] = []; });   // 清掉候场消息

var r = room.startGame();
console.log('startGame = ' + JSON.stringify(r));
console.log('开局后 roster（房主视角）= ' + JSON.stringify(room.roster.map(function (x) { return x.seat + ':' + x.name; })) +
  '  连接座位 = ' + JSON.stringify(Object.keys(net.seats).map(Number).sort()));

/* ---- 断言 ---- */
var hostSeats = room.roster.filter(function (x) { return !x.isHost; }).map(function (x) { return x.seat; }).sort();
var connSeats = Object.keys(net.seats).map(Number).sort();

ok(JSON.stringify(hostSeats) === JSON.stringify(connSeats),
  '连接座位集合 == 房主 roster 的客户端座位集合',
  JSON.stringify({ roster: hostSeats, conns: connSeats }));

// 每条连接都应该收到「以自己座位为 myIndex」的视图
connSeats.forEach(function (seat) {
  var c = net.seats[seat];
  var views = (net.inbox[seat] || []).filter(function (m) { return m.type === P.H2C.VIEW; });
  ok(views.length > 0, '座位 ' + seat + ' 收到了开局视图');
  if (views.length) {
    ok(views[views.length - 1].view.myIndex === seat,
      '座位 ' + seat + ' 的视图 myIndex 正确',
      'myIndex=' + views[views.length - 1].view.myIndex);
  }
  ok(c && c.__seat === seat, 'conn.__seat 已同步到新座位 ' + seat);
});

// 被挪动的客户端要收到 SEAT 通知，且告知的就是新座位
var movedSeats = connSeats;    // 这个场景下两条都被挪动了（2→1、3→2）
movedSeats.forEach(function (seat) {
  var seats = (net.inbox[seat] || []).filter(function (m) { return m.type === P.H2C.SEAT; });
  ok(seats.length === 1 && seats[0].seat === seat,
    '座位 ' + seat + ' 收到 SEAT 通知（新座位 = ' + seat + '）',
    JSON.stringify(seats));
});

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
