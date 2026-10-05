/* ============================================================
 * scripts/test-room.js —— 无头（不开浏览器）验证联机逻辑
 *
 * 用假的「管子」跑一场完整的 4 人局，重点断言三件事：
 *   1. 信息隐藏：任何客户端收到的视图里，别人的手牌必须全是占位牌，
 *      不能出现任何真牌 id；A3 地主的底牌字段必须被抠掉。
 *   2. 权威校验：客户端绕过程序直接发一个非法出牌（不是你手里的牌 /
 *      还没轮到你 / 压不过），必须被房主拒绝且牌局不被改坏。
 *   3. 能正常打完：一局能从发牌一路走到结算，且所有客户端最终
 *      收到一致的公开信息（名次 / 剩余张数）。
 *
 * 跑法：node scripts/test-room.js
 * ============================================================ */
'use strict';

var path = require('path');
var DIR = path.join(__dirname, '..', 'js');

/* ai.js 在 Node 下会 require('./ai_v1.js')（供搜索 rollout 用），
   而这个文件仓库里原本不存在，所以无头测试一上来就 MODULE_NOT_FOUND。
   js/ai_v1.js 现放了一个「导出 null」的占位模块把这条 require 接住，
   ai.js 于是退回自带的 hard 实现（就是它注释里写的退路）。
   这里只需要确认那个占位模块确实在，不在就直接报清楚。 */
if (!require('fs').existsSync(path.join(DIR, 'ai_v1.js'))) {
  console.error('缺少 js/ai_v1.js（ai.js 在 Node 下会 require 它）。');
  console.error('它应当是个 module.exports = null 的占位模块，见文件内注释。');
  process.exit(2);
}

var P = require(path.join(DIR, 'protocol.js'));
var Game = require(path.join(DIR, 'game.js'));
require(path.join(DIR, 'determinize.js'));
require(path.join(DIR, 'endgame.js'));
require(path.join(DIR, 'mcts.js'));
var AI = require(path.join(DIR, 'ai.js'));
var Room = require(path.join(DIR, 'room.js'));

/* ---------------- 断言小工具 ---------------- */

var pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  \u2713 ' + label); }
  else {
    fail++;
    console.log('  \u2717 ' + label + (detail ? ('  \u2192 ' + detail) : ''));
  }
}
function section(t) { console.log('\n' + t); }

/* ---------------- 假传输层 ----------------
   模拟 net.js 的对外形状：sendToSeat / broadcast / attach / detachSeat。
   房主发什么，就同步存进对应玩家的「收件箱」。 */
function makeFakeNet() {
  var inbox = {};        // seat -> [msg]
  var seats = {};        // seat -> conn 对象
  function push(seat, msg) {
    if (!inbox[seat]) inbox[seat] = [];
    inbox[seat].push(JSON.parse(JSON.stringify(msg)));
  }
  return {
    inbox: inbox,
    push: push,
    take: function (seat) { var m = inbox[seat] || []; inbox[seat] = []; return m; },
    attach: function (seat, conn) { seats[seat] = conn || { __seat: seat }; },
    detachSeat: function (seat) { delete seats[seat]; },
    sendToSeat: function (seat, msg) { push(seat, msg); },
    broadcast: function (msg) { Object.keys(seats).forEach(function (s) { push(Number(s), msg); }); },
    close: function () {}
  };
}

/* ---------------- 搭一桌 4 人 ----------------
   房主（seat 0）持权威 state，seat 1~3 是客户端。
   客户端只拿到发来的视图，用它去算合法出牌（和真实界面一样）。 */
