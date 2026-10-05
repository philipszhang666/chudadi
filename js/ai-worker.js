/* ============================================================
 * ai-worker.js —— 在后台线程里跑 AI 决策，避免阻塞主线程。
 *
 * 主线程把当前局面（纯数据快照）postMessage 过来；这里算好后，把决策
 * （出牌只回传牌的 id）postMessage 回去。这样电脑「思考」时，主线程
 * 依然能响应：玩家可以照常选牌 / 组合牌。
 *
 * 为什么能直接复用现有模块：
 *   cards.js / game.js / determinize.js / endgame.js / mcts.js / ai.js
 *   都是「纯逻辑、无界面依赖」的脚本，且用 `var X = ...` 申明全局。
 *   在 Worker 里用 importScripts 依序加载即可，无需改动它们。
 *   （ai.js 里对旧版 ai_v1.js 的引用在浏览器/Worker 环境下本就为空，
 *     与页面直接 <script> 加载时的行为一致。）
 * ============================================================ */
'use strict';

importScripts(
  'cards.js',
  'game.js',
  'determinize.js',
  'endgame.js',
  'mcts.js',
  'ai.js'
);

self.onmessage = function (e) {
  var msg = e.data;
  if (!msg || msg.type !== 'decide') return;
  var out;
  try {
    var d = AI.decide(msg.state, msg.index, msg.diff, msg.opts || {});
    out = {
      id: msg.id,
      ok: true,
      action: (d && d.action === 'play') ? 'play' : 'pass',
      // 只回传 id：主线程用自己那份「正规」牌对象去落地，避免跨线程对象不一致
      cards: (d && d.cards) ? d.cards.map(function (c) { return c.id; }) : null
    };
  } catch (err) {
    out = { id: msg.id, ok: false, error: String((err && err.message) || err) };
  }
  self.postMessage(out);
};
