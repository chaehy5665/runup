// runup live agent. Injected by the local proxy as the first script of every page in the base and head
// panes. It reports what the person does in this pane (scroll, click, input, keys, navigation) to the
// compare page, and replays what they did in the other pane. `window.__RUNUP__` is prepended by the server.
(function () {
  'use strict';
  var cfg = window.__RUNUP__ || {};
  if (window.__runupAgent) return;
  window.__runupAgent = true;

  // Same clock on both sides: start at the configured instant and tick from page load.
  if (cfg.freezeTime) {
    var RealDate = Date;
    var offset = RealDate.parse(cfg.freezeTime) - RealDate.now();
    var FakeDate = function Date() {
      if (!new.target) return new FakeDate().toString();
      var args = Array.prototype.slice.call(arguments);
      return args.length ? new (Function.prototype.bind.apply(RealDate, [null].concat(args)))() : new RealDate(RealDate.now() + offset);
    };
    FakeDate.prototype = RealDate.prototype;
    FakeDate.now = function () { return RealDate.now() + offset; };
    FakeDate.parse = RealDate.parse;
    FakeDate.UTC = RealDate.UTC;
    Object.setPrototypeOf(FakeDate, RealDate);
    window.Date = FakeDate;
  }
  if (cfg.dpr) {
    try { Object.defineProperty(window, 'devicePixelRatio', { get: function () { return cfg.dpr; }, configurable: true }); } catch (e) { /* read-only in some engines */ }
  }
  if (cfg.userAgent) {
    try { Object.defineProperty(navigator, 'userAgent', { get: function () { return cfg.userAgent; }, configurable: true }); } catch (e) { /* ignore */ }
  }

  var framed = window.parent !== window;
  if (!framed) return;
  var side = cfg.side;

  function post(msg) {
    msg.runup = 1;
    msg.side = side;
    try { window.parent.postMessage(msg, '*'); } catch (e) { /* parent gone */ }
  }

  // ---- element paths ------------------------------------------------------------------------------
  function uniqueSel(sel) {
    try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; }
  }
  function pathOf(el) {
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      if (el.id && uniqueSel('#' + CSS.escape(el.id))) { parts.unshift('#' + CSS.escape(el.id)); break; }
      var tid = el.getAttribute('data-testid');
      if (tid && uniqueSel('[data-testid="' + CSS.escape(tid) + '"]')) { parts.unshift('[data-testid="' + CSS.escape(tid) + '"]'); break; }
      var i = 1;
      var sib = el;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === el.tagName) i++;
      parts.unshift(el.tagName.toLowerCase() + ':nth-of-type(' + i + ')');
      el = el.parentElement;
    }
    return parts.join(' > ');
  }
  function byPath(path) {
    if (!path) return null;
    try { return document.querySelector(path); } catch (e) { return null; }
  }
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function describe(el) {
    if (!el) return '';
    var text = (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.value || '').trim().replace(/\s+/g, ' ');
    return el.tagName.toLowerCase() + (text ? ' "' + text.slice(0, 40) + '"' : '');
  }
  var INTERACTIVE = 'a[href],button,input,select,textarea,label,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=radio],[role=switch],[onclick],[tabindex]';
  // The element a click is "about": an icon's <path> or a label's <span> resolves to its button or link.
  function clickTarget(el) {
    while (el && !(el instanceof HTMLElement)) el = el.parentElement;
    if (!el) return null;
    return el.closest(INTERACTIVE) || el;
  }

  // ---- what the person does here ------------------------------------------------------------------
  var replaying = 0;
  var lastUser = 0;
  // Replayed events are untrusted, so isTrusted alone keeps them from echoing back. Only scroll needs the
  // `replaying` guard: a programmatic scroll still fires a trusted scroll event.
  function markUser(e) {
    if (!e.isTrusted) return;
    lastUser = Date.now();
    post({ type: 'active' });
  }
  ['pointerdown', 'wheel', 'touchstart', 'keydown'].forEach(function (t) {
    window.addEventListener(t, markUser, { capture: true, passive: true });
  });
  function userDriven() { return !replaying && Date.now() - lastUser < 1000; }

  document.addEventListener('click', function (e) {
    if (!e.isTrusted) return;
    var el = clickTarget(e.target);
    if (!el) return;
    post({ type: 'event', event: { kind: 'click', path: pathOf(el), tag: el.tagName, x: e.clientX, y: e.clientY, label: describe(el) } });
  }, true);

  function editable(el) {
    return el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  }
  function onInput(e) {
    if (!e.isTrusted) return;
    var el = e.target;
    if (!editable(el)) return;
    if (el.type === 'checkbox' || el.type === 'radio') return; // the click carries it
    post({ type: 'event', event: { kind: 'input', path: pathOf(el), tag: el.tagName, value: el.isContentEditable ? el.innerText : el.value, label: describe(el) } });
  }
  document.addEventListener('input', onInput, true);
  document.addEventListener('change', function (e) { if (e.target && e.target.tagName === 'SELECT') onInput(e); }, true);

  document.addEventListener('keydown', function (e) {
    if (!e.isTrusted) return;
    var el = document.activeElement;
    if (editable(el) && e.key.length === 1 && !e.ctrlKey && !e.metaKey) return; // the input event carries it
    if (['Shift', 'Control', 'Alt', 'Meta'].indexOf(e.key) !== -1) return;
    post({ type: 'event', event: { kind: 'key', key: e.key, code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey, path: el && el !== document.body ? pathOf(el) : '', label: e.key } });
  }, true);

  var scrollQueued = false;
  function reportViewport() {
    post({ type: 'viewport', x: window.scrollX, y: window.scrollY, w: window.innerWidth, h: window.innerHeight });
  }
  window.addEventListener('scroll', function () {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(function () {
      scrollQueued = false;
      reportViewport();
      if (userDriven()) post({ type: 'event', event: { kind: 'scroll', x: window.scrollX, y: window.scrollY } });
    });
  }, { passive: true });
  document.addEventListener('scroll', function (e) {
    var el = e.target;
    if (!el || el === document || el === document.documentElement || !userDriven()) return;
    post({ type: 'event', event: { kind: 'elscroll', path: pathOf(el), top: el.scrollTop, left: el.scrollLeft } });
  }, { capture: true, passive: true });

  // ---- navigation ---------------------------------------------------------------------------------
  function here() { return location.pathname + location.search + location.hash; }
  var lastUrl = null;
  function reportNav() {
    var url = here();
    if (url === lastUrl) return;
    lastUrl = url;
    post({ type: 'nav', url: url, title: document.title });
  }
  ['pushState', 'replaceState'].forEach(function (m) {
    var orig = history[m];
    history[m] = function () {
      var r = orig.apply(this, arguments);
      setTimeout(reportNav, 0);
      return r;
    };
  });
  window.addEventListener('popstate', reportNav);
  window.addEventListener('hashchange', reportNav);

  // ---- cross-origin frames cannot be mirrored ---------------------------------------------------------
  var frameBadges = [];
  function scanFrames() {
    frameBadges.forEach(function (b) { b.remove(); });
    frameBadges = [];
    var count = 0;
    Array.prototype.forEach.call(document.querySelectorAll('iframe'), function (f) {
      var src = f.getAttribute('src');
      if (!src || /^(about:|javascript:|data:|blob:)/.test(src)) return;
      var origin;
      try { origin = new URL(src, location.href).origin; } catch (e) { return; }
      if (origin === location.origin) return;
      count++;
      var r = f.getBoundingClientRect();
      if (!r.width || !r.height) return;
      var b = document.createElement('div');
      b.setAttribute('data-runup-overlay', '');
      b.textContent = cfg.labels && cfg.labels.separate ? cfg.labels.separate : 'controlled separately';
      b.style.cssText = 'position:absolute;z-index:2147483646;pointer-events:none;font:600 11px/1.4 system-ui,sans-serif;background:#b35c00;color:#fff;padding:2px 6px;border-radius:0 0 6px 0;' +
        'left:' + (r.left + window.scrollX) + 'px;top:' + (r.top + window.scrollY) + 'px;outline:2px dashed #b35c00;outline-offset:0;';
      document.documentElement.appendChild(b);
      frameBadges.push(b);
    });
    post({ type: 'frames', count: count });
  }
  var scanTimer = null;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanFrames, 300);
  }

  // ---- replaying the other side -----------------------------------------------------------------------
  function flash(el, color) {
    if (!el) return;
    var r = el.getBoundingClientRect();
    var d = document.createElement('div');
    d.setAttribute('data-runup-overlay', '');
    d.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid ' + color + ';border-radius:4px;transition:opacity .6s;' +
      'left:' + (r.left - 2) + 'px;top:' + (r.top - 2) + 'px;width:' + (r.width + 4) + 'px;height:' + (r.height + 4) + 'px;';
    document.documentElement.appendChild(d);
    setTimeout(function () { d.style.opacity = '0'; }, 700);
    setTimeout(function () { d.remove(); }, 1400);
  }
  function withReplay(fn) {
    replaying++;
    try { return fn(); } finally { setTimeout(function () { replaying--; }, 120); }
  }
  function resolveTarget(ev) {
    var el = byPath(ev.path);
    if (el && visible(el)) return { el: el, via: 'path' };
    if (typeof ev.x === 'number') {
      var at = clickTarget(document.elementFromPoint(ev.x, ev.y));
      if (at && ev.tag && at.tagName === ev.tag && at !== document.body && at !== document.documentElement) return { el: at, via: 'position' };
      // A child of the same kind of target (e.g. the span inside a button) still counts.
      var up = at && ev.tag ? at.closest(ev.tag.toLowerCase()) : null;
      if (up && up !== document.body && up !== document.documentElement) return { el: up, via: 'position' };
    }
    return { el: null, via: 'notfound' };
  }
  function pointerSequence(el, x, y) {
    var r = el.getBoundingClientRect();
    var cx = x != null && x >= r.left && x <= r.right ? x : r.left + r.width / 2;
    var cy = y != null && y >= r.top && y <= r.bottom ? y : r.top + r.height / 2;
    var base = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, button: 0, view: window };
    var pbase = Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, base);
    el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ buttons: 1 }, pbase)));
    el.dispatchEvent(new MouseEvent('mousedown', Object.assign({ buttons: 1 }, base)));
    if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    el.dispatchEvent(new PointerEvent('pointerup', pbase));
    el.dispatchEvent(new MouseEvent('mouseup', base));
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(new MouseEvent('click', base));
  }
  function setValue(el, value) {
    if (el.isContentEditable) { el.innerText = value; }
    else {
      var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, value);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function apply(ev) {
    return withReplay(function () {
      if (ev.kind === 'scroll') {
        window.scrollTo(ev.x, ev.y);
        var short = Math.abs(window.scrollY - ev.y) > 2;
        return { status: short ? 'short' : 'ok' };
      }
      if (ev.kind === 'elscroll') {
        var sc = byPath(ev.path);
        if (!sc) return { status: 'notfound' };
        sc.scrollTop = ev.top;
        sc.scrollLeft = ev.left;
        return { status: 'ok' };
      }
      if (ev.kind === 'click') {
        var t = resolveTarget(ev);
        if (!t.el) return { status: 'notfound' };
        flash(t.el, t.via === 'path' ? '#3b5bdb' : '#e8590c');
        pointerSequence(t.el, t.via === 'position' ? ev.x : null, t.via === 'position' ? ev.y : null);
        return { status: t.via === 'path' ? 'ok' : 'position', label: describe(t.el) };
      }
      if (ev.kind === 'input') {
        var inp = byPath(ev.path);
        if (!inp || !editable(inp)) return { status: 'notfound' };
        setValue(inp, ev.value);
        return { status: 'ok' };
      }
      if (ev.kind === 'key') {
        var target = byPath(ev.path) || document.activeElement || document.body;
        if (ev.path && !byPath(ev.path)) return { status: 'notfound' };
        var init = { key: ev.key, code: ev.code, ctrlKey: ev.ctrl, shiftKey: ev.shift, altKey: ev.alt, metaKey: ev.meta, bubbles: true, cancelable: true };
        var notCancelled = target.dispatchEvent(new KeyboardEvent('keydown', init));
        target.dispatchEvent(new KeyboardEvent('keyup', init));
        if (notCancelled && ev.key === 'Enter' && target.form && target.tagName === 'INPUT' && target.form.requestSubmit) target.form.requestSubmit();
        return { status: 'ok' };
      }
      return { status: 'unknown' };
    });
  }

  function runSteps(steps) {
    var i = 0;
    function next() {
      if (i >= steps.length) return post({ type: 'steps-done' });
      var s = steps[i++];
      var done = function () { setTimeout(next, 50); };
      try {
        if (s.click) { var c = document.querySelector(s.click); if (c) withReplay(function () { pointerSequence(c); }); return done(); }
        if (s.hover) { var h = document.querySelector(s.hover); if (h) h.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return done(); }
        if (s.fill) { var f = document.querySelector(s.fill[0]); if (f) withReplay(function () { setValue(f, String(s.fill[1])); }); return done(); }
        if (s.press) {
          var key = Array.isArray(s.press) ? s.press[1] : s.press;
          var pt = Array.isArray(s.press) ? document.querySelector(s.press[0]) : document.activeElement || document.body;
          if (pt) pt.dispatchEvent(new KeyboardEvent('keydown', { key: key, bubbles: true, cancelable: true }));
          return done();
        }
        if (s.scroll) { var sc = document.querySelector(s.scroll); if (sc) sc.scrollIntoView(); return done(); }
        if (s.wait) return setTimeout(next, s.wait);
        if (s.waitFor) {
          var start = Date.now();
          var poll = function () { if (document.querySelector(s.waitFor) || Date.now() - start > 10000) next(); else setTimeout(poll, 100); };
          return poll();
        }
        if (s.evaluate) { (0, eval)(s.evaluate); return done(); }
      } catch (e) { /* keep going */ }
      done();
    }
    next();
  }

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || m.runup !== 1 || e.source !== window.parent) return;
    if (m.type === 'apply') {
      var res;
      try { res = apply(m.event); } catch (err) { res = { status: 'error', label: String(err && err.message || err).slice(0, 80) }; }
      post({ type: 'result', id: m.id, kind: m.event.kind, status: res.status, label: res.label || m.event.label || '' });
    } else if (m.type === 'navigate') {
      if (here() !== m.url) location.assign(m.url);
    } else if (m.type === 'history') {
      if (m.dir === 'back') history.back();
      else if (m.dir === 'forward') history.forward();
      else location.reload();
    } else if (m.type === 'steps') {
      runSteps(m.steps || []);
    } else if (m.type === 'hello?') {
      lastUrl = null;
      reportNav();
      reportViewport();
      scanFrames();
    }
  });

  function ready() {
    reportNav();
    reportViewport();
    scanFrames();
    var ours = function (n) { return n.nodeType === 1 && n.hasAttribute('data-runup-overlay'); };
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.type === 'attributes') { if (!ours(r.target)) return scheduleScan(); continue; }
        var nodes = Array.prototype.slice.call(r.addedNodes).concat(Array.prototype.slice.call(r.removedNodes));
        if (!nodes.every(ours)) return scheduleScan();
      }
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'style', 'open'] });
    window.addEventListener('resize', scheduleScan);
    // Layout can move a frame without any DOM change near it (fonts, images); keep badges on their frames.
    if (window.ResizeObserver) new ResizeObserver(scheduleScan).observe(document.body || document.documentElement);
    post({ type: 'ready', url: here() });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
})();
