/* ============================================================
 * endgame.js —— 残局精确搜索
 *
 * 思路：当「场上总牌数」很少时，启发式已经没什么用武之地，
 * 干脆把残局当「有限步的精确博弈」求解：
 *   1) 不完全信息（看不到对手手牌）→ 先用 Determinize.sample()
 *      按公开信息（我的手牌 / 已出过的牌 / 各家剩余张数）采样出若干
 *      「完全信息世界」；
 *   2) 在每个世界里跑精确的 Max^n 极小极大：每个决策者都最大化
 *      「自己的终局名次收益」，到终局（有人出完）或步数上限为止；
 *   3) 把同一动作在各采样世界里拿到的收益取平均，选平均最高的。
 *
 * 终局收益：
 *   · 经典局：头游 = +WIN，其余 = -剩余张数（先保证「能头游就头游」）。
 *   · A3 地主：地主队按两人名次之和判胜负（≤4 胜 / =5 平 / ≥6 负）；
 *     独拿 ♠A♠3 则按个人名次（1 胜 / 2 平 / 3、4 负）。
 *     收益 = 胜 +WIN / 平 0 / 负 -WIN，农民队取反。
 *
 * 关键：只用公开信息采样，不作弊偷看对手手牌。
 * 依赖 cards.js / game.js / determinize.js。
 * ============================================================ */

