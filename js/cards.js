/* ============================================================
 * cards.js —— 改版锄大地：牌型判定与比大小引擎（纯逻辑，无界面依赖）
 *
 * 改版规则：
 *   点数大小：3 > 2 > A > K > Q > J > 10 > 9 > 8 > 7 > 6 > 5 > 4
 *   花色大小：♠ > ♥ > ♣ > ♦   （因此 ♦4 是全场最小的牌）
 *   牌型：单张 / 对子 / 三条 / 五张（同花顺 > 四条 > 葫芦 > 同花 > 顺子）
 *   同花比同花：先比花色（♠ > ♥ > ♣ > ♦），花色相同再比点数（3 最大）再逐张
 *   同花顺比同花顺：先比顺子大小，相同再比花色
 *   张数规则：只能同张数互比，五张牌型只能和五张比，不能拿去压单张/对子/三条
 *   顺子：线性序列 2 3 4 5 6 7 8 9 10 J Q K A，
 *         最大 10-J-Q-K-A，最小 A-2-3-4-5（特例），无绕圈组合
 * ============================================================ */

var CD = (function () {
  'use strict';

  /* ---------------- 基本常量 ---------------- */

  // 花色，数字越大越大
  var SUITS = [
    { key: 'S', sym: '♠', name: '黑桃', order: 4, red: false },
    { key: 'H', sym: '♥', name: '红桃', order: 3, red: true },
    { key: 'C', sym: '♣', name: '梅花', order: 2, red: false },
    { key: 'D', sym: '♦', name: '方块', order: 1, red: true }
  ];

  var SUIT_ORDER = { S: 4, H: 3, C: 2, D: 1 };

  // 改版点数：4 最小(1)，3 最大(13)
  var RANK_VALUE = {
    '4': 1,
    '5': 2,
    '6': 3,
    '7': 4,
    '8': 5,
    '9': 6,
    '10': 7,
    'J': 8,
    'Q': 9,
    'K': 10,
    'A': 11,
    '2': 12,
    '3': 13
  };

  // 显示顺序（从大到小），用于界面和日志
  var RANK_DESC = ['3', '2', 'A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4'];

  var RANKS = ['4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2', '3'];

  // 顺子专用顺序：2 < 3 < 4 < ... < K < A
  // 顺序是线性 2..A，所以顺子最大是 10-J-Q-K-A，最小是 A-2-3-4-5（特例）
  var STRAIGHT_ORDER = {
    '2': 0, '3': 1, '4': 2, '5': 3, '6': 4, '7': 5, '8': 6, '9': 7,
    '10': 8, 'J': 9, 'Q': 10, 'K': 11, 'A': 12
  };
  // A-2-3-4-5 的顶端牌 A 在自然序列里是最大的，但这一手要按「最小顺子」算，
  // 所以给它一个低于所有常规顺子的强度值
  var A2345_VALUE = -1;

  // 玩法旗标
  var RULES = {
    firstCard: '4D',          // 持有 ♦4 者先出，且首出必须包含它
    fiveBeatsAny: false,      // 五张牌型「不能」压任意牌型，只能和五张比
    allowA2345: true,         // A-2-3-4-5 视为合法顺子（全局最小顺子）
    bombIsFiveCards: true     // 四条视为「四张 + 1 张单牌」的五张牌型
  };

  /* ---------------- 牌的构造与基础比较 ---------------- */

  var ALL_CARDS = [];
  (function buildDeck() {
    for (var ri = 0; ri < RANKS.length; ri++) {
      for (var si = 0; si < SUITS.length; si++) {
        var r = RANKS[ri], s = SUITS[si];
        ALL_CARDS.push({
          id: r + s.key,
          rank: r,
          suit: s.key,
          sym: s.sym,
          red: s.red,
          value: RANK_VALUE[r],
          suitOrder: s.order
        });
      }
    }
    ALL_CARDS.sort(function (a, b) { return compareCard(b, a); }); // 从大到小
  })();

  var BY_ID = {};
  ALL_CARDS.forEach(function (c) { BY_ID[c.id] = c; });

  function getCard(id) {
    if (typeof id === 'object' && id) return id;
    return BY_ID[id] || null;
  }

  /** 单牌比较：>0 表示 a 大 */
  function compareCard(a, b) {
    a = getCard(a); b = getCard(b);
    if (a.value !== b.value) return a.value - b.value;
    return a.suitOrder - b.suitOrder;
  }

  function sortAsc(cards) { return cards.slice().sort(compareCard); }
  function sortDesc(cards) { return cards.slice().sort(function (a, b) { return compareCard(b, a); }); }

  /** 组合比较：从最大牌依次比到最小牌，用于同花/顺子等 */
  function compareRankSeq(a, b) {
    a = sortDesc(a); b = sortDesc(b);
    var n = Math.min(a.length, b.length);
    for (var i = 0; i < n; i++) {
      var c = compareCard(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }

  /* ---------------- 牌型判定 ---------------- */

  function countByRank(cards) {
    var map = {};
    cards.forEach(function (c) {
      if (!map[c.rank]) map[c.rank] = { rank: c.rank, value: c.value, cards: [] };
      map[c.rank].cards.push(c);
    });
    return Object.keys(map).map(function (k) { return map[k]; });
  }

  function isFlush(cards) {
    for (var i = 1; i < cards.length; i++) {
      if (cards[i].suit !== cards[0].suit) return false;
    }
    return true;
  }

  /**
   * 判定五张是否为顺子。
   * 顺子按线性序列 2 3 4 5 6 7 8 9 10 J Q K A 取连续五张：
   *   最小常规顺子 2-3-4-5-6，最大顺子 10-J-Q-K-A。
   *   A-2-3-4-5 是唯一特例，作为全局最小顺子（不参与绕圈）。
   * 因此 J-Q-K-A-2、Q-K-A-2-3 这类绕圈组合都不是顺子。
   * 返回 { ok, topValue, topRank, special }
   *   topValue 越大顺子越强
   */
  function straightInfo(cards) {
    var ranks = cards.map(function (c) { return c.rank; });
    if (new Set(ranks).size !== ranks.length) return { ok: false };

    // A-2-3-4-5：特例，最小顺子
    if (RULES.allowA2345) {
      var need = { A: 1, '2': 1, '3': 1, '4': 1, '5': 1 };
      if (cards.every(function (c) { return need[c.rank] === 1; })) {
        return { ok: true, topValue: A2345_VALUE, topRank: '5', special: true };
      }
    }

    var seqs = ranks.map(function (r) { return STRAIGHT_ORDER[r]; }).sort(function (a, b) { return a - b; });
    for (var i = 1; i < seqs.length; i++) {
      if (seqs[i] !== seqs[i - 1] + 1) return { ok: false };
    }

    // 顶端牌 = 自然序列里最大的那张
    var top = cards.reduce(function (best, c) {
      return STRAIGHT_ORDER[c.rank] > STRAIGHT_ORDER[best.rank] ? c : best;
    }, cards[0]);
    return { ok: true, topValue: STRAIGHT_ORDER[top.rank], topRank: top.rank, special: false };
  }

  var CATEGORY_NAME = {
    single: '单张',
    pair: '对子',
    triple: '三条',
    straight: '顺子',
    flush: '同花',
    fullhouse: '葫芦',
    quads: '四条',
    straightflush: '同花顺'
  };

  var CATEGORY_RANK = {
    single: 1, pair: 2, triple: 3,
    straight: 4, flush: 5, fullhouse: 6, quads: 7, straightflush: 8
  };

  /**
   * 分析一组牌（数组），返回
   * { ok, category, cards, value, name, size, ... }
   * value 为「同类别」内可比较的强度值：
   *   单张/对子/三条/四条 -> 主点数 maxValue * 10 + 主花色顺序
   *   顺子/同花顺        -> 顺子顶端牌值
   *   同花               -> 大牌主导的排名序列，用 seq 字段比较
   *   葫芦               -> 三条点数 * 100 + 对子点数
   */
  function analyze(cards) {
    if (!cards || !cards.length) return { ok: false, reason: '没有选择任何牌' };
    cards = cards.map(getCard);
    var n = cards.length;

    if (n === 1) {
      return { ok: true, category: 'single', name: '单张', size: 1, cards: cards, value: cards[0].value * 10 + cards[0].suitOrder, main: cards[0] };
    }

    if (n === 2) {
      if (cards[0].rank !== cards[1].rank) return { ok: false, reason: '两张牌点数不同，不构成对子' };
      var hi2 = sortDesc(cards)[0];
      return { ok: true, category: 'pair', name: '对子', size: 2, cards: cards, value: hi2.value * 10 + hi2.suitOrder, main: hi2 };
    }

    if (n === 3) {
      if (!(cards[0].rank === cards[1].rank && cards[1].rank === cards[2].rank)) {
        return { ok: false, reason: '三张牌点数不同，不构成三条' };
      }
      var hi3 = sortDesc(cards)[0];
      return { ok: true, category: 'triple', name: '三条', size: 3, cards: cards, value: hi3.value * 10 + hi3.suitOrder, main: hi3 };
    }

    if (n !== 5) {
      return { ok: false, reason: '只能出 1、2、3 或 5 张牌' };
    }

    /* ---- 五张牌型 ---- */
    var groups = countByRank(cards).sort(function (a, b) { return b.cards.length - a.cards.length || b.value - a.value; });
    var flush = isFlush(cards);
    var st = straightInfo(cards);
    var desc = sortDesc(cards);

    // 顺子/同花顺「比花色」用顺子顶端牌（34567 取 7，A2345 取 5），
    // 不能用改版点数最大的那张（3 > 2 > ... 会取到 3，导致同段顺子比花色结论相反）。
    var straightTop = st.ok ? (cards.filter(function (c) { return c.rank === st.topRank; })[0] || desc[0]) : null;

    if (flush && st.ok) {
      return {
        ok: true, category: 'straightflush', name: '同花顺', size: 5, cards: cards,
        value: st.topValue,
        topRank: st.topRank, special: st.special, main: straightTop, flushSuit: straightTop.suit
      };
    }

    if (groups[0].cards.length === 4) {
      var qc = sortDesc(groups[0].cards);
      return {
        ok: true, category: 'quads', name: '四条', size: 5, cards: cards,
        value: qc[0].value * 10 + qc[0].suitOrder,
        quadRank: groups[0].rank, kicker: groups[1] ? groups[1].rank : null, main: qc[0]
      };
    }

    if (groups[0].cards.length === 3 && groups[1] && groups[1].cards.length === 2) {
      var tc = sortDesc(groups[0].cards)[0];
      var pc = sortDesc(groups[1].cards)[0];
      return {
        ok: true, category: 'fullhouse', name: '葫芦', size: 5, cards: cards,
        value: tc.value * 100 + pc.value,
        tripleRank: groups[0].rank, pairRank: groups[1].rank, main: tc
      };
    }

    if (flush) {
      return {
        ok: true, category: 'flush', name: '同花', size: 5, cards: cards,
        value: desc[0].value, seq: desc, suit: desc[0].suit, main: desc[0]
      };
    }

    if (st.ok) {
      return {
        ok: true, category: 'straight', name: '顺子', size: 5, cards: cards,
        value: st.topValue, topRank: st.topRank, special: st.special, main: straightTop
      };
    }

    if (groups[0].cards.length === 3) return { ok: false, reason: '三张 + 两张不同点，只能组成三条或葫芦，五张需为葫芦' };
    if (groups[0].cards.length === 2) return { ok: false, reason: '五张牌里没有可识别的牌型（顺子 / 同花 / 葫芦 / 四条 / 同花顺）' };
    return { ok: false, reason: '这五张牌不构成任何合法牌型' };
  }

  function isFive(play) { return play && play.size === 5; }

  /** 顺子自然顺序排序：A 最大、3/2 最小。仅供顺子相关场景使用，不用于同花比较 */
  function sortByStraightOrderDesc(cards) {
    return cards.slice().sort(function (a, b) {
      return STRAIGHT_ORDER[b.rank] - STRAIGHT_ORDER[a.rank] || b.suitOrder - a.suitOrder;
    });
  }

  /**
   * 同花比较：先比花色（♠ > ♥ > ♣ > ♦），花色相同再比点数
   * （3 > 2 > A > K > ... > 4）：先比最大牌，最大牌相同再逐张比下去。
   * >0 表示 a 大
   */
  function compareFlush(a, b) {
    var as = sortDesc(a), bs = sortDesc(b); // 同花内部同花色，sortDesc 即改版点数从大到小
    var sd = as[0].suitOrder - bs[0].suitOrder;   // 1) 先比花色（♠>♥>♣>♦）
    if (sd !== 0) return sd;
    for (var i = 0; i < 5; i++) {                 // 2) 花色相同 → 先比最大牌，再逐张
      var d = as[i].value - bs[i].value;
      if (d !== 0) return d;
    }
    return 0;
  }

  /**
   * b 能否压过 a（a 为桌上当前最大，null 表示 b 自由领出）
   * 返回 { ok, reason }
   *
   * 张数规则：只能同张数互比。五张牌型只和五张比（不能用三带二去压三条），
   * 但五张之间不要求同一牌型：同花顺/四条/葫芦/同花/顺子可以互压，按级别决出胜负。
   */
  function canBeat(b, a) {
    if (!b || !b.ok) return { ok: false, reason: (b && b.reason) || '牌型不合法' };
    if (!a) return { ok: true };

    if (b.size !== a.size) {
      return {
        ok: false,
        reason: '张数不同：桌上出的是' + a.name + '（' + a.size + ' 张），只能出 ' + a.size + ' 张来压'
      };
    }

    // 非五张：牌型必须一致
    if (!isFive(b) && b.category !== a.category) {
      return { ok: false, reason: '牌型不同：需要出' + a.name };
    }

    var c = comparePlay(b, a);
    if (c > 0) return { ok: true };
    return { ok: false, reason: '压不过桌上的' + a.name + ' ' + cardsText(a.cards) };
  }

  /** 同张数之间比较，>0 表示 b 大 */
  function comparePlay(b, a) {
    // 五张之间：先比牌型级别（同花顺 > 四条 > 葫芦 > 同花 > 顺子），
    // 级别相同再比牌力：同花「先花色、后点数」(见 compareFlush)，顺子/同花顺「先顺子、后花色」。
    if (isFive(b) && isFive(a)) {
      var lv = (CATEGORY_RANK[b.category] || 0) - (CATEGORY_RANK[a.category] || 0);
      if (lv !== 0) return lv;
    }
    if (b.category !== a.category) {
      return (CATEGORY_RANK[b.category] || 0) - (CATEGORY_RANK[a.category] || 0);
    }
    if (b.category === 'flush') {
      return compareFlush(b.cards, a.cards) || 0;
    }
    if (b.category === 'fullhouse') {
      return (b.tripleRank ? RANK_VALUE[b.tripleRank] : 0) - (a.tripleRank ? RANK_VALUE[a.tripleRank] : 0)
        || (b.pairRank ? RANK_VALUE[b.pairRank] : 0) - (a.pairRank ? RANK_VALUE[a.pairRank] : 0);
    }
    if (b.category === 'straight' || b.category === 'straightflush') {
      if (b.value !== a.value) return b.value - a.value;
      // 同一段顺子（比如双方都是 56789）：比最大牌的花色
      return b.main.suitOrder - a.main.suitOrder;
    }
    return b.value - a.value; // single / pair / triple / quads
  }

  /* ---------------- 手牌「最少几手走完」评估 ----------------
     用于 AI 判断手牌结构：把一手牌拆成最少的出牌次数。

     同点数内部：c 张牌最少 ceil(c/3) 手（1 张=单张、2 张=对子、3 张=三条，
     4 张=三条+单张，因为不能出四张）。所以只按点数分组求和就是**一个上界**。
     五张牌型（顺子/同花/葫芦/四条/同花顺）可能更省手，所以在这个上界的基础上
     用带记忆化的搜索去找更少的方案；搜索以「不拆散同点数组合」为原则
     （把三条拆成对子+单张永远不划算），再用访问上限兜底性能。
     ----------------------------------------------------------- */

  var _planCache = {};
  var _planCacheSize = 0;
  var PLAN_CACHE_MAX = 20000;      // 上限，防止长期运行把内存吃满

  /** 生成所有「不拆散同点数组合」的五张牌型候选 */
  function fivePatterns(cards) {
    var out = [];
    var groups = groupByRank(cards);
    var cnt = {};
    groups.forEach(function (g) { cnt[g.rank] = g.cards.length; });

    function safe(g) { return (cnt[g.rank] || 0) - g.cards.length !== 1; } // 不用得只剩 1 张孤牌

    // 四条（四张 + 任意一张；四张本身不能出，必须带一张）
    groups.forEach(function (g) {
      if (g.cards.length !== 4) return;
      groups.forEach(function (k) {
        if (k.rank === g.rank) return;
        k.cards.forEach(function (c) {
          out.push(g.cards.concat([c]));
        });
      });
    });

    // 葫芦（三条 + 对子）
    groups.forEach(function (g) {
      if (g.cards.length < 3) return;
      groups.forEach(function (k) {
        if (k.rank === g.rank || k.cards.length < 2) return;
        for (var a = 0; a < 3; a++) {
          for (var b = a + 1; b < 3; b++) {
            out.push([g.cards[a], g.cards[b], g.cards[3 - a - b], k.cards[0], k.cards[1]]);
          }
        }
      });
    });

    // 顺子（按自然序列 2..A 取连续五张；A-2-3-4-5 由下面这个特例覆盖）
    var ORDER = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    var byRank = {};
    groups.forEach(function (g) { byRank[g.rank] = g.cards; });

    // 枚举「某段连续 5 个点数」能凑出的顺子。
    // 每个点数可以取 1 张或 2 张（同点数在顺子里最多相邻两次），
    // 总数必须恰好 5 张；并且不允许把某个点数拆得恰好剩 1 张。
    function picksFor(run) {
      var out2 = [];
      function rec(k, acc, used) {
        if (used > 5) return;
        if (k === run.length) {
          if (used === 5) out2.push(acc);
          return;
        }
        var list = byRank[run[k]];
        if (!list || !list.length) return;
        var maxTake = Math.min(2, list.length);
        for (var t = 1; t <= maxTake; t++) {
          if (used + t > 5) break;
          rec(k + 1, acc.concat(list.slice(0, t)), used + t);
        }
      }
      rec(0, [], 0);
      return out2.filter(function (p) {
        var u = {};
        p.forEach(function (c) { u[c.rank] = (u[c.rank] || 0) + 1; });
        // 只拒绝这一种拆坏：同点数拿走了 2 张以上、却正好剩 1 张孤牌
        // （例：从三条里拿 2 张凑顺子）。拿 1 张剩 1 张不算拆坏——
        // 手里有 88 时，用一张 8 凑顺子 + 剩一张单 8，是「顺子 + 单张」= 2 手，很划算。
        return !Object.keys(u).some(function (r) {
          return u[r] >= 2 && (cnt[r] || 0) - u[r] === 1;
        });
      });
    }

    for (var i = 0; i + 4 < ORDER.length; i++) {
      var runs = [[ORDER[i], ORDER[i + 1], ORDER[i + 2], ORDER[i + 3], ORDER[i + 4]]];
      if (i === 0) runs.push(['A', '2', '3', '4', '5']);   // 特例最小顺子
      runs.forEach(function (run) {
        picksFor(run).forEach(function (p) { out.push(p); });
      });
    }

    // 同花（人少时才有意义，最多取同花色里最小的 5 张不要留大牌）
    var bySuit = {};
    cards.forEach(function (c) {
      (bySuit[c.suit] = bySuit[c.suit] || []).push(c);
    });
    Object.keys(bySuit).forEach(function (s) {
      var list = sortAsc(bySuit[s]);
      if (list.length < 5) return;
      for (var a = 0; a + 4 < list.length; a++) {
        var five = list.slice(a, a + 5);
        var u = {};
        five.forEach(function (c) { u[c.rank] = (u[c.rank] || 0) + 1; });
        var bad = Object.keys(u).some(function (r) { return (cnt[r] || 0) - u[r] === 1; });
        if (!bad) out.push(five);
      }
    });

    return out;
  }

  function cardsKey(cards) {
    return cards.map(function (c) { return c.id; }).sort().join(',');
  }

  /**
   * 手牌最少需要几手才能走完。
   * 策略：先按「同点数分组」得到一个上界，再尝试用五张牌型替换掉若干组，
   * 使手数更少；搜索带记忆化与剪枝。
   */
  function minHands(cards) {
    cards = cards.map(getCard);
    if (!cards.length) return 0;
    var key = cardsKey(cards);
    if (_planCache[key] !== undefined) return _planCache[key];

    // 上界：同点数分组，每组 ceil(c/3)
    function groupedBound(list) {
      var gs = groupByRank(list), n = 0;
      gs.forEach(function (g) { n += Math.ceil(g.cards.length / 3); });
      return n;
    }

    var upper = groupedBound(cards);
    var patterns = fivePatterns(cards);
    var best = upper;
    var visits = 0;
    var CAP = 4000;

    function search(remain, used) {
      if (visits++ > CAP || used >= best) return;
      if (!remain.length) { best = used; return; }

      var lb = groupedBound(remain);
      // 剩下的牌用分组方式收尾：这也是一种可行方案
      if (used + lb < best) best = used + lb;
      // 即使所有剩余牌都能凑成五张牌型，也至少还要 ceil(n/5) 手
      if (used + Math.ceil(remain.length / 5) >= best) return;

      var have = {};
      remain.forEach(function (c) { have[c.id] = 1; });
      for (var i = 0; i < patterns.length; i++) {
        var pat = patterns[i];
        var okAll = true;
        for (var j = 0; j < pat.length; j++) {
          if (!have[pat[j].id]) { okAll = false; break; }
        }
        if (!okAll) continue;
        search(removeCards(remain, pat), used + 1);
      }
    }

    if (patterns.length) search(cards, 0);

    // 缓存写入（带容量上限：超了就整体清空，避免无限增长）
    if (_planCacheSize >= PLAN_CACHE_MAX) { _planCache = {}; _planCacheSize = 0; }
    _planCache[key] = best;
    _planCacheSize++;
    return best;
  }

  /** 清空缓存（换局时调用即可） */
  function clearPlanCache() { _planCache = {}; _planCacheSize = 0; }

  /* ---------------- 文本与工具 ---------------- */

  function cardText(c) {
    c = getCard(c);
    return c.sym + c.rank;
  }

  function cardsText(cards) {
    return sortDesc(cards.map(getCard)).map(cardText).join(' ');
  }

  function playText(play) {
    if (!play || !play.cards) return '';
    return play.name + '：' + cardsText(play.cards);
  }

  /** 手牌分组：同点数，点数从大到小 */
  function groupByRank(hand) {
    var map = {};
    hand.forEach(function (c) {
      if (!map[c.rank]) map[c.rank] = [];
      map[c.rank].push(c);
    });
    return Object.keys(map).map(function (r) {
      return { rank: r, value: RANK_VALUE[r], cards: sortDesc(map[r]) };
    }).sort(function (a, b) { return b.value - a.value; });
  }

  function hasCard(hand, id) {
    return hand.some(function (c) { return c.id === id; });
  }

  /* ---------------- 合法出牌生成 ---------------- */

  // 生成所有 5 张组合
  function combinations5(arr) {
    var out = [], n = arr.length;
    for (var a = 0; a < n - 4; a++)
      for (var b = a + 1; b < n - 3; b++)
        for (var c = b + 1; c < n - 2; c++)
          for (var d = c + 1; d < n - 1; d++)
            for (var e = d + 1; e < n; e++)
              out.push([arr[a], arr[b], arr[c], arr[d], arr[e]]);
    return out;
  }

  function findFivePlays(hand, mustInclude) {
    var out = [], seen = {};
    var req = mustInclude || null;
    var mine = {};
    // mustInclude 过滤前置：避免对不可能入选的组合做完整牌型分析（17~18 张手牌时开销明显）
    if (req) hand.forEach(function (c) { if (c.id === req) mine[c.id] = 1; });

    combinations5(hand).forEach(function (combo) {
      if (req) {
        var has = false;
        for (var i = 0; i < 5; i++) if (mine[combo[i].id]) { has = true; break; }
        if (!has) return;
      }
      var p = analyze(combo);
      if (p.ok && p.size === 5) {
        // 四条是「四张 + 1」，同一组四条只需要一个代表（带最小脚牌）
        if (p.category === 'quads') {
          var key = p.category + '|' + p.value;
          if (seen[key]) return;
          seen[key] = 1;
        }
        out.push(p);
      }
    });
    return out;
  }

  // 合法出牌结果缓存：同一手牌 + 同一目标 + 同一约束 -> 复用，
  // 避免人类每次点牌都重新枚举五张组合
  var _moveCache = { key: null, value: null };

  /** 候选排序：先出张数少的（少拆牌），同张数再比牌力 */
  function bySizeThenPower(a, b) {
    return (a.cards.length - b.cards.length) || (playPower(a) - playPower(b));
  }

  function handKey(hand) {
    return hand.map(function (c) { return c.id; }).sort().join(',');
  }

  /**
   * 生成所有能压过 target 的出牌（target 为 null 时=领出，返回全部候选）
   * options: { maxResults, mustInclude:'4D', noFive, noCache }
   *
   * 张数规则：五张只和五张比，一/二/三张只和同张数比。
   */
  function findBeatingPlays(hand, target, options) {
    options = options || {};
    hand = hand.slice();

    var mustInclude = options.mustInclude || null;
    var cacheKey = handKey(hand) + '|' + (target ? target.category + target.size + target.value + (target.main ? target.main.id : '') : '-') +
      '|' + (mustInclude || '-') + '|' + (options.maxResults || 0) + '|' + (options.noFive ? 1 : 0);
    if (!options.noCache && _moveCache.key === cacheKey) return _moveCache.value;

    var results = [];

    function allowed(play) {
      if (mustInclude && !play.cards.some(function (c) { return c.id === mustInclude; })) return false;
      return true;
    }

    var targetIsFive = isFive(target);

    // 五张牌型：只有领出、或桌上也是五张时才考虑（五张不能压单张/对子/三条）
    if (!options.noFive && (!target || targetIsFive)) {
      var fives = findFivePlays(hand, mustInclude).filter(function (p) {
        return (!target || comparePlay(p, target) > 0);
      });
      results = results.concat(fives);
    }

    if (!targetIsFive) {
      var size = target ? target.size : null;
      var groups = groupByRank(hand);

      if (size === null || size === 1) {
        groups.forEach(function (g) {
          g.cards.forEach(function (c) {
            var p = analyze([c]);
            if (allowed(p) && (!target || canBeat(p, target).ok)) results.push(p);
          });
        });
      }
      if (size === null || size === 2) {
        groups.forEach(function (g) {
          if (g.cards.length >= 2) {
            for (var i = 0; i < g.cards.length - 1; i++)
              for (var j = i + 1; j < g.cards.length; j++) {
                var p = analyze([g.cards[i], g.cards[j]]);
                if (allowed(p) && (!target || canBeat(p, target).ok)) results.push(p);
              }
          }
        });
      }
      if (size === null || size === 3) {
        groups.forEach(function (g) {
          if (g.cards.length >= 3) {
            for (var i = 0; i < g.cards.length - 2; i++)
              for (var j = i + 1; j < g.cards.length - 1; j++)
                for (var k = j + 1; k < g.cards.length; k++) {
                  var p = analyze([g.cards[i], g.cards[j], g.cards[k]]);
                  if (allowed(p) && (!target || canBeat(p, target).ok)) results.push(p);
                }
          }
        });
      }
    }

    // 去重（按牌 id 排序组合）
    var uniq = {}, out = [];
    results.forEach(function (p) {
      var key = p.cards.map(function (c) { return c.id; }).sort().join(',');
      if (!uniq[key]) { uniq[key] = 1; out.push(p); }
    });

    out.sort(bySizeThenPower);
    if (options.maxResults && out.length > options.maxResults) out = out.slice(0, options.maxResults);

    if (!options.noCache) _moveCache = { key: cacheKey, value: out };
    return out;
  }

  function clearMoveCache() { _moveCache = { key: null, value: null }; }

  /** 出牌「代价」排序：越小越省牌 */
  function playPower(p) {
    var cat = CATEGORY_RANK[p.category] || 0;
    if (p.category === 'flush') {
      // 同花：先花色（♠>♥>♣>♦）再点数（3 最大）再逐张，与 compareFlush 同口径
      var d = sortDesc(p.cards);
      var seq = 0;
      for (var i = 0; i < d.length; i++) seq = seq * 14 + d[i].value;
      return cat * 10000000 + d[0].suitOrder * 1000000 + seq;
    }
    return cat * 10000000 + (p.value || 0) * 1000 + (p.main ? p.main.suitOrder : 0);
  }

  /** 从 set 中移除 cards，返回新数组 */
  function removeCards(set, cards) {
    var ids = {};
    cards.forEach(function (c) { ids[c.id] = 1; });
    return set.filter(function (c) { return !ids[c.id]; });
  }

  /* ---------------- 导出 ---------------- */
  var api = {
    SUITS: SUITS, SUIT_ORDER: SUIT_ORDER, RANK_VALUE: RANK_VALUE, RANK_DESC: RANK_DESC,
    RANKS: RANKS, RULES: RULES, ALL_CARDS: ALL_CARDS, CATEGORY_NAME: CATEGORY_NAME,
    CATEGORY_RANK: CATEGORY_RANK,
    getCard: getCard, compareCard: compareCard, compareRankSeq: compareRankSeq,
    sortAsc: sortAsc, sortDesc: sortDesc, countByRank: countByRank,
    isFlush: isFlush, straightInfo: straightInfo, analyze: analyze,
    canBeat: canBeat, comparePlay: comparePlay, isFive: isFive,
    compareFlush: compareFlush, STRAIGHT_ORDER: STRAIGHT_ORDER, sortByStraightOrderDesc: sortByStraightOrderDesc,
    cardText: cardText, cardsText: cardsText, playText: playText,
    groupByRank: groupByRank, hasCard: hasCard,
    findFivePlays: findFivePlays, findBeatingPlays: findBeatingPlays, clearMoveCache: clearMoveCache,
    bySizeThenPower: bySizeThenPower,
    minHands: minHands, fivePatterns: fivePatterns, clearPlanCache: clearPlanCache,
    playPower: playPower, removeCards: removeCards
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
