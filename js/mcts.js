/* ============================================================
 * mcts.js —— ISMCTS（信息集蒙特卡洛树搜索）
 *
 * 思路：不完全信息 + 4 人，用「采样 + 搜索」逼近：
 *   每轮迭代先 Determinize.sample() 出一个补全世界，
 *   再在这棵「信息集树」上按 UCT 走一遍（树跨采样共享，这就是 ISMCTS
 *   相对 PIMC 的优势——不同采样汇入同一节点，统计更稳），
 *   到没展开的节点就从这里用启发式策略 rollout 到底。
 *
 * 多人（非零和）处理：每个节点属于「该走的人」，节点只累计
 * 「该走的人」的收益（Max^n 风格），即人人最大化自己的收益。
 *
 * 终局收益：payoff[p] = -p 剩余手牌数（赢家为 0，是最大值）。
 *   这样「尽快走完」和「拦住对手（否则自己剩很多牌）」都被自动激励。
 *
 * 纯搜索，不需要神经网络；rollout 策略由外部注入（一般是 ai.js 的启发式）。
 * 依赖 cards.js / game.js / determinize.js。
 * ============================================================ */

var MCTS = (function () {
  'use strict';

  var hasReq = (typeof module !== 'undefined' && module.exports);
  var _CD = hasReq ? require('./cards.js') : CD;
  var _G = hasReq ? require('./game.js') : Game;
  var _Det = hasReq ? require('./determinize.js') : Determinize;
  // A3 地主：搜索的终局收益复用 endgame.js 的口径（按队伍名次判胜负），
  // 免得搜索在 A3 里只顾「自己跑光」。endgame.js 在 index.html 里先于本文件加载。
  var _End = hasReq ? require('./endgame.js') : (typeof Endgame !== 'undefined' ? Endgame : null);

  function Node(player) {
    this.player = player;      // 该节点的决策者
    this.N = {};               // action key -> 访问次数
    this.W = {};               // action key -> 该决策者收益累计
    this.children = {};        // action key -> Node
  }

  function playKey(cards) {
    return 'P:' + cards.map(function (c) { return c.id; }).sort().join(',');
  }

  /** 当前局面的全部合法动作（含「过牌」，当桌上有牌时） */
  function enumerateMoves(state, opts) {
    var plays = _G.legalMoves(state);
    var moves = [];
    for (var i = 0; i < plays.length; i++) {
      moves.push({ key: playKey(plays[i].cards), cards: plays[i].cards, play: plays[i], pass: false });
    }
    if (state.current !== null) moves.push({ key: 'pass', cards: null, play: null, pass: true });

    if (opts && opts.priorFn) {
      var priors = opts.priorFn(state, moves);
      if (priors) {
        for (var j = 0; j < moves.length; j++) moves[j].prior = priors[j] || 0;
      }
    }
    return moves;
  }

  function applyMove(state, mv) {
    return mv.pass ? _G.pass(state, state.turn) : _G.play(state, state.turn, mv.cards);
  }

  // A3 搜索用量纲：队伍胜负权重。压到和「剩余张数」同级别，
  // 既让「队伍胜负」主导，又不把 UCT 探索项（~牌数量纲）压没。
  var TEAM_W = 50;

  /** 终局（或截断）收益向量。
   *  经典局：-剩余手牌数（越大越好）。
   *  A3 地主：复用 endgame.js 的规则——终局按地主队名次判胜负（胜/平/负，
   *  再用剩牌数破平），中途截断用 heuristicVec（牌越少越好，且同队互相帮衬）。
   *  这样搜索的目标函数和硬 A3 残局一致，不会只顾自己跑牌。 */
  function payoff(state) {
    var E = hasReq ? _End : (typeof Endgame !== 'undefined' ? Endgame : null);
    if (E && E.isLandlord(state)) {
      if (state.phase !== 'over') return E.heuristicVec(state);
      var t = E.landlordOutcome(state);
      var s = t.outcome === 'win' ? 1 : (t.outcome === 'draw' ? 0 : -1);
      return state.players.map(function (p) {
        var isL = state.landlord.members.indexOf(p.index) >= 0;
        var base = (isL ? s : -s) * TEAM_W;
        return base - p.hand.length;   // 同队内越早走完（剩牌越少）越好
      });
    }
    var arr = [];
    for (var i = 0; i < state.players.length; i++) arr.push(-state.players[i].hand.length);
    return arr;
  }

  /** 从当前世界用 rollout 策略打到终局（或步数上限），返回收益向量 */
  function rollout(state, opts) {
    var guard = 0, maxSteps = opts.maxRolloutSteps;
    while (state.phase !== 'over' && guard < maxSteps) {
      guard++;
      var d = opts.rolloutPolicy(state, state.turn);
      var r;
      if (d && d.action === 'play' && d.cards && d.cards.length) r = _G.play(state, state.turn, d.cards);
      else r = _G.pass(state, state.turn);
      if (!r || !r.ok) {
        if (state.current === null) {
          var h = _CD.sortAsc(state.players[state.turn].hand);
          _G.play(state, state.turn, [h[0]]);
        } else {
          _G.pass(state, state.turn);
        }
      }
    }
    return payoff(state);
  }

  /** 选择动作：未展开优先（按先验/随机）；已展开按 PUCT / UCT */
  function chooseMove(node, moves, opts, rng) {
    var i, m, total = 0;
    for (i = 0; i < moves.length; i++) total += (node.N[moves[i].key] || 0);

    var unexpanded = null;
    for (i = 0; i < moves.length; i++) {
      if (node.N[moves[i].key] === undefined) { (unexpanded || (unexpanded = [])).push(moves[i]); }
    }
    if (unexpanded) {
      if (opts.priorFn) {
        var bestP = unexpanded[0];
        for (i = 1; i < unexpanded.length; i++) {
          if ((unexpanded[i].prior || 0) > (bestP.prior || 0)) bestP = unexpanded[i];
        }
        return bestP;
      }
      return unexpanded[Math.floor(rng() * unexpanded.length)];
    }

    // 已展开的动作一律用 UCT（探索项按"牌数"量纲缩放）。
    // 先验只决定"未展开"动作的尝试顺序，避免把探索项压没。
    var best = null, bestU = -Infinity;
    for (i = 0; i < moves.length; i++) {
      m = moves[i];
      var n = node.N[m.key];
      var q = node.W[m.key] / n;
      var u = q + opts.c * Math.sqrt(Math.log(total + 1) / n);
      if (u > bestU) { bestU = u; best = m; }
    }
    return best;
  }

  function simulate(node, world, opts, rng, depth) {
    if (world.phase === 'over' || depth >= opts.maxDepth) return payoff(world);
    var moves = enumerateMoves(world, opts);
    if (!moves.length) return payoff(world);

    var mover = world.turn;
    var chosen = chooseMove(node, moves, opts, rng);
    applyMove(world, chosen);

    var child = node.children[chosen.key];
    var r;
    if (!child) {
      child = new Node(world.phase === 'over' ? -1 : world.turn);
      node.children[chosen.key] = child;
      r = opts.valueFn ? opts.valueFn(world) : rollout(world, opts);
    } else {
      r = simulate(child, world, opts, rng, depth + 1);
    }

    node.N[chosen.key] = (node.N[chosen.key] || 0) + 1;
    node.W[chosen.key] = (node.W[chosen.key] || 0) + (r[mover] || 0);
    return r;
  }

  function normalize(options) {
    options = options || {};
    return {
      iterations: options.iterations || 200,
      c: options.c !== undefined ? options.c : 3,
      maxDepth: options.maxDepth || 64,
      maxRolloutSteps: options.maxRolloutSteps || 200,
      rng: options.rng || Math.random,
      priorFn: options.priorFn || null,
      rolloutPolicy: options.rolloutPolicy || defaultRollout,
      valueFn: options.valueFn || null,
      maxMs: options.maxMs || 0
    };
  }

  /** 没注入策略时的兜底：总是出最小的一张（几乎不会用到） */
  function defaultRollout(state, mover) {
    var h = _CD.sortAsc(state.players[mover].hand);
    if (state.current === null) return { action: 'play', cards: [h[0]] };
    var mv = _G.legalMoves(state);
    if (mv.length) return { action: 'play', cards: mv[0].cards };
    return { action: 'pass', cards: null };
  }

  function toDecision(mv) {
    return mv.pass ? { action: 'pass', cards: null } : { action: 'play', cards: mv.cards };
  }

  /**
   * 主入口：为 state.turn（或 self）选一手。
   * 返回 { action:'play', cards } 或 { action:'pass' }；无解返回 null。
   */
  function search(state, self, options) {
    var opts = normalize(options);
    var wantRoot = !!(options && options.returnRoot);
    if (state.phase === 'over') return null;
    self = self === undefined ? state.turn : self;

    var rootMoves = enumerateMoves(state, opts);
    if (!rootMoves.length) return { action: 'pass', cards: null };
    if (rootMoves.length === 1) return wantRoot
      ? { decision: toDecision(rootMoves[0]), moves: rootMoves, pi: [1] }
      : toDecision(rootMoves[0]);

    var root = new Node(self);
    var deadline = opts.maxMs ? Date.now() + opts.maxMs : 0;

    for (var it = 0; it < opts.iterations; it++) {
      if (deadline && (it & 15) === 0 && Date.now() >= deadline) break;
      var world = _Det.sample(state, self, opts.rng);
      simulate(root, world, opts, opts.rng, 0);
    }

    // 选访问次数最多的一手（平手看均值得分）
    var best = null, bestN = -1, bestQ = -Infinity;
    for (var i = 0; i < rootMoves.length; i++) {
      var m = rootMoves[i];
      var n = root.N[m.key] || 0;
      var q = n ? root.W[m.key] / n : -Infinity;
      if (n > bestN || (n === bestN && q > bestQ)) { bestN = n; bestQ = q; best = m; }
    }
    var bestD = best ? toDecision(best) : toDecision(rootMoves[0]);
    if (wantRoot) {
      var totalN = 0, pi = [];
      for (var k = 0; k < rootMoves.length; k++) totalN += (root.N[rootMoves[k].key] || 0);
      for (k = 0; k < rootMoves.length; k++) pi.push(totalN ? (root.N[rootMoves[k].key] || 0) / totalN : 1 / rootMoves.length);
      return { decision: bestD, moves: rootMoves, pi: pi };
    }
    return bestD;
  }

  /* ---------------- AlphaZero 式搜索（PUCT + 网络先验/估值） ---------------- */

  function gaussian(rng) { var u = 0, v = 0; while (u === 0) u = rng(); while (v === 0) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  function gammaSample(alpha, rng) {
    var d = alpha - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      var x, v;
      do { x = gaussian(rng); v = 1 + c * x; } while (v <= 0);
      v = v * v * v;
      var u = rng();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }
  function dirichletNoise(n, alpha, rng) {
    var g = [], s = 0, i;
    for (i = 0; i < n; i++) { var x = gammaSample(alpha, rng); g.push(x); s += x; }
    for (i = 0; i < n; i++) g[i] /= s;
    return g;
  }

  /** PUCT：未访问先按先验试；已访问用 u = Q + c·P·√(ΣN)/(1+N) */
  function choosePUCT(node, moves, opts, rng) {
    var i, unv = null;
    for (i = 0; i < moves.length; i++) if (node.N[moves[i].key] === undefined) { (unv || (unv = [])).push(moves[i]); }
    if (unv) {
      var best = unv[0];
      for (i = 1; i < unv.length; i++) if ((node.P[unv[i].key] || 0) > (node.P[best.key] || 0)) best = unv[i];
      return best;
    }
    var total = 0;
    for (i = 0; i < moves.length; i++) total += node.N[moves[i].key];
    var bs = null, bu = -Infinity;
    for (i = 0; i < moves.length; i++) {
      var m = moves[i], n = node.N[m.key], q = node.W[m.key] / n;
      var u = q + opts.c * (node.P[m.key] || 0) * Math.sqrt(total + 1) / (1 + n);
      if (u > bu) { bu = u; bs = m; }
    }
    return bs;
  }

  function azSimulate(node, world, opts, rng, depth) {
    if (world.phase === 'over' || depth >= opts.maxDepth) return payoff(world);
    var mover = world.turn;
    if (!node.expanded) {
      var mv0 = enumerateMoves(world, opts);
      var e0 = opts.evalFn(world, mv0);
      node.P = {};
      for (var a = 0; a < mv0.length; a++) node.P[mv0[a].key] = e0.P[a];
      node.expanded = true;
      return e0.value;
    }
    var moves = enumerateMoves(world, opts);
    if (!moves.length) return payoff(world);
    var chosen = choosePUCT(node, moves, opts, rng);
    applyMove(world, chosen);
    var child = node.children[chosen.key];
    if (!child) { child = new Node(world.phase === 'over' ? -1 : world.turn); node.children[chosen.key] = child; }
    var r = azSimulate(child, world, opts, rng, depth + 1);
    node.N[chosen.key] = (node.N[chosen.key] || 0) + 1;
    node.W[chosen.key] = (node.W[chosen.key] || 0) + (r[mover] || 0);
    return r;
  }

  function normalizeAZ(o) {
    o = o || {};
    return {
      iterations: o.iterations || 200,
      c: o.c !== undefined ? o.c : 1.5,
      maxDepth: o.maxDepth || 64,
      rng: o.rng || Math.random,
      evalFn: o.evalFn,
      maxMs: o.maxMs || 0,
      dirichlet: !!o.dirichlet,
      dirichletAlpha: o.dirichletAlpha !== undefined ? o.dirichletAlpha : 0.3,
      dirichletEps: o.dirichletEps !== undefined ? o.dirichletEps : 0.25
    };
  }

  /** AZ 搜索：返回 { decision, moves, pi }（pi = root 访问分布，供 self-play 记录） */
  function azSearch(state, self, options) {
    var opts = normalizeAZ(options);
    if (!opts.evalFn) throw new Error('azSearch 需要 evalFn');
    if (state.phase === 'over') return { decision: null, moves: [], pi: [] };
    self = self === undefined ? state.turn : self;

    var rootMoves = enumerateMoves(state, opts);
    if (!rootMoves.length) return { decision: { action: 'pass', cards: null }, moves: [], pi: [] };
    if (rootMoves.length === 1) return { decision: toDecision(rootMoves[0]), moves: rootMoves, pi: [1] };

    var root = new Node(self);
    var e0 = opts.evalFn(state, rootMoves);
    root.P = {};
    for (var i = 0; i < rootMoves.length; i++) root.P[rootMoves[i].key] = e0.P[i];
    root.expanded = true;
    if (opts.dirichlet) {
      var noise = dirichletNoise(rootMoves.length, opts.dirichletAlpha, opts.rng);
      for (i = 0; i < rootMoves.length; i++) {
        var kk = rootMoves[i].key;
        root.P[kk] = (1 - opts.dirichletEps) * root.P[kk] + opts.dirichletEps * noise[i];
      }
    }

    var deadline = opts.maxMs ? Date.now() + opts.maxMs : 0;
    for (var it = 0; it < opts.iterations; it++) {
      if (deadline && (it & 15) === 0 && Date.now() >= deadline) break;
      var world = _Det.sample(state, self, opts.rng);
      azSimulate(root, world, opts, opts.rng, 0);
    }

    var total = 0, pi = [];
    for (i = 0; i < rootMoves.length; i++) total += (root.N[rootMoves[i].key] || 0);
    for (i = 0; i < rootMoves.length; i++) pi.push(total ? (root.N[rootMoves[i].key] || 0) / total : 1 / rootMoves.length);
    var best = 0;
    for (i = 1; i < rootMoves.length; i++) if ((root.N[rootMoves[i].key] || 0) > (root.N[rootMoves[best].key] || 0)) best = i;
    return { decision: toDecision(rootMoves[best]), moves: rootMoves, pi: pi };
  }

  var api = {
    search: search,
    azSearch: azSearch,
    enumerateMoves: enumerateMoves,
    payoff: payoff,
    Node: Node
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
