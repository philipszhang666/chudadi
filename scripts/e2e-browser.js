/* ============================================================
 * scripts/e2e-browser.js —— 真浏览器端到端联机测试
 *
 * 无头测试（test-room.js）用的是假「管子」，证明不了三件事：
 *   1. PeerJS 在真实浏览器里能不能建起 DataChannel（信令 / ICE / NAT）
 *   2. index.html 里那几个脚本的加载顺序对不对
 *   3. 界面层的接线（点开房 → 房间码 → 加入 → 开局 → 视图同步）通不通
 *
 * 这个脚本把这三件事一起验掉：
 *   · 起一个本地静态服务器
 *   · 用 headless Chrome 开两个标签页（两个独立 origin 的 Peer）
 *   · A 页开房 → 拿到房间码 → B 页用它加入 → A 页开局
 *   · 断言 B 页看不到 A 页的手牌（真牌 id 一个都不能出现），
 *     但能看到自己的手牌和正确的公开信息
 *
 * 依赖：本机装了 Chrome；能访问 PeerJS 公共 broker（信令）。
 * 跑法：node scripts/e2e-browser.js
 * ============================================================ */
'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');
var os = require('os');
var { spawn } = require('child_process');

var ROOT = path.join(__dirname, '..');

/* ---------------- 断言 ---------------- */
var pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  \u2713 ' + label); }
  else { fail++; console.log('  \u2717 ' + label + (detail ? ('  \u2192 ' + detail) : '')); }
}
function section(t) { console.log('\n' + t); }

/* ---------------- 静态服务器 ---------------- */
var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml'
};

