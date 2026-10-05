/* ============================================================
 * protocol.js —— 联机的「信息隐藏层」+ 消息协议常量
 *
 * 这个文件是整个联机方案里最要紧的一块，单独拎出来：
 *
 *   单机时，Game.newGame() 会把四家手牌全放在同一个 state 里，
 *   因为只有一个玩家、AI 在同一台机器上，没什么好藏的。
 *
 *   联机时绝对不能把这个 state 直接发给别人 —— 任何人按 F12
 *   就能看见在场所有人的牌。所以每台客户端只允许收到
 *   「自己的手牌 + 公开信息」：
 *     · 别人的手牌      → 只留张数，牌面换成占位牌（不能留真牌！）
 *     · A3 地主的队友   → 只发「谁是地主队」，不给任何人本人的身份
 *                         字段（连地主本人的 player 对象上也只留
 *                         members，由 AI 自己从手牌推）
 *     · 本局的权威出牌记录（trick / lastTrick / current / played）
 *       是公开信息，照发
 *     · 结算时其余各家的剩余手牌照发 —— 那本来就是结算表要展示的
 *
 * 刻意违反这条规则的地方只有一处：结算浮层要显示的「各家剩余牌」，
 * 那是设计上就要公开的（见 index.html 里的结算表说明）。
 *
 * 这个文件不依赖 PeerJS、不依赖 DOM，所以能在 Node 里直接跑测试
 * （scripts/test-protocol.js 就靠这一点做「别人看不见我的手牌」的断言）。
 * ============================================================ */

var ProtocolNS = (function () {
  'use strict';

  /* ---------------- 消息类型 ---------------- */
  /* 客户端 → 房主 */
  var C2H = {
    HELLO: 'hello',         // { name }                       加入房间
    LOBBY_SET: 'lobbySet',  // { config }                     房主改设置（仅房主）
    START: 'start',         //                                房主发牌开局
    ACTION: 'action',       // { seq, action:'play'|'pass', cards:[id] }
    BYE: 'bye',             //                                主动离开
    PING: 'ping'            //                                保活
  };

  /* 房主 → 客户端 */
  var H2C = {
    WELCOME: 'welcome',     // { seat, code, isHost, config, roster }
    REJECT: 'reject',       // { reason }                     房间满 / 已开局 等
    LOBBY: 'lobby',         // { config, roster, started }
    VIEW: 'view',           // { seq, view }                  裁剪后的局面
    EVENT: 'event',         // { kind, ... }                  音效 / 提示（可选）
    PONG: 'pong',
    BYE: 'bye'
  };

  var PHASE = { LOBBY: 'lobby', PLAYING: 'playing', OVER: 'over' };

  /* ---------------- 房间码 ---------------- */
  /* 去掉容易看错的字符（0/O、1/I/L），方便口头念、手输 */
  var CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  function makeCode(rng) {
    rng = rng || Math.random;
    var s = '';
    for (var i = 0; i < 4; i++) {
      s += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)];
    }
    return s;
  }

  /** 房间码 → PeerJS 的 peer id。前缀避免和别人的公共 id 撞车 */
  var PEER_PREFIX = 'cdd-v1-';
  function peerIdFor(code) { return PEER_PREFIX + String(code || '').toUpperCase(); }

  function normalizeCode(raw) {
    var s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return s.slice(0, 4);
  }

  /* ---------------- 占位牌 ----------------
     给别人的手牌做占位：界面只用到 .length（画几张牌背），
     但绝不能带着真牌面，否则等于没藏。 */
  function dummyCards(n) {
    var out = [];
    for (var i = 0; i < n; i++) out.push({ hidden: true });
    return out;
  }

  /* ---------------- 裁剪：把真 state 变成某人能看的 view ----------------
     state  —— 权威局面（房主 / 单机里的那一份）
     seat   —— 收件人的座位号
     返回一份深拷贝，改它不会污染权威 state。
     这不是「安全边界」级别的防护（明文 WebRTC，房主当然看得到全部），
     它防的是「随手开个开发者工具就能看光全场」这种日常作弊。 */
  function makeView(state, seat) {
    if (!state) return null;
    var view = JSON.parse(JSON.stringify(state));

    view.myIndex = seat;
    view.humanIndex = seat;         // 复用旧字段：界面里一律读 myIndex

    view.players.forEach(function (p, i) {
      p.isHuman = (i === seat);
      // 手牌：本人的原样，别人的只留张数 + 占位
      if (i !== seat) {
        p.hand = dummyCards((p.hand && p.hand.length) || 0);
      }
      // 这三样是本人私有视角的缓存，本人也用不上（界面按公开信息重画），
      // 但留着会让「谁打过什么」泄露出去，直接清掉由客户端从公开记录重建。
      p.played = i === seat ? (p.played || []) : [];
    });

    // A3 地主：members 是公开的（牌亮出来全场都看得见），
    // 但 holderA / holder3 是「谁手里捏着 ♠A♠3」的底牌，必须抠掉
    if (view.landlord) {
      delete view.landlord.holderA;
      delete view.landlord.holder3;
    }

    return view;
  }

  /* ---------------- 一份 view 是否「该家自己的手牌是真的」 ----------------
     测试和自检用：确认别人的手牌里没有任何真牌。 */
  function leakedRealHands(view, seat) {
    var bad = [];
    (view.players || []).forEach(function (p, i) {
      if (i === seat) return;
      (p.hand || []).forEach(function (c) {
        if (!c || !c.hidden) bad.push({ player: i, card: c && c.id });
      });
    });
    return bad;
  }

  /* ---------------- 座位 → 屏幕位置（视角旋转） ----------------
     每个人都要看自己坐在正下方。屏幕上的对手位（除去正下方）按
     顺时针排成 SEAT_SLOTS 那个顺序，于是「把对手位整体旋转一下」
     就能保证本地玩家永远正中。

     返回一个数组：screenSlotOf[玩家index] = 屏幕槽位号（-1 = 本地玩家，
     坐正下方，不属于这些槽位）。屏幕槽位只有前 used 个会被显示。 */
  function seatLayout(playerCount, mySeat) {
    var slotOf = [];
    for (var i = 0; i < playerCount; i++) {
      if (i === mySeat) { slotOf.push(-1); continue; }
      // 顺时针：本地玩家之后的下一位排到第一个可用槽位
      var k = ((i - mySeat - 1) % playerCount + playerCount) % playerCount;
      slotOf.push(k);
    }
    return slotOf;
  }

  var api = {
    C2H: C2H, H2C: H2C, PHASE: PHASE,
    CODE_ALPHABET: CODE_ALPHABET, PEER_PREFIX: PEER_PREFIX,
    makeCode: makeCode, peerIdFor: peerIdFor, normalizeCode: normalizeCode,
    dummyCards: dummyCards,
    makeView: makeView, leakedRealHands: leakedRealHands,
    seatLayout: seatLayout
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
