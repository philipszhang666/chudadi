/* ============================================================
 * ui.js —— 界面控制（依赖 cards.js / game.js / ai.js）
 * ============================================================ */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var state = null;
  var selected = {};        // 选中的牌 id
  var legalCache = { turn: -1, current: null, list: [] };
  var busy = false;         // 电脑思考中
  var timers = [];
  var botTimerPending = false;

  /* ---------------- 设置 ---------------- */

  var SETTINGS_KEY = 'chudadi.settings.v2';

  // dimUnplayable 默认 false：不能出的牌不做任何提示，
  // 只有玩家真的出了不合规则的牌时才给出警告。
  var DEFAULTS = { playerCount: 4, landlord: true, difficulty: 'hard', speed: 'slow', dimUnplayable: false, sound: 'normal', nonA3ToLast: false };

  // 三档难度 → 实际算法（内部算法名：normal=贪心 / hard=记牌+结构+该不该压 /
  //                                 hardv2=hard+残局精确解 / search=ISMCTS）
  // 普通档 = hardv2：hard 基础上叠加残局精确解（总牌 ≤14 张时用采样+Max^n 求解），
  //          对撞纯 hard 头游率 +1.2pp（z≈3.4，2 万局）。
  // 困难档 = ISMCTS + hardv2 尾盘残局 rollout（rollout 里残局阈值降到 8 张，让搜索能跑满迭代）。
  //   实测 vs 纯 hardv1：rollout=hardv2@8 → 头游率 64.0%（+14.0pp）；
  //   而 rollout=hardv2@14 只有 54.6%（+4.6pp）且慢 7 倍（模拟里残局太频繁，搜索被饿死）。
  var DIFF_ALGO = {
    easy:   { diff: 'normal' },
    normal: { diff: 'hardv2' },
    hard:   { diff: 'search', opts: { search: { rollout: 'hardv2@8', iterations: 120, c: 1, maxMs: 1500 } } }
  };

  // 音效音量档位
  var SOUND_VOLUME = { off: 0, low: 0.35, normal: 0.7, high: 1.0 };

  // 电脑每步的「目标时长」（毫秒）：先算（AI 决策），再补时到该目标。
  // 算得比目标还慢就不再额外等；算得快才补差额。详见 botPlay。
  var SPEED = { slow: 1200, normal: 800, fast: 400 };

  var settings = (function loadSettings() {
    var s = {};
    Object.keys(DEFAULTS).forEach(function (k) { s[k] = DEFAULTS[k]; });
    try {
      var raw = window.localStorage && window.localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        Object.keys(DEFAULTS).forEach(function (k) {
          if (saved[k] !== undefined) s[k] = saved[k];
        });
      }
    } catch (e) { /* 隐私模式等场景忽略 */ }
    if (Game.SUPPORTED_COUNTS.indexOf(s.playerCount) < 0) s.playerCount = DEFAULTS.playerCount;
    if (typeof s.landlord !== 'boolean') s.landlord = DEFAULTS.landlord;
    if (typeof s.nonA3ToLast !== 'boolean') s.nonA3ToLast = DEFAULTS.nonA3ToLast;
    if (s.landlord) s.playerCount = 4;   // A3 地主只在 4 人局里出现
    if (!DIFF_ALGO[s.difficulty]) s.difficulty = DEFAULTS.difficulty;
    if (!SPEED[s.speed]) s.speed = DEFAULTS.speed;
    if (SOUND_VOLUME[s.sound] === undefined) s.sound = DEFAULTS.sound;
    return s;
  })();

  /** 把音效档位应用到引擎 */
  function applySound() {
    Sound.setEnabled(settings.sound !== 'off');
    Sound.setVolume(SOUND_VOLUME[settings.sound]);
  }

  /** 播放音效（统一入口，方便以后加静音条件） */
  function sfx(name) {
    if (settings.sound === 'off') return;
    applySound();
    Sound.play(name);
  }

  function saveSettings() {
    try {
      if (window.localStorage) window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) { /* 忽略 */ }
  }

  /** 把设置同步到界面控件 */
  function applySettingsToUI() {
    var map = {
      segPlayers: settings.landlord ? 'a3' : String(settings.playerCount),
      segDifficulty: settings.difficulty,
      segSpeed: settings.speed,
      segDimUnplayable: settings.dimUnplayable ? 'on' : 'off',
      segNonA3ToLast: settings.nonA3ToLast ? 'on' : 'off',
      segSound: settings.sound
    };
    Object.keys(map).forEach(function (id) {
      var box = $(id);
      if (!box) return;
      Array.prototype.forEach.call(box.children, function (btn) {
        var on = btn.dataset && btn.dataset.value === map[id];
        btn.classList.toggle('active', !!on);
      });
    });
    var labels = { easy: '简单', normal: '普通', hard: '困难' };
    var modeLabel = settings.landlord ? 'A3 地主' : settings.playerCount + ' 人';
    var sum = $('setupSummary');
    if (sum) sum.textContent = modeLabel + ' · ' + labels[settings.difficulty];
  }

  /** 高精度计时（拿不到 performance 时退化成 Date.now） */
  function nowMs() {
    return (window.performance && window.performance.now) ? window.performance.now() : Date.now();
  }

  // 对手座位：四角。你在桌子下方正中。
  // 顺序按反向轮转（你 → 右上 → 左上 → 左下），这样 3 人局两个对手
  // 正好坐在两个上角，与你左右对称。
  //   3 人局 → 右上(1)、左上(2)          （下方两个角留空，保持对称）
  //   4 人局 → 右上(1)、左上(2)、左下(3)
  var SEAT_SLOTS = ['seat-tr', 'seat-tl', 'seat-bl', 'seat-br'];

  var LAYOUT_BY_COUNT = {
    3: 2,   // 用 SEAT_SLOTS 的前 2 个
    4: 3    // 用前 3 个
  };

  /* ---------------- 小工具 ---------------- */

  // 局号：每开新局 +1。定时器回调执行前会核对自己的局号，
  // 旧局遗留的定时器（包括执行中又排出的新定时器）一律作废，
  // 否则会把新一局的状态改坏（座位布局被覆盖、牌数对不上等）。
  var gameSeq = 0;

  function clearTimers() {
    timers.forEach(clearTimeout);
    timers = [];
    gameSeq++;          // 让所有在途回调失效
    botTimerPending = false;
  }

  /** 把回调绑定到当前局；局号变了就不再执行 */
  function later(fn, ms) {
    var seq = gameSeq;
    var t = setTimeout(function () {
      if (seq !== gameSeq) return;   // 这一局已经被替换了
      fn();
    }, ms);
    timers.push(t);
    return t;
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  /* ---------------- 渲染：扑克牌 ---------------- */

  /**
   * 一张牌：只在左上角显示「点数 + 花色」（点数在上、花色在下）。
   * 没有居中水印，也没有右下角旋转角标。
   */
  function cardEl(card, mini, faceDown) {
    if (faceDown) {
      return el('div', 'back');
    }
    var e = el('div', 'card' + (mini ? ' mini' : '') + ' ' + (card.red ? 'red' : 'black'));
    e.dataset.id = card.id;

    var corner = el('div', 'corner');
    corner.appendChild(el('span', 'r', card.rank));
    corner.appendChild(el('span', 's', card.sym));
    e.appendChild(corner);
    e.title = card.sym + card.rank;

    return e;
  }

  /* ---------------- 出牌显示顺序 ----------------
     一手牌画到桌面 / 写进说明里时，从左到右的顺序按牌型决定：
       · 顺子 / 同花顺：按顺子序列从小到大（2 3 4 5 6 … K A）；
         A-2-3-4-5 是特例，A 当最小，显示成 A 2 3 4 5
       · 同花：按改版点数从小到大（4 5 6 … A 2 3，3 最大排最右）
       · 葫芦（三带二）：先三张、后两张
       · 四条（四带一）：先四张、后脚牌
       · 其余牌型：保持从大到小（与原样一致） */

  function playCardsInDisplayOrder(play) {
    if (!play || !play.cards) return [];
    var cards = play.cards;
    var cat = play.category;

    // 顺子 / 同花顺：按顺子序列从小到大
    if (cat === 'straight' || cat === 'straightflush') {
      var wheel = !!play.special;   // A-2-3-4-5：A 当最小
      return cards.slice().sort(function (a, b) {
        var ka = (wheel && a.rank === 'A') ? -1 : CD.STRAIGHT_ORDER[a.rank];
        var kb = (wheel && b.rank === 'A') ? -1 : CD.STRAIGHT_ORDER[b.rank];
        return (ka - kb) || (a.suitOrder - b.suitOrder);
      });
    }

    // 同花：改版点数从小到大
    if (cat === 'flush') return CD.sortAsc(cards);

    // 葫芦（三带二）：三张在前、两张在后
    if (cat === 'fullhouse') return nthFirst(cards, 3);

    // 四条（四带一）：四张在前、脚牌在后
    if (cat === 'quads') return nthFirst(cards, 4);

    // 其余（单张 / 对子 / 三条）：从大到小，保持原样
    return CD.sortDesc(cards);
  }

  /** 把出现 n 次的那个点数整体排到前面（组内按大小），其余牌排到后面（组内按大小） */
  function nthFirst(cards, n) {
    var byRank = {};
    cards.forEach(function (c) {
      if (!byRank[c.rank]) byRank[c.rank] = [];
      byRank[c.rank].push(c);
    });
    var head = [], tail = [];
    Object.keys(byRank).forEach(function (r) {
      var g = CD.sortDesc(byRank[r]);
      if (byRank[r].length === n) head = head.concat(g);
      else tail = tail.concat(g);
    });
    return head.concat(tail);
  }

  /* ---------------- 渲染：座位 ---------------- */

  /** 按人数显示/隐藏角落座位，并同步你自己的座位信息 */
  function applyLayout() {
    var used = LAYOUT_BY_COUNT[state.players.length] || LAYOUT_BY_COUNT[4];
    SEAT_SLOTS.forEach(function (id, i) {
      var box = $(id);
      if (box) box.hidden = (i >= used);
    });
    renderMySeat();
  }

  /** 你的座位（桌子下方正中）：名字、张数、轮到你了 / 头游 / 报牌 */
  function renderMySeat() {
    var box = $('seat-me');
    if (!box) return;
    var me = state.players[0];
    var inline = $('myCountInline');
    if (inline) inline.textContent = me.hand.length + ' 张';

    // 名字元素在 index.html 里（不要清空 box，否则会把它删掉）
    var name = box.querySelector ? box.querySelector('.pname') : null;
    if (name) name.classList.toggle('active', state.turn === 0 && state.phase === 'playing');

    var info = $('mySeatInfo');
    if (!info) return;
    info.innerHTML = '';
    var bits = [];
    if (me.rank === 1) bits.push(['rank1', '头游']);
    else if (me.finished) bits.push([null, '第 ' + me.rank + ' 名']);
    if (me.announced) bits.push(['rank1', '报牌 1 张']);
    if (state.landlord && state.landlord.members.indexOf(0) >= 0) {
      var selfRevealed = state.revealed['AS'] === 0 || state.revealed['3S'] === 0;
      bits.push(['landlord', selfRevealed ? '地主（已亮牌）' : '暗地主']);
    }
    if (state.phase === 'playing' && state.turn === 0) bits.push([null, '轮到你出牌']);
    bits.forEach(function (b) { info.appendChild(el('span', b[0], b[1])); });
  }

  function renderSeat(player) {
    var box = $(SEAT_SLOTS[player.index - 1]);
    if (!box) return;
    box.innerHTML = '';

    var name = el('div', 'pname' + (state.turn === player.index && state.phase === 'playing' ? ' active' : ''));
    name.appendChild(el('span', 'dot'));
    name.appendChild(el('span', null, player.name));
    name.appendChild(el('span', 'pc', player.hand.length + ' 张'));
    box.appendChild(name);

    var info = el('div', 'pinfo');
    if (player.rank === 1) info.appendChild(el('span', 'rank1', '头游'));
    else if (player.finished) info.appendChild(el('span', null, '第 ' + player.rank + ' 名'));
    if (player.announced) info.appendChild(el('span', 'rank1', '报牌 1 张'));
    if (state.landlord) {
      var isLm = state.landlord.members.indexOf(player.index) >= 0;
      var revealed = state.revealed['AS'] === player.index || state.revealed['3S'] === player.index;
      if (isLm && revealed) info.appendChild(el('span', 'landlord', '地主'));
    }
    if (state.players[state.turn] === player && state.phase === 'playing') info.appendChild(el('span', null, '思考中…'));
    if (info.childNodes.length) box.appendChild(info);

    // 本墩出牌 / 手牌
    var wrap = el('div', 'pcards');
    if (player.hand.length === 0 && !(player.lastPlay && state.currentOwner === player.index)) {
      wrap.appendChild(el('div', 'passed-badge', '已出完'));
    } else if (player.lastPlay && state.currentOwner === player.index) {
      playCardsInDisplayOrder(player.lastPlay).forEach(function (c) {
        wrap.appendChild(cardEl(c, true));
      });
    } else if (player.played && player.played.length) {
      CD.sortDesc(player.played).forEach(function (c) { wrap.appendChild(cardEl(c, true)); });
    } else if (player.passed && state.trick.length) {
      wrap.appendChild(el('div', 'passed-badge', '过 牌'));
    } else {
      // 牌背按「真实剩余张数」显示：数一数牌背就知道对手还剩几张
      var pile = el('div', 'pile');
      for (var i = 0; i < player.hand.length; i++) pile.appendChild(cardEl(null, true, true));
      wrap.appendChild(pile);
    }
    box.appendChild(wrap);
  }

  /* ---------------- 渲染：中央 ---------------- */

  var centerVisual = { sig: '' };

  function centerSig() {
    if (!state.current) return '';
    return state.currentOwner + '|' + CD.cardsText(state.current.cards) + '|' + state.round;
  }

  function renderCenter() {
    if (!state) return;
    var tag = $('turnTag');

    if (state.phase === 'over') {
      tag.textContent = '本局结束';
    } else {
      tag.textContent = state.turn === 0 ? '轮到你出牌' : state.players[state.turn].name + ' 出牌中';
    }
    $('roundTag').textContent = '第 ' + state.round + ' 墩';
    renderTrickLog();   // 出牌记录每次出牌 / 过牌都要刷新（不受下面“桌面牌没变”的短路影响）

    // 桌面牌没变化就直接返回：否则每次重渲染都会把「西家的葫芦（…）」
    // 覆盖成「你 领出…」这类过时说明
    var sig = centerSig();
    if (sig === centerVisual.sig) return;
    centerVisual = { sig: sig };
    drawCenterCards();
  }

  /* ---------------- 渲染：本轮出牌记录 ----------------
     只显示最近「一圈」（每个玩家各出一次）的动作，做成一排小标签，过牌单独高亮。
     一圈走完、又轮到已经出过的玩家时，就开始显示新的一轮。 */

  var trickLogSig = '';

  /** 取最近的一圈：从末尾往前收，遇到重复的玩家就停（= 该开新的一圈了） */
  function currentLap(entries, pc) {
    var out = [], seen = {};
    for (var i = entries.length - 1; i >= 0; i--) {
      var e = entries[i];
      if (seen[e.player]) break;
      seen[e.player] = true;
      out.unshift(e);
      if (out.length >= pc) break;
    }
    return out;
  }

  function renderTrickLog() {
    var box = $('trickLog');
    if (!box) return;

    // 本墩进行中看本墩；刚结束、还没人领出就看上一墩 —— 反正都只取最近的一圈
    var src = (state.trick && state.trick.length) ? state.trick
            : (state.lastTrick && state.lastTrick.length) ? state.lastTrick
            : null;
    if (!src) {
      if (!box.hidden || box.innerHTML) { box.hidden = true; box.innerHTML = ''; trickLogSig = ''; }
      return;
    }
    var entries = currentLap(src, state.players.length);

    var sig = entries.map(function (e) {
      return e.player + (e.passed ? 'p' : 'x' + (e.play && e.play.cards ? CD.cardsText(e.play.cards) : ''));
    }).join(',');
    if (sig === trickLogSig && !box.hidden) return;
    trickLogSig = sig;

    box.hidden = false;
    box.innerHTML = '';
    var inner = el('div', 'tl-inner');
    inner.appendChild(el('span', 'tl-label', '本轮'));
    entries.forEach(function (entry, i) {
      var chip = el('span', 'tl-chip ' + (entry.passed ? 'tl-pass' : 'tl-play'));
      chip.appendChild(el('span', 'tl-who', state.players[entry.player].name));
      if (entry.passed) {
        chip.appendChild(el('span', 'tl-act', '过牌'));
      } else {
        chip.appendChild(el('span', 'tl-act', '出'));
        chip.appendChild(el('span', 'tl-cards',
          playCardsInDisplayOrder(entry.play).map(CD.cardText).join(' ')));
      }
      if (i === entries.length - 1) chip.classList.add('tl-new');   // 最新一条做淡入
      inner.appendChild(chip);
    });
    box.appendChild(inner);
  }

  /** 直接把当前桌面上的牌画到中央（不做飞牌动画） */
  function drawCenterCards() {
    var box = $('centerCards');
    box.innerHTML = '';
    if (!state.current) return;
    playCardsInDisplayOrder(state.current).forEach(function (c) {
      box.appendChild(cardEl(c, false));
    });
  }

  /* ---------------- 未开局：正中的「开始游戏」 ----------------
     刚进页面、以及每一局结束后，都停在「未开局」状态：
     state === null，牌桌清空，正中间只有一个「开始游戏」按钮。
     点了它才发牌（newGame），不点就一直等着，电脑也不会自己出牌。 */

  var lastSummary = '';     // 上一局的结果，写在开始界面里

  /** 回到未开局状态。summary 传入上一局结果时会显示出来 */
  function showStartScreen(summary) {
    clearTimers();          // 作废在途定时器，电脑不会自己接着出牌
    busy = false;
    botTimerPending = false;
    selected = {};
    legalCache = { turn: -1, current: null, moveCount: -1, list: [] };
    centerVisual = { sig: '' };
    lastTurnAnnounced = -1;
    tailIds = [];           // 新一局：手牌是新发的，「组合」记录清空
    dragging = false;       // 万一开新局时正按着鼠标划牌，这里收尾
    suppressClick = false;
    state = null;
    if (summary !== undefined) lastSummary = summary;
    var ov = $('overlay');
    if (ov) ov.hidden = true;
    renderIdle();
  }

  /** 未开局的画面：牌桌清空，只留正中的「开始游戏」按钮 */
  function renderIdle() {
    // 座位清空（座位框保留，开局时布局不跳动）
    SEAT_SLOTS.forEach(function (id) {
      var box = $(id);
      if (box) box.innerHTML = '';
    });
    var mySeat = $('seat-me');
    if (mySeat && mySeat.querySelector) {
      var nm = mySeat.querySelector('.pname');
      if (nm) nm.classList.remove('active');
    }
    var myInfo = $('mySeatInfo');
    if (myInfo) myInfo.innerHTML = '';
    if ($('myCountInline')) $('myCountInline').textContent = '0 张';
    if ($('myCount')) $('myCount').textContent = '0 张';
    if ($('myBadge')) $('myBadge').hidden = true;

    if ($('turnTag')) $('turnTag').textContent = '等待开始';
    if ($('roundTag')) $('roundTag').textContent = '—';
    if ($('centerCards')) $('centerCards').innerHTML = '';
    if ($('trickLog')) { $('trickLog').innerHTML = ''; $('trickLog').hidden = true; }
    if ($('hand')) {
      $('hand').innerHTML = '';
      $('hand').classList.remove('dim-on');
      $('hand').classList.remove('dim-all');
    }

    // 注意：btnClear 不在这里禁用 —— updateSelection / syncTurnUI 都不管它的
    // disabled，一旦在未开局时禁掉，整局都会是灰的。它在未开局时点了也是空操作。
    // btnGroup 可以禁（newGame 里会重新启用），因为没手牌时捡牌没有意义。
    ['btnPass', 'btnPlay', 'btnHint', 'btnGroup'].forEach(function (id) {
      if ($(id)) $(id).disabled = true;
    });
    setTip('');
    setSelInfo('点「开始游戏」发牌');

    if ($('startTitle')) $('startTitle').textContent = lastSummary ? '本局结束' : '准备开始';
    // 按钮下面一行：我的累计输赢局数
    if ($('startRecord')) $('startRecord').textContent = myRecordText();
    if ($('startHint')) {
      $('startHint').textContent = lastSummary || '点「开始游戏」发牌，持 ♦4 的人先出';
    }
    if ($('center')) $('center').classList.add('idle');
    if ($('startScreen')) $('startScreen').hidden = false;
  }


  /* ---------------- 渲染：我的手牌 ---------------- */

  function currentLegal() {
    if (!state || state.phase !== 'playing' || state.turn !== 0) return [];
    if (legalCache.turn === state.turn && legalCache.current === state.current &&
        legalCache.moveCount === state.moveCount) return legalCache.list;
    var list = Game.legalMoves(state);
    legalCache = { turn: state.turn, current: state.current, moveCount: state.moveCount, list: list };
    return list;
  }

  /** 某张牌是否参与至少一个合法出牌 */
  function cardIsPlayable(cardId, legal) {
    for (var i = 0; i < legal.length; i++) {
      var cs = legal[i].cards;
      for (var j = 0; j < cs.length; j++) if (cs[j].id === cardId) return true;
    }
    return false;
  }

  function renderHandCards() {
    if (!state) return;
    var me = state.players[0];
    var box = $('hand');
    box.innerHTML = '';
    // 默认不加任何视觉提示；只有设置里打开「标注不能出的牌」才逐张压暗
    box.classList.toggle('dim-on', !!settings.dimUnplayable);
    var legal = currentLegal();
    var myTurn = state.phase === 'playing' && state.turn === 0;
    // 轮到我、且桌上这手我一张都压不过（只能过牌）→ 整把牌一律压暗。
    // 这条规则永远生效，和设置里的「标注不能出的牌」开关无关。
    var cannotPlay = myTurn && state.current !== null && legal.length === 0;
    box.classList.toggle('dim-all', cannotPlay);

    handDisplayOrder(me.hand).forEach(function (c) {
      var e = cardEl(c, false);
      var playable = myTurn && cardIsPlayable(c.id, legal);
      // 不能出的牌不做任何标注（只有 dimUnplayable 打开时由容器上的类来压暗）
      if (myTurn && !playable) e.classList.add('unplayable');
      if (selected[c.id]) e.classList.add('sel');
      // 单击 = 切换这一张；按住（鼠标左键 / 手指）划过一串 = 成批选 / 成批取消
      e.__card = c;   // 触摸划选时用 elementFromPoint 找回这张牌对应的对象
      e.addEventListener('mousedown', function (ev) { onCardMouseDown(ev, c, e); });
      e.addEventListener('mouseenter', function () { onCardDragOver(c, e); });
      e.addEventListener('mousemove', function () { onCardDragOver(c, e); });
      e.addEventListener('mouseup', endCardDrag);
      e.addEventListener('click', function (ev) { onCardClick(ev, c); });
      e.addEventListener('touchstart', function (ev) { onCardTouchStart(ev, c, e); }, { passive: false });
      box.appendChild(e);
    });

    $('myCount').textContent = me.hand.length + ' 张';
    $('myBadge').hidden = !me.announced;
  }

  /** 重建手牌 */
  function renderHand() {
    renderHandCards();
  }

  /* ---------------- 捡牌：把选中的牌组合到最右边 ----------------
     手牌默认按大小排（CD.sortDesc）。点「组合」可以把选中的牌捡出来、
     一起挪到手牌最右边，其余牌保持原来的大小顺序不变。
     顺序按牌 id 记在 tailIds 里：
       · 出掉某张牌后，它的 id 自然从 tailIds 里失效，不会影响别人
       · 开新一局 / 回开始界面会清空（手牌本来就是新发的） */

  var tailIds = [];         // 被「组合」到最右边的牌 id（按点击时的先后顺序）

  /** 手牌显示顺序：默认大小顺序，「组合」过的牌排在最右边 */
  function handDisplayOrder(hand) {
    var sorted = CD.sortDesc(hand);
    if (!tailIds.length) return sorted;
    var tail = [];
    tailIds.forEach(function (id) {
      var c = null;
      for (var i = 0; i < sorted.length; i++) if (sorted[i].id === id) { c = sorted[i]; break; }
      if (c) tail.push(c);          // 已经出掉的牌直接跳过
    });
    var inTail = {};
    tail.forEach(function (c) { inTail[c.id] = 1; });
    var head = sorted.filter(function (c) { return !inTail[c.id]; });
    return head.concat(tail);
  }

  /**
   * 「组合」按钮：
   *   选了牌 → 这些牌按当前顺序挪到手牌最右边（再点一次会挪到更右边）
   *   没选牌 → 恢复默认的大小排序（捡错了可以退回去）
   */
  function doGroup() {
    if (!state) return;
    var order = handDisplayOrder(state.players[0].hand);
    var picked = order.filter(function (c) { return selected[c.id]; })
      .map(function (c) { return c.id; });

    if (!picked.length) {
      if (!tailIds.length) {
        setSelInfo('先点牌选中，再点「组合」把它们挪到最右边', 'err');
        sfx('error');
        return;
      }
      tailIds = [];
      sfx('tap');
      updateSelection();       // 重画手牌 + 同步按钮状态
      setSelInfo('已恢复默认排序（按大小从左到右）', 'ok');
      return;
    }

    // 已经组合过的牌先摘掉，再按当前顺序接到队尾
    tailIds = tailIds.filter(function (id) { return picked.indexOf(id) < 0; }).concat(picked);
    var text = CD.cardsText(selectedCards());
    selected = {};             // 组合完自动取消选中：捡过去的牌自己「降下去」
    sfx('tick');
    updateSelection();
    setSelInfo('已把 ' + text + ' 捡到最右边（已取消选中）', 'ok');
  }

  /* ---------------- 提示文字 ---------------- */

  function setTip(text, kind) {
    var t = $('tip');
    t.textContent = text || '';
    t.className = 'tip' + (kind ? ' ' + kind : '');
  }

  function setSelInfo(text, kind) {
    var s = $('selInfo');
    s.textContent = text;
    s.className = 'sel-info' + (kind ? ' ' + kind : '');
  }

  /* ---------------- 选择与合法性 ----------------
     选牌不设限（select 阶段不判合法），
     合法性判断统一放在点「出牌」的 doPlay 里。 */

  function selectedCards() {
    return state.players[0].hand.filter(function (c) { return selected[c.id]; });
  }

  function updateSelection() {
    if (!state) return;                 // 未开局：没有任何可操作的东西
    var me = state.players[0];
    var myTurn = state.phase === 'playing' && state.turn === 0;
    var legal = currentLegal();
    var cards = selectedCards();

    renderMySeat();     // 座位高亮 / 张数也要跟着轮次更新
    renderHand();

    $('btnPass').disabled = !myTurn || state.current === null;
    $('btnPlay').disabled = !myTurn || !cards.length;
    $('btnHint').disabled = !myTurn || !legal.length;

    if (state.phase === 'over') {
      setSelInfo('本局已结束');
      return;
    }
    // 选了什么优先显示（别人出牌时选牌、组合也要看得见自己选了什么），
    // 选牌阶段不做任何合法性判断：想说「这几张能不能出」就点「出牌」。
    if (cards.length) {
      setSelInfo('已选 ' + cards.length + ' 张：' + CD.cardsText(cards));
      return;
    }
    if (!myTurn) {
      setSelInfo('等待 ' + state.players[state.turn].name + '…（可以选牌 / 组合，只是不能出牌）');
      return;
    }
    setSelInfo(legal.length ? '请选择要出的牌' : '你没有能压过的牌，只能过牌');
  }

  /* ---------------- 选牌：单击 + 按住左键划过去 ----------------
     单击一张 = 选中 / 取消这一张。
     按住鼠标左键划过一串牌 = 成批处理：
       起始那张原本没选中 → 划过的全部选中
       起始那张原本已选中 → 划过的全部取消
     拖动过程中只切换牌上的 .sel 类（不重建 DOM，不然划到一半元素被换掉），
     松手时才 updateSelection() 统一刷新按钮和底部说明。 */

  var suppressClick = false;   // mousedown 已经处理过，紧随其后的 click 不要重复切换
  var dragging = false;        // 正按着左键划牌
  var dragMode = 'select';     // 'select' = 划过的都选中；'deselect' = 划过的都取消
  var lastDragId = null;       // 上一张处理过的牌，同一张牌不重复触发

  /** 把某张牌设为选中/未选中；返回是否真的变了。cardNode 有的话顺手切 .sel 类 */
  function setCardSelected(card, on, cardNode) {
    if (on) {
      if (selected[card.id]) return false;
      selected[card.id] = 1;
    } else {
      if (!selected[card.id]) return false;
      delete selected[card.id];
    }
    if (cardNode && cardNode.classList) cardNode.classList.toggle('sel', !!on);
    sfx('tick');
    return true;
  }

  function selectByDrag(card, cardNode) {
    if (!dragging || lastDragId === card.id) return;
    lastDragId = card.id;
    setCardSelected(card, dragMode === 'select', cardNode);
  }

  function onCardMouseDown(ev, card, cardNode) {
    if (!state || state.phase !== 'playing') return;
    if (ev && ev.button !== undefined && ev.button !== 0) return;   // 只认鼠标左键
    if (ev && ev.preventDefault) ev.preventDefault();               // 别选中文字 / 别触发原生拖拽
    suppressClick = true;
    dragging = true;
    lastDragId = null;
    // 起始牌的状态决定这一趟是「批量选中」还是「批量取消」
    dragMode = selected[card.id] ? 'deselect' : 'select';
    selectByDrag(card, cardNode);
  }

  function onCardDragOver(card, cardNode) {
    if (!dragging) return;
    suppressClick = true;
    selectByDrag(card, cardNode);
  }

  /** 松手：结束拖动并统一刷新（按钮状态、底部「已选 N 张」） */
  function endCardDrag() {
    if (!dragging) return;
    dragging = false;
    lastDragId = null;
    updateSelection();
  }

  /** 触摸版「按下」：等价于鼠标 mousedown —— 开始一次划选 */
  function onCardTouchStart(ev, card, cardNode) {
    if (!state || state.phase !== 'playing') return;
    if (!ev.touches || ev.touches.length !== 1) return;   // 多指（缩放）忽略
    ev.preventDefault();                                  // 阻止滚动/缩放，也不再补发鼠标事件
    suppressClick = true;
    dragging = true;
    lastDragId = null;
    // 起始牌的状态决定这一趟是「批量选中」还是「批量取消」
    dragMode = selected[card.id] ? 'deselect' : 'select';
    selectByDrag(card, cardNode);
  }

  /**
   * 触摸版「划过」：touchmove 的 target 永远是起手那张牌，
   * 所以用 elementFromPoint 找出指头当前压在哪张牌上，再处理它。
   */
  function onDocTouchMove(ev) {
    if (!dragging || !ev.touches || !ev.touches.length) return;
    ev.preventDefault();
    var t = ev.touches[0];
    var node = document.elementFromPoint(t.clientX, t.clientY);
    var cardNode = (node && node.closest) ? node.closest('.hand .card') : null;
    if (cardNode && cardNode.__card) onCardDragOver(cardNode.__card, cardNode);
  }

  /**
   * 点手牌 = 选中 / 取消选中。
   * · 不做任何合法性限制：想出哪张就选哪张，合不合法只在点「出牌」时判断（见 doPlay）。
   * · 不限制轮次：别人出牌的时候也能点自己的牌（方便趁这段时间先把要留的牌「组合」到一边），
   *   只是这时候「出牌 / 过牌 / 提示」三个按钮是禁用的。
   * · 浏览器在 mousedown → mouseup 之后还会补一个 click；那次 click 要忽略掉，
   *   否则刚选中的牌会被立刻取消（拖动同理）。
   */
  function onCardClick(ev, card) {
    if (suppressClick) { suppressClick = false; return; }
    if (!state || state.phase !== 'playing') return;
    if (selected[card.id]) delete selected[card.id];
    else selected[card.id] = 1;
    sfx('tick');
    updateSelection();
  }

  /* ---------------- 出牌 / 过牌 ---------------- */

  /**
   * 任何一方出牌后的统一收尾：重建界面 + 同步按钮状态，再决定轮到谁。
   * 注意：轮到玩家时也必须刷新，否则电脑刚出完牌时
   * 「出牌/过牌」按钮会停留在旧状态（disabled）。
   */
  function finishMove(play, actor) {
    legalCache = { turn: -1, current: null, moveCount: -1, list: [] };
    CD.clearMoveCache();
    renderAll();
    syncTurnUI();
    playMoveSound(play, actor);
    announceLandlordCards(play, actor);

    if (state.phase === 'over') { scheduleResult(); return; }
    if (state.turn === 0) { announceMyTurn(); return; }
    scheduleBots();
  }

  /** 出牌音效：按牌型大小换音色 */
  function playMoveSound(play, actor) {
    if (!play) { sfx('tap'); return; }        // 过牌
    if (play.category === 'straightflush' || play.category === 'quads' || play.category === 'fullhouse') {
      sfx('big');
    } else if (play.cards.length > 1) {
      sfx('playMulti');
    } else {
      sfx('play');
    }
    // 有人报牌（只剩 1 张）提醒一下
    if (actor && actor.announced) later(function () { sfx('warn'); }, 160);
  }

  /** A3 地主：有人亮出 ♠A / ♠3 时提示全场（若是队友，顺便认出来） */
  function announceLandlordCards(play, actor) {
    if (!state || !state.landlord || !play || !play.cards || !actor) return;
    play.cards.forEach(function (c) {
      if ((c.id !== 'AS' && c.id !== '3S') || state.revealed[c.id] !== actor.index) return;
      var partner = state.landlord.members.indexOf(0) >= 0 && actor.index !== 0;
      var msg = actor.name + ' 亮出 ' + CD.cardText(c) + '！' + (partner ? ' 他就是你的队友！' : '');
      later(function () { setTip(msg); }, 120);
    });
  }

  /** 按当前轮次同步按钮 / 提示 */
  function syncTurnUI() {
    if (!state) return;
    // 交给 updateSelection：它会按「轮到谁 + 我选了什么」把按钮和底部说明一起刷新
    // （轮不到我时出牌/过牌/提示自然都是禁用的）
    updateSelection();
  }

  /** 供调试使用：当前内部标志位 */
  function debugFlags() {
    return { busy: busy, botTimerPending: botTimerPending, gameSeq: gameSeq };
  }

  function doPlay() {
    if (!state || busy || state.phase !== 'playing' || state.turn !== 0) return;
    var cards = selectedCards();
    if (!cards.length) return;
    var r = Game.play(state, 0, cards);
    if (!r.ok) { setSelInfo('✗ ' + r.reason, 'err'); sfx('error'); return; }
    selected = {};
    finishMove(r.play, state.players[0]);
  }

  function doPass() {
    if (!state || busy || state.phase !== 'playing' || state.turn !== 0) return;
    if (state.current === null) { setSelInfo('✗ 领出时不能过牌，必须出牌', 'err'); sfx('error'); return; }
    var r = Game.pass(state, 0);
    if (!r.ok) { setSelInfo('✗ ' + r.reason, 'err'); sfx('error'); return; }
    selected = {};
    finishMove(null, null);
  }

  /**
   * 提示：没选牌时选「最小的一手」；
   * 已经选了牌时，补全成包含这些牌的最小合法出牌（例如点了 ♦4 就配成 ♣5♦5♦4）。
   */
  function doHint() {
    if (!state) return;
    var legal = currentLegal();
    if (!legal.length) { setSelInfo('没有可出的牌', 'err'); return; }

    var picked = selectedCardsIds();
    var target = null;
    if (picked.length) {
      var pool = legal.filter(function (p) {
        return picked.every(function (id) {
          return p.cards.some(function (c) { return c.id === id; });
        });
      });
      if (pool.length) target = pool[0];
    }
    if (!target) {
      // 没选牌（或选的牌配不成牌型）：推荐张数最少的一手
      target = legal.slice().sort(CD.bySizeThenPower)[0];
    }

    selected = {};
    target.cards.forEach(function (c) { selected[c.id] = 1; });
    sfx('tick');
    updateSelection();
    setSelInfo('提示：' + target.name + '：' + CD.cardsText(target.cards), 'ok');
  }

  function selectedCardsIds() {
    return state.players[0].hand.filter(function (c) { return selected[c.id]; })
      .map(function (c) { return c.id; });
  }

  /* ---------------- 电脑回合 ---------------- */

  /* ---------------- AI 后台线程（避免阻塞界面） ----------------
     把 AI 决策丢到 Worker 里算，主线程就不卡：电脑「思考」时玩家照样能
     选牌 / 组合牌。拿不到 Worker（例如用 file:// 直接打开被浏览器拦截）
     时，自动退回主线程同步计算；功能不受影响，只是那一下会短暂卡顿。 */
  var aiWorker = null;     // null=待初始化 / Worker 实例 / false=不可用
  var aiJob = null;        // 在途请求 { id, done }
  var aiJobId = 0;

  function ensureWorker() {
    if (aiWorker !== null) return aiWorker;
    if (typeof Worker === 'undefined') { aiWorker = false; return false; }
    try {
      var w = new Worker('js/ai-worker.js');
      w.onmessage = function (e) {
        var job = aiJob;
        if (!job || !e.data || e.data.id !== job.id) return;
        aiJob = null;
        job.done(e.data);
      };
      w.onerror = function (ev) {
        console.error('AI 后台线程出错，退回主线程计算：', ev && ev.message);
        aiWorker = false;
        var job = aiJob; aiJob = null;
        if (job) job.done(null);
      };
      aiWorker = w;
    } catch (err) {
      console.warn('无法创建 AI 后台线程（file:// 打开时常见），退回主线程计算：',
        err && err.message);
      aiWorker = false;
    }
    return aiWorker;
  }

  /** 让 AI 决策：优先后台线程；回调收到 null 表示后台不可用、需回退同步算 */
  function aiDecideAsync(state, idx, diff, opts, cb) {
    var w = ensureWorker();
    if (!w) { cb(null); return; }
    var id = ++aiJobId;
    aiJob = { id: id, done: cb };
    try {
      w.postMessage({ type: 'decide', id: id, state: state, index: idx, diff: diff, opts: opts || {} });
    } catch (err) {
      console.error('向后台线程发送局面失败，退回主线程：', err && err.message);
      aiWorker = false;
      aiJob = null;
      cb(null);
    }
  }

  function scheduleBots() {
    if (!state || state.phase !== 'playing') { busy = false; return; }
    if (state.turn === 0) {
      // 轮到玩家：必须清掉 busy 并同步按钮，
      // 否则 doPlay/doPass 开头的 busy 守卫会静默吞掉点击
      busy = false;
      syncTurnUI();
      announceMyTurn();
      return;
    }
    if (botTimerPending) return;
    // 先让浏览器把上一步的重绘画出来，再进 botPlay 去「先算」
    // （AI 决策是同步阻塞的，直接算会卡住上一步的显示）
    botTimerPending = true;
    busy = true;
    later(function () {
      botTimerPending = false;
      busy = false;
      botPlay();
    }, 0);
  }

  /** 轮到我出牌时的提示音（只在「刚轮到我」的那一下响） */
  var lastTurnAnnounced = -1;
  function announceMyTurn() {
    if (!state || state.phase !== 'playing' || state.turn !== 0) return;
    // 用 moveCount 去重：同一手不要重复响
    if (lastTurnAnnounced === state.moveCount) return;
    lastTurnAnnounced = state.moveCount;
    sfx('turn');
  }

  function botPlay() {
    if (!state || state.phase !== 'playing' || state.turn === 0) return;
    if (botTimerPending) return;
    var idx = state.turn;
    var actor = state.players[idx];
    var algo = DIFF_ALGO[settings.difficulty] || DIFF_ALGO.normal;
    // A3 地主模式：换成地主版算法（残局 / 搜索的终局收益都按「队伍名次」结算）
    //   普通档 hardv2 → hardA3v2
    //   困难档 search(rollout:hardv2@8) → search(rollout:hardv1)
    //   （rollout 换成便宜的 hardv1；搜索终局收益仍由 mcts.js 按「地主队名次」结算）
    if (settings.landlord) {
      if (algo.diff === 'hardv2') {
        algo = { diff: 'hardA3v2' };
      } else if (algo.diff === 'search' && algo.opts && algo.opts.search) {
        var _so = {}, _s0 = algo.opts.search;
        for (var _k in _s0) if (_s0.hasOwnProperty(_k)) _so[_k] = _s0[_k];
        _so.rollout = 'hardv1';
        algo = { diff: 'search', opts: { search: _so } };
      }
    }

    // 先「算」：优先丢到后台线程算，主线程保持可交互（选牌 / 组合牌照常）
    var seq = gameSeq;
    var t0 = nowMs();
    botTimerPending = true;
    busy = true;

    aiDecideAsync(state, idx, algo.diff, algo.opts || {}, function (res) {
      if (seq !== gameSeq) return;            // 期间开了新局 → 作废
      var d = (res && res.ok) ? { action: res.action, cards: res.cards } : null;
      if (!d) {
        // 后台不可用 / 出错：退回主线程同步计算（会短暂卡一下）
        try { d = AI.decide(state, idx, algo.diff, algo.opts || {}); }
        catch (err) { console.error('AI 决策失败：', err); d = { action: 'pass' }; }
      }
      // 再「等」：把这一步总时长补到目标值（慢 1200 / 普通 800 / 快 400ms）
      //   · 算得（含后台通信）已比目标慢 → 不再等
      //   · 算得快 → 只补差额
      var wait = Math.max(0, SPEED[settings.speed] - (nowMs() - t0));
      later(function () {
        botTimerPending = false;
        busy = false;
        applyBotMove(idx, actor, d);
      }, wait);
    });
  }

  /** 把电脑算好的这步落到牌桌上，再决定下一个轮到谁 */
  function applyBotMove(idx, actor, d) {
    var r = d.action === 'play' ? Game.play(state, idx, d.cards) : Game.pass(state, idx);
    if (!r.ok) {
      // 理论上不会发生（300 局模拟零失败）；真出问题就强制过牌，避免卡死
      if (state.current === null) {
        // 领出时不能过牌：随便出一张最小的牌
        var hand = CD.sortAsc(state.players[idx].hand);
        r = Game.play(state, idx, [hand[0]]);
      } else {
        r = Game.pass(state, idx);
      }
      if (!r.ok) { console.error('电脑出牌失败：', r.reason); busy = false; return; }
    }
    legalCache = { turn: -1, current: null, moveCount: -1, list: [] };
    renderAll();
    playMoveSound(r.play, actor);
    announceLandlordCards(r.play, actor);

    if (state.phase === 'over') { busy = false; scheduleResult(); return; }
    if (state.turn === 0) { busy = false; syncTurnUI(); announceMyTurn(); return; }

    // 下一个还是电脑：交给 scheduleBots，先重绘再开始下一步的「先算」
    scheduleBots();
  }

  /* ---------------- 战绩：只记输赢局数，不算分 ----------------
     战绩按玩家名字累计（你 / 西家 / 北家 / 东家），
     每打完一局：头游赢 1 局，其余各家各输 1 局。
     只保存在本次打开页面期间（不写 localStorage）。 */

  var tally = {};           // 名字 -> { win: n, lose: n }

  function tallyOf(name) {
    if (!tally[name]) tally[name] = { win: 0, draw: 0, lose: 0 };
    return tally[name];
  }

  /** 本局记一笔：赢家赢 1 局，其余每家输 1 局 */
  function recordTally() {
    var res = state.result;
    if (res.landlord || res.ranked) {
      // A3 地主 / 非 A3 打到末游：按每家的胜负 / 平局各记一笔
      res.detail.forEach(function (d) {
        var t = tallyOf(d.name);
        if (d.outcome === 'win') t.win++;
        else if (d.outcome === 'draw') t.draw++;
        else t.lose++;
      });
    } else {
      state.players.forEach(function (p) {
        var t = tallyOf(p.name);
        if (p.index === res.winner) t.win++; else t.lose++;
      });
    }
  }

  /** 我的战绩文字：胜 3 局 · 平 2 局 · 负 1 局（共 6 局） */
  function myRecordText() {
    var name = state ? state.players[0].name : '你';
    var t = tallyOf(name);
    var total = t.win + t.draw + t.lose;
    return '你 胜 ' + t.win + ' 局 · 平 ' + t.draw + ' 局 · 负 ' + t.lose + ' 局（共 ' + total + ' 局）';
  }

  /* ---------------- 结算 ---------------- */

  function scheduleResult() {
    later(showResult, 700);
  }

  /** 非 A3「打到末游」的结算：按玩家名次给 胜 / 平 / 负 */
  function showRankedResult(res) {
    var flat = { win: '你胜', draw: '平局', lose: '你负' };
    var human = res.humanOutcome;

    lastSummary = '上一局：' + flat[human];
    sfx(human === 'win' ? 'win' : (human === 'lose' ? 'lose' : 'tap'));
    $('resultTitle').textContent = human === 'win' ? '🎉 你赢了！'
      : (human === 'lose' ? '😞 你输了' : '🤝 平局');

    var body = $('resultBody');
    body.innerHTML = '';

    var table = el('table', 'result-table');
    var thead = el('thead');
    var hr = el('tr');
    ['名次', '玩家', '剩余', '剩余牌'].forEach(function (t) { hr.appendChild(el('th', null, t)); });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = el('tbody');
    res.detail.forEach(function (d) {
      var tr = el('tr', d.outcome === 'win' ? 'win' : '');
      tr.appendChild(el('td', null, '第 ' + d.rank + ' 名'));
      tr.appendChild(el('td', null, d.name));
      tr.appendChild(el('td', null, d.rest + ' 张'));
      tr.appendChild(el('td', 'rest-cards', d.rest ? CD.cardsText(d.restCards) : '—'));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    body.appendChild(table);

    body.appendChild(el('p', null,
      myRecordText() + '　（' + res.playerCount + ' 人局 · 打到末游：头游＝胜，第 2 名＝平，其余＝负）'));

    $('overlay').hidden = false;
  }

  function showResult() {
    if (!state || !state.result) return;
    var res = state.result;

    recordTally();          // 只记输赢局数（不再累计得分）

    if (res.landlord) { showLandlordResult(res); return; }
    if (res.ranked) { showRankedResult(res); return; }

    // ---- 经典玩法：头游即赢 ----
    // 写进「开始界面」，关掉结算浮层后还能看到上一局是谁赢的
    lastSummary = '上一局：' + (res.winner === 0 ? '你赢了！' : state.players[res.winner].name + ' 先出完');

    sfx(res.winner === 0 ? 'win' : 'lose');

    $('resultTitle').textContent = res.winner === 0 ? '🎉 你赢了！' : state.players[res.winner].name + ' 先出完';
    var body = $('resultBody');
    body.innerHTML = '';

    var table = el('table', 'result-table');
    var thead = el('thead');
    var hr = el('tr');
    // 表头 + 内容都左对齐（见 styles.css 的 .result-table）
    ['名次', '玩家', '剩余', '剩余牌'].forEach(function (t) { hr.appendChild(el('th', null, t)); });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = el('tbody');
    res.detail.forEach(function (d) {
      var tr = el('tr', d.rank === 1 ? 'win' : '');
      tr.appendChild(el('td', null, '第 ' + d.rank + ' 名'));
      tr.appendChild(el('td', null, d.name));
      tr.appendChild(el('td', null, d.rest + ' 张'));
      tr.appendChild(el('td', 'rest-cards', d.rest ? CD.cardsText(d.restCards) : '—'));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    body.appendChild(table);

    body.appendChild(el('p', null,
      myRecordText() + '　（' + res.playerCount + ' 人局，每局只有头游算赢，其余各家各输一局）'));

    $('overlay').hidden = false;
  }

  /** A3 地主的结算：显示各家名次 + 队伍，再按规则给出「你的输赢」 */
  function showLandlordResult(res) {
    var ll = res.landlord;
    var flat = { win: '胜', draw: '平', lose: '负' };
    var mine = { win: '你胜', draw: '平局', lose: '你负' };
    var human = ll.humanOutcome;

    lastSummary = '上一局（A3 地主）：' + mine[human];
    sfx(human === 'win' ? 'win' : (human === 'lose' ? 'lose' : 'tap'));
    $('resultTitle').textContent = human === 'win' ? '🎉 你赢了！'
      : (human === 'lose' ? '😞 你输了' : '🤝 平局');

    var body = $('resultBody');
    body.innerHTML = '';

    var table = el('table', 'result-table');
    var thead = el('thead');
    var hr = el('tr');
    ['名次', '玩家', '队伍', '剩余', '剩余牌'].forEach(function (t) { hr.appendChild(el('th', null, t)); });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = el('tbody');
    res.detail.forEach(function (d) {
      var tr = el('tr', d.outcome === 'win' ? 'win' : '');
      tr.appendChild(el('td', null, '第 ' + d.rank + ' 名'));
      tr.appendChild(el('td', null, d.name));
      tr.appendChild(el('td', 'team-cell', d.team === 'landlord' ? (ll.solo ? '地主·独' : '地主') : '农民'));
      tr.appendChild(el('td', null, d.rest + ' 张'));
      tr.appendChild(el('td', 'rest-cards', d.rest ? CD.cardsText(d.restCards) : '—'));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    body.appendChild(table);

    // 亮出地主队是谁
    var teamLine = ll.solo
      ? state.players[ll.members[0]].name + '（♠A + ♠3 一人独拿）'
      : ll.members.map(function (i) {
          return state.players[i].name + '（' + (i === ll.holderA ? '♠A' : '♠3') + '）';
        }).join('、');
    body.appendChild(el('p', 'll-teams',
      '地主队：' + teamLine + '　→　地主方' + flat[ll.landlordOutcome] + '，农民方' + flat[ll.farmerOutcome]));

    body.appendChild(el('p', null, myRecordText() + '　（A3 地主 · 本局：' + mine[human] + '）'));

    $('overlay').hidden = false;
  }

  /* ---------------- 总渲染 ---------------- */

  function renderAll() {
    if (!state) return;
    applyLayout();   // 内部会调用 renderMySeat
    state.players.slice(1).forEach(renderSeat);
    renderCenter();
    renderHand();
    var myTurn = state.phase === 'playing' && state.turn === 0;
    if (myTurn) {
      var legal = currentLegal();
      if (!legal.length && state.current) setTip('没有能压过的牌，请过牌');
      else if (state.isFirstPlay) setTip('第一手必须包含 ♦4');
      else if (state.current) setTip('需要压过：' + CD.cardsText(state.current.cards));
      else setTip('自由领出');
    } else if (state.phase === 'playing') {
      setTip(state.players[state.turn].name + ' 思考中…');
    } else {
      setTip('');
    }
    syncTurnUI();
  }

  /* ---------------- 开局 ---------------- */

  /** 开始新的一局：发牌、把「开始游戏」界面收起来、该谁先出就谁先出 */
  function newGame() {
    clearTimers();
    ensureWorker();          // 预热 AI 后台线程（先把各家 AI 模块加载好）
    busy = false;
    botTimerPending = false;
    selected = {};
    legalCache = { turn: -1, current: null, moveCount: -1, list: [] };
    CD.clearMoveCache();
    centerVisual = { sig: '' };
    lastTurnAnnounced = -1;                 // 新一局，重新允许「轮到我」提示音
    tailIds = [];                           // 新一局：手牌重新按大小排
    dragging = false;                       // 收尾可能残留的拖动状态
    suppressClick = false;
    state = Game.newGame({ playerCount: settings.playerCount, landlord: settings.landlord, nonA3ToLast: settings.nonA3ToLast });
    $('overlay').hidden = true;
    if ($('startScreen')) $('startScreen').hidden = true;   // 收起「开始游戏」
    if ($('btnGroup')) $('btnGroup').disabled = false;      // 未开局时禁用过，这里放开
    if ($('center')) $('center').classList.remove('idle');  // 恢复中央的轮次/说明
    sfx('deal');
    renderAll();
    if (state.turn !== 0) scheduleBots();
    else announceMyTurn();
  }

  /* ---------------- 事件绑定 ---------------- */

  // 拖动选牌松手时：可能已经划到手牌外面了，所以全局兜一下
  document.addEventListener('mouseup', endCardDrag);
  document.addEventListener('mouseleave', endCardDrag);
  // 触摸划选：touchmove 里要 preventDefault（阻止滚动/缩放），必须显式 passive:false
  document.addEventListener('touchmove', onDocTouchMove, { passive: false });
  document.addEventListener('touchend', endCardDrag);
  document.addEventListener('touchcancel', endCardDrag);

  /**
   * 关掉浮层。结算浮层关掉后不直接开新局，
   * 而是回到「开始游戏」界面，让玩家自己决定什么时候开始。
   */
  function closeOverlays() {
    var over = $('overlay');
    var wasResult = !!(over && !over.hidden);
    if (over) over.hidden = true;
    if ($('settingsOverlay')) $('settingsOverlay').hidden = true;
    if (wasResult && state && state.phase === 'over') showStartScreen();
  }

  /** 分段控件：点击哪一项就把它设为选中值 */
  function bindSegment(id, key, onChange) {
    var box = $(id);
    if (!box) return;
    Array.prototype.forEach.call(box.children, function (btn) {
      btn.addEventListener('click', function () {
        var v = btn.dataset && btn.dataset.value;
        if (v === null || v === undefined) return;
        settings[key] = (key === 'playerCount') ? Number(v)
          : ((key === 'dimUnplayable' || key === 'nonA3ToLast') ? v === 'on' : v);
        saveSettings();
        applySettingsToUI();
        if (onChange) onChange(settings[key]);
      });
    });
  }

  /** 「游戏人数」三选一：A3 地主 = 4 人局 + ♠A/♠3 暗队 */
  function bindPlayerMode() {
    var box = $('segPlayers');
    if (!box) return;
    Array.prototype.forEach.call(box.children, function (btn) {
      btn.addEventListener('click', function () {
        var v = btn.dataset && btn.dataset.value;
        if (v === 'a3') { settings.landlord = true; settings.playerCount = 4; }
        else { settings.landlord = false; settings.playerCount = Number(v); }
        saveSettings();
        applySettingsToUI();
        // 玩法 / 人数变了，当前这局的牌数 / 座位就对不上了：
        // 回到开始界面等玩家自己开局（不自动发牌）
        showStartScreen();
        setTip(settings.landlord
          ? '已切换为 A3 地主（4 人暗队：♠A 与 ♠3 一队），点「开始游戏」发牌'
          : '已切换为 ' + settings.playerCount + ' 人局，点「开始游戏」发牌');
      });
    });
  }

  function bind() {
    $('btnPlay').addEventListener('click', doPlay);
    $('btnPass').addEventListener('click', doPass);
    $('btnHint').addEventListener('click', doHint);
    $('btnClear').addEventListener('click', function () {
      selected = {};
      updateSelection();
    });
    // 捡牌：把选中的牌组合到最右边（老页面缓存没有这个按钮时也不至于报错）
    if ($('btnGroup')) $('btnGroup').addEventListener('click', doGroup);
    // 顶栏「重新开局」= 结束当前这局、回到开始界面（不自动发牌，
    // 要玩家自己点正中的「开始游戏」）
    $('btnNew').addEventListener('click', function () {
      showStartScreen();
      setTip('点「开始游戏」发牌');
    });
    // 结算浮层的按钮只负责回到牌桌，真正开始要按正中的「开始游戏」
    $('btnAgain').addEventListener('click', function () { showStartScreen(); });
    // 只有这一个地方会发牌：正中的「开始游戏」
    if ($('btnStart')) $('btnStart').addEventListener('click', function () { newGame(); });

    // 设置
    $('btnSettings').addEventListener('click', function () {
      $('settingsOverlay').hidden = false;
    });
    $('btnCloseSettings').addEventListener('click', function () {
      $('settingsOverlay').hidden = true;
    });
    // 「以当前设置重新开局」= 关掉设置面板 + 回到开始界面（不自动发牌，
    // 要玩家自己点正中的「开始游戏」）
    $('btnApplyNew').addEventListener('click', function () {
      $('settingsOverlay').hidden = true;
      showStartScreen();
      setTip('设置已生效，点「开始游戏」发牌');
    });
    bindPlayerMode();
    bindSegment('segDifficulty', 'difficulty', function () {
      setTip('难度已切换为：' + { easy: '简单', normal: '普通', hard: '困难' }[settings.difficulty]);
    });
    bindSegment('segSpeed', 'speed', function () {
      setTip('电脑每步目标时长：' + SPEED[settings.speed] + ' ms');
    });
    bindSegment('segDimUnplayable', 'dimUnplayable', function () {
      updateSelection();
      setTip(settings.dimUnplayable ? '已打开：不能出的牌会灰显' : '已关闭：手牌不做任何提示');
    });
    bindSegment('segNonA3ToLast', 'nonA3ToLast', function () {
      setTip(settings.nonA3ToLast
        ? '已打开：非 A3 局打到末游，按名次判胜负（下一局生效）'
        : '已关闭：非 A3 局头游即结束');
    });
    bindSegment('segSound', 'sound', function () {
      applySound();
      if (settings.sound === 'off') {
        setTip('音效已关闭');
      } else {
        setTip('音效：' + { low: '轻', normal: '正常', high: '响' }[settings.sound]);
        sfx('tap');          // 立刻试听一下
      }
    });

    $('btnRules').addEventListener('click', function () { $('rulesOverlay').hidden = false; });
    $('btnCloseRules').addEventListener('click', function () { $('rulesOverlay').hidden = true; });

    // 键盘快捷键
    document.addEventListener('keydown', function (e) {
      if (!$('overlay').hidden || !$('settingsOverlay').hidden) {
        if (e.key === 'Escape') closeOverlays();
        return;
      }
      // 未开局（刚进页面 / 上一局结束后）：回车或空格 = 点「开始游戏」
      if (!state) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          newGame();
        }
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        doPlay();
      } else if (e.key === 'Escape') {
        selected = {};
        updateSelection();
      } else if (e.key.toLowerCase() === 'p') {
        doPass();
      } else if (e.key.toLowerCase() === 'h') {
        doHint();
      }
    });
  }

  // 页面切回时，如果电脑回合没有待执行的定时器，补一次调度，避免卡住
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    if (state && state.phase === 'playing' && state.turn !== 0 && !botTimerPending) scheduleBots();
  });

  /* ---------------- 启动 ---------------- */
  applySettingsToUI();
  applySound();
  bind();
  // 刚进页面不自动发牌：停在「未开局」，等玩家点正中的「开始游戏」
  showStartScreen('');

  // 暴露给控制台调试
  window.__game = {
    get state() { return state; },
    newGame: newGame,
    legal: function () { return currentLegal(); },
    flags: debugFlags,
    render: renderAll
  };
})();
