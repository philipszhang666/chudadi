/* ============================================================
 * scripts/dom-shim.js —— 极简 DOM 桩，用来在 Node 里跑真正的 ui.js
 *
 * 为什么需要：
 *   界面相关的 bug（比如「点出牌没反应」）在无头测试里抓不到，
 *   因为它们依赖真实的 DOM 事件链。而这个环境起不了浏览器
 *   （Chrome 的 crashpad 被沙箱拦），也不该为了测试引入 jsdom。
 *
 *   所以按这个项目一贯的做法：手写一个刚好够用的桩，把 ui.js
 *   原封不动加载进来，然后真的去「点」按钮。
 *
 * 覆盖范围：只实现 ui.js 实际用到的那些 API（见文件末尾的清单）。
 *   元素结构从 index.html 里解析出来，所以 id / class / hidden
 *   这些属性和线上一致 —— 这一点很重要，
 *   因为 applyRoleVisibility 正是靠 .host-only 这个 class 找元素，
 *   而 .host-only[hidden] 的 CSS 又决定客户端看不看得见。
 * ============================================================ */
'use strict';

var fs = require('fs');

/* ---------------- 元素 ---------------- */

function ClassList(el) {
  this._el = el;
}
ClassList.prototype._list = function () {
  return (this._el.className || '').split(/\s+/).filter(Boolean);
};
ClassList.prototype._set = function (arr) {
  this._el.className = arr.join(' ');
};
ClassList.prototype.contains = function (c) {
  return this._list().indexOf(c) >= 0;
};
ClassList.prototype.add = function (c) {
  var l = this._list();
  if (l.indexOf(c) < 0) { l.push(c); this._set(l); }
};
ClassList.prototype.remove = function (c) {
  this._set(this._list().filter(function (x) { return x !== c; }));
};
ClassList.prototype.toggle = function (c, force) {
  var on = (force === undefined) ? !this.contains(c) : !!force;
  if (on) this.add(c); else this.remove(c);
  return on;
};
ClassList.prototype.item = function (i) { return this._list()[i] || null; };

function Element(tag) {
  this.tagName = String(tag || 'div').toUpperCase();
  this.children = [];
  this.childNodes = this.children;
  this.parentNode = null;
  this.className = '';
  this.id = '';
  this.textContent = '';
  this.dataset = {};
  this.attributes = {};
  this.hidden = false;
  this.disabled = false;
  this.value = '';
  this.title = '';
  this.style = {};
  this._listeners = {};
  this.classList = new ClassList(this);
}

Element.prototype.appendChild = function (child) {
  if (!child) return child;
  if (child.parentNode) child.parentNode.removeChild(child);
  child.parentNode = this;
  this.children.push(child);
  return child;
};
Element.prototype.removeChild = function (child) {
  var i = this.children.indexOf(child);
  if (i >= 0) { this.children.splice(i, 1); child.parentNode = null; }
  return child;
};
Element.prototype.insertBefore = function (child, ref) {
  var i = ref ? this.children.indexOf(ref) : -1;
  if (i < 0) return this.appendChild(child);
  if (child.parentNode) child.parentNode.removeChild(child);
  child.parentNode = this;
  this.children.splice(i, 0, child);
  return child;
};
Object.defineProperty(Element.prototype, 'innerHTML', {
  get: function () { return this._html || ''; },
  set: function (v) {
    // ui.js 只往里写 '' 来清空；写字符串时按纯文本记下，不做解析
    this._html = String(v === undefined || v === null ? '' : v);
    if (this._html === '') {
      var self = this;
      this.children.slice().forEach(function (c) { self.removeChild(c); });
    }
  }
});
Object.defineProperty(Element.prototype, 'firstChild', {
  get: function () { return this.children[0] || null; }
});
Element.prototype.addEventListener = function (type, fn) {
  if (!this._listeners[type]) this._listeners[type] = [];
  this._listeners[type].push(fn);
};
Element.prototype.removeEventListener = function (type, fn) {
  var l = this._listeners[type];
  if (!l) return;
  var i = l.indexOf(fn);
  if (i >= 0) l.splice(i, 1);
};
/** 模拟点击：调用所有 click 监听器（带一个最小的事件对象） */
Element.prototype.click = function () {
  var self = this;
  var ev = {
    type: 'click', preventDefault: function () {}, stopPropagation: function () {},
    button: 0, target: this
  };
  (this._listeners.click || []).slice().forEach(function (fn) { fn.call(self, ev); });
  return this;
};
Element.prototype.querySelector = function (sel) {
  var all = this.querySelectorAll(sel);
  return all.length ? all[0] : null;
};
Element.prototype.querySelectorAll = function (sel) {
  var out = [];
  var wantClass = null, wantTag = null, wantId = null;
  if (sel[0] === '.') wantClass = sel.slice(1);
  else if (sel[0] === '#') wantId = sel.slice(1);
  else wantTag = sel.toUpperCase();
  (function walk(node) {
    node.children.forEach(function (c) {
      var hit = false;
      if (wantClass) hit = c.classList.contains(wantClass);
      else if (wantId) hit = (c.id === wantId);
      else hit = (c.tagName === wantTag);
      if (hit) out.push(c);
      walk(c);
    });
  })(this);
  return out;
};
Element.prototype.closest = function (sel) {
  var wantClass = sel[0] === '.' ? sel.slice(1) : null;
  var node = this;
  while (node) {
    if (wantClass && node.classList && node.classList.contains(wantClass)) return node;
    node = node.parentNode;
  }
  return null;
};
Element.prototype.getAttribute = function (k) { return this.attributes[k]; };
Element.prototype.setAttribute = function (k, v) { this.attributes[k] = String(v); };
Element.prototype.removeAttribute = function (k) { delete this.attributes[k]; };
Element.prototype.contains = function (node) {
  var p = node;
  while (p) { if (p === this) return true; p = p.parentNode; }
  return false;
};

