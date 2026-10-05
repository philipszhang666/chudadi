/* ============================================================
 * game.js —— 改版锄大地：游戏状态机（发牌 / 轮转 / 过牌 / 结算）
 * 依赖 cards.js（浏览器里为全局 CD）
 * ============================================================ */

var Game = (function () {
  'use strict';

  var _CD = (typeof module !== 'undefined' && module.exports) ? require('./cards.js') : CD;

  // 名字按「先给敌方席位、最后给对人类」的顺序取，保证人类是 0 号
  //   4 人：[你, 西家, 北家, 东家]
  //   3 人：[你, 西家, 东家]
  var NAMES_BY_COUNT = {
    3: ['你', '西家', '东家'],
    4: ['你', '西家', '北家', '东家']
  };

  var SUPPORTED_COUNTS = [3, 4];

  // 计分规则：按剩余张数，每张 1 分；剩余 >= 10 张翻倍
  var SCORE = { perCard: 1, doubleAt: 10, doubleTimes: 2 };

  function shuffle(arr, rng) {
    rng = rng || Math.random;
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function playerCountOf(state) { return state.players.length; }

  /**
   * 创建一局新游戏
   * options: { playerCount: 3|4, rng, deck }
   *
   * 发牌：52 张按人数均分，分不尽的余牌随机发给某人（多抓一张）。
   *   4 人 → 每人 13 张
   *   3 人 → 两人 17 张、一人 18 张（余 1 张随机补给）
   */
  function newGame(options) {
    options = options || {};
    var count = options.playerCount || 4;
    if (!NAMES_BY_COUNT[count]) count = 4;
    var names = NAMES_BY_COUNT[count];

    var deck = options.deck ? options.deck.slice() : shuffle(_CD.ALL_CARDS, options.rng);

    var base = Math.floor(deck.length / count);
    var extra = deck.length - base * count;      // 余牌数：4人=0，3人=1

    // 先按整数份分好，再把余牌随机补给 extra 个玩家
    var counts = [];
    for (var i = 0; i < count; i++) counts.push(base);
    var order = shuffle(names.map(function (_, idx) { return idx; }), options.rng);
    for (var e = 0; e < extra; e++) counts[order[e]]++;

    var players = [];
    var cursor = 0;
    for (var k = 0; k < count; k++) {
      players.push({
        index: k,
        name: names[k],
        isHuman: k === 0,
        hand: _CD.sortDesc(deck.slice(cursor, cursor + counts[k])),
        dealt: counts[k],   // 本局发到的张数（用于显示余牌）
        played: [],         // 本墩已出的牌（用于界面）
        lastPlay: null,     // 本墩最后一次有效出牌
        passed: false,
        finished: false,
        rank: 0,            // 名次：1=头游
        penalty: 0,
        announced: false    // 是否已报牌（剩 1 张）
      });
      cursor += counts[k];
    }

    var leader = players.findIndex(function (p) {
      return p.hand.some(function (c) { return c.id === _CD.RULES.firstCard; });
    });
    if (leader < 0) leader = 0;

    var state = {
      playerCount: count,
      deckSize: deck.length,
      extraCard: extra > 0 ? { count: extra, to: order.slice(0, extra) } : null,
      players: players,
      starter: leader,          // 本局首出者（持 ♦4）
      turn: leader,
      trick: [],                // 本墩出牌记录 { player, play }
      lastTrick: [],            // 刚结束的一墩（界面显示「上一墩」用）
      current: null,            // 当前桌上最大牌（play 对象）
      currentOwner: null,       // 当前最大牌的出牌人
      passCount: 0,
      isFirstPlay: true,        // 本局第一手：必须包含 ♦4
      phase: 'playing',         // playing | over
      round: 1,                 // 第几墩
      humanIndex: 0,
      log: [],
      result: null,
      moveCount: 0,
      played: {},               // 已出过的牌 id 集合（供 AI 记牌）
      fivePlays: 0,             // 已经出过几手五张牌（供 AI 判断外面的五张还剩多少）
      passes: [],               // 过牌反推（hardv3）：{player, play} —— 该家压不过 play
      finishCount: 0,           // A3 地主：已经出完牌的人数（用来定名次）
      revealed: {},             // A3 地主：♠A / ♠3 是否已亮出（id -> 出牌人 index）
      landlord: null,           // A3 地主：暗队信息（未启用时为 null）
      nonA3ToLast: false        // 非 A3「打到末游」：按名次判胜负（A3 局恒为 false）
    };

    // A3 地主：持 ♠A 与 ♠3 的两家自动成一队（暗队，开局不公开身份）
    if (options.landlord && count === 4) {
      var holderA = players.findIndex(function (pl) {
        return pl.hand.some(function (c) { return c.id === 'AS'; });
      });
      var holder3 = players.findIndex(function (pl) {
        return pl.hand.some(function (c) { return c.id === '3S'; });
      });
      state.landlord = {
        enabled: true,
        holderA: holderA,
        holder3: holder3,
        solo: holderA === holder3,                 // 一人同时拿 ♠A♠3
        members: holderA === holder3 ? [holderA] : [holderA, holder3],
        cards: ['AS', '3S']
      };
    }

    // 非 A3「打到末游」开关：只在非 A3 局生效（A3 有自己的结束判定）
    state.nonA3ToLast = !!options.nonA3ToLast && !state.landlord;

    pushLog(state, '开局：' + count + ' 人局，每人 ' + base + ' 张');
    if (state.landlord) pushLog(state, 'A3 地主：♠A 与 ♠3 各归其主，身份保密');
    if (extra > 0) {
      var extraNames = order.slice(0, extra).map(function (idx) { return players[idx].name; }).join('、');
      pushLog(state, '余下 ' + extra + ' 张随机补给：' + extraNames + '（' + (base + 1) + ' 张）');
    }
    pushLog(state, players[leader].name + ' 持 ' + _CD.cardText(_CD.getCard(_CD.RULES.firstCard)) + '（全场最小），先出牌');
    return state;
  }

  function pushLog(state, text) {
    state.log.push(text);
  }

  function human(state) { return state.players[state.humanIndex]; }

  /** 当前出牌者需要满足的额外条件 */
  function currentConstraint(state) {
    return state.isFirstPlay ? { mustInclude: _CD.RULES.firstCard } : {};
  }

  /** 枚举当前出牌者的全部合法出牌（由弱到强） */
  function legalMoves(state) {
    var p = state.players[state.turn];
    var opts = currentConstraint(state);
    var plays = _CD.findBeatingPlays(p.hand, state.current, opts);
    if (opts.mustInclude) {
      // 首出必须带 ♦4：同花 / 顺子等也允许，但必须严格是合法牌型
      plays = plays.filter(function (pl) {
        return pl.cards.some(function (c) { return c.id === _CD.RULES.firstCard; });
      });
    }
    return plays;
  }

  /** 玩家是否能压过桌上的牌 */
  function mustPass(state) {
    return state.current !== null && legalMoves(state).length === 0;
  }

  /** 出牌。返回 { ok, reason, trickEnded, gameOver } */
  function play(state, playerIndex, cards) {
    if (state.phase === 'over') return { ok: false, reason: '本局已结束' };
    if (state.turn !== playerIndex) return { ok: false, reason: '还没轮到你出牌' };

    var p = state.players[playerIndex];
    var list = (cards || []).map(_CD.getCard);
    if (list.some(function (c) { return !c; })) return { ok: false, reason: '未知的牌' };

    // 必须是手里的牌
    var handIds = {};
    p.hand.forEach(function (c) { handIds[c.id] = 1; });
    var dup = {};
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!handIds[c.id]) return { ok: false, reason: '你没有 ' + _CD.cardText(c) };
      if (dup[c.id]) return { ok: false, reason: '同一张牌不能出两次' };
      dup[c.id] = 1;
    }

    var playObj = _CD.analyze(list);
    if (!playObj.ok) return { ok: false, reason: playObj.reason };

    // 首出必须含 ♦4
    if (state.isFirstPlay) {
      var need = _CD.RULES.firstCard;
      if (!list.some(function (c) { return c.id === need; })) {
        return { ok: false, reason: '本局第一手必须包含 ' + _CD.cardText(_CD.getCard(need)) };
      }
    }

    if (state.current) {
      var chk = _CD.canBeat(playObj, state.current);
      if (!chk.ok) return { ok: false, reason: chk.reason };
    }

    // 执行出牌
    p.hand = _CD.removeCards(p.hand, list);
    p.played = list;
    p.lastPlay = playObj;
    p.passed = false;
    p.announced = p.hand.length === 1;

    state.trick.push({ player: playerIndex, play: playObj, passed: false });
    state.current = playObj;
    state.currentOwner = playerIndex;
    state.passCount = 0;
    state.isFirstPlay = false;
    state.moveCount++;
    if (list.length === 5) state.fivePlays++;
    list.forEach(function (c) { state.played[c.id] = 1; });

    // A3 地主：♠A / ♠3 亮出时记下是谁出的（公开信息）
    if (state.landlord) {
      list.forEach(function (c) {
        if ((c.id === 'AS' || c.id === '3S') && state.revealed[c.id] === undefined) {
          state.revealed[c.id] = playerIndex;
        }
      });
    }

    pushLog(state, p.name + ' 出 ' + _CD.playText(playObj) + (p.announced ? '（报牌！剩 1 张）' : ''));

    var trickEnded = false, gameOver = false;

    if (p.hand.length === 0) {
      p.finished = true;
      if (state.landlord || state.nonA3ToLast) {
        // 「打完排名次」的两类模式（A3 地主 / 非 A3 打到末游）：
        // 出完一家先记名次，再看该模式的结束条件是否满足。
        state.finishCount++;
        p.rank = state.finishCount;
        if (finishedDecided(state)) {
          gameOver = true;
          endGame(state);
        } else {
          advance(state);
          trickEnded = settleTrick(state);
        }
      } else {
        gameOver = true;
        endGame(state, playerIndex);
      }
    } else {
      advance(state);
      // 其余所有玩家都过牌 => 本墩结束，最后出牌者重新领出
      trickEnded = settleTrick(state);
    }

    return { ok: true, trickEnded: trickEnded, gameOver: gameOver, play: playObj };
  }

  /** 过牌 */
  function pass(state, playerIndex) {
    if (state.phase === 'over') return { ok: false, reason: '本局已结束' };
    if (state.turn !== playerIndex) return { ok: false, reason: '还没轮到你' };
    if (state.current === null) return { ok: false, reason: '领出时不能过牌，必须出牌' };
    if (legalMoves(state).length > 0 && state.forcePass !== true) {
      // 允许主动过牌（战术），但界面会提示
    }

    var p = state.players[playerIndex];
    p.passed = true;
    p.played = [];
    state.trick.push({ player: playerIndex, play: null, passed: true });
    state.passCount++;
    if (state.current) state.passes.push({ player: playerIndex, play: state.current });
    pushLog(state, p.name + ' 过牌');

    advance(state);
    var trickEnded = settleTrick(state);
    return { ok: true, trickEnded: trickEnded, gameOver: false };
  }

  function advance(state) {
    var n = state.players.length;
    var guard = 0;
    do {
      state.turn = (state.turn + 1) % n;
      guard++;
      // 已出完的玩家自动跳过（多局模式下才会出现）
    } while (state.players[state.turn].finished && guard < n * 2);
  }

  /** 还有牌的玩家数 */
  function activeCount(state) {
    var n = 0;
    state.players.forEach(function (p) { if (p.hand.length > 0) n++; });
    return n;
  }

  /**
   * 一墩是否结束（桌上其他人全部过牌）。
   *   · 领出者手里还有牌 → 除他以外的人都过了即可（active - 1）
   *   · 领出者已出完（A3 地主里会出现）→ 所有还有牌的人都过了才算（active）
   * 结束时清桌，并由（还出得了牌的）领出者重新领出。
   */
  function settleTrick(state) {
    if (state.current === null) return false;
    var active = activeCount(state);
    var ownerActive = state.currentOwner !== null && state.players[state.currentOwner].hand.length > 0;
    var need = ownerActive ? active - 1 : active;
    if (state.passCount >= need) {
      startNewTrick(state);
      return true;
    }
    return false;
  }

  /** 一墩结束：桌上清空，最后出牌者领出 */
  function startNewTrick(state) {
    var owner = state.currentOwner;
    state.players.forEach(function (p) {
      if (p.index !== owner) { p.played = []; p.passed = false; }
    });
    state.players[owner].lastPlay = null;
    state.current = null;
    state.currentOwner = null;
    state.passCount = 0;
    state.lastTrick = state.trick;   // 先记下刚结束的一墩（含最后那个「过牌」），再清空
    state.trick = [];
    state.round++;
    state.turn = owner;
    // A3 地主：领出权归最后出牌的人；若他刚好已出完，交给下一个还有牌的人
    if (state.players[owner].hand.length === 0) {
      var n = state.players.length, t = owner, guard = 0;
      do { t = (t + 1) % n; guard++; } while (state.players[t].hand.length === 0 && guard <= n);
      state.turn = t;
    }
    pushLog(state, '—— 第 ' + state.round + ' 墩：' + state.players[state.turn].name + ' 领出 ——');
  }

  /**
   * 出完一家后，本局是否该结束（用于「打完排名次」的两类模式）。
   *   · A3 地主 → 交给 landlordDecided；
   *   · 非 A3「打到末游」→ 玩家名次已定就结束：
   *       玩家自己出完 → 名次既定（第 1 名＝胜 / 第 2 名＝平 / 第 3、4 名＝负）；
   *       已有两名玩家出完而玩家还没出完 → 玩家最好只能第 3 名 → 判负。
   */
  function finishedDecided(state) {
    if (state.landlord) return landlordDecided(state);
    if (state.players[state.humanIndex].finished) return true;
    return state.finishCount >= 2;
  }

  /**
   * A3 地主：终局胜负是否已定（定了就立即结算，不必再打到末游）。
   *   ① 只剩最后一名有牌（末游）—— 原兜底规则；
   *   ② 已出完的前两名同队 —— 两队的名次和随即固定，胜负已定；
   *   ③ 独地主（一人独拿 ♠A♠3）本人已出完 —— 他的名次直接决定胜/平/负。
   */
  function landlordDecided(state) {
    var players = state.players;
    var remaining = players.filter(function (q) { return q.hand.length > 0; });
    if (remaining.length <= 1) return true;

    var ll = state.landlord;
    if (ll.solo && players[ll.members[0]].finished) return true;

    var finished = players.filter(function (q) { return q.rank; })
      .sort(function (a, b) { return a.rank - b.rank; });
    if (finished.length >= 2) {
      var aLand = ll.members.indexOf(finished[0].index) >= 0;
      var bLand = ll.members.indexOf(finished[1].index) >= 0;
      if (aLand === bLand) return true;
    }
    return false;
  }

  /**
   * 结算
   * 计分：每个输家按剩余张数扣分（每张 perCard 分，≥10 张翻倍）；
   * 赢家得分 = 所有输家失分之和（人数越多赢得越多）。
   */
  function endGame(state, winnerIndex) {
    state.phase = 'over';
    var players = state.players;
    var order;

    if (state.landlord || state.nonA3ToLast) {
      // 打完排名次（A3 地主 / 非 A3 打到末游）：出完的按出完先后（rank 已定）；
      // 提前结束时可能仍有多家捏着牌，这些没出完的按剩余张数从少到多补名次。
      var rated = players.filter(function (p) { return p.rank; }).length;
      players.filter(function (p) { return !p.rank; })
        .sort(function (a, b) { return a.hand.length - b.hand.length; })
        .forEach(function (p) { p.rank = ++rated; });
      order = players.slice()
        .sort(function (a, b) { return a.rank - b.rank; })
        .map(function (p) { return p.index; });
    } else {
      order = [winnerIndex];
      // 名次按剩余张数从少到多
      var rest = players.filter(function (p) { return p.index !== winnerIndex; })
        .sort(function (a, b) { return a.hand.length - b.hand.length; });
      rest.forEach(function (p) { order.push(p.index); });
      order.forEach(function (idx, i) { players[idx].rank = i + 1; });
    }

    // 计分（界面已不再显示，保留旧口径以免影响其它代码）
    var winnerGain = 0;
    order.forEach(function (idx, i) {
      var p = players[idx];
      var pen = 0;
      if (i > 0) {
        pen = p.hand.length * SCORE.perCard;
        if (p.hand.length >= SCORE.doubleAt) pen *= SCORE.doubleTimes;
      }
      p.penalty = pen;
      if (i > 0) winnerGain += pen;
    });
    players[order[0]].penalty = -winnerGain;

    var landlord = state.landlord ? buildLandlordResult(state) : null;
    var rankOutcome = function (r) { return r === 1 ? 'win' : (r === 2 ? 'draw' : 'lose'); };

    var detail = [];
    order.forEach(function (idx, i) {
      var p = players[idx];
      detail.push({
        index: idx, name: p.name, rank: p.rank, rest: p.hand.length,
        restCards: _CD.sortDesc(p.hand), penalty: p.penalty,
        doubled: i > 0 && p.hand.length >= SCORE.doubleAt,
        team: landlord ? (landlord.members.indexOf(idx) >= 0 ? 'landlord' : 'farmer') : null,
        outcome: landlord ? landlord.playerOutcome[idx]
               : (state.nonA3ToLast ? rankOutcome(p.rank) : (i === 0 ? 'win' : 'lose'))
      });
    });

    state.result = {
      winner: order[0], order: order, detail: detail,
      winnerGain: winnerGain, playerCount: players.length,
      landlord: landlord,
      ranked: !!state.nonA3ToLast,     // 非 A3「打到末游」：按名次判胜负
      humanOutcome: null
    };
    if (state.nonA3ToLast) {
      detail.forEach(function (d) {
        if (d.index === state.humanIndex) state.result.humanOutcome = d.outcome;
      });
    }

    if (landlord) {
      var who = landlord.humanOutcome === 'win' ? '你胜'
              : (landlord.humanOutcome === 'lose' ? '你负' : '平局');
      pushLog(state, 'A3 地主结束：' + who + '（地主队：'
        + landlord.members.map(function (i) { return players[i].name; }).join('、') + '）');
    } else if (state.nonA3ToLast) {
      var flat = { win: '你胜', draw: '平局', lose: '你负' };
      pushLog(state, '打到末游结束：' + flat[state.result.humanOutcome] + '（'
        + order.map(function (idx) { return players[idx].name + '第' + players[idx].rank + '名'; }).join('、') + '）');
    } else {
      pushLog(state, '本局结束：' + players[order[0]].name + ' 先出完，其余共失 ' + winnerGain + ' 分');
    }
  }

  /** A3 地主结算：按两队的名次判定胜负 / 平局 */
  function buildLandlordResult(state) {
    var ll = state.landlord;
    var players = state.players;
    var rankOf = {};
    players.forEach(function (p) { rankOf[p.index] = p.rank; });

    var members = ll.members.slice();
    var landlordOutcome;
    if (ll.solo) {
      // 一人独拿 ♠A♠3：第 1 名胜、第 2 名平、第 3/4 名负
      var r = rankOf[members[0]];
      landlordOutcome = r === 1 ? 'win' : (r === 2 ? 'draw' : 'lose');
    } else {
      // 名次之和 ≤4 胜、=5 平、≥6 负
      landlordOutcome = teamOutcome(rankOf[members[0]] + rankOf[members[1]]);
    }
    var farmerOutcome = oppositeOutcome(landlordOutcome);

    var playerOutcome = {}, teams = {};
    players.forEach(function (p) {
      var isL = members.indexOf(p.index) >= 0;
      playerOutcome[p.index] = isL ? landlordOutcome : farmerOutcome;
      teams[p.index] = isL ? 'landlord' : 'farmer';
    });

    return {
      enabled: true,
      solo: ll.solo,
      members: members,
      holderA: ll.holderA,
      holder3: ll.holder3,
      revealed: {
        'AS': state.revealed['AS'] === undefined ? null : state.revealed['AS'],
        '3S': state.revealed['3S'] === undefined ? null : state.revealed['3S']
      },
      landlordOutcome: landlordOutcome,
      farmerOutcome: farmerOutcome,
      playerOutcome: playerOutcome,
      teams: teams,
      humanOutcome: playerOutcome[state.humanIndex]
    };
  }

  /** 名次之和 → 结果（从该队的角度） */
  function teamOutcome(sum) {
    if (sum <= 4) return 'win';
    if (sum === 5) return 'draw';
    return 'lose';
  }

  function oppositeOutcome(o) {
    return o === 'win' ? 'lose' : (o === 'lose' ? 'win' : 'draw');
  }

  /** 当前是否轮到人类且需要操作 */
  function awaitHuman(state) {
    return state.phase === 'playing' && state.turn === state.humanIndex;
  }

  /** 给界面用的提示：当前出牌者必须带哪张牌 */
  function hintText(state) {
    if (state.phase === 'over') return '';
    var p = state.players[state.turn];
    if (state.isFirstPlay) return '第一手必须包含 ' + _CD.cardText(_CD.getCard(_CD.RULES.firstCard));
    if (state.current) return '需压过 ' + _CD.playText(state.current);
    return '自由领出';
  }

  var api = {
    NAMES_BY_COUNT: NAMES_BY_COUNT, SUPPORTED_COUNTS: SUPPORTED_COUNTS, SCORE: SCORE,
    newGame: newGame, shuffle: shuffle, human: human,
    legalMoves: legalMoves, mustPass: mustPass, currentConstraint: currentConstraint,
    play: play, pass: pass, awaitHuman: awaitHuman, hintText: hintText,
    pushLog: pushLog, playerCountOf: playerCountOf
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
