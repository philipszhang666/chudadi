/* ============================================================
 * ai.js —— 改版锄大地：电脑玩家策略
 * 依赖 cards.js（CD）与 game.js（Game）
 *
 * 难度：
 *   easy   完全随机（偶尔乱出）
 *   normal 贪心：能压就压最小的，能一把走完就走完
 *   hard   记牌 + 手牌结构评估：尽量少拆牌、留大牌、抢占领出权
 * ============================================================ */

var AI = (function () {
  'use strict';

  var _CD = (typeof module !== 'undefined' && module.exports) ? require('./cards.js') : CD;
  var _G = (typeof module !== 'undefined' && module.exports) ? require('./game.js') : Game;
  var _MCTS = (typeof module !== 'undefined' && module.exports)
    ? require('./mcts.js')
    : (typeof MCTS !== 'undefined' ? MCTS : null);
  var _Endgame = (typeof module !== 'undefined' && module.exports)
    ? require('./endgame.js')
    : (typeof Endgame !== 'undefined' ? Endgame : null);

  // hardv1：旧版 ai_v1.js 的 hard 档，供搜索 rollout 直接引用（rollout:'hardv1'）。
  //   Node 下按模块加载 ai_v1.js（与 bench 的 'hardv1' 完全一致）；
  //   浏览器里若加载了 ai_v1.js（导出为全局 AIv1）就用它，否则退回本文件的 hard
  //   —— 本文件 hard 在默认权重下即等价 V1（holdW / safe 默认 0）。
  var _AIV1 = (typeof module !== 'undefined' && module.exports)
    ? require('./ai_v1.js')
    : (typeof AIv1 !== 'undefined' ? AIv1 : null);

  // 出牌代价：牌型越大、点数越大越「舍不得」
  var BASE_COST = { single: 0, pair: 6, triple: 14, straight: 22, flush: 27, fullhouse: 33, quads: 40, straightflush: 48 };

  function cost(play) {
    var v = (play.value || 0) / 10;
    return (BASE_COST[play.category] || 0) + v + (play.main ? play.main.suitOrder / 100 : 0);
  }

  /* ---------------- 困难档：记牌（只用公开信息） ---------------- */

  /**
   * 「确定不在对手手上」的牌 = 所有已出过的牌 + 自己的手牌。
   *
   * 修正说明：旧版把「其他玩家手牌」也算进 seen，等于 AI 偷看对手牌，
   * 而且方向反了——它把对手手里的牌当成「安全牌」，导致 isTopRemaining
   * 退化成「这张是不是我手里最大的牌」。现在只认「已出过 + 自己手里」，
   * 剩下的才代表对手那边的未知威胁。
   */
  function knownCards(state, p) {
    var map = {};
    Object.keys(state.played || {}).forEach(function (id) { map[id] = 1; });
    (p ? p.hand : []).forEach(function (c) { map[c.id] = 1; });
    return map;
  }

  /** 兼容旧签名 */
  function seen(state, p) { return knownCards(state, p); }

  /** 某张牌是否还是「外面（对手那边）已经没有更大的牌了」 */
  function isTopRemaining(card, knownMap) {
    for (var i = 0; i < _CD.ALL_CARDS.length; i++) {
      var c = _CD.ALL_CARDS[i];
      if (c.id === card.id) break;      // 只检查比自己大的牌（ALL_CARDS 从大到小）
      if (knownMap[c.id]) continue;     // 已出过 / 在我手里 → 不构成威胁
      return false;                     // 对手那边还有更大的牌
    }
    return true;
  }

  /** 还没露面的牌（可能仍在对手手上），用来估计外面的威胁 */
  function unseenCards(knownMap) {
    var out = [];
    for (var i = 0; i < _CD.ALL_CARDS.length; i++) {
      if (!knownMap[_CD.ALL_CARDS[i].id]) out.push(_CD.ALL_CARDS[i]);
    }
    return out;
  }

  /* ---------------- 过牌反推（hardv3） ----------------
     过牌 = 「我当时压不过桌上那张牌」。手牌只会变少，这个约束一旦成立就永久成立：
     若某家曾对一张牌 rp 过牌（压不过 rp），那么对任何比 rp 还大的牌 p
     （canBeat(p,rp) 为真），他也一定压不过——否则他能压 p ⇒ 也能压 rp，矛盾。
     只用公开信息（谁对什么过牌），不偷看手牌。 */
  function passCannotBeat(qIndex, play, state) {
    var list = state.passes;
    if (!list || !list.length) return false;
    for (var i = 0; i < list.length; i++) {
      var rec = list[i];
      if (rec.player !== qIndex || !rec.play) continue;
      if (_CD.canBeat(play, rec.play).ok) return true;   // 他压不过更小的 rp → 也压不过我这张
    }
    return false;
  }

  /** 还有牌、且被证明「压不过 play」的对手占比 0~1（1 = 全场都压不过，控牌稳了） */
  function safeFraction(play, state, me) {
    var n = state.players.length, active = 0, safe = 0;
    for (var i = 0; i < n; i++) {
      if (i === me) continue;
      if (state.players[i].hand.length === 0) continue;
      active++;
      if (passCannotBeat(i, play, state)) safe++;
    }
    return active > 0 ? safe / active : 0;
  }

  /** 手牌「整齐度」旧版：只按同点数分组，ceil(张数/3) 求和 */
  function handsEstimateNaive(cards) {
    var groups = _CD.groupByRank(cards);
    var n = 0;
    groups.forEach(function (g) {
      n += Math.ceil(g.cards.length / 3); // 3 张算一手（对子/三条）
    });
    return n;
  }

  /**
   * 手牌「最少几手走完」——认牌型版本。
   * 顺子 / 同花 / 葫芦 / 四条都算 1 手，比按点数硬拆更贴近真实出牌次数。
   * 实现在 cards.js 里（带缓存，18 张手牌约 0.4ms）。
   */
  function handsEstimateSmart(cards) {
    return _CD.minHands(cards);
  }

  // 当前使用的评估函数（基准测试会切换它来对比新旧策略）
  var handsEstimate = handsEstimateSmart;

  // 「期望手数」：把「最省」（minHands，假设牌型都能顺利打出）与「保守上界」
  // （按点数分组、不认牌型）按 EXP_BETA 线性混合，近似「牌型不一定打得出去」的期望。
  // EXP_BETA=0 → 纯最省(=smart)；=1 → 纯保守(=naive)。
  var EXP_BETA = 0.5;
  function handsEstimateExpected(cards) {
    return (1 - EXP_BETA) * handsEstimateSmart(cards) + EXP_BETA * handsEstimateNaive(cards);
  }

  /** 按 options.hands 选评估函数：'naive' | 'smart' | 'expected' | 默认(全局) */
  function resolveHands(options) {
    if (options && options.handsBeta !== undefined) EXP_BETA = options.handsBeta;
    var h = options && options.hands;
    if (h === 'naive') return handsEstimateNaive;
    if (h === 'smart') return handsEstimateSmart;
    if (h === 'expected') return handsEstimateExpected;
    return handsEstimate;
  }

  /* ---------------- 领出 ----------------
     领出的选择直接决定「五张牌型能不能走掉」：
     按规则五张只能和五张比，如果 AI 领出时只肯出单张，
     那它手里的顺子 / 同花 / 葫芦就只有等别人也领五张才有机会出，基本烂在手里。
     所以领出按这个打分：
       · 结构：出完之后手牌「还要几手走完」最好正好少 1（别拆自己的牌型）
       · 五张：领出五张有额外奖励（它是最难找机会出的一类）
       · 牌力：同等条件下先走小牌，别拿大牌开路 */

  // struct/five/cost 的取值是 tests/bench-ai.js 上扫出来的（见该文件「领出策略」一节）：
  // five 从 0 一路加到 100，交叉对局头游率从 55.5% 升到 57.7% 后在 28 附近封顶，
  // 所以取 28（≈「只要不拆牌型，有五张就先走五张」）。
  var LEAD_CFG = { struct: 12, five: 28, cost: 0.3, fiveMin: 0.5, urgent: 12, race: 0, safe: 0 };

  // 五张牌型「打出去之后大概守得住」的先验（越难被压越接近 1）
  var FIVE_SAFETY_BASE = {
    straightflush: 0.95, quads: 0.8, fullhouse: 0.5, flush: 0.45, straight: 0.3
  };

  /** 对手紧迫度 0~1：有人快走完（剩牌少）→ 接近 1 */
  function opponentUrgency(state, p) {
    var n = state.players.length, minLen = Infinity, i;
    for (i = 0; i < n; i++) {
      var q = state.players[i];
      if (q.index === p.index || q.hand.length === 0) continue;
      if (q.hand.length < minLen) minLen = q.hand.length;
    }
    if (!isFinite(minLen)) return 0;
    return Math.max(0, Math.min(1, (8 - minLen) / 5));   // ≤3 张→1，8 张及以上→0
  }

  /**
   * 这手牌「打出去之后守不守得住领出权」的粗略置信度 0~1。
   * 只用公开信息（已出过的牌 + 自己手牌 + 场上出过几手五张）推断，不偷看对手手牌。
   * 目前只对五张牌型给分：五张只能靠领出才能打掉，值不值得出要看它守不守得住。
   */
  function holdLeadScore(state, m, knownMap) {
    if (m.size !== 5) return 0;
    var base = FIVE_SAFETY_BASE[m.category] || 0.3;
    var key = (m.main && m.main.value) || 0;            // 这手五张的「牌力」参考点
    var unseen = unseenCards(knownMap);
    var threat = 0;
    for (var i = 0; i < unseen.length; i++) {
      if (unseen[i].value >= key) threat++;             // 外面还剩多少「比它大的料」
    }
    // 场上五张出得越多，剩下的越可能压得住我这手
    var s = base - threat * 0.02 + (state.fivePlays || 0) * 0.03;
    return Math.max(0, Math.min(1, s));
  }

  /* ---------------- 概率化威胁模型 ----------------
     旧版只有 isTopRemaining 的 0/1 布尔（单张精确：外面有更大的就一定被压）。
     这里改成连续概率：估计「这手打出去压不压得住」。
       · beatingUnits：外面还能凑出多少「同张数、更大」的手（对/三条按同点数成组）
       · holdProb    ：这些「更大的手」全都避开「我之后才行动的人」的概率（超几何）
     单张 → 退化成原来的 0/1；对子/三条/五张 → 真正 0~1 的连续值。 */

  function comb(n, k) {
    if (k < 0 || n < 0 || k > n) return 0;
    if (k > n - k) k = n - k;
    var r = 1;
    for (var i = 1; i <= k; i++) r = r * (n - k + i) / i;
    return r;
  }

  /** 外面还能凑出多少手「同张数且更大」的牌 */
  function beatingUnits(play, knownMap) {
    var v = (play.main && play.main.value) || 0;
    var suit = (play.main && play.main.suitOrder) || 0;
    var size = play.size || (play.cards ? play.cards.length : 1);
    if (size === 1) {
      var single = 0;
      for (var i = 0; i < _CD.ALL_CARDS.length; i++) {
        var c = _CD.ALL_CARDS[i];
        if (knownMap[c.id]) continue;
        if (c.value > v || (c.value === v && c.suitOrder > suit)) single++;
      }
      return single;
    }
    if (size === 2 || size === 3) {
      var copies = {};
      for (var j = 0; j < _CD.ALL_CARDS.length; j++) {
        var cc = _CD.ALL_CARDS[j];
        if (knownMap[cc.id] || cc.value <= v) continue;
        copies[cc.value] = (copies[cc.value] || 0) + 1;
      }
      var units = 0;
      Object.keys(copies).forEach(function (rv) { units += Math.floor(copies[rv] / size); });
      return units;
    }
    // 五张：用「外面比它大的牌数 / 5」粗略估计还能凑几手
    var big = 0;
    for (var k = 0; k < _CD.ALL_CARDS.length; k++) {
      var c2 = _CD.ALL_CARDS[k];
      if (!knownMap[c2.id] && c2.value > v) big++;
    }
    return Math.floor(big / 5);
  }

  /** 我这手打出去后，还有多少张「外手牌」有机会在我之后行动 */
  function afterMeSlots(state, p) {
    var n = state.players.length, slots = 0, cur = state.currentOwner;
    if (cur === null || cur === undefined) {
      for (var i = 0; i < n; i++) {
        var q = state.players[i];
        if (q.index !== p.index && q.hand.length > 0) slots += q.hand.length;
      }
      return slots;
    }
    var t = (p.index + 1) % n, guard = 0;
    while (t !== cur && guard < n) {
      var q2 = state.players[t];
      if (q2.hand.length > 0) slots += q2.hand.length;
      t = (t + 1) % n; guard++;
    }
    return slots;
  }

  /** 这手牌「压不压得住」的概率 0~1（威胁模型的概率版本） */
  function holdProb(play, state, p, knownMap) {
    var size = play.size || (play.cards ? play.cards.length : 1);
    if (size === 5) return holdLeadScore(state, play, knownMap);
    var units = beatingUnits(play, knownMap);
    if (units <= 0) return 1;
    var U = 0;
    state.players.forEach(function (q) { if (q.index !== p.index) U += q.hand.length; });
    if (U <= 0) return 1;
    var slots = Math.min(afterMeSlots(state, p), U);
    if (slots <= 0) return 1;
    return comb(U - units, slots) / comb(U, slots);
  }

  /** 老领出策略（只会挑「最先挑中单张」的那个排序）—— 仅留给基准测试做对照 */
  function oldLeadSort(usable) {
    var sorted = usable.slice().sort(function (a, b) {
      var da = (a.size === 1 ? 0 : 4) + cost(a);
      var db = (b.size === 1 ? 0 : 4) + cost(b);
      return da - db;
    });
    return sorted[0];
  }

  function chooseLead(state, p, options) {
    options = options || {};
    var moves = _G.legalMoves(state);
    if (!moves.length) return null;

    // 能一把走完，直接走（选牌力最小的那手，反正都一样）
    var out = moves.filter(function (m) { return m.cards.length === p.hand.length; });
    if (out.length) return out[0];

    // 别把 ♦4 这种绝对最小牌在领出时扔掉（除非它是唯一选择）
    var usable = moves.filter(function (m) {
      return !(m.size === 1 && m.main && m.main.id === _CD.RULES.firstCard);
    });
    if (!usable.length) usable = moves;

    if (options.lead === 'old') return oldLeadSort(usable);

    var cfg = (options.hardCfg && options.hardCfg.lead) || options.leadCfg || {};
    var W_STRUCT = cfg.struct !== undefined ? cfg.struct : LEAD_CFG.struct;
    var W_FIVE = cfg.five !== undefined ? cfg.five : LEAD_CFG.five;
    var W_COST = cfg.cost !== undefined ? cfg.cost : LEAD_CFG.cost;
    var W_FIVE_MIN = cfg.fiveMin !== undefined ? cfg.fiveMin : LEAD_CFG.fiveMin;
    var W_URGENT = cfg.urgent !== undefined ? cfg.urgent : LEAD_CFG.urgent;
    var W_RACE = cfg.race !== undefined ? cfg.race : LEAD_CFG.race;
    var useSafety = cfg.fiveSafety !== false;
    var W_HOLD = cfg.holdW !== undefined ? cfg.holdW : 0;   // 概率化威胁权重（V1=0）
    var W_SAFE = cfg.safe !== undefined ? cfg.safe : LEAD_CFG.safe;   // 过牌反推（hardv3）

    var known = knownCards(state, p);
    var urgency = opponentUrgency(state, p);
    var est = resolveHands(options);
    var before = est(p.hand);
    var best = null, bestScore = Infinity;
    usable.forEach(function (m) {
      var rest = _CD.removeCards(p.hand, m.cards);
      var after = rest.length ? est(rest) : 0;
      // 出一手牌，理想情况下「还要几手」正好少 1；拆散牌型会更差
      var score = (after - (before - 1)) * W_STRUCT;
      if (m.size === 5) {
        var hold = useSafety ? holdLeadScore(state, m, known) : 1;
        // 守得住的五张给满奖励（-W_FIVE）；守不住的只给下限（别拿烂五张去送）
        score -= W_FIVE * (W_FIVE_MIN + (1 - W_FIVE_MIN) * hold);
        // 对手快走完时，更愿意打「守得住」的五张来抢节奏
        score -= W_URGENT * urgency * hold;
      }
      // 有人快走完 → 倾向于多出几张、跑得快
      if (W_RACE) score -= W_RACE * urgency * m.size;
      score += cost(m) * W_COST;
      // 概率化威胁：这手大概率压得住（守得住领出权）→ 加分
      if (W_HOLD) score -= W_HOLD * holdProb(m, state, p, known);
      // 过牌反推：被证明压不过我这手的对手越多，领出后越稳（越可能守住领出权）
      if (W_SAFE) score -= W_SAFE * safeFraction(m, state, p.index);
      if (score < bestScore) { bestScore = score; best = m; }
    });
    return best;
  }

  /* ---------------- 跟牌 ---------------- */

  function chooseFollow(state, p, difficulty, opts) {
    var moves = _G.legalMoves(state);
    if (!moves.length) return null;

    // 能一把走完
    var out = moves.filter(function (m) { return m.cards.length === p.hand.length; });
    if (out.length) {
      out.sort(function (a, b) { return cost(a) - cost(b); });
      return out[0];
    }

    moves.sort(function (a, b) { return cost(a) - cost(b); });
    var cheapest = moves[0];
    var easy = difficulty === 'easy';

    if (easy && moves.length > 1 && Math.random() < 0.35) {
      return moves[Math.floor(Math.random() * moves.length)];
    }

    // 不要为了压一手而把手牌拆散：出完后若剩单张孤牌，优先改用最小单张
    if (cheapest.size > 1 && p.hand.length - cheapest.size === 1) {
      var alt = moves.filter(function (m) { return m.size === 1; });
      if (alt.length) cheapest = alt[0];
    }

    if (difficulty === 'hard') {
      // 注意：hardFollow 可能返回 null（判定「不该压」→ 过牌），
      // 不能回退到 cheapest，否则「该不该压」就白做了
      return hardFollow(state, p, moves, opts || {});
    }

    return cheapest;
  }

  /* ---------------- 「该不该压」判断 ---------------- */

  /**
   * 「压这一手有多亏」——返回分数惩罚（加进候选评分里）。
   *
   * 为什么用软惩罚而不是硬性过滤：压牌是**唯一能减少手牌的动作**，
   * 一刀切禁止会把过牌率推到 57%（实测），AI 就变成「只守不攻」。
   * 所以这里只把「明显浪费」的压牌打分变差，让它和其他方案竞争。
   *
   * 什么算亏：
   *   - 用大牌（2 / 3）压小牌
   *   - 出完这手之后手牌反而更零碎（多一个要跑的轮次）
   *   - 下家手上牌还很多，不急着抢这一手
   */
  function pressWaste(state, p, m, est, cfg) {
    est = est || handsEstimateSmart;
    cfg = cfg || {};
    // 权重刻意取小：基准测试（2500 局 × 双向，见 tests/bench-ai.js）显示
    // 惩罚越强表现越差（头游率 22.9% → 22.1%），所以这里只做轻微纠偏。
    var W_HIGH = cfg.high !== undefined ? cfg.high : 1.0;       // 每 1 点牌力的惩罚
    var W_STRUCT = cfg.struct !== undefined ? cfg.struct : 2.0; // 每多一个轮次的惩罚
    var W_CALM = cfg.calm !== undefined ? cfg.calm : 1.0;       // 下家不紧张时的惩罚
    var START = cfg.startAt !== undefined ? cfg.startAt : 9;    // 牌力超过它才算「用大牌」
    var FACTOR = cfg.factor !== undefined ? cfg.factor : 0.3;   // 大牌浪费的缩放
    var NEXT_CALM = cfg.nextCalmLen !== undefined ? cfg.nextCalmLen : 5; // 下家多少张算「不急」

    var rest = _CD.removeCards(p.hand, m.cards);
    var v = (m.main && m.main.value) || 0;
    var waste = 0;

    // 1) 用大牌压小牌：牌力超过 START（默认 9，即 A 及以上）才开始算浪费
    if (v > START) waste += (v - START) * W_HIGH * FACTOR;

    // 2) 结构变差：出完之后手牌需要的轮次反而变多了
    var before = est(p.hand);
    var after = rest.length ? est(rest) : 0;
    if (after > before - 1) waste += (after - (before - 1)) * W_STRUCT;

    // 3) 下家牌还很多（≥5 张）→ 不急着抢这一手
    var n = state.players.length;
    var next = state.players[(p.index + 1) % n];
    if (next && next.hand.length >= NEXT_CALM) waste += W_CALM;

    return waste;
  }

  /** 该不该压（保留一个硬性判断：只用于「压下去能立刻走完」这类必须抢的场面） */
  function mustPress(state, p, m, est, cfg) {
    est = est || handsEstimateSmart;
    cfg = cfg || {};
    var n = state.players.length;
    var rest = _CD.removeCards(p.hand, m.cards);

    if (!rest.length) return true;                 // 出完就走完
    if (est(rest) <= 1) return true;               // 出完两手内走完

    // 下家快走完了（< 阈值张，默认 3）→ 必须拦
    var nextFew = cfg.mustNextFew !== undefined ? cfg.mustNextFew : 3;
    var next = state.players[(p.index + 1) % n];
    if (next && next.hand.length > 0 && next.hand.length < nextFew) return true;

    return false;
  }

  /** 跟牌权重（hardCfg.follow 可调；默认值 = 原行为） */
  function resolveFollow(options) {
    var F = (options && options.hardCfg && options.hardCfg.follow) || {};
    function pick(k, d) { return F[k] !== undefined ? F[k] : d; }
    return {
      estW: pick('estW', 1.5),             // 每减少一手牌的价值
      untouchable: pick('untouchable', 3), // 留绝对大牌的奖励
      restShort: pick('restShort', 4),     // 出完剩牌少的奖励
      restShortAt: pick('restShortAt', 3), // 剩多少张以内算「顺手走完」
      highPenalty: pick('highPenalty', 5), // 拿大牌压小的惩罚
      highAt: pick('highAt', 12),          // 多大算大牌（2/3）
      highHandMin: pick('highHandMin', 6)  // 手牌多于它才在意浪费大牌
      ,holdW: pick('holdW', 0)             // 概率化威胁（压不压得住）权重；0=关闭(=V1)
      ,safe: pick('safe', 0)               // 过牌反推权重；0=关闭（hardv3）
    };
  }

  /** 困难档跟牌：算上「外面还剩什么大牌」+ 该不该压 */
  function hardFollow(state, p, moves, options) {
    options = options || {};
    var usePress = options.press !== undefined ? options.press : defaultPress;
    var est = resolveHands(options);
    var F = resolveFollow(options);
    var cfg = (options.hardCfg && options.hardCfg.press) || options.pressCfg || {};

    var seenMap = knownCards(state, p);   // 已出过的牌 + 自己的手牌（公开信息，不偷看对手）
    var best = null, bestScore = Infinity;

    moves.forEach(function (m) {
      var rest = _CD.removeCards(p.hand, m.cards);

      var score = cost(m);
      // 出完之后手牌是否更整齐（认牌型）
      score += est(rest) * F.estW;

      // 如果剩下的牌里有「外面已经没有更大的牌」的绝对大牌，说明控制权还在自己手里
      var hasUntouchable = rest.some(function (c) { return isTopRemaining(c, seenMap); });
      if (hasUntouchable) score -= F.untouchable;

      // 顺手能走完剩下的牌，奖励
      if (rest.length <= F.restShortAt) score -= F.restShort;

      // 用大牌（2 / 3）去压小牌不划算，除非手牌已经不多
      if (m.main && m.main.value >= F.highAt && p.hand.length > F.highHandMin) score += F.highPenalty;

      // 概率化威胁：这手大概率压得住 → 加分（V1 下 holdW=0，不生效）
      if (F.holdW) score -= F.holdW * holdProb(m, state, p, seenMap);
      // 过牌反推：已被证明压不过我这手的对手越多，这手越稳（hardv3）
      if (F.safe) score -= F.safe * safeFraction(m, state, p.index);

      // 「该不该压」：软惩罚。必须抢的场面直接免罚
      if (usePress) {
        var waste = pressWaste(state, p, m, est, cfg);
        if (mustPress(state, p, m, est, cfg)) waste = Math.min(waste, 0);
        score += waste;
      }

      if (score < bestScore) { bestScore = score; best = m; }
    });

    return best;
  }

  /* ---------------- 搜索档（ISMCTS） ---------------- */

  /**
   * 'search' 档：用 MCTS 在「采样出来的完全信息世界」里搜索（见 mcts.js）。
   *   options.search = { iterations, c, maxDepth, maxRolloutSteps, maxMs, rollout, prior, rng }
   * 搜索不训练；rollout / 先验都复用本文件的启发式，等于「用搜索放大启发式」。
   */
  /** 轻量 rollout 策略：只用 cost 挑最小的一手，不枚举五张、不做结构评估（快很多） */
  function fastMove(state, mover) {
    var hand = state.players[mover].hand;
    var target = state.current;
    var needFive = target ? _CD.isFive(target) : false;   // 只有被迫跟五张时才枚举五张
    var moves = _CD.findBeatingPlays(hand, target, { noFive: !needFive });
    if (!moves.length) return { action: 'pass', cards: null };
    var best = moves[0], bc = cost(best);
    for (var i = 1; i < moves.length; i++) {
      var c = cost(moves[i]);
      if (c < bc) { bc = c; best = moves[i]; }
    }
    return { action: 'play', cards: best.cards };
  }

  function searchMove(state, playerIndex, options) {
    var cfg = (options && options.search) || {};
    var rolloutMode = cfg.rollout || 'fast';
    // cfg.rolloutFn 可直接注入自定义 rollout 策略（实验用，优先于 rolloutMode 字符串）
    // rolloutMode 支持 '难度@N' 形式，如 'hardv2@8'：rollout 用 hardv2，但模拟世界里
    //   残局阈值降到 N 张。阈值越低，rollout 里的残局越少触发、越便宜 → 搜索能跑更多迭代。
    //   （实测：@14 太慢把搜索饿死仅 +4.6pp；@8/@10 又快又强 +13~14pp）
    var rolloutPolicy;
    if (cfg.rolloutFn) {
      rolloutPolicy = cfg.rolloutFn;
    } else if (rolloutMode === 'fast') {
      rolloutPolicy = function (st, mover) { return fastMove(st, mover); };
    } else if (rolloutMode.indexOf('@') > 0) {
      var _rp = rolloutMode.split('@'), _rbase = _rp[0], _rmc = parseInt(_rp[1], 10);
      rolloutPolicy = function (st, mover) {
        return decide(st, mover, _rbase, { endgame: { maxCards: _rmc, samples: 8, maxNodes: 30000 } });
      };
    } else {
      rolloutPolicy = function (st, mover) { return decide(st, mover, rolloutMode, {}); };
    }

    var priorFn = null;
    if (cfg.prior !== false) {
      priorFn = function (st, moves) {
        var ps = [], i, sum = 0;
        for (i = 0; i < moves.length; i++) {
          // 出牌：代价越小先验越高；过牌：给一个中等先验
          ps.push(moves[i].pass ? 1 / (1 + 9) : 1 / (1 + cost(moves[i].play)));
        }
        for (i = 0; i < ps.length; i++) sum += ps[i];
        for (i = 0; i < ps.length; i++) ps[i] = sum ? ps[i] / sum : 1 / ps.length;
        return ps;
      };
    }

    var d = _MCTS.search(state, playerIndex, {
      iterations: cfg.iterations || 150,
      c: cfg.c,
      maxDepth: cfg.maxDepth,
      maxRolloutSteps: cfg.maxRolloutSteps,
      rng: cfg.rng,
      maxMs: cfg.maxMs !== undefined ? cfg.maxMs : 1200,
      priorFn: priorFn,
      rolloutPolicy: rolloutPolicy,
      valueFn: cfg.valueFn || null
    });
    return d || { action: 'pass' };
  }

  /* ---------------- A3 地主：队友配合（只用公开信息，不作弊） ----------------
     知识来源：
       · 「我是不是地主」= 看自己手牌有没有 ♠A / ♠3
       · 「队友是谁」= 我手里没的那张牌（♠A 或 ♠3）一旦亮出，出牌人就是队友；
         绝不读 state.landlord.members（那是上帝视角）
     配合策略：
       · 不顶队友：当前最大牌是队友出的 → 除非能一把走完，否则过牌
       · 喂牌：我领出、队友只剩 1 张 → 领一张最小的单张，给队友机会走掉
       · 护队友：对手领出、队友只剩 1 张 → 抢先压一手拿回领出权，下一手再喂 */

  /** 已经亮出（打过）的 ♠A / ♠3 的出牌人（公开信息） */
  function knownLandlordMembers(state) {
    var out = [], r = state.revealed || {};
    ['AS', '3S'].forEach(function (id) {
      var i = r[id];
      if (i !== undefined && i !== null && out.indexOf(i) < 0) out.push(i);
    });
    return out;
  }

  /** 用公开信息能确定的队友；没有就返回 null */
  function allyOf(state, p) {
    if (!state.landlord) return null;
    var has = {};
    p.hand.forEach(function (c) { has[c.id] = 1; });
    var holdsA = !!has['AS'], holds3 = !!has['3S'];

    if (!holdsA && !holds3) {
      // 农民：只有两名地主都亮出后，才能用排除法确定另一个农民
      var known = knownLandlordMembers(state);
      if (known.length >= 2) {
        var others = state.players.filter(function (q) {
          return q.index !== p.index && known.indexOf(q.index) < 0;
        });
        if (others.length === 1) return others[0].index;
      }
      return null;
    }
    if (holdsA && holds3) return null;             // 独拿 ♠A♠3：没有队友

    var otherCard = holdsA ? '3S' : 'AS';
    var idx = (state.revealed || {})[otherCard];
    if (idx === undefined || idx === null || idx === p.index) return null;
    return idx;
  }

  /** 合法出牌里代价最小的一手（跟牌场景就是最小的能压过的那手） */
  function cheapestLegal(state) {
    var moves = _G.legalMoves(state);
    if (!moves.length) return null;
    moves.sort(function (a, b) { return cost(a) - cost(b); });
    return moves[0];
  }

  /** 在基础决策之上叠加队友配合（仅 A3 地主模式生效） */
  function cooperate(state, p, base) {
    if (!state.landlord || !base) return base;
    var ally = allyOf(state, p);
    if (ally === null || ally === undefined) return base;
    var allyCards = state.players[ally].hand.length;

    // A) 不顶队友（队友自己还在场）
    if (state.current !== null && state.currentOwner === ally && allyCards > 0) {
      if (base.action === 'play' && base.cards && base.cards.length === p.hand.length) return base;  // 能走完就走
      return { action: 'pass' };
    }

    var goingOut = base.action === 'play' && base.cards && base.cards.length === p.hand.length;

    // B) 喂牌：我领出 + 队友只剩 1 张 → 领最小的单张
    if (state.current === null && allyCards === 1 && !goingOut) {
      var moves = _G.legalMoves(state);
      var singles = moves.filter(function (m) { return m.size === 1; });
      if (singles.length) {
        singles.sort(function (a, b) { return cost(a) - cost(b); });
        return { action: 'play', cards: singles[0].cards, play: singles[0] };
      }
    }

    // C) 护队友：对手领出 + 队友只剩 1 张 → 抢先压一手拿回领出权
    if (state.current !== null && state.currentOwner !== ally && allyCards === 1) {
      if (base.action === 'pass') {
        var cheap = cheapestLegal(state);
        if (cheap) return { action: 'play', cards: cheap.cards, play: cheap };
      }
    }

    return base;
  }

  /* ---------------- 主入口 ---------------- */

  /**
   * 电脑决策。返回 { action:'play', cards } 或 { action:'pass' }
   * options.hands 可切换手牌评估函数（'smart' 认牌型 / 'naive' 只按点数）
   * options.press 可开关「该不该压」判断——仅供基准测试对比新旧策略
   * options.lead 传 'old' 用老领出策略，options.leadCfg 可调领出权重——同样只给基准测试用
   * difficulty 'search' 走 ISMCTS（见 searchMove）
   */
  /** hardv2 = hard 档 + 残局精确解；残局阈值默认 14 张（实测最佳配置） */
  var ENDGAME_DEFAULT = { maxCards: 14, samples: 8, maxNodes: 30000 };

  function decide(state, playerIndex, difficulty, options) {
    difficulty = difficulty || state.difficulty || 'normal';
    options = options || {};
    var useEndgame = options.endgame;

    // hardv1 / hardA3v1：旧版 ai_v1.js 的 hard 档（A3 下自带队友配合），不含残局精确解。
    //   直接委派给 ai_v1.js；拿不到就退回本文件的 hard（默认权重下即等价 V1）。
    //   A3 搜索里 'search(rollout:hardA3v1)' 的 rollout 字符串也走这里。
    if (difficulty === 'hardv1' || difficulty === 'hardA3v1') {
      if (_AIV1) return _AIV1.decide(state, playerIndex, 'hard', options);
      difficulty = 'hard';
    }

    // hardv2：在 hard 档基础上叠加残局精确解（等价 hard + options.endgame）
    if (difficulty === 'hardv2') {
      difficulty = 'hard';
      if (useEndgame === undefined || useEndgame === null) useEndgame = true;
    }

    // hardA3v2：hardv2 的 A3 地主版。残局收益改按「地主队名次」结算
    // （endgame.js 检测到 state.landlord 会自动换用队伍名次口径）。非 A3 局等同 hardv2。
    if (difficulty === 'hardA3v2') {
      difficulty = 'hard';
      if (useEndgame === undefined || useEndgame === null) useEndgame = true;
    }

    // hardv3 = hardv2 的实验档：默认等同 hardv2，由 options.hardv3 显式开启各实验项：
    //   hardv3.safeLead / safeFollow → 过牌反推权重
    //   hardv3.handsBeta             → 手数估计「最省(0) ↔ 期望(1)」混合系数
    if (difficulty === 'hardv3') {
      difficulty = 'hard';
      if (useEndgame === undefined || useEndgame === null) useEndgame = true;
      var hv3 = options.hardv3 || {};
      var hc3 = options.hardCfg || (options.hardCfg = {});
      hc3.lead = hc3.lead || {};
      if (hc3.lead.safe === undefined) hc3.lead.safe = hv3.safeLead !== undefined ? hv3.safeLead : 0;
      hc3.follow = hc3.follow || {};
      if (hc3.follow.safe === undefined) hc3.follow.safe = hv3.safeFollow !== undefined ? hv3.safeFollow : 0;
      if (hv3.handsBeta !== undefined) { options.hands = 'expected'; options.handsBeta = hv3.handsBeta; }
    }

    if (difficulty === 'search') {
      if (_MCTS) {
        var d = searchMove(state, playerIndex, options);
        return cooperate(state, state.players[playerIndex], d);
      }
      difficulty = 'hard';                 // 没加载 mcts.js 时退回困难档
    }
    var p = state.players[playerIndex];

    // 残局精确搜索：总牌数很少时，用「采样 + 完全信息 Max^n 精确解」代替启发式。
    // useEndgame 可为：省略/false(=基线 hard)、true(=ENDGAME_DEFAULT)、
    // 或配置对象 { maxCards, samples, maxNodes }。
    if (difficulty === 'hard' && useEndgame && _Endgame && state.turn === playerIndex) {
      var egCfg = (typeof useEndgame === 'object') ? useEndgame : (options.endgameCfg || ENDGAME_DEFAULT);
      if (_Endgame.applicable(state, egCfg)) {
        var ed = _Endgame.solve(state, playerIndex, egCfg);
        if (ed) return cooperate(state, p, ed);
      }
    }

    if (state.current === null) {
      var lead = chooseLead(state, p, options);
      return cooperate(state, p, lead ? { action: 'play', cards: lead.cards, play: lead } : { action: 'pass' });
    }

    if (difficulty === 'easy' && Math.random() < 0.25) {
      // 简单档偶尔明明能压也不压
      return cooperate(state, p, { action: 'pass' });
    }

    var follow = chooseFollow(state, p, difficulty, options);
    return cooperate(state, p, follow ? { action: 'play', cards: follow.cards, play: follow } : { action: 'pass' });
  }

  /** 供基准测试切换默认策略（也可以按次传 options 覆盖） */
  function setStrategy(mode) {
    handsEstimate = (mode === 'naive') ? handsEstimateNaive : handsEstimateSmart;
    defaultPress = (mode !== 'nopress');
  }

  var defaultPress = true;

  var api = {
    decide: decide, chooseLead: chooseLead, chooseFollow: chooseFollow,
    cost: cost, searchMove: searchMove,
    handsEstimate: function (cards) { return handsEstimate(cards); },
    handsEstimateNaive: handsEstimateNaive,
    handsEstimateSmart: handsEstimateSmart,
    pressWaste: pressWaste,
    mustPress: mustPress,
    setStrategy: setStrategy,
    ENDGAME_DEFAULT: ENDGAME_DEFAULT
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
