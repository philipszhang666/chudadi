/* ============================================================
 * scale.js —— 把整个游戏固定成 16:9 画布，再整体等比缩放
 *
 * .app 是固定的 1600×900 设计画布（见 styles.css）。这里按视口算出缩放比
 * （contain：取宽、高比例的较小者），把它缩放并居中。效果：
 *   · 内部布局永远在 1600×900 上排好，再整体缩放，永不因屏幕比例重排错乱；
 *   · 手机横屏（又宽又矮）只是缩得更小、左右留黑边，元素相对位置完全不变；
 *   · 桌面窗口比 1600×900 小时自动缩小，比它大时按比例放大铺满。
 * ============================================================ */
(function () {
  'use strict';

  var DW = 1600, DH = 900;   // 设计尺寸（16:9）

  function fit() {
    var app = document.querySelector('.app');
    if (!app) return;
    var W = window.innerWidth || document.documentElement.clientWidth;
    var H = window.innerHeight || document.documentElement.clientHeight;
    var k = Math.min(W / DW, H / DH);          // contain：整块都放得下
    var ox = (W - DW * k) / 2;                 // 居中，多余部分留黑边
    var oy = (H - DH * k) / 2;
    app.style.transform = 'translate(' + ox + 'px,' + oy + 'px) scale(' + k + ')';
  }

  window.addEventListener('resize', fit);
  window.addEventListener('load', fit);
  // 旋转屏幕后，部分浏览器尺寸要过一会儿才更新，补一次
  window.addEventListener('orientationchange', function () {
    fit();
    setTimeout(fit, 300);
  });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', fit);

  // 脚本放在 </body> 前，此时 .app 已存在，直接算一次
  fit();
})();