function setupGame(config) {
  var net = makeFakeNet();
  var views = {};          // seat -> 最新视图
  var hostRoom = null;
  var rejections = {};     // seat -> [拒绝原因]

  var room = Room.create({
    net: net,
    ai: {
      decide: function (state, idx, diff, o) {
        // 测试里用便宜档，跑得快
        return AI.decide(state, idx, diff, o || {});
      },
      algo: function () { return { diff: 'hardv2' }; },
      speedMs: function () { return 0; }         // 不留思考时间，测试要快
    },
    on: {
      lobby: function () {},
      view: function (e) {
        // 房主自己的视角
        views[0] = e.view;
      },
      started: function () {},
      finished: function () {}
    }
  });

  room.startHost({ name: '房主', config: config });
  hostRoom = room;

  // 之前没 attach 的座位现在补上，让 broadcast 能找到 1~3
  for (var s = 1; s < config.playerCount; s++) {
    net.attach(s, { __seat: s });
  }

  // 模拟三个客户端加入（走真实的消息路径）
  var conns = {};
  for (var s2 = 1; s2 < config.playerCount; s2++) {
    var conn = { __seat: undefined, close: function () {} };
    conns[s2] = conn;
    room.onData({ type: P.C2H.HELLO, name: '玩家' + s2 }, conn);
  }

  return {
    room: room, net: net, views: views, conns: conns, rejections: rejections,
    /** 把房主发给各客户端的 VIEW / 拒绝消息收下来（会清空收件箱） */
    drain: function () {
      for (var s = 1; s < config.playerCount; s++) {
        net.take(s).forEach(function (m) {
          if (m.type === P.H2C.VIEW) views[s] = m.view;
          if (m.type === P.H2C.EVENT && m.kind === 'reject') {
            if (!rejections[s]) rejections[s] = [];
            rejections[s].push(m.reason);
          }
        });
      }
    }
  };
}

/* ============================================================
   1. 信息隐藏
   ============================================================ */
section('1. 信息隐藏：客户端不能看到别人的手牌');

(function () {
  var g = setupGame({ playerCount: 4, landlord: false, nonA3ToLast: false });
  var r = g.room.startGame();
  ok(r.ok, '4 人局开局成功', r.reason);
  g.drain();

  var hostState = g.room.state;
  ok(!!hostState, '房主持有权威状态');

  [1, 2, 3].forEach(function (seat) {
    var v = g.views[seat];
    if (!v) { ok(false, '座位 ' + seat + ' 收到了视图'); return; }

    var leak = P.leakedRealHands(v, seat);
    ok(leak.length === 0, '座位 ' + seat + ' 的视图里没有别人的真牌',
      leak.length ? ('泄露了 ' + leak.length + ' 张，例如 ' + JSON.stringify(leak[0])) : '');

    // 自己的手牌必须是真的，且和权威 state 一致
    var mine = v.players[seat].hand.map(function (c) { return c.id; }).sort().join(',');
    var real = hostState.players[seat].hand.map(function (c) { return c.id; }).sort().join(',');
    ok(mine === real, '座位 ' + seat + ' 能看到自己的真手牌');

    // 别人的手牌张数要对（否则界面画错牌背数量）
    var countsOk = v.players.every(function (p, i) {
      return p.hand.length === hostState.players[i].hand.length;
    });
    ok(countsOk, '座位 ' + seat + ' 看到的所有人张数正确');

    ok(v.myIndex === seat, '座位 ' + seat + ' 的 myIndex 正确');
    var humanFlags = v.players.filter(function (p) { return p.isHuman; });
    ok(humanFlags.length === 1 && v.players[seat].isHuman, '座位 ' + seat + ' 只有自己是 isHuman');
  });

  // 占位牌里不能夹带任何真牌字段
  var dummy = g.views[1].players[0].hand[0];
  ok(dummy && dummy.hidden === true && dummy.id === undefined,
    '别人的手牌是占位牌（无 id / 无牌面）', JSON.stringify(dummy));

  // 公平性：三家客户端看到的公开信息必须完全一致
  var pub = [1, 2, 3].map(function (seat) {
    var v = g.views[seat];
    return JSON.stringify({
      turn: v.turn, current: v.current, round: v.round,
      counts: v.players.map(function (p) { return p.hand.length; }),
      trick: v.trick
    });
  });
  ok(pub[0] === pub[1] && pub[1] === pub[2], '三家客户端收到的公开信息一致');
})();

/* ============================================================
   2. A3 地主：底牌不能泄露
   ============================================================ */
section('2. A3 地主：队友身份不能泄露');

