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
var CD = require(path.join(DIR, 'cards.js'));
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

/* ---------------- 异步结束屏障 ----------------
   第 5 节和第 11 节都是异步的（房主的 AI 用 setTimeout 分片，得等它跑）。
   这里踩过一个很坑的错：finish() 谁先到谁就 process.exit，于是【先结束的
   那一节会把另一节还没跑的断言直接丢掉】——总数在 108/113 之间飘，
   而失败数一直是 0，看上去「全过」。

   现在每节开工前 asyncPending++，干完 asyncPending--，只有归零才汇总。 */
var asyncPending = 0;
function asyncStart() { asyncPending++; }
function asyncDone() { asyncPending--; if (asyncPending <= 0) finish(); }

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

/* ---------------- 搭一桌 ----------------
   房主（seat 0）持权威 state，其余座位是客户端。
   config.humans 指定「实际有多少个真人」：
     · 人不够时剩下的座位【没有 roster 记录】—— 这正是「电脑补位」的前提，
       也是线上出事故的那条路径（2 个真人玩 3 人局时，座位 2 是空的）。
     · 不传就默认坐满。 */
function setupGame(config) {
  var net = makeFakeNet();
  var views = {};          // seat -> 最新视图
  var hostRoom = null;
  var rejections = {};     // seat -> [拒绝原因]
  var humans = (config.humans === undefined) ? config.playerCount : config.humans;

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

  // 只有前 humans 个座位有真人；其余的座位留空（= 交给电脑）
  var conns = {};
  for (var s2 = 1; s2 < humans; s2++) {
    net.attach(s2, { __seat: s2 });
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
  var leader = st.turn;                       // 持 ♦4 的人先出（座位随机！）
  var snapshot = function () {
    return JSON.stringify(st.players.map(function (p) {
      return p.hand.map(function (c) { return c.id; });
    }));
  };
  var before = snapshot();

  /** 找一张「确定不在某家手里」的牌。
      不能写死 '3S' —— 它可能正好就发在那个人手上，
      那这条就不是「出别人的牌」而是合法出牌了，断言会变得没意义。 */
  function cardNotIn(hand) {
    var have = {};
    hand.forEach(function (c) { have[c.id] = 1; });
    for (var i = 0; i < CD.ALL_CARDS.length; i++) {
      if (!have[CD.ALL_CARDS[i].id]) return CD.ALL_CARDS[i].id;
    }
    return null;
  }

  /* 这一节踩过三个坑，注释留着免得再犯：

     坑1：持 ♦4 的人坐哪是随机的。原来写成 if (leader === 0) 分两条路测，
          每次只跑一半断言，总数在 99/101 之间跳。现在两条入口都无条件跑。

     坑2：同一局里连发几个非法动作，拒绝记录是累积的 —— 一条断言只看
          「数组长度 === 1」，就会被前面那条操作产生的拒绝顶掉而随机失败。

     坑3（坑2 的变体）：房主入口的拒绝也可能落到座位 1（当轮到座位 1 出牌时
          就是「还没轮到你」）。所以「谁收到过拒绝」不能作为断言依据，
          只能看「这次操作有没有让那个人的拒绝数 +1」。

     另外：座位 0 是房主（UI 走 room.applyAction），座位 1~3 是客户端
     （UI 走 net.send → room.onData）。所以「客户端入口」必须在 1~3 里挑。 */
  function rejectDelta(fn, seat) {
    var b = (g.rejections[seat] || []).length;
    fn();
    g.drain();
    return (g.rejections[seat] || []).length - b;
  }

  // (a) 客户端入口：非当前出牌者发动作 —— 必须被拒，牌局不许变
  var notLeader = (leader + 1) % 4;
  if (notLeader === 0) {
    // 用「房主入口」覆盖同一个语义：房主现在不是该出牌的人
    var ra = g.room.applyAction(0, 'play', [st.players[0].hand[0].id]);
    ok(!ra.ok, '非当前出牌者（房主）的动作被拒', ra.reason);
  } else {
    var dA = rejectDelta(function () {
      g.room.onData({ type: P.C2H.ACTION, action: 'play', cards: [st.players[notLeader].hand[0].id] }, g.conns[notLeader]);
    }, notLeader);
    ok(dA === 1, '非当前出牌者收到了拒绝', 'delta=' + dA + ' ' + JSON.stringify(g.rejections[notLeader]));
  }
  ok(before === snapshot(), '非当前出牌者的动作没有改坏牌局');

  // (b) 房主入口：房主出一张「不在自己手里的牌」—— 必须被拒
  var hostWrong = g.room.applyAction(0, 'play', [cardNotIn(st.players[0].hand)]);
  ok(!hostWrong.ok, '房主自己出不在手里的牌也被拒', hostWrong.reason);
  ok(before === snapshot(), '房主非法出牌没有改坏牌局');

  // (c) 客户端入口：出一张确定不在自己手里的牌
  //     发送者固定在 1 号（客户端），理由见上：0 号是房主，不走这条入口
  var dB = rejectDelta(function () {
    g.room.onData({ type: P.C2H.ACTION, action: 'play', cards: [cardNotIn(st.players[1].hand)] }, g.conns[1]);
  }, 1);
  ok(dB === 1, '客户端出不在手里的牌被拒', 'delta=' + dB + ' ' + JSON.stringify(g.rejections[1]));
  ok(before === snapshot(), '客户端出不在手里的牌没有改坏牌局');

  // (d) 第一手不带 ♦4 —— 由真正持 ♦4 的那位来发，两个入口都覆盖
  if (leader !== 0) {
    var hand = st.players[leader].hand.filter(function (c) { return c.id !== '4D'; });
    var dD = rejectDelta(function () {
      g.room.onData({ type: P.C2H.ACTION, action: 'play', cards: [hand[hand.length - 1].id] }, g.conns[leader]);
    }, leader);
    ok(dD === 1, '首手不带 ♦4 被拒（客户端入口）',
      'delta=' + dD + ' ' + JSON.stringify(g.rejections[leader]));
  } else {
    var noFour = st.players[0].hand.filter(function (c) { return c.id !== '4D'; });
    var r4 = g.room.applyAction(0, 'play', [noFour[noFour.length - 1].id]);
    ok(!r4.ok, '首手不带 ♦4 被拒（房主入口）', r4.reason);
  }
  ok(before === snapshot(), '首手不带 ♦4 没有改坏牌局');

  ok(st.players[leader].hand.some(function (c) { return c.id === '4D'; }),
    '先出的人确实持 ♦4（前面几条拒绝理由才成立）');
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

/**
 * 把一局打完：轮到真人就帮他走，轮到电脑位就等房主的 pump 自己推进。
 * 返回 Promise，结束时把最终 state 交出来。
 * 第 5 节（掉线代打）和第 11 节（空位补位）都用它。
 */
function playOutMixed(room, views) {
  return new Promise(function (resolve) {
    var st = room.state;
    if (!st) return resolve(null);
    var spin = 0;
    function isHumanSeat(seat) {
      return room.roster.some(function (r) { return r.seat === seat; });
    }
    function tick() {
      if (st.phase === 'over') return resolve(st);
      if (spin++ > 3000) return resolve(st);          // 超时也返回，交给断言去说明失败
      var s = st.turn;
      if (isHumanSeat(s)) {
        var legal = Game.legalMoves(P.makeView(st, s));
        var res = legal.length
          ? room.applyAction(s, 'play', legal[0].cards.map(function (c) { return c.id; }))
          : room.applyAction(s, 'pass');
        if (!res.ok) return resolve(st);
      }
      setTimeout(tick, 3);          // 轮到电脑位时什么都不做，等 pump
    }
    tick();
  });
}

/* ============================================================
   5. 掉线代打（异步：pump 用 setTimeout 分片，得等它跑）
   ============================================================ */
section('5. 有人掉线时房主接手，牌局不会卡死');

(async function () {
  asyncStart();
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

  // 之后轮到 AI，pump 是异步的（setTimeout 分片），等它跑完。
  // 用 playOutMixed 走完整局，而不是只等一下看有没有动 —— 只等 1.5 秒
  // 会时快时慢地误判，真正的判据是「这一局能不能打完」。
  playOutMixed(g.room, g.views).then(function (final) {
    ok(final.phase === 'over', '掉线座位由房主代打，整局能打完（phase=' + final.phase + '）');
    ok(g.room.phase === 'over' || final.phase === 'playing', '房间阶段与实际牌局一致');
    asyncDone();
  });
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

  /* 下面这条原本写的是「400 次里不重复的要 > 380」——那是个概率断言，
     会随运行抖动（实际跑到过 99/101 两次数不同）。改成确定性的均匀性检查：
     31 个字符在每一位上都该出现，而且频次不能离谱。 */
  var N = 31000;                      // 每个字符平均出现 1000 次
  var perPos = [{}, {}, {}, {}];
  for (var k = 0; k < N; k++) {
    var s = P.makeCode();
    for (var pi = 0; pi < 4; pi++) perPos[pi][s[pi]] = (perPos[pi][s[pi]] || 0) + 1;
  }
  var alphabet = P.CODE_ALPHABET;
  var uniformProblems = [];
  perPos.forEach(function (counts, pi) {
    var seen = Object.keys(counts).length;
    if (seen !== alphabet.length) uniformProblems.push('第 ' + pi + ' 位只出现了 ' + seen + ' 种字符');
    Object.keys(counts).forEach(function (ch) {
      var c = counts[ch];
      // 期望 1000 次，允许 0.5x~1.8x 的波动（正态下这是极宽松的界）
      if (c < 500 || c > 1800) uniformProblems.push('第 ' + pi + ' 位字符 ' + ch + ' 出现 ' + c + ' 次');
    });
  });
  ok(uniformProblems.length === 0,
    N + ' 次采样：4 位字符分布均匀（每位 ' + alphabet.length + ' 种字符都出现且频次正常）',
    uniformProblems.slice(0, 3).join('; '));

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
   11. 空座位由电脑补位 + 真人座位绝不能被电脑顶掉
   ============================================================
   线上出过的事故：2 个真人玩 3/4 人局，轮到没人坐的座位时房主死活
   不出牌，牌局卡住。根因是 nextBotSeat() 里
       var r = roster.filter(seat === t)[0];
       if (!r) return -1;          // 空座位 → 被当成「轮到人类了」
   roster 里只有真人，空座位根本没有记录，于是从没被当作电脑位。

   修的时候又踩了第二个坑（这个测试就是为此加的）：
       onlineHuman = r.online && !r.isHost;
   这一下把【房主自己】判成了电脑 —— 真人还没点，牌就被 AI 打出去了，
   而且房主那一手等于被代替。房主当然也在名单里且 online，
   所以判据只能是 r.online，不能再加 !r.isHost。 */
section('11. 空座位补位 + 真人座位不被电脑顶掉');

(async function () {
  asyncStart();
  var g = setupGame({ playerCount: 3, landlord: false, nonA3ToLast: false, humans: 2 });
  ok(g.room.roster.length === 2, 'A. 只坐了 2 个人（座位 0、1）',
    JSON.stringify(g.room.roster.map(function (r) { return r.seat; })));

  var r = g.room.startGame();
  ok(r.ok, 'A. 人不够也能开局（空位交给电脑）', r.reason);

  var st = g.room.state;
  var botSeats = [];
  st.players.forEach(function (p) {
    var rec = g.room.roster.filter(function (x) { return x.seat === p.index; })[0];
    if (!rec || !rec.online) botSeats.push(p.index);
  });
  ok(botSeats.length === st.players.length - 2,
    'A. 有 ' + (st.players.length - 2) + ' 个座位该由电脑代打（实际 ' + JSON.stringify(botSeats) + '）');

  g.drain();

  // 先走到「轮到电脑位」的那一刻，记录 moveCount
  var guard = 0;
  while (guard++ < 300 && st.phase === 'playing') {
    var s = st.turn;
    if (botSeats.indexOf(s) >= 0) break;
    var legal = Game.legalMoves(P.makeView(st, s));
    var res = legal.length
      ? g.room.applyAction(s, 'play', legal[0].cards.map(function (c) { return c.id; }))
      : g.room.applyAction(s, 'pass');
    g.drain();
    if (!res.ok) break;
  }
  var atBotTurn = botSeats.indexOf(st.turn) >= 0 && st.phase === 'playing';
  ok(atBotTurn, 'A. 牌局走到了「轮到空座位」的时刻（座位 ' + st.turn + '）');

  var moveBefore = st.moveCount;
  setTimeout(function () {
    ok(st.moveCount > moveBefore,
      'A. 房主替空座位自动出牌了（moveCount ' + moveBefore + ' → ' + st.moveCount + '）');

    playOutMixed(g.room, g.views).then(function (final) {
      ok(final.phase === 'over', 'A. 整局打完，没有卡死');
      ok(final.result && final.result.detail.length === 3, 'A. 三家都进了结算');

      /* ---- B. 满员局：真人座位（尤其是房主）绝不能被 AI 顶掉 ---- */
      var g2 = setupGame({ playerCount: 4, landlord: false, nonA3ToLast: false });
      ok(g2.room.roster.length === 4, 'B. 4 个座位都有人');
      g2.room.startGame();
      var st2 = g2.room.state;
      ok(st2.players.length === 4, 'B. 满员局没有电脑位');
      g2.drain();

      // 一直推进到「轮到房主」为止（房主是座位 0）
      var g3 = 0;
      while (g3++ < 300 && st2.phase === 'playing' && st2.turn !== 0) {
        var s2 = st2.turn;
        var legal2 = Game.legalMoves(P.makeView(st2, s2));
        var res2 = legal2.length
          ? g2.room.applyAction(s2, 'play', legal2[0].cards.map(function (c) { return c.id; }))
          : g2.room.applyAction(s2, 'pass');
        g2.drain();
        if (!res2.ok) break;
      }
      ok(st2.phase === 'over' || st2.turn === 0, 'B. 推进到了房主的回合');

      if (st2.phase === 'playing' && st2.turn === 0) {
        var hostHand = st2.players[0].hand.map(function (c) { return c.id; }).join(',');
        var mc = st2.moveCount;
        // 放着不管一段时间：房主不点，pump 就绝不能动
        setTimeout(function () {
          var hostHand2 = st2.players[0].hand.map(function (c) { return c.id; }).join(',');
          ok(hostHand === hostHand2,
            'B. 房主没点出牌，牌没有被 AI 顶掉（手牌 ' +
            st2.players[0].hand.length + ' 张未变）',
            'before=' + hostHand + ' after=' + hostHand2);
          ok(st2.moveCount === mc,
            'B. 轮到房主时 pump 不动（moveCount 保持 ' + mc + '）');
          ok(st2.turn === 0, 'B. 仍然是房主的回合，等他自己出牌');

          // 最后确认满员局也能整局打完
          playOutMixed(g2.room, g2.views).then(function (final2) {
            ok(final2.phase === 'over', 'B. 满员局整局打完');
            asyncDone();
          });
        }, 700);
      } else {
        ok(true, 'B. （这一局在轮到房主前就结束了，跳过）');
        asyncDone();
      }
    });
  }, 900);
})();

/* ============================================================
   12. 权限：只有房主能改设置、能开局
   ============================================================
   界面上靠隐藏开关（applyRoleVisibility）让客户端看不到，
   但界面是「提示」，真正的边界必须在服务端。
   这里从协议层直接打这两个动作，确认房主会拒。 */
section('12. 权限：只有房主能改设置 / 开局');

(function () {
  var g = setupGame({ playerCount: 4, landlord: false, nonA3ToLast: false, humans: 4 });

  // ---- 改设置 ----
  var before = JSON.stringify(g.room.config);
  ok(before.indexOf('"playerCount":4') >= 0, '初始配置是 4 人局', before);

  // 直接伪造一条「客户端改设置」的消息（绕过界面）
  g.room.onData({ type: P.C2H.LOBBY_SET, config: { playerCount: 3, landlord: true } }, g.conns[1]);
  var after = JSON.stringify(g.room.config);
  ok(after === before, '客户端发的改设置被忽略，配置没变', after);

  // 房主自己改才生效
  g.room.setConfig({ playerCount: 3 });
  ok(g.room.config.playerCount === 3, '房主改设置生效（playerCount → 3）');

  // ---- 开局的入口校验 ----
  // startGame 只在房主那一端有意义：客户端根本不持有权威 state，
  // 客户端上的 room.isHost 为 false，所以同名的调用会被第一步挡掉。
  // 这里能测的是房主侧的前置条件。
  var notEnough = setupGame({ playerCount: 4, landlord: false, nonA3ToLast: false, humans: 1 });
  var r0 = notEnough.room.startGame();
  ok(!r0.ok, '只有房主一个人时开不了局', r0.reason);

  var okRoom = setupGame({ playerCount: 4, landlord: false, nonA3ToLast: false, humans: 2 });
  var r1 = okRoom.room.startGame();
  ok(r1.ok, '有 2 个人就能开局', r1.reason);

  var r2 = okRoom.room.startGame();
  ok(!r2.ok, '一局还没结束时不能再开一局', r2.reason);
})();

/* ============================================================
   汇总（放最后：第 5 节和第 11 节都是异步的）
   ============================================================ */
function finish() {
  console.log('\n' + '='.repeat(52));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('='.repeat(52));
  process.exit(fail ? 1 : 0);
}