var Endgame = (function () {
  'use strict';

  var hasReq = (typeof module !== 'undefined' && module.exports);
  var _CD = hasReq ? require('./cards.js') : CD;
  var _G = hasReq ? require('./game.js') : Game;
  var _Det = hasReq ? require('./determinize.js') : Determinize;

  var WIN = 100000;
  // 「必赢」剪枝阈值。A3 下终局收益是 WIN 再减去名次破平项（最多 -4），
  // 所以不能再拿「>= WIN」判断必赢，否则剪枝永不触发、搜索被拖慢。
  var WIN_CUT = WIN - 10;

  function totalCards(state) {
    var n = 0;
    for (var i = 0; i < state.players.length; i++) n += state.players[i].hand.length;
    return n;
  }

  /** 桌上一手牌的可比较指纹（用于状态 key） */
  function playKeyOf(pl) {
    if (!pl) return '-';
    return pl.category + '|' + pl.size + '|' + (pl.value || 0) + '|' + ((pl.main && pl.main.id) || '');
  }

  /** 状态指纹：把所有「会影响后续结果」的量都编进去 */
  function stateKey(state) {
    var parts = [];
    for (var i = 0; i < state.players.length; i++) {
      parts.push(state.players[i].hand.map(function (c) { return c.id; }).sort().join('.'));
    }
    var fin = state.players.map(function (p) { return p.finished ? 1 : 0; }).join('');
    return parts.join('/') + '#' + state.turn + '#' + playKeyOf(state.current) +
      '#' + state.currentOwner + '#' + state.passCount + '#' + (state.isFirstPlay ? 1 : 0) + '#' + fin;
  }

  /** 是否 A3 地主局（决定终局收益口径） */
  function isLandlord(state) {
    return !!(state && state.landlord && state.landlord.enabled !== false);
  }

  /**
   * A3 地主：由名次算地主队胜负。
   *   两人队按名次之和：≤4 胜、=5 平、≥6 负（与界面规则一致）；
   *   独拿 ♠A♠3：第 1 名胜、第 2 名平、第 3/4 名负。
   */
  function landlordOutcome(state) {
    var n = state.players.length;
    var rankOf = state.players.map(function (p) { return p.rank || n; });
    var mem = state.landlord.members;
    var outcome;
    if (state.landlord.solo || mem.length === 1) {
      var r = rankOf[mem[0]];
      outcome = (r === 1) ? 'win' : (r === 2 ? 'draw' : 'lose');
    } else {
      var s = rankOf[mem[0]] + rankOf[mem[1]];
      outcome = (s <= 4) ? 'win' : (s === 5 ? 'draw' : 'lose');
    }
    return { outcome: outcome, rankOf: rankOf };
  }

  /**
   * 终局收益向量。
   *   经典局：头游 +WIN，其余 -剩余张数（先保证能头游就头游）；
   *   A3 地主：地主队 胜 +WIN / 平 0 / 负 -WIN，农民队取反，
   *            再按「名次越靠前越好」做小幅破平。
   */
  function terminalVec(state) {
    if (isLandlord(state)) {
      var t = landlordOutcome(state);
      var lv = t.outcome === 'win' ? WIN : (t.outcome === 'draw' ? 0 : -WIN);
      return state.players.map(function (p) {
        var isL = state.landlord.members.indexOf(p.index) >= 0;
        var base = isL ? lv : -lv;
        return base - t.rankOf[p.index];       // 破平：名次越小（越靠前）越好
      });
    }
    var w = -1;
    for (var i = 0; i < state.players.length; i++) {
      if (state.players[i].hand.length === 0) { w = i; break; }
    }
    return state.players.map(function (p) {
      return p.index === w ? WIN : -p.hand.length;
    });
  }

  /** 搜索被节点上限截断时的粗略估值：牌越少越好；A3 下让同队略倾向帮队友走完 */
  function heuristicVec(state) {
    if (isLandlord(state) && !state.landlord.solo) {
      var mem = state.landlord.members, ally = {};
      ally[mem[0]] = mem[1]; ally[mem[1]] = mem[0];
      return state.players.map(function (p) {
        var v = -p.hand.length, a = ally[p.index];
        if (a !== undefined) v += -0.5 * state.players[a].hand.length;
        return v;
      });
    }
    return state.players.map(function (p) { return -p.hand.length; });
  }

  /** 当前决策者的全部动作（合法出牌 + 有桌上牌时可过牌） */
  function movesOf(state) {
    var plays = _G.legalMoves(state);
    var out = plays.map(function (p) {
      return {
        cards: p.cards, play: p, pass: false,
        key: 'P:' + p.cards.map(function (c) { return c.id; }).sort().join(',')
      };
    });
    if (state.current !== null) out.push({ pass: true, cards: null, play: null, key: 'pass' });
    return out;
  }

  /** 生成「下了这手之后」的新状态（克隆 + 落子；不改动入参） */
  function childState(state, mv) {
    var s = _Det.cloneState(state);
    if (mv.pass) _G.pass(s, s.turn);
    else _G.play(s, s.turn, mv.cards);
    return s;
  }

  /** 动作排序：能一把走完的先试（触发早剪枝），其次出牌张数多的优先 */
  function orderMoves(state, ms) {
    var L = state.players[state.turn].hand.length;
    ms.sort(function (a, b) {
      var wa = (!a.pass && a.cards.length === L) ? 0 : 1;
      var wb = (!b.pass && b.cards.length === L) ? 0 : 1;
      if (wa !== wb) return wa - wb;
      var sa = a.pass ? 0 : a.cards.length;
      var sb = b.pass ? 0 : b.cards.length;
      return sb - sa;
    });
    return ms;
  }

  /**
   * Max^n 精确搜索：返回从当前局面出发（各方都最优）的终局收益向量。
   *   · 每个节点由 state.turn 决策，选「让自己收益最大」的动作
   *   · 带记忆化（同一状态只算一次）与访问上限（超限退回启发式估值）
   */
  function full(state, ctx) {
    if (state.phase === 'over') return terminalVec(state);
    if (ctx.nodes >= ctx.cap) return heuristicVec(state);
    ctx.nodes++;

    var key = stateKey(state);
    var hit = ctx.memo.get(key);
    if (hit) return hit;

    var ms = orderMoves(state, movesOf(state));
    if (!ms.length) {
      var v0 = heuristicVec(state);
      ctx.memo.set(key, v0);
      return v0;
    }

    var mover = state.turn, best = null, bestV = -Infinity;
    for (var i = 0; i < ms.length; i++) {
      var child = childState(state, ms[i]);
      var v = (child.phase === 'over') ? terminalVec(child) : full(child, ctx);
      if (v[mover] > bestV) { bestV = v[mover]; best = v; }
      if (bestV >= WIN_CUT) break;             // 该决策者已能必赢，无需再看别的
    }
    ctx.memo.set(key, best);
    return best;
  }

  /** 残局条件：总牌数 ≤ maxCards（默认只对 4 人局启用） */
  function applicable(state, options) {
    options = options || {};
    if (!state || state.phase !== 'playing') return false;
    if (state.players.length !== 4 && !options.allowAnyCount) return false;
    var maxCards = options.maxCards !== undefined ? options.maxCards : 10;
    return totalCards(state) <= maxCards;
  }

  function toDecision(mv) {
    return mv.pass ? { action: 'pass', cards: null } : { action: 'play', cards: mv.cards };
  }

  /**
   * 残局求解：为 self（必须是当前出牌者）返回最优动作。
   * options: { maxCards, samples, maxNodes, rng }
   * 不满足残局条件 / 无解 → 返回 null（调用方回退启发式）。
   */
  function solve(state, self, options) {
    options = options || {};
    if (!applicable(state, options)) return null;
    if (state.turn !== self) return null;

    var rootMoves = orderMoves(state, movesOf(state));
    if (!rootMoves.length) return null;
    if (rootMoves.length === 1) return toDecision(rootMoves[0]);

    var samples = options.samples || 16;
    var rng = options.rng || Math.random;
    var cap = options.maxNodes || 30000;

    var sum = {}, cnt = {}, order = [];

    for (var s = 0; s < samples; s++) {
      // 第一个样本用真实局面（信息完美）保证方向不偏，其余按公开信息采样
      var world = (s === 0 && options.firstExact !== false)
        ? state : _Det.sample(state, self, rng);

      var ctx = { nodes: 0, cap: cap, memo: new Map() };
      var bestKey = null, bestV = -Infinity;
      for (var i = 0; i < rootMoves.length; i++) {
        var child = childState(world, rootMoves[i]);
        var v = (child.phase === 'over') ? terminalVec(child) : full(child, ctx);
        var val = v[self];
        if (val > bestV) { bestV = val; bestKey = rootMoves[i].key; }
        if (bestV >= WIN_CUT) break;
      }
      if (bestKey !== null) {
        if (sum[bestKey] === undefined) { sum[bestKey] = 0; cnt[bestKey] = 0; order.push(bestKey); }
        sum[bestKey] += bestV;
        cnt[bestKey]++;
      }
    }

    // 选平均收益最高的动作；平手取被采样更认可的
    var best = null, bestAvg = -Infinity, bestN = -1;
    for (var k = 0; k < order.length; k++) {
      var kk = order[k];
      var avg = sum[kk] / cnt[kk];
      if (avg > bestAvg || (avg === bestAvg && cnt[kk] > bestN)) {
        bestAvg = avg; bestN = cnt[kk]; best = kk;
      }
    }
    if (best === null) return null;

    for (var j = 0; j < rootMoves.length; j++) {
      if (rootMoves[j].key === best) return toDecision(rootMoves[j]);
    }
    return null;
  }

  var api = {
    solve: solve, applicable: applicable, totalCards: totalCards,
    terminalVec: terminalVec, movesOf: movesOf, childState: childState,
    stateKey: stateKey, WIN: WIN,
    isLandlord: isLandlord, landlordOutcome: landlordOutcome, heuristicVec: heuristicVec
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