(function () {
  var g = setupGame({ playerCount: 4, landlord: true, nonA3ToLast: false });
  var r = g.room.startGame();
  ok(r.ok, 'A3 地主局开局成功', r.reason);
  g.drain();

  ok(!!g.room.state.landlord, '权威状态里确实有 A3 暗队信息');
  [1, 2, 3].forEach(function (seat) {
    var v = g.views[seat];
    if (!v || !v.landlord) { ok(false, '座位 ' + seat + ' 有 landlord 字段'); return; }
    ok(v.landlord.holderA === undefined && v.landlord.holder3 === undefined,
      '座位 ' + seat + ' 看不到「谁捏着 ♠A / ♠3」');
    ok(Array.isArray(v.landlord.members),
      '座位 ' + seat + ' 仍能拿到地主队成员（这是亮牌后公开的信息）');
  });
})();

/* ============================================================
   3. 权威校验：非法动作必须被拒
   ============================================================ */
section('3. 权威校验：客户端伪造动作会被房主拒绝');

(function () {
  var g = setupGame({ playerCount: 4, landlord: false, nonA3ToLast: false });
  g.room.startGame();
  g.drain();

  var st = g.room.state;
  var leader = st.turn;                       // 持 ♦4 的人先出
  var notLeader = (leader + 1) % 4;
  var before = JSON.stringify(st.players.map(function (p) { return p.hand.map(function (c) { return c.id; }); }));

  // (a) 不是你的回合
  g.room.onData({ type: P.C2H.ACTION, action: 'play', cards: [st.players[notLeader].hand[0].id] }, g.conns[notLeader]);
  g.drain();                                  // 立刻收，否则收件箱会被后面的 drain 清掉
  var after1 = JSON.stringify(st.players.map(function (p) { return p.hand.map(function (c) { return c.id; }); }));
  ok(before === after1, '非当前出牌者的动作没有改坏牌局');
  ok(g.rejections[notLeader] && g.rejections[notLeader].length === 1,
    '非当前出牌者收到了拒绝', JSON.stringify(g.rejections[notLeader]));

  // (b) 当前出牌者出了「不在自己手里的牌」
  var leaderSeat = leader;
  if (leaderSeat === 0) {
    // 房主自己出手，走 applyAction
    var wrong = g.room.applyAction(0, 'play', ['3S']);
    ok(!wrong.ok, '房主自己出不在手里的牌也被拒', wrong.reason);
  } else {
    g.room.onData({ type: P.C2H.ACTION, action: 'play', cards: ['3S'] }, g.conns[leaderSeat]);
    g.drain();
    var after2 = JSON.stringify(st.players.map(function (p) { return p.hand.map(function (c) { return c.id; }); }));
    ok(before === after2, '出不在手里的牌没有改坏牌局');
    ok(g.rejections[leaderSeat] && g.rejections[leaderSeat].length === 1,
      '出不在手里的牌被拒', JSON.stringify(g.rejections[leaderSeat]));
  }

  // (c) 第一手不带 ♦4
  if (leaderSeat === 0) {
    var noFour = g.room.state.players[0].hand.filter(function (c) { return c.id !== '4D'; });
    var r3 = g.room.applyAction(0, 'play', [noFour[noFour.length - 1].id]);
    ok(!r3.ok, '首手不带 ♦4 被拒', r3.reason);
  } else {
    var hand = st.players[leaderSeat].hand.filter(function (c) { return c.id !== '4D'; });
    g.room.onData({ type: P.C2H.ACTION, action: 'play', cards: [hand[hand.length - 1].id] }, g.conns[leaderSeat]);
    g.drain();
    var after3 = JSON.stringify(st.players.map(function (p) { return p.hand.map(function (c) { return c.id; }); }));
    ok(before === after3, '首手不带 ♦4 没有改坏牌局');
    ok(g.rejections[leaderSeat] && g.rejections[leaderSeat].length === 2, '首手不带 ♦4 被拒',
      JSON.stringify(g.rejections[leaderSeat]));
  }

  // 领导出牌者肯定拿 ♦4，前面断言过
  ok(st.players[leader].hand.some(function (c) { return c.id === '4D'; }),
    '先出的人确实持 ♦4（前面的拒绝理由才成立）');
})();

/* ============================================================
   4. 完整打完一局
   ============================================================ */
section('4. 端到端：一局能从头打到结算');

