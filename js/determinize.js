/* ============================================================
 * determinize.js —— 搜索用的「确定性采样」
 *
 * 不完全信息游戏（看不到对手手牌）里做搜索，第一步是把未知的手牌
 * 按公开信息「补全」成一个完全信息的局面（determinization）：
 *   · 公开信息 = 我的手牌 + 已出过的牌 + 每人还剩几张（hand.length）
 *   · 未露面的牌随机、均匀地分给其他玩家，张数严格对齐
 * 反复采样多份「世界」，就能在期望意义上逼近真实的不确定局面。
 *
 * 依赖 cards.js（CD）。不依赖 ai.js / game.js 的运行时状态（只用其数据结构）。
 * ============================================================ */

var Determinize = (function () {
  'use strict';

  var _CD = (typeof module !== 'undefined' && module.exports) ? require('./cards.js') : CD;

  /** 深拷贝一份对局状态（只拷贝会被 play/pass 改写的那部分） */
  function cloneState(st) {
    var s = {}, k;
    for (k in st) { if (Object.prototype.hasOwnProperty.call(st, k)) s[k] = st[k]; }

    s.players = st.players.map(function (p) {
      var q = {}, k2;
      for (k2 in p) { if (Object.prototype.hasOwnProperty.call(p, k2)) q[k2] = p[k2]; }
      q.hand = p.hand.slice();
      q.played = p.played ? p.played.slice() : [];
      return q;
    });

    s.trick = st.trick.slice();
    s.played = {};
    for (k in st.played) { if (Object.prototype.hasOwnProperty.call(st.played, k)) s.played[k] = 1; }
    // A3 地主：revealed 是搜索会写的状态，必须深拷贝，否则 rollout 出牌会污染真实局面
    s.revealed = {};
    if (st.revealed) {
      for (k in st.revealed) {
        if (Object.prototype.hasOwnProperty.call(st.revealed, k)) s.revealed[k] = st.revealed[k];
      }
    }
    s.log = [];                       // 搜索里不需要日志，避免字符串增长
    s.passes = st.passes ? st.passes.slice() : [];   // 搜索里的过牌不应污染真实局面
    return s;
  }

  /** 还没露面的牌 = 全部牌 − 我的手牌 − 已出过的牌（即：藏在对手手里的牌） */
  function unseenCards(state, self) {
    var known = {};
    var played = state.played || {};
    for (var id in played) { if (Object.prototype.hasOwnProperty.call(played, id)) known[id] = 1; }
    state.players[self].hand.forEach(function (c) { known[c.id] = 1; });
    return _CD.ALL_CARDS.filter(function (c) { return !known[c.id]; });
  }

  /**
   * 采样一个「世界」：把未露面的牌按各家公开的剩余张数随机发下去。
   * 返回新的 state（不改动入参）。self = 站在谁的视角（他的手牌保持真实）。
   */
  function sample(state, self, rng) {
    rng = rng || Math.random;
    var st = cloneState(state);
    var pool = unseenCards(state, self);

    // Fisher-Yates
    for (var i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }

    var k = 0;
    for (var pi = 0; pi < st.players.length; pi++) {
      if (pi === self) continue;
      var n = state.players[pi].hand.length;   // 公开张数
      st.players[pi].hand = pool.slice(k, k + n);
      k += n;
    }
    return st;
  }

  var api = { cloneState: cloneState, unseenCards: unseenCards, sample: sample };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
