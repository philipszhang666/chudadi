/* ============================================================
 * sound.js —— 音效引擎（Web Audio API 实时合成，不依赖任何音频文件）
 *
 * 为什么用合成而不是音频文件：
 *   这个游戏是纯静态页面，直接用 file:// 打开。
 *   file:// 下加载外部音频会被浏览器（尤其 Chrome）按 CORS 拦掉，
 *   所以这里用振荡器 + 包络 + 滤波噪声实时合成音效——
 *   零文件、零加载、离线可用。
 *
 * 浏览器要求音频上下文由用户手势创建/恢复，所以：
 *   启动时不建上下文；第一次声音（必然是点击）才创建，并在
 *   之后的每次播放前尝试 resume()。
 * ============================================================ */

var Sound = (function () {
  'use strict';

  var ctx = null;
  var master = null;
  var noiseBuf = null;
  var enabled = true;

  function midi(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  /** 懒创建音频上下文；关闭音效时永远不创建 */
  function ensure() {
    if (!enabled) return null;
    try {
      if (!ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = 0.7;
        master.connect(ctx.destination);

        var n = Math.floor(ctx.sampleRate * 0.5);
        noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
        var d = noiseBuf.getChannelData(0);
        for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      }
      if (ctx.state === 'suspended' && ctx.resume) {
        var p = ctx.resume();
        if (p && p.catch) p.catch(function () { /* 忽略 */ });
      }
      return ctx;
    } catch (e) {
      return null;
    }
  }

  /** 一个带包络的振荡器音 */
  function tone(opt) {
    var c = ensure();
    if (!c) return;
    try {
      var t0 = c.currentTime + (opt.delay || 0);
      var dur = opt.dur || 0.12;
      var vol = opt.vol === undefined ? 0.3 : opt.vol;
      if (vol <= 0) return;

      var o = c.createOscillator();
      o.type = opt.type || 'sine';
      o.frequency.setValueAtTime(opt.freq, t0);
      if (opt.to) o.frequency.exponentialRampToValueAtTime(Math.max(1, opt.to), t0 + dur);

      var g = c.createGain();
      var atk = Math.min(opt.attack === undefined ? 0.005 : opt.attack, dur * 0.5);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + atk);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

      o.connect(g);
      g.connect(master);
      o.start(t0);
      o.stop(t0 + dur + 0.03);
    } catch (e) { /* 忽略 */ }
  }

  /** 一段带包络的滤波噪声（用于「啪」「沙」这类音色） */
  function noise(opt) {
    var c = ensure();
    if (!c || !noiseBuf) return;
    try {
      var t0 = c.currentTime + (opt.delay || 0);
      var dur = opt.dur || 0.08;
      var vol = opt.vol === undefined ? 0.25 : opt.vol;
      if (vol <= 0) return;

      var s = c.createBufferSource();
      s.buffer = noiseBuf;
      s.loop = true;

      var f = c.createBiquadFilter();
      f.type = opt.filter || 'bandpass';
      f.frequency.setValueAtTime(opt.freq || 1200, t0);
      if (opt.to) f.frequency.exponentialRampToValueAtTime(Math.max(1, opt.to), t0 + dur);
      f.Q.value = opt.q === undefined ? 1.2 : opt.q;

      var g = c.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

      s.connect(f);
      f.connect(g);
      g.connect(master);
      s.start(t0);
      s.stop(t0 + dur + 0.03);
    } catch (e) { /* 忽略 */ }
  }

  /* ---------------- 具体音效 ---------------- */

  var FX = {
    /** 选牌 / 取消选择：很轻的一声 */
    tick: function () {
      noise({ freq: 3200, dur: 0.03, vol: 0.10, q: 2.5 });
      tone({ freq: 1500, to: 900, dur: 0.035, vol: 0.045, type: 'triangle' });
    },

    /** 按钮按下 / 过牌：一小声「嗒」 */
    tap: function () {
      tone({ freq: 320, to: 150, dur: 0.07, vol: 0.13, type: 'square' });
      noise({ freq: 900, dur: 0.05, vol: 0.08, q: 1 });
    },

    /** 发牌：沙沙一扫 */
    deal: function () {
      noise({ freq: 900, to: 4200, dur: 0.22, vol: 0.10, q: .7 });
    },

    /** 单张牌打在桌上 */
    play: function () {
      noise({ freq: 1800, to: 500, dur: 0.08, vol: 0.22, q: 1.1 });
      tone({ freq: 240, to: 110, dur: 0.10, vol: 0.16, type: 'triangle' });
    },

    /** 多张牌：几张牌叠着落下的感觉 */
    playMulti: function (n) {
      var k = Math.min(n || 2, 5);
      for (var i = 0; i < k; i++) {
        noise({ delay: i * 0.045, freq: 2000 - i * 180, to: 500, dur: 0.07, vol: 0.16, q: 1.1 });
        tone({ delay: i * 0.045, freq: 260 - i * 18, to: 110, dur: 0.09, vol: 0.11, type: 'triangle' });
      }
    },

    /** 大牌型（同花顺 / 四条 / 葫芦）：更响 + 一点金属感 */
    big: function () {
      noise({ freq: 2400, to: 400, dur: 0.16, vol: 0.24, q: .9 });
      tone({ freq: 180, to: 70, dur: 0.26, vol: 0.20, type: 'sawtooth' });
      tone({ delay: 0.02, freq: 1320, to: 660, dur: 0.20, vol: 0.08, type: 'sine' });
    },

    /** 出牌不合规则：两声低鸣 */
    error: function () {
      tone({ freq: 200, dur: 0.10, vol: 0.20, type: 'sawtooth' });
      tone({ delay: 0.11, freq: 150, dur: 0.14, vol: 0.20, type: 'sawtooth' });
    },

    /** 轮到我出牌：柔和的提示音 */
    turn: function () {
      tone({ freq: midi(76), dur: 0.16, vol: 0.13, type: 'sine' });
      tone({ delay: 0.10, freq: midi(83), dur: 0.24, vol: 0.13, type: 'sine' });
    },

    /** 有人报牌（只剩 1 张） */
    warn: function () {
      tone({ freq: 660, dur: 0.10, vol: 0.16, type: 'triangle' });
      tone({ delay: 0.12, freq: 660, dur: 0.10, vol: 0.16, type: 'triangle' });
    },

    /** 我赢了：上行三音 */
    win: function () {
      [72, 76, 79].forEach(function (m, i) {
        tone({ delay: i * 0.085, freq: midi(m), dur: i === 2 ? 0.5 : 0.18, vol: 0.16, type: 'triangle' });
      });
    },

    /** 别人赢了：下行两音 */
    lose: function () {
      tone({ freq: midi(67), dur: 0.22, vol: 0.14, type: 'triangle' });
      tone({ delay: 0.16, freq: midi(60), dur: 0.40, vol: 0.14, type: 'triangle' });
    }
  };

  /* ---------------- 对外接口 ---------------- */

  function setEnabled(v) { enabled = !!v; }

  function setVolume(v) {
    if (master) master.gain.value = v;
  }

  function play(name) {
    if (!enabled) return;
    var f = FX[name];
    if (f) { try { f(); } catch (e) { /* 忽略 */ } }
  }

  var api = {
    play: play,
    setEnabled: setEnabled,
    setVolume: setVolume,
    FX: FX,
    /** 音频上下文（未创建时为 null）——给测试观察用 */
    context: function () { return ctx; }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