(function () {
  var g = setupGame({ playerCount: 4, landlord: false, nonA3ToLast: false });
  g.room.startGame();
  g.drain();

  var st = g.room.state;
  var steps = 0;
  var MAX = 4000;

  while (st.phase === 'playing' && steps < MAX) {
    steps++;
    var seat = st.turn;
    var view = (seat === 0) ? P.makeView(st, 0) : g.views[seat];
    if (!view) { ok(false, '座位 ' + seat + ' 有视图可用来决策'); break; }

    // 客户端用自己的视图算合法出牌 —— 和真实界面完全同一条路径
    var legal = Game.legalMoves(view);
    var move;
    if (legal.length) {
      var pick = legal[0];
      move = { action: 'play', cards: pick.cards.map(function (c) { return c.id; }) };
    } else if (view.current !== null) {
      move = { action: 'pass' };
    } else {
      ok(false, '领出时居然没有合法出牌（不该发生）'); break;
    }

    var r = g.room.applyAction(seat, move.action, move.cards);
    if (!r.ok) { ok(false, '第 ' + steps + ' 步动作被拒：' + r.reason); break; }
    g.drain();
  }

  ok(steps < MAX, '一局在有限步数内打完（' + steps + ' 步）');
  ok(st.phase === 'over', '牌局进入结算状态');
  ok(!!st.result && Array.isArray(st.result.detail), '结算结果里有各家明细');
  ok(st.result.detail.length === 4, '结算明细包含 4 家');

  var sum = st.result.detail.map(function (d) { return d.rank; }).sort().join(',');
  ok(sum === '1,2,3,4', '四家名次是 1/2/3/4', sum);

  // 结算后所有人都该拿到公开的结算信息
  var v1 = g.views[1];
  ok(v1 && v1.phase === 'over', '客户端也收到了结算状态');
  ok(v1 && v1.result && v1.result.detail.length === 4, '客户端拿到了完整结算明细');
  ok(v1 && v1.result.detail.every(function (d) { return typeof d.rest === 'number'; }),
    '结算明细里各家的剩余张数是公开的');
})();

/* ============================================================
   5. 掉线代打（异步：pump 用 setTimeout 分片，得等它跑）
   ============================================================ */
section('5. 有人掉线时房主接手，牌局不会卡死');

(function () {
  var g = setupGame({ playerCount: 4, landlord: false, nonA3ToLast: false });
  g.room.startGame();
  g.drain();

  // 让 1/2/3 全部掉线，只留房主；房主应当自动代打完剩下三家
  [1, 2, 3].forEach(function (s) { g.room.onDisconn(g.conns[s]); });
  ok(g.room.roster.filter(function (r) { return r.online; }).length === 1,
    '名单里只剩房主在线');

  // 房主自己出牌，之后应该由 AI 接手其余三家
  var st = g.room.state;
  var guard = 0;
  while (st.phase === 'playing' && st.turn === 0 && guard < 500) {
    guard++;
    var legal = Game.legalMoves(st);
    var r = legal.length
      ? g.room.applyAction(0, 'play', legal[0].cards.map(function (c) { return c.id; }))
      : g.room.applyAction(0, 'pass');
    if (!r.ok) { ok(false, '房主出牌被拒：' + r.reason); break; }
    g.drain();
  }

  // 之后轮到 AI，pump 是异步的（setTimeout 分片），等它跑完
  setTimeout(function () {
    ok(st.phase === 'over' || st.turn === 0 || !st.players[st.turn].isHuman,
      '掉线座位由房主代打，没有卡死（当前 phase=' + st.phase + ' turn=' + st.turn + '）');
    ok(g.room.phase === 'over' || st.phase === 'playing', '房间阶段与实际牌局一致');

    finish();
  }, 1500);
})();

/* ============================================================
   6. 视角旋转：每个人都得看自己坐正下方
   ============================================================ */
section('6. 视角旋转：座位 → 屏幕槽位');

