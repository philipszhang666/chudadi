/* ============================================================
 * scripts/repro-surrender.js —— 投降逻辑回归
 *
 *   node scripts/repro-surrender.js
 *
 * 覆盖：
 *   1) 经典 4 人单机：投降 → 立刻结束，投降者第 4 名、判负；
 *   2) 非 A3「打到末游」单机：同上；
 *   3) 联机（多个真人）：一人投降后仍继续，等真人都打完才收；
 *   4) 多人多次投降：按投降顺序占 4、3、2… 名次；
 *   5) A3 地主随机整局：投降者始终垫底、名次是 1..n 排列、
 *      地主队胜负与「名次和」口径一致。
 * ============================================================ */
'use strict';

var path = require('path');
var ROOT = path.join(__dirname, '..');
var Game = require(path.join(ROOT, 'js/game.js'));

var passes = 0, fails = 0;
function ok(cond, msg) {
  if (cond) { passes++; }
  else { fails++; console.log('  \u2717 ' + msg); }
}

function perm1toN(state) {
  var r = state.players.map(function (p) { return p.rank; }).slice().sort(function (a, b) { return a - b; });
  for (var i = 0; i < r.length; i++) if (r[i] !== i + 1) return false;
  return true;
}

/* --- 1. 经典 4 人单机 --- */
(function () {
  var s = Game.newGame({ playerCount: 4 });
  var handLen = s.players[0].hand.length;
  var r = Game.surrender(s, 0);
  ok(r.ok, '经典单机：投降返回 ok');
  ok(s.phase === 'over', '经典单机：投降立刻结束');
  ok(s.players[0].rank === 4, '经典单机：投降者第 4 名（实际 ' + s.players[0].rank + '）');
  ok(s.players[0].finished === true, '经典单机：标记已出局');
  ok(s.players[0].hand.length === 0, '经典单机：手牌清空');
  ok(s.players[0].surrCards.length === handLen, '经典单机：留了退场时的手牌');
  ok(s.result && s.result.detail.length === 4, '经典单机：结算含 4 人');
  var d0 = s.result.detail.filter(function (d) { return d.index === 0; })[0];
  ok(d0 && d0.outcome === 'lose', '经典单机：投降者判负');
  ok(perm1toN(s), '经典单机：名次是 1..4 的排列');
  ok(s.result.detail[3].index === 0, '经典单机：投降者排在最后');
})();

/* --- 2. 非 A3 打到末游 单机 --- */
(function () {
  var s = Game.newGame({ playerCount: 4, nonA3ToLast: true });
  Game.surrender(s, 0);
  ok(s.phase === 'over', '末游单机：投降立刻结束');
  ok(s.players[0].rank === 4, '末游单机：投降者第 4 名');
  ok(s.result.ranked === true, '末游单机：结算标记 ranked');
  ok(s.result.humanOutcome === 'lose', '末游单机：投降者判负');
})();

/* --- 3. 经典联机（2 真人）--- */
(function () {
  var s = Game.newGame({ playerCount: 4 });
  s.players[0].isHuman = true;
  s.players[1].isHuman = true;
  Game.surrender(s, 0);
  ok(s.phase === 'playing', '联机经典：还有真人没打完 → 继续');
  ok(s.players[0].rank === 4, '联机经典：投降者第 4 名');
  Game.surrender(s, 1);
  ok(s.phase === 'over', '联机经典：真人都投降 → 收场');
})();

/* --- 4. 多人多次投降：4、3、2 --- */
(function () {
  var s = Game.newGame({ playerCount: 4, nonA3ToLast: true });
  s.players.forEach(function (p) { p.isHuman = true; });
  Game.surrender(s, 0);
  Game.surrender(s, 1);
  ok(s.phase === 'playing' || s.phase === 'over', '多人多次：动作都能落地');
  Game.surrender(s, 2);
  ok(s.phase === 'over', '多人多次：投降 3 家只剩 1 家 → 收场');
  ok(s.players[0].rank === 4, '多人多次：先投的第 4');
  ok(s.players[1].rank === 3, '多人多次：次投的第 3');
  ok(s.players[2].rank === 2, '多人多次：第三投的第 2');
  ok(s.players[3].rank === 1, '多人多次：剩下那家第 1');
  ok(perm1toN(s), '多人多次：名次 1..4 排列');
})();

/* --- 5. A3 地主随机整局：投降者垫底 + 队伍口径一致 --- */
(function () {
  function randomMove(st) {
    var moves = Game.legalMoves(st);
    if (st.current === null) {
      if (!moves.length) return null;
      return { action: 'play', cards: picks(moves) };
    }
    if (moves.length && Math.random() < 0.5) return { action: 'play', cards: picks(moves) };
    return { action: 'pass' };
  }
  function picks(moves) {
    var m = moves[Math.floor(Math.random() * moves.length)];
    return m.cards.map(function (c) { return c.id; });
  }

  var rounds = 300, overCnt = 0, rankBad = 0, teamBad = 0, stuckBad = 0;
  for (var t = 0; t < rounds; t++) {
    var s = Game.newGame({ playerCount: 4, landlord: true });
    var members = s.landlord.members.slice();
    var who = members[Math.floor(Math.random() * members.length)];
    Game.surrender(s, who);

    var guard = 0;
    while (s.phase === 'playing' && guard < 6000) {
      var seat = s.turn;
      var mv = randomMove(s);
      var r;
      if (!mv) { r = { ok: false }; }
      else if (mv.action === 'play') r = Game.play(s, seat, mv.cards);
      else r = Game.pass(s, seat);
      if (!r.ok) {
        if (s.current === null) r = Game.play(s, seat, [s.players[seat].hand[0].id]);
        else r = Game.pass(s, seat);
        if (!r.ok) break;
      }
      guard++;
    }

    if (s.phase !== 'over') { stuckBad++; continue; }
    overCnt++;
    if (s.players[who].rank !== 4) rankBad++;
    if (!perm1toN(s)) rankBad++;

    var exp;
    if (s.landlord.solo) {
      var rr = s.players[s.landlord.members[0]].rank;
      exp = rr === 1 ? 'win' : (rr === 2 ? 'draw' : 'lose');
    } else {
      var sum = s.landlord.members.reduce(function (a, i) { return a + s.players[i].rank; }, 0);
      exp = sum <= 4 ? 'win' : (sum === 5 ? 'draw' : 'lose');
    }
    if (s.result.landlord.landlordOutcome !== exp) teamBad++;
  }
  ok(stuckBad === 0, 'A3：每局都能正常收场（卡死 ' + stuckBad + ' 局）');
  ok(rankBad === 0, 'A3：' + overCnt + ' 局中投降者始终垫底且名次是 1..4 排列（bad=' + rankBad + '）');
  ok(teamBad === 0, 'A3：' + overCnt + ' 局地主队胜负与名次和口径一致（bad=' + teamBad + '）');
})();

console.log('\n通过 ' + passes + ' 项，失败 ' + fails + ' 项');
if (fails) process.exit(1);
