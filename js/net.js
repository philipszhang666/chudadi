/* ============================================================
 * net.js —— 联机传输层（PeerJS 星型连接）
 *
 * 拓扑：开房的人是「房主」，也是权威状态持有者。其他人（客户端）
 * 各自开一条 WebRTC DataChannel 直连房主。3~4 人局就是房主挂
 * 3 条连接，开销很小。
 *
 *      客户端A ─┐
 *      客户端B ─┼─→ 房主（权威 state + 跑 AI + 裁剪视图后广播）
 *      客户端C ─┘
 *
 * 信令走 PeerJS 的免费公共 broker（不填 host/key 就是它），所以
 * 这套东西零后端：谁都不用自己架服务器，浏览器之间直连。
 *
 * 这一层只管「管子」：连接、房间码、收发 JSON、断线回调、保活。
 * 游戏规则和权威逻辑在 room.js，信息裁剪在 protocol.js。
 * ============================================================ */

var Net = (function () {
  'use strict';

  var P = (typeof module !== 'undefined' && module.exports)
    ? require('./protocol.js')
    : ProtocolNS;

  /* ---------------- ICE 服务器 ----------------
     STUN 只负责「问出我的公网地址」，真正建连还得靠两边能互相打通。
     碰上对称 NAT / 运营商级 NAT / 封锁 UDP 的网络，STUN 单独是打不通的，
     必须有个 TURN 中继替双方转发。

     这里用 Open Relay（metered.ca 提供的免费公共 TURN）：
       官方页面 https://www.metered.ca/tools/openrelay/
       · 443/TCP 那条最重要 —— 很多公司网 / 校园网封 UDP，只放 TCP 443
       · 免费公共服务，长期稳定性没保证；哪天失效了，ICE 会自动退回
         只走 STUN（不会报错，只是穿透力变弱），因此加着比不加好。
       想换成自己的 TURN（更稳）：把下面 TURN_* 换成自己的凭据即可。

     注意：TURN 只在直连打不通时才启用，能直连时流量不会绕道中继，
     所以不会拖慢正常情况下的牌局。 */
  var STUN = [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' }
  ];

  var TURN_USER = 'openrelayproject';
  var TURN_PASS = 'openrelayproject';
  var TURN = [
    { urls: 'turn:openrelay.metered.ca:443', username: TURN_USER, credential: TURN_PASS },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: TURN_USER, credential: TURN_PASS },
    { urls: 'turn:openrelay.metered.ca:80', username: TURN_USER, credential: TURN_PASS },
    { urls: 'turn:openrelay.metered.ca:3478?transport=udp', username: TURN_USER, credential: TURN_PASS }
  ];

  var ICE_SERVERS = STUN.concat(TURN);

  var PEER_OPTS = {
    debug: 1,
    config: { iceServers: ICE_SERVERS }
  };

  /** 自检页要复用同一份配置，暴露出去免得两处不一致 */
  function iceServers() { return ICE_SERVERS.slice(); }

  var role = null;          // 'host' | 'client' | null
  var peer = null;          // PeerJS Peer 实例
  var code = null;          // 4 位房间码
  var mySeat = 0;
  var handlers = {};        // 事件回调
  var conns = {};           // 仅房主：seat -> DataConnection
  var hostConn = null;      // 仅客户端：到房主的连接
  var closedByUs = false;
  var reconnectTimer = null;
  var lastJoinName = '';    // 重连时要用同一个昵称，房主才认得出是老玩家

  function emit(name) {
    var f = handlers[name];
    if (!f) return;
    f.apply(null, Array.prototype.slice.call(arguments, 1));
  }

  function on(name, fn) { handlers[name] = fn; }

  function reset() {
    role = null; peer = null; code = null; mySeat = 0;
    conns = {}; hostConn = null; closedByUs = false;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  function peerAvailable() {
    return typeof Peer !== 'undefined';
  }

  function sendTo(conn, msg) {
    if (!conn) return false;
    try {
      conn.send(msg);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---------------- 房主 ---------------- */

  /**
   * 开房。成功后回调 onReady({ code, seat:0 })
   * 房主自己也是玩家，固定坐 0 号位 —— 这样不用额外挂一台设备。
   */
  function host(seed) {
    if (!peerAvailable()) { emit('error', { reason: 'peerjs-missing' }); return; }
    reset();
    role = 'host';
    mySeat = 0;

    var tries = 0;
    openHostPeer(seed);

    function openHostPeer(trySeed) {
      code = trySeed ? P.normalizeCode(trySeed) : P.makeCode();
      if (!code || code.length < 4) { emit('error', { reason: 'bad-code', code: code }); return; }

      peer = new Peer(P.peerIdFor(code), PEER_OPTS);

      peer.on('open', function () {
        emit('ready', { code: code, seat: 0, isHost: true });
      });

      peer.on('connection', function (conn) {
        conn.on('open', function () { emit('conn', conn); });
        conn.on('data', function (data) { emit('data', data, conn); });
        conn.on('close', function () { emit('disconn', conn); });
        conn.on('error', function (err) { emit('connerror', err, conn); });
      });

      peer.on('error', function (err) {
        var t = err && err.type;
        // 「和 Peer X 的连接出问题」：这就是某个客户端掉线了，
        // 要把他的座位标成掉线，房主才会接手代打
        if (t === 'peer-unavailable' && err.message) {
          var m = new RegExp(P.PEER_PREFIX + '([A-Z0-9]{4})').exec(String(err.message));
          if (m) emit('peer-lost', { code: m[1] });
        }
        // 房间码撞车：换一个重来（公共 broker 上 id 可能被别人占）
        if ((t === 'unavailable-id' || t === 'invalid-id') && tries < 5) {
          tries++;
          try { peer.destroy(); } catch (e) {}
          openHostPeer();
          return;
        }
        emit('error', { reason: t || 'peer-error', message: err && err.message });
      });

      peer.on('disconnected', function () {
        // 与信令服务器断开：已建立的 DataChannel 不受影响，
        // 但新玩家就进不来了。尝试重连信令。
        if (closedByUs) return;
        emit('signal-lost');
        try { peer.reconnect(); } catch (e) {}
      });
    }
  }

  /** 房主：接受一条已送达的连接，把它登记到某个座位 */
  function attach(seat, conn) {
    conns[seat] = conn;
  }

  function detachSeat(seat) {
    var c = conns[seat];
    delete conns[seat];
    return c;
  }

  function broadcast(msg, exceptSeat) {
    Object.keys(conns).forEach(function (k) {
      var seat = Number(k);
      if (exceptSeat !== undefined && seat === exceptSeat) return;
      sendTo(conns[seat], msg);
    });
  }

  function sendToSeat(seat, msg) { return sendTo(conns[seat], msg); }

  /* ---------------- 客户端 ---------------- */

  /** 加入房间。onReady({ seat }) 在连上房主后回调 */
  function join(rawCode, name) {
    if (!peerAvailable()) { emit('error', { reason: 'peerjs-missing' }); return; }
    var c = P.normalizeCode(rawCode);
    if (c.length < 4) { emit('error', { reason: 'bad-code', code: c }); return; }

    var wasRole = role;
    var wasSeat = mySeat;
    lastJoinName = name || lastJoinName;
    reset();
    role = 'client';
    code = c;
    mySeat = wasSeat;         // 重连时保留原座位，由房主确认

    peer = new Peer(PEER_OPTS);

    // 连接是个慢过程，中途得让界面有东西可看，否则用户只会觉得「点了没反应」
    emit('phase', { phase: 'broker', text: '正在连信令服务器…' });

    peer.on('open', function () {
      emit('phase', { phase: 'connecting', text: '正在和房主建立直连（打洞中）…' });
      var conn = peer.connect(P.peerIdFor(c), { reliable: true, serialization: 'json' });

      var settled = false;
      /* 超时从 15s 放到 45s：手机 4G 上要等 broker + 收集候选 +
         打通 NAT，15 秒经常不够，之前那样会把「慢但能成」的连接误判成失败。
         真正的死胡同（房间码不存在）会由 peer-unavailable 立刻报出来，
         不用靠这个超时兜底，所以放大它是安全的。 */
      var timeout = setTimeout(function () {
        if (settled) return;
        settled = true;
        emit('error', { reason: 'timeout', code: c });
      }, 45000);

      // 打洞给了候选就会触发，用它显示进度，让用户知道还在动
      try {
        conn.on('iceStateChanged', function (st) {
          emit('phase', { phase: 'ice', text: '网络连接状态：' + st });
        });
      } catch (e) { /* 老版本 PeerJS 没这个事件，忽略 */ }

      conn.on('open', function () {
        settled = true;
        clearTimeout(timeout);
        hostConn = conn;
        emit('phase', { phase: 'handshake', text: '已连上房主，正在入座…' });
        // 重连时把自己的原座位报上去，房主会尽量让回原位
        sendTo(conn, { type: P.C2H.HELLO, code: c, name: name || '', seat: wasRole === 'client' ? wasSeat : null });
        emit('ready', { code: c, seat: null, isHost: false, wasReconnect: wasRole === 'client' });
      });

      conn.on('data', function (data) { emit('data', data, conn); });
      conn.on('close', function () {
        if (closedByUs) return;
        emit('disconn', conn);
        scheduleReconnect();
      });
      conn.on('error', function (err) {
        emit('phase', { phase: 'datachannel-error', text: '数据通道出错：' + ((err && err.type) || err) });
        emit('connerror', err, conn);
      });
    });

    peer.on('error', function (err) {
      var t = err && err.type;
      // peer-unavailable = 房间码不存在。
      //   首次加入时：房主打错码 / 房间已关。
      //   重连时：房主已经关掉页面 —— 这时候不能傻等重试，要直接报出去。
      if (t === 'peer-unavailable') { emit('error', { reason: 'not-found', code: c }); return; }
      emit('error', { reason: t || 'peer-error', message: err && err.message });
    });
  }

  /** 掉线后自动重试，最多几轮，避免手机上网络一断就永久卡住 */
  var retry = 0;
  function scheduleReconnect() {
    if (closedByUs || role !== 'client' || !code) return;
    if (retry >= 6) { emit('error', { reason: 'reconnect-failed' }); return; }
    retry++;
    var delay = Math.min(1200 * retry, 6000);
    emit('reconnecting', { attempt: retry, delay: delay });
    reconnectTimer = setTimeout(function () { join(code, lastJoinName); }, delay);
  }

  /**
   * 手机切后台再切回来时，WebRTC / PeerJS 的连接经常已经悄悄死了
   * （iOS Safari 上尤其常见）。这里主动探一下：连接断了就立刻重连，
   * 不等那 1.2s 起步的退避计时。
   */
  function poke() {
    if (role !== 'client' || closedByUs || !code) return;
    if (hostConn && hostConn.open) {
      sendTo(hostConn, { type: P.C2H.PING });
      return;
    }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    retry = 0;
    emit('reconnecting', { attempt: 1, delay: 0 });
    join(code, lastJoinName);
  }

  function send(msg) {
    if (role === 'host') return false;       // 房主自己要发得指名道姓
    retry = 0;
    return sendTo(hostConn, msg);
  }

  function close() {
    closedByUs = true;
    try { if (hostConn) sendTo(hostConn, { type: P.C2H.BYE }); } catch (e) {}
    try { if (peer) peer.destroy(); } catch (e) {}
    reset();
  }

  var api = {
    on: on,
    host: host, join: join, close: close, poke: poke,
    attach: attach, detachSeat: detachSeat,
    broadcast: broadcast, sendToSeat: sendToSeat, send: send,
    iceServers: iceServers,
    getRole: function () { return role; },
    getCode: function () { return code; },
    getMySeat: function () { return mySeat; },
    setMySeat: function (s) { mySeat = s; },
    seats: function () { return Object.keys(conns).map(Number); },
    /** 房主：某个房间码对应的客户端掉线了（PeerJS 报的） */
    seatOfCode: function (c) {
      var want = P.peerIdFor(c);
      var found = null;
      Object.keys(conns).forEach(function (seat) {
        var conn = conns[seat];
        if (conn && conn.peer === want) found = Number(seat);
      });
      return found;
    },
    available: peerAvailable
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