(function () {
  // 4 人局：3 个对手位，必须刚好占满 0/1/2
  [0, 1, 2, 3].forEach(function (me) {
    var layout = P.seatLayout(4, me);
    ok(layout[me] === -1, '4 人局：我自己（座位 ' + me + '）在正下方');
    var others = layout.filter(function (s) { return s >= 0; }).sort();
    ok(others.join(',') === '0,1,2',
      '4 人局：从座位 ' + me + ' 看，三个对手正好占满 3 个屏幕槽位', others.join(','));
  });

  // 关键性质：我的下家（顺时针）永远出现在屏幕「右上」= 槽位 0。
  // 这条保证了「谁在我后面出牌」在每个人屏幕上都对得上。
  [0, 1, 2, 3].forEach(function (me) {
    var next = (me + 1) % 4;
    ok(P.seatLayout(4, me)[next] === 0,
      '4 人局：座位 ' + me + ' 看下家（座位 ' + next + '）在右上');
  });

  // 3 人局：只有 2 个对手位，占用槽位 0 和 1（两个上角，左右对称）
  [0, 1, 2].forEach(function (me) {
    var layout = P.seatLayout(3, me);
    ok(layout[me] === -1, '3 人局：我自己（座位 ' + me + '）在正下方');
    var others = layout.filter(function (s) { return s >= 0; }).sort();
    ok(others.join(',') === '0,1',
      '3 人局：从座位 ' + me + ' 看，两个对手占满前 2 个槽位', others.join(','));
  });
})();

/* ============================================================
   7. 房间码
   ============================================================ */
section('7. 房间码');

(function () {
  var seen = {};
  var bad = 0;
  for (var i = 0; i < 400; i++) {
    var c = P.makeCode();
    if (c.length !== 4) bad++;
    // 不能出现容易看错的 0/O/1/I/L（要口头念给朋友听）
    if (/[01OIL]/.test(c)) bad++;
    seen[c] = (seen[c] || 0) + 1;
  }
  ok(bad === 0, '400 个房间码都是 4 位且不含易混字符');
  ok(Object.keys(seen).length > 380,
    '房间码随机性够（400 次里 ' + Object.keys(seen).length + ' 个不重复）');

  ok(P.normalizeCode('abcd') === 'ABCD', '小写房间码会转成大写');
  ok(P.normalizeCode(' a b c d ') === 'ABCD', '房间码里的空格会被忽略');
  ok(P.peerIdFor('abcd') === P.PEER_PREFIX + 'ABCD', 'peer id 带前缀且大写');
})();

/* ============================================================
   9. 其他模式也能打完（3 人局 / A3 地主 / 打到末游）
   ============================================================ */
section('9. 3 人局与 A3 地主局');

function playOutFullGame(config, label) {
  var g = setupGame(config);
  var r0 = g.room.startGame();
  if (!r0.ok) { ok(false, label + '：开局失败', r0.reason); return null; }
  g.drain();

  var st = g.room.state;
  var n = 0;
  while (st.phase === 'playing' && n < 6000) {
    n++;
    var seat = st.turn;
    var view = (seat === 0) ? P.makeView(st, 0) : g.views[seat];
    if (!view) { ok(false, label + '：座位 ' + seat + ' 没有视图'); return null; }
    var legal = Game.legalMoves(view);
    var move = legal.length
      ? { action: 'play', cards: legal[0].cards.map(function (c) { return c.id; }) }
      : { action: 'pass' };
    var r = g.room.applyAction(seat, move.action, move.cards);
    if (!r.ok) { ok(false, label + '：第 ' + n + ' 步被拒 ' + r.reason); return null; }
    g.drain();
  }
  ok(st.phase === 'over', label + '：一局打完（' + n + ' 步）');
  ok(!!st.result && st.result.detail.length === config.playerCount,
    label + '：结算明细有 ' + config.playerCount + ' 家');
  return { g: g, state: st };
}

