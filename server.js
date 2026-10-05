/* ============================================================
 * server.js —— 纯静态服务器（只为方便手机实测，联机本身不需要它）
 *
 * 重要：联机不依赖这个脚本！
 *   · 正式玩法是把页面部署在 GitHub Pages 上，大家访问网页，靠
 *     WebRTC 直连（PeerJS 免费 broker 只做牵线，不转发牌局数据）。
 *   · 这个脚本的用途只有一个：你自己在电脑上想用手机试试时，
 *     node server.js 起个本地静态站，手机连同一个 Wi-Fi 打开就够了。
 *
 *   注意 http://<局域网IP>:8080 这种地址在手机上是「非安全上下文」，
 *   但 WebRTC 数据通道和 PeerJS 都不要求安全上下文，所以能正常工作。
 *
 * 跑法：node server.js  [端口]
 * ============================================================ */
'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');
var os = require('os');

var ROOT = __dirname;
var PORT = Number(process.argv[2]) || 8080;

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2'
};

function lanAddresses() {
  var out = [];
  var ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach(function (name) {
    (ifaces[name] || []).forEach(function (a) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name: name, address: a.address });
    });
  });
  return out;
}

var server = http.createServer(function (req, res) {
  var url = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
  if (url === '/') url = '/index.html';

  var file = path.join(ROOT, url);
  // 别让 ../ 跑到仓库外面去
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }

  fs.stat(file, function (err, st) {
    if (err || st.isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 ' + url);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(file).pipe(res);
  });
});

server.listen(PORT, function () {
  var addrs = lanAddresses();
  console.log('');
  console.log('锄大地 · 本地静态服务已启动');
  console.log('');
  console.log('  本机：      http://127.0.0.1:' + PORT + '/');
  addrs.forEach(function (a) {
    console.log('  局域网(' + a.name + ')：http://' + a.address + ':' + PORT + '/');
  });
  console.log('');
  console.log('手机实测步骤：');
  console.log('  1. 电脑和手机连同一个 Wi-Fi');
  console.log('  2. 手机浏览器打开上面那个「局域网」地址');
  console.log('  3. 电脑页面点 🌐 联机 → 开房，拿到 4 位房间码');
  console.log('  4. 手机页面点 🌐 联机 → 输入房间码 → 加入');
  console.log('  5. 电脑上点「开始游戏」');
  console.log('');
  console.log('  （Windows 首次运行可能会弹防火墙提示，选「专用网络」允许即可）');
  console.log('');
  console.log('按 Ctrl+C 停止。');
});
