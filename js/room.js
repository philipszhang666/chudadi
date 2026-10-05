/* ============================================================
 * room.js —— 权威房间：真 state 只存在这里
 *
 * 「房主也是玩家」，所以房主的浏览器同时扮演两个角色：
 *   1) 本地玩家：界面和单机时一样，只是多了一层网络
 *   2) 房主/裁判：持有唯一权威 state，校验所有人的出牌，跑 AI，
 *      然后把裁剪过的视图分别发给每个人
 *
 * 谁都不能自己改牌局：客户端点「出牌」只是把「我想出这几张」发给
 * 房主，由房主用同一份 game.js 校验，合法才落地、才广播。
 * 客户端连自己能不能出这张牌都是靠房主发来的视图算出来的。
 *
 * 这个文件不依赖 PeerJS、不依赖 DOM（网络收发通过 net 形参注入），
 * 所以能在 Node 里挂个假 net 直接跑完整对局测试
 * （见 scripts/test-room.js）。
 * ============================================================ */

var Room = (function () {
  'use strict';

  var _isNode = (typeof module !== 'undefined' && module.exports);
  var P = _isNode ? require('./protocol.js') : ProtocolNS;
  var G = _isNode ? require('./game.js') : Game;

  /**
   * 建一个房间控制器。
   *   opts.net   —— 传输层（net.js 或测试用的假实现）
   *   opts.on    —— 事件回调 { lobby, view, started, finished, error, closed }
   *   opts.ai    —— AI 相关配置 { decide(state, idx, diff, opts), algo(diffName), speedMs }
   */
  function create(opts) {
    opts = opts || {};
    var net = opts.net;
    var on = opts.on || {};
    var ai = opts.ai || {};

    var isHost = false;
    var code = null;
    var phase = P.PHASE.LOBBY;
    var config = { playerCount: 4, landlord: true, nonA3ToLast: false, difficulty: 'normal', speed: 'normal' };
    var roster = [];            // [{ seat, name, isHost, online }]
    var state = null;           // 权威局面（客户端上这里是房主发来的视图）
    var seq = 0;
    var botTimer = null;
    var closed = false;

    function now() { return (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0; }
    function later(fn, ms) { return setTimeout(fn, ms || 0); }

    function emit(name) {
      var f = on[name];
      if (f) f.apply(null, Array.prototype.slice.call(arguments, 1));
    }

    /* ---------------- 名单 ---------------- */

    function rosterView() {
      return roster.map(function (r) {
        return { seat: r.seat, name: r.name, isHost: r.isHost, online: r.online };
      });
    }

    function sendLobby() {
      var payload = { config: config, roster: rosterView(), phase: phase, code: code };
      if (isHost) net.broadcast({ type: P.H2C.LOBBY, lobby: payload });
      emit('lobby', payload);
    }

    function firstFreeSeat() {
      for (var s = 0; s < config.playerCount; s++) {
        var taken = roster.some(function (r) { return r.seat === s; });
        if (!taken) return s;
      }
      return -1;
    }

    function nameFor(seat) {
      var r = roster.filter(function (x) { return x.seat === seat; })[0];
      return (r && r.name) || ('玩家' + (seat + 1));
    }

    /* ---------------- 视图广播 ---------------- */

    function broadcastView(extra) {
      if (!state) return;
      seq++;
      roster.forEach(function (r) {
        if (r.isHost) {
          // 房主自己不需要走网络：直接吃同一份裁剪视图，
          // 这样「房主看别人手牌」这件事从根上就不存在了
          emit('view', { seq: seq, view: P.makeView(state, r.seat), roster: rosterView(), extra: extra });
        } else {
          net.sendToSeat(r.seat, {
            type: P.H2C.VIEW, seq: seq,
            view: P.makeView(state, r.seat), roster: rosterView(), extra: extra
          });
        }
      });
    }

    /* ---------------- 出牌落地 ---------------- */

    /**
     * 把一步动作落到权威 state 上。
     * 返回 { ok, reason }。reason 会原样回给客户端显示。
     */
    function apply(seat, action, cards) {
      if (!state || state.phase !== 'playing') return { ok: false, reason: '本局已结束' };
      if (state.turn !== seat) return { ok: false, reason: '还没轮到你出牌' };

      var r;
      if (action === 'pass') {
        r = G.pass(state, seat);
      } else {
        r = G.play(state, seat, cards || []);
      }
      if (!r.ok) return { ok: false, reason: r.reason };

      if (state.phase === 'over') {
        phase = P.PHASE.OVER;
        emit('finished', state.result);
      }
      return { ok: true, trickEnded: !!r.trickEnded, gameOver: !!r.gameOver };
    }

    /** 找一个「该由房主跑 AI」的座位；没有就返回 -1 */
    function nextBotSeat() {
      if (!state || state.phase !== 'playing') return -1;
      var t = state.turn;
      if (!isHost) return -1;                       // 只有房主跑 AI
      var r = roster.filter(function (x) { return x.seat === t; })[0];
      if (!r) return -1;
      if (r.isHost) return -1;                      // 房主自己是真人
      if (r.online) return -1;                      // 在线的真人自己会出牌
      return t;                                     // 掉线的真人 → 房主代打
    }

    function aiAlgo() {
      return ai.algo ? ai.algo(config.difficulty) : { diff: 'hardv2' };
    }

    function aiSpeed() {
      return ai.speedMs ? ai.speedMs(config.speed) : 700;
    }

    /**
     * 推进一步：如果轮到 AI（电脑位或掉线玩家），算一手并落地；
     * 落地后再看下一步，直到轮到某个人类玩家或本局结束。
     *
     * 用 setTimeout 分片而不是 while 循环：AI 决策是同步阻塞的，
     * 一口气跑完会把房主的界面和 WebRTC 心跳一起卡死。
     */
    function pump() {
      if (closed) return;
      if (!state || state.phase !== 'playing') return;
      var seat = nextBotSeat();
      if (seat < 0) return;                          // 轮到人类了，等他的消息
      if (botTimer) return;

      var t0 = now();
      var algo = aiAlgo();
      var d;
      try {
        d = ai.decide ? ai.decide(state, seat, algo.diff, algo.opts || {}) : { action: 'pass' };
      } catch (err) {
        d = { action: 'pass' };
      }

      // 先算再补时：和单机的节奏感保持一致，真人看牌不至于一闪而过
      var wait = Math.max(0, aiSpeed() - (now() - t0));
      botTimer = later(function () {
        botTimer = null;
        if (closed || !state || state.phase !== 'playing') return;
        if (state.turn !== seat) return;             // 期间局面变了，作废

        var res = apply(seat, d && d.action === 'play' ? 'play' : 'pass', d && d.cards);
        if (!res.ok) {
          // 理论上不会发生（AI 的走法一定合法）；真出问题就兜底，
          // 否则房主会卡在这一步、所有人都动不了
          if (state.current === null) {
            var hand = state.players[seat].hand.slice().sort(function (a, b) {
              return (a.value - b.value) || (a.suitOrder - b.suitOrder);
            });
            res = apply(seat, 'play', hand.length ? [hand[0]] : []);
          } else {
            res = apply(seat, 'pass');
          }
          if (!res.ok) return;
        }
        broadcastView({ bot: true, seat: seat });
        pump();
      }, wait);
    }

    /* ---------------- 房主：处理客户端消息 ---------------- */

    function handleHello(msg, conn) {
      var seat = null;

      // 重连：原来坐哪就尽量还给哪
      if (msg.seat !== null && msg.seat !== undefined) {
        var same = roster.filter(function (r) { return r.seat === msg.seat; })[0];
        if (same && !same.online) seat = same.seat;
      }
      if (seat === null) seat = firstFreeSeat();

      if (seat < 0) {
        // 注意：这里还不能用 net.sendToSeat（他的座位号还没登记），
        // 直接往这条连接上回
        try { conn.send({ type: P.H2C.REJECT, reason: '房间满了' }); } catch (e) {}
        try { conn.close(); } catch (e) {}
        return;
      }
      // 开局后只允许原座位的人重连，不允许新人插进来
      if (phase !== P.PHASE.LOBBY) {
        var known = roster.some(function (r) { return r.seat === seat && r.name === (msg.name || ''); });
        if (!known) {
          try { conn.send({ type: P.H2C.REJECT, reason: '本局已经开始了' }); } catch (e) {}
          try { conn.close(); } catch (e) {}
          return;
        }
      }

      conn.__seat = seat;
      net.attach(seat, conn);

      var entry = roster.filter(function (r) { return r.seat === seat; })[0];
      if (entry) {
        entry.name = msg.name || entry.name;
        entry.online = true;
      } else {
        roster.push({ seat: seat, name: msg.name || ('玩家' + (seat + 1)), isHost: false, online: true });
      }
      roster.sort(function (a, b) { return a.seat - b.seat; });

      net.sendToSeat(seat, {
        type: P.H2C.WELCOME, seat: seat, code: code, isHost: false,
        config: config, roster: rosterView(), phase: phase
      });

      sendLobby();

      // 局中重连：立刻把当前局面补发给他
      if (state) net.sendToSeat(seat, { type: P.H2C.VIEW, seq: ++seq, view: P.makeView(state, seat), roster: rosterView() });

      emit('join', { seat: seat, name: nameFor(seat) });
    }

    function handleAction(msg, conn) {
      var seat = conn.__seat;
      if (seat === undefined || seat === null) return;
      var res = apply(seat, msg.action, msg.cards);
      if (!res.ok) {
        // 非法动作：只回给当事人，不打扰别人
        net.sendToSeat(seat, { type: P.H2C.EVENT, kind: 'reject', reason: res.reason, actionId: msg.seq });
        return;
      }
      broadcastView({ actionId: msg.seq, seat: seat });
      pump();
    }

    function handleData(msg, conn) {
      if (!msg || !msg.type) return;

      if (!isHost) { onClientMessage(msg); return; }

      switch (msg.type) {
        case P.C2H.HELLO: handleHello(msg, conn); break;
        case P.C2H.ACTION: handleAction(msg, conn); break;
        case P.C2H.PING: net.sendToSeat(conn.__seat, { type: P.H2C.PONG }); break;        case P.C2H.BYE: dropSeat(conn.__seat); break;
        default: break;
      }
    }

    function dropSeat(seat) {
      if (seat === undefined || seat === null) return;
      var r = roster.filter(function (x) { return x.seat === seat; })[0];
      if (!r) return;
      r.online = false;
      net.detachSeat(seat);

      if (phase === P.PHASE.LOBBY) {
        // 还没开局：直接腾出座位，别人可以补进来
        roster = roster.filter(function (x) { return x.seat !== seat; });
        sendLobby();
      } else {
        // 局中掉线：座位给他留着，房主先代打（见 nextBotSeat），
        // 人回来重连还能接上自己的牌
        sendLobby();
        broadcastView({ offline: seat });
        pump();
      }
    }

    /* ---------------- 客户端：处理房主消息 ---------------- */

    function onClientMessage(msg) {
      switch (msg.type) {
        case P.H2C.WELCOME:
          mySeat = msg.seat;
          code = msg.code;
          config = msg.config;
          roster = msg.roster || [];
          phase = msg.phase || P.PHASE.LOBBY;
          net.setMySeat(msg.seat);
          emit('welcome', { seat: msg.seat, code: code, config: config, roster: rosterView(), phase: phase });
          break;
        case P.H2C.LOBBY:
          config = msg.lobby.config;
          roster = msg.lobby.roster || [];
          phase = msg.lobby.phase || phase;
          emit('lobby', msg.lobby);
          break;
        case P.H2C.VIEW:
          state = msg.view;
          roster = msg.roster || roster;
          phase = (state && state.phase === 'over') ? P.PHASE.OVER : P.PHASE.PLAYING;
          emit('view', { seq: msg.seq, view: state, roster: rosterView(), extra: msg.extra });
          break;
        case P.H2C.REJECT:
          emit('error', { reason: msg.reason });
          close();
          break;
        case P.H2C.EVENT:
          emit('netEvent', msg);
          break;
        case P.H2C.BYE:
          emit('closed', { reason: 'host-left' });
          close();
          break;
        default: break;
      }
    }

    var mySeat = 0;

    /* ---------------- 对外接口 ---------------- */

    function startHost(hostOpts) {
      isHost = true;
      code = (hostOpts && hostOpts.code) || null;
      roster = [];
      phase = P.PHASE.LOBBY;
      if (hostOpts && hostOpts.config) {
        Object.keys(hostOpts.config).forEach(function (k) { config[k] = hostOpts.config[k]; });
      }
      roster.push({ seat: 0, name: (hostOpts && hostOpts.name) || '房主', isHost: true, online: true });
      sendLobby();
    }

    function joinAsClient(joinOpts) {
      isHost = false;
      phase = P.PHASE.LOBBY;
      roster = [];
    }

    function setConfig(patch) {
      if (!isHost) return;
      Object.keys(patch || {}).forEach(function (k) { config[k] = patch[k]; });
      sendLobby();
    }

    /** 房主发牌开局 */
    function startGame(overrides) {
      if (!isHost) return { ok: false, reason: '只有房主能开局' };
      if (phase === P.PHASE.PLAYING) return { ok: false, reason: '本局还没结束' };
      var humans = roster.length;
      if (humans < 2) return { ok: false, reason: '至少要 2 个人才能开局' };
      if (humans > config.playerCount) return { ok: false, reason: '人比座位多了' };

      Object.keys(overrides || {}).forEach(function (k) { config[k] = overrides[k]; });

      // 座位可能不是 0..n-1 连续的（有人中途走了），补成连续座位，
      // 否则 NAMES_BY_COUNT 那套名字/座位表会对不上
      roster.sort(function (a, b) { return a.seat - b.seat; });
      roster.forEach(function (r, i) { r.seat = i; });

      state = G.newGame({
        playerCount: config.playerCount,
        landlord: !!config.landlord,
        nonA3ToLast: !!config.nonA3ToLast
      });

      // 名字换成真人的名字，界面里就不用再看「西家/北家」了
      roster.forEach(function (r) {
        var p = state.players[r.seat];
        if (p) { p.name = r.name; p.isHuman = true; }
      });

      phase = P.PHASE.PLAYING;
      seq = 0;
      emit('started', { config: config, roster: rosterView() });
      broadcastView({ start: true });
      pump();
      return { ok: true };
    }

    /** 人类动作入口。房主自己的点击也走这里，保证只有一条合法路径 */
    function applyAction(seat, action, cards) {
      if (!isHost) return { ok: false, reason: '只有房主能落地动作' };
      var res = apply(seat, action, cards);
      if (!res.ok) return res;
      broadcastView({ seat: seat });
      pump();
      return res;
    }

    /** 回大厅（再来一局） */
    function backToLobby() {
      if (!isHost) return;
      phase = P.PHASE.LOBBY;
      state = null;
      seq = 0;
      if (botTimer) { clearTimeout(botTimer); botTimer = null; }
      sendLobby();
    }

    function close(reason) {
      closed = true;
      if (botTimer) { clearTimeout(botTimer); botTimer = null; }
      if (isHost) net.broadcast({ type: P.H2C.BYE, reason: reason || 'host-closed' });
      net.close();
      emit('closed', { reason: reason || 'closed' });
    }

    /** 统一的消息入口：把 net 的 data 事件接到这里 */
    function onData(msg, conn) { handleData(msg, conn); }
    function onConn(conn) { /* 等他的 HELLO，那才知道该坐哪 */ }
    function onDisconn(conn) { dropSeat(conn.__seat); }

    return {
      onData: onData, onConn: onConn, onDisconn: onDisconn,
      startHost: startHost, joinAsClient: joinAsClient,
      setConfig: setConfig, startGame: startGame, applyAction: applyAction,
      backToLobby: backToLobby, close: close, pump: pump,
      get isHost() { return isHost; },
      get phase() { return phase; },
      get config() { return config; },
      get roster() { return rosterView(); },
      get state() { return state; },
      get code() { return code; },
      get seq() { return seq; }
    };
  }

  var api = { create: create };
  if (_isNode) module.exports = api;
  return api;
})();