(function () {
  var three = playOutFullGame({ playerCount: 3, landlord: false, nonA3ToLast: false }, '3 人局');
  if (three) {
    // 3 人局：52 张 = 17+17+18，余下那张随机补给某人
    var dealt = three.state.players.map(function (p) { return p.dealt; }).sort().join(',');
    ok(dealt === '17,17,18', '3 人局发牌是 17/17/18（实际 ' + dealt + '）');
    // 三家客户端的视图字段对得上
    var v = three.g.views[1];
    ok(v && v.players.length === 3, '3 人局客户端视图是 3 家');
    ok(v && v.players[1].hand.length === three.state.players[1].hand.length,
      '3 人局客户端看到自己的牌数正确');
  }

  var a3 = playOutFullGame({ playerCount: 4, landlord: true, nonA3ToLast: false }, 'A3 地主局');
  if (a3) {
    ok(!!a3.state.result.landlord, 'A3 局结算里带队伍信息');
    ok(!!a3.state.result.landlord.playerOutcome, 'A3 局结算里每人都有各自的胜负');
    var per = a3.state.result.landlord.playerOutcome;
    ok(Object.keys(per).length === 4, 'A3 局四家都有 outcome');
    var vals = Object.keys(per).map(function (k) { return per[k]; });
    ok(vals.every(function (x) { return x === 'win' || x === 'draw' || x === 'lose'; }),
      'A3 局 outcome 取值合法');
  }

  var last = playOutFullGame({ playerCount: 4, landlord: false, nonA3ToLast: true }, '非 A3 打到末游');
  if (last) {
    ok(last.state.result.ranked === true, '打到末游模式标记了 ranked');
    var outcomes = last.state.result.detail.map(function (d) { return d.outcome; });
    ok(outcomes[0] === 'win', '打到末游：第 1 名胜');
    ok(outcomes[1] === 'draw', '打到末游：第 2 名平');
    ok(outcomes[2] === 'lose' && outcomes[3] === 'lose', '打到末游：第 3/4 名负');
  }
})();

/* ============================================================
   10. 视图字段完整性：界面要用的字段一个都不能少
   （视图是 JSON 过的纯数据，界面直接拿它渲染，缺字段就会白屏）
   ============================================================ */
section('10. 视图字段完整性');

(function () {
  var g = setupGame({ playerCount: 4, landlord: false, nonA3ToLast: false });
  g.room.startGame();
  g.drain();

  // 打到有牌上桌、有人过牌，覆盖面更广
  var st = g.room.state;
  for (var k = 0; k < 6 && st.phase === 'playing'; k++) {
    var seat = st.turn;
    var v = (seat === 0) ? P.makeView(st, 0) : g.views[seat];
    var legal = Game.legalMoves(v);
    var mv = legal.length ? { a: 'play', c: legal[0].cards.map(function (x) { return x.id; }) } : { a: 'pass' };
    g.room.applyAction(seat, mv.a, mv.c);
    g.drain();
  }

  var view = g.views[1];
  ok(!!view, '拿得到客户端的视图');

  // 顶层字段
  ['playerCount', 'players', 'turn', 'round', 'current', 'currentOwner',
    'trick', 'lastTrick', 'isFirstPlay', 'phase', 'revealed', 'myIndex'
  ].forEach(function (f) {
    ok(view[f] !== undefined, '视图里有顶层字段 ' + f);
  });

  // 每个玩家节点的字段（界面渲染座位 / 手牌都靠这些）
  var nodeFields = ['index', 'name', 'hand', 'played', 'lastPlay', 'passed',
    'finished', 'rank', 'penalty', 'announced'];
  var miss = [];
  view.players.forEach(function (p) {
    nodeFields.forEach(function (f) {
      if (p[f] === undefined) miss.push('座位' + p.index + '.' + f);
    });
  });
  ok(miss.length === 0, '每个玩家节点字段齐全', miss.join(', '));

  // 桌面上的牌必须带完整牌面（界面要画点数/花色/颜色）
  if (view.current) {
    var c = view.current.cards[0];
    ok(c.id && c.rank && c.sym !== undefined && c.suitOrder !== undefined && c.value !== undefined,
      '桌面上的牌带完整牌面字段', JSON.stringify(c));
  } else {
    ok(true, '（这一帧桌上没有牌，跳过牌面字段检查）');
  }

  // JSON 往返后不丢东西（视图正是这样过网络的）
  var round = JSON.parse(JSON.stringify(view));
  ok(round.players.length === view.players.length &&
     round.players[1].hand.length === view.players[1].hand.length &&
     JSON.stringify(round.current) === JSON.stringify(view.current),
    '视图 JSON 往返后内容不变');
})();

/* ============================================================
   8. 汇总（放最后：第 5 节是异步的）
   ============================================================ */
function finish() {
  console.log('\n' + '='.repeat(52));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('='.repeat(52));
  process.exit(fail ? 1 : 0);
}