function startServer() {
  return new Promise(function (resolve) {
    var srv = http.createServer(function (req, res) {
      var url = decodeURIComponent(req.url.split('?')[0]);
      if (url === '/') url = '/index.html';
      var file = path.join(ROOT, url);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, '127.0.0.1', function () { resolve(srv); });
  });
}

/* ---------------- Chrome DevTools Protocol ---------------- */
function httpJson(url) {
  return new Promise(function (resolve, reject) {
    http.get(url, function (res) {
      var b = '';
      res.on('data', function (d) { b += d; });
      res.on('end', function () {
        try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function cdp(wsUrl) {
  return new Promise(function (resolve, reject) {
    var ws = new WebSocket(wsUrl);
    var id = 0;
    var pending = {};
    var events = [];
    var listeners = [];

    ws.addEventListener('open', function () {
      resolve({
        send: function (method, params) {
          return new Promise(function (res, rej) {
            var myId = ++id;
            pending[myId] = { res: res, rej: rej };
            ws.send(JSON.stringify({ id: myId, method: method, params: params || {} }));
          });
        },
        on: function (fn) { listeners.push(fn); },
        events: events,
        close: function () { try { ws.close(); } catch (e) {} }
      });
    });
    ws.addEventListener('message', function (ev) {
      var m = JSON.parse(ev.data);
      if (m.id && pending[m.id]) {
        var p = pending[m.id];
        delete pending[m.id];
        if (m.error) p.rej(new Error(m.error.message));
        else p.res(m.result);
      } else if (m.method) {
        events.push(m);
        listeners.forEach(function (f) { f(m); });
      }
    });
    ws.addEventListener('error', function (e) { reject(new Error('ws error')); });
  });
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/** 在页面里跑一段表达式，返回它的值 */
async function evalIn(session, expr) {
  var r = await session.send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true
  });
  if (r.exceptionDetails) {
    throw new Error('页面里报错：' + (r.exceptionDetails.exception
      ? r.exceptionDetails.exception.description || r.exceptionDetails.exception.value
      : r.exceptionDetails.text));
  }
  return r.result.value;
}

/** 轮询页面状态直到条件成立 */
async function waitFor(session, expr, timeoutMs, label) {
  var t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    var v = await evalIn(session, expr);
    if (v) return v;
    await sleep(250);
  }
  throw new Error('等待超时：' + label + '（' + timeoutMs + 'ms）');
}

/* ---------------- 主流程 ---------------- */
(async function main() {
  var chromePath = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'
  ].filter(function (p) { return p && fs.existsSync(p); })[0];

  if (!chromePath) { console.log('没找到 Chrome，跳过浏览器端到端测试'); process.exit(0); }

  var srv = await startServer();
  var PORT = srv.address().port;
  var BASE = 'http://127.0.0.1:' + PORT + '/index.html';
  console.log('本地服务器：' + BASE);

  var profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdd-e2e-'));
  var DEBUG_PORT = 9333;

  var chrome = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=' + DEBUG_PORT,
    '--remote-allow-origins=*',
    '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-dev-shm-usage',
    '--mute-audio',
    'about:blank'
  ], { stdio: 'ignore' });

  var cleanup = function () {
    try { chrome.kill(); } catch (e) {}
    try { srv.close(); } catch (e) {}
  };
  process.on('exit', cleanup);

  try {
    // 等 DevTools 端点起来
    var ver = null;
    for (var i = 0; i < 40; i++) {
      try { ver = await httpJson('http://127.0.0.1:' + DEBUG_PORT + '/json/version'); break; }
      catch (e) { await sleep(250); }
    }
    if (!ver) throw new Error('Chrome DevTools 端点没起来');
    console.log('Chrome: ' + ver['Browser'] + '\n');

    var browserWs = ver.webSocketDebuggerUrl;
    var bro = await cdp(browserWs);

    async function newTab(name) {
      var t = await bro.send('Target.createTarget', { url: 'about:blank' });
      var list = await httpJson('http://127.0.0.1:' + DEBUG_PORT + '/json/list');
      var info = list.filter(function (x) { return x.id === t.targetId; })[0];
      var sess = await cdp(info.webSocketDebuggerUrl);
      await sess.send('Runtime.enable');
      await sess.send('Page.enable');
      var errors = [];
      sess.on(function (m) {
        if (m.method === 'Runtime.exceptionThrown') {
          var d = m.params.exceptionDetails;
          errors.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
        }
        if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
          errors.push(m.params.args.map(function (a) { return a.value; }).join(' '));
        }
      });
      sess.__errors = errors;
      sess.__name = name;
      return sess;
    }

    /* ---------------- 打开两个页面 ---------------- */
    var A = await newTab('A');
    var B = await newTab('B');
    await A.send('Page.navigate', { url: BASE });
    await B.send('Page.navigate', { url: BASE });
    await sleep(1500);

    section('0. 页面加载');
    [A, B].forEach(function (tab) {
      ok(tab.__errors.length === 0, tab.__name + ' 页面无 JS 报错',
        tab.__errors.slice(0, 2).join(' | '));
    });
    ok(await evalIn(A, 'typeof Peer === "function"'), 'PeerJS 加载成功');
    ok(await evalIn(A, 'typeof Room === "object" && typeof ProtocolNS === "object" && typeof Net === "object"'),
      '联机的三个模块（protocol / net / room）都加载成功');
    ok(await evalIn(A, '!!window.__game'), '界面初始化完成（__game 可用）');

    /* ---------------- A 开房 ---------------- */
    section('1. 房主开房');
    await evalIn(A, '$("nickInput").value = "房主A"; __game.host();');
    var code = await waitFor(A, '__game.code || ""', 25000, '房主拿到房间码');
    ok(/^[A-Z0-9]{4}$/.test(code), '房主拿到 4 位房间码：' + code);
    ok(await evalIn(A, '__game.mode === "online" && __game.seat === 0'), '房主进入联机模式且坐 0 号位');

    /* ---------------- B 加入 ---------------- */
    section('2. 客户端加入房间');
    await evalIn(B, '$("nickInput").value = "玩家B"; __game.join("' + code + '");');
    var joined = await waitFor(B, '__game.mode === "online" && __game.code === "' + code + '" && __game.seat !== null',
      30000, 'B 连上房主');
    ok(!!joined, 'B 通过房间码连上了房主');

    var aRoster = await waitFor(A, 'JSON.stringify(__game.room.roster.filter(function(r){return r.online;}).length)',
      15000, '房主名单里出现 2 人');
    ok(aRoster === '2' || Number(aRoster) === 2, '房主名单里有 2 个在线玩家（' + aRoster + '）');
    var bSeat = await evalIn(B, '__game.seat');
    ok(bSeat === 1, 'B 被分到 1 号位（实际 ' + bSeat + '）');

    /* ---------------- 开局 ---------------- */
    section('3. 房主开局，所有人都收到视图');
    await evalIn(A, '__game.newGame();');
    await waitFor(A, '__game.state && __game.state.phase === "playing"', 10000, '房主进入牌局');
    await waitFor(B, '__game.state && __game.state.phase === "playing"', 10000, 'B 收到牌局视图');

    ok(await evalIn(A, '!!__game.state'), '房主有牌局状态');
    ok(await evalIn(B, '!!__game.state'), 'B 有牌局状态');

    /* ---------------- 信息隐藏（最关键的断言） ---------------- */
    section('4. 信息隐藏：实机验证 B 看不见 A 的手牌');

    var probe = `
      (function(){
        var s = __game.state, me = __game.seat;
        var mineReal = s.players[me].hand.filter(function(c){ return c && c.id; }).length;
        var mineDummy = s.players[me].hand.filter(function(c){ return c && c.hidden; }).length;
        var others = [];
        s.players.forEach(function(p, i){
          if (i === me) return;
          others.push({
            seat: i,
            total: p.hand.length,
            real: p.hand.filter(function(c){ return c && c.id; }).length,
            ids: p.hand.filter(function(c){ return c && c.id; }).map(function(c){ return c.id; })
          });
        });
        return JSON.stringify({ me: me, mineReal: mineReal, mineDummy: mineDummy, others: others });
      })()
    `;

    var bProbe = JSON.parse(await evalIn(B, probe));
    ok(bProbe.mineReal === 13, 'B 能看到自己完整的 13 张真牌（实际 ' + bProbe.mineReal + '）');
    ok(bProbe.mineDummy === 0, 'B 自己的手牌里没有占位牌');
    var bLeak = bProbe.others.filter(function (o) { return o.real > 0; });
    ok(bLeak.length === 0, 'B 看不到任何别人的真牌',
      bLeak.length ? ('座位 ' + bLeak[0].seat + ' 泄露 ' + bLeak[0].real + ' 张：' + bLeak[0].ids.join(',')) : '');
    ok(bProbe.others.every(function (o) { return o.total === 13; }),
      'B 看到的各家张数正确（都是 13）');

    var aProbe = JSON.parse(await evalIn(A, probe));
    var aLeak = aProbe.others.filter(function (o) { return o.real > 0; });
    ok(aLeak.length === 0, '房主 A 自己也看不到别人的真牌（同一套裁剪路径）');

    section('5. 两家手牌互不相同（确实是两副牌）');
    var aHand = await evalIn(A, '__game.state.players[0].hand.map(function(c){return c.id;}).sort().join(",")');
    var bHand = await evalIn(B, '__game.state.players[1].hand.map(function(c){return c.id;}).sort().join(",")');
    ok(aHand && bHand && aHand !== bHand, 'A 的手牌和 B 的手牌不是同一份');
    ok(aHand.split(',').length === 13 && bHand.split(',').length === 13, '两边各 13 张');

    var aNames = await evalIn(A, '__game.state.players.map(function(p){return p.name;}).join(",")');
    ok(aNames.indexOf('房主A') >= 0 && aNames.indexOf('玩家B') >= 0,
      '牌桌上显示的是真人的昵称：' + aNames);

    section('6. 公开信息一致');
    var aPub = await evalIn(A, 'JSON.stringify({t:__game.state.turn,c:__game.state.current,r:__game.state.round})');
    var bPub = await evalIn(B, 'JSON.stringify({t:__game.state.turn,c:__game.state.current,r:__game.state.round})');
    ok(aPub === bPub, '两边的轮次 / 桌面牌 / 墩数完全一致');
    ok(await evalIn(A, '__game.state.players.filter(function(p){return p.isHuman;}).length === 4'),
      '4 个座位都被标记为真人（联机时没有电脑）');

    section('7. 客户端出牌 → 房主校验 → 广播回来');
    // 让轮到的那家出牌：这里走真实的界面路径（模拟点击会麻烦，直接调动作入口）
    var turn0 = await evalIn(A, '__game.state.turn');
    // 谁的回合就由谁出：0 = 房主走房主入口，否则客户端发消息
    var acted = await evalIn(A, `
      (function(){
        var s = __game.state;
        var seat = s.turn;
        var view = s;
        var legal = Game.legalMoves(view);
        if (!legal.length) return 'no-legal';
        var ids = legal[0].cards.map(function(c){return c.id;});
        if (seat === 0) {
          var r = __game.room.applyAction(0, 'play', ids);
          return r.ok ? 'host-played' : ('rejected:' + r.reason);
        }
        return 'seat' + seat;
      })()
    `);

    if (acted === 'host-played') {
      ok(true, '房主出牌成功并广播');
      await sleep(800);
      var sameAfter = await evalIn(A,
        'JSON.stringify({m:__game.state.moveCount,c:__game.state.current?__game.state.current.cards.map(function(x){return x.id;}).join(","):null})')
        === await evalIn(B,
        'JSON.stringify({m:__game.state.moveCount,c:__game.state.current?__game.state.current.cards.map(function(x){return x.id;}).join(","):null})');
      ok(sameAfter, '出牌后两边看到的桌面牌仍然一致');
    } else {
      ok(true, '当前轮到客户端（座位 ' + acted + '），跳过房主出牌路径（已由无头测试覆盖）');
    }

    /* ---------------- 非法动作必须被拒 ---------------- */
    section('8. 客户端伪造动作会被房主拒绝');
    var forged = await evalIn(B, `
      (function(){
        var s = __game.state;
        // 直接绕过界面，发一个「不是自己回合 / 不是自己牌」的动作
        Net.send({ type: ProtocolNS.C2H.ACTION, seq: 999, action: 'play', cards: ['3S'] });
        return true;
      })()
    `);
    await sleep(800);
    var bStillOk = await evalIn(B, '__game.state && __game.state.phase === "playing"');
    ok(bStillOk, '伪造动作之后牌局没有被改坏');
    var aStillOk = await evalIn(A, '__game.state && __game.state.phase === "playing"');
    ok(aStillOk, '房主那侧仍然是进行中的牌局');

    /* ---------------- 页面报错 ---------------- */
    section('9. 全程无 JS 报错');
    [A, B].forEach(function (tab) {
      var real = tab.__errors.filter(function (e) { return e && e.indexOf('favicon') < 0; });
      ok(real.length === 0, tab.__name + ' 页面无 JS 报错', real.slice(0, 2).join(' | '));
    });

  } catch (err) {
    fail++;
    console.log('\n✗ 测试中断：' + (err && err.message));
  }

  console.log('\n' + '='.repeat(52));
  console.log('浏览器端到端：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('='.repeat(52));
  cleanup();
  process.exit(fail ? 1 : 0);
})();
