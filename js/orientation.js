/* ============================================================
 * orientation.js —— 手机端「横屏」处理
 *
 * 浏览器能力差异很大，没法只用一招搞定：
 *   · Android Chrome / Firefox：可以 requestFullscreen() +
 *     screen.orientation.lock('landscape') 真正把屏幕锁成横屏，
 *     但必须由一次「用户手势」触发（浏览器安全限制）。
 *   · iOS Safari：既不给普通元素全屏，也没有 orientation.lock，
 *     网页无法强制旋转 —— 只能提示用户自己把手机横过来。
 *
 * 所以这里做两件事：
 *   1) 竖屏时显示「请横屏使用」提示层（显隐由 styles.css 的媒体查询控制）；
 *   2) 对支持锁方向的浏览器，在提示层里显示一个「全屏并横屏」按钮，
 *      点一下即可全屏 + 锁横屏。
 * ============================================================ */
(function () {
  'use strict';

  function canLockLandscape() {
    return !!(document.documentElement.requestFullscreen &&
      window.screen && screen.orientation &&
      typeof screen.orientation.lock === 'function');
  }

  function goLandscape() {
    var el = document.documentElement;
    var lock = function () {
      try {
        var p = screen.orientation.lock('landscape');
        if (p && p.catch) p.catch(function () { /* 设备不支持就忽略 */ });
      } catch (e) { /* 忽略 */ }
    };
    try {
      var fs = el.requestFullscreen();
      if (fs && fs.then) fs.then(lock, lock);
      else lock();
    } catch (e) {
      lock();
    }
  }

  function init() {
    var btn = document.getElementById('rotateBtn');
    if (!btn) return;
    if (canLockLandscape()) {
      btn.hidden = false;
      btn.addEventListener('click', goLandscape);
    }
    // 不支持锁方向（如 iOS）：按钮保持隐藏，只显示「请横屏」文字提示
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