/* ---------------- 文档 ---------------- */

function Document() {
  this._byId = {};
  this.documentElement = new Element('html');
  this.body = new Element('body');
  this.documentElement.appendChild(this.body);
  this.hidden = false;
  this.readyState = 'complete';
  this._listeners = {};
}
Document.prototype.createElement = function (tag) { return new Element(tag); };
Document.prototype.getElementById = function (id) { return this._byId[id] || null; };
Document.prototype.querySelector = function (sel) {
  return this.documentElement.querySelector(sel);
};
Document.prototype.querySelectorAll = function (sel) {
  return this.documentElement.querySelectorAll(sel);
};
Document.prototype.addEventListener = function (type, fn) {
  if (!this._listeners[type]) this._listeners[type] = [];
  this._listeners[type].push(fn);
};
Document.prototype.removeEventListener = function (type, fn) {
  var l = this._listeners[type] || [];
  var i = l.indexOf(fn);
  if (i >= 0) l.splice(i, 1);
};
Document.prototype.dispatch = function (type, ev) {
  (this._listeners[type] || []).slice().forEach(function (fn) { fn(ev || {}); });
};
Document.prototype.elementFromPoint = function () { return null; };
Document.prototype.execCommand = function () { return true; };

/* ---------------- 从 index.html 建元素树 ----------------
   只要 id / class / hidden 这三样准确，就足够覆盖 ui.js 的取元素逻辑。 */
var VOID_TAGS = { br: 1, img: 1, input: 1, hr: 1, meta: 1, link: 1, source: 1, area: 1, base: 1, col: 1, embed: 1, param: 1, track: 1, wbr: 1 };

function parseHtml(doc, html) {
  // 去掉注释和 script/style 内容（里面可能有类似标签的东西）
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<style[\s\S]*?<\/style>/gi, '');

  var stack = [doc.body];
  var re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)(\/?)>/g;
  var m;
  while ((m = re.exec(html))) {
    var closing = m[1] === '/';
    var tag = m[2].toLowerCase();
    var attrs = m[3] || '';
    var selfClose = m[4] === '/' || VOID_TAGS[tag];

    if (closing) {
      // 找到匹配的祖先并弹栈
      for (var i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === tag.toUpperCase()) { stack.length = i; break; }
      }
      continue;
    }

    var el = new Element(tag);

    var idM = /\bid\s*=\s*"([^"]*)"/.exec(attrs);
    if (idM) { el.id = idM[1]; doc._byId[idM[1]] = el; }

    var clsM = /\bclass\s*=\s*"([^"]*)"/.exec(attrs);
    if (clsM) el.className = clsM[1];

    if (/\bhidden\b/.test(attrs)) el.hidden = true;
    if (/\bdisabled\b/.test(attrs)) el.disabled = true;

    var valM = /\bvalue\s*=\s*"([^"]*)"/.exec(attrs);
    if (valM) el.value = valM[1];

    var dsRe = /\bdata-([a-z0-9-]+)\s*=\s*"([^"]*)"/g, dm;
    while ((dm = dsRe.exec(attrs))) {
      var key = dm[1].replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); });
      el.dataset[key] = dm[2];
    }

    stack[stack.length - 1].appendChild(el);
    if (!selfClose) stack.push(el);
  }
  return doc;
}

/** 建一个「和 index.html 一致」的 document */
function createDocument(htmlPath) {
  var doc = new Document();
  var html = fs.readFileSync(htmlPath, 'utf8');
  parseHtml(doc, html);
  return doc;
}

module.exports = {
  Element: Element,
  ClassList: ClassList,
  Document: Document,
  createDocument: createDocument,
  parseHtml: parseHtml
};
