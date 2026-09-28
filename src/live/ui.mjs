/**
 * The compare page for `runup live`. Static HTML with inline CSS/JS; all data comes from
 * /__runup/state.json, and the two panes talk to it through postMessage.
 */

const CSS = `
:root{--bg:#f4f5f7;--panel:#fff;--ink:#16181d;--muted:#5d6370;--line:#e2e4e9;--accent:#3b5bdb;--base:#7048e8;--head:#0c8599;--bad:#d6336c;--bad-bg:#fff0f5;--warn:#b35c00;--warn-bg:#fff6e6;--ok:#2b8a3e;--box:#ff1f5a;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--panel:#171a21;--ink:#e8eaf0;--muted:#9aa1b0;--line:#2a2f3a;--accent:#8ea2ff;--base:#b197fc;--head:#66d9e8;--bad:#ff6b9a;--bad-bg:#2a1520;--warn:#ffb454;--warn-bg:#2a2012;--ok:#69db7c;color-scheme:dark}}
*{box-sizing:border-box}html,body{height:100%;margin:0}body{background:var(--bg);color:var(--ink);font:13px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;display:grid;grid-template-rows:auto 1fr;overflow:hidden}
code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
header{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:8px 12px;background:var(--panel);border-bottom:1px solid var(--line)}
.brand{font-weight:700;color:var(--accent);margin-right:4px}
.refs{color:var(--muted);font-size:12px}.refs b{font-weight:600}.refs .b{color:var(--base)}.refs .h{color:var(--head)}
.group{display:flex;align-items:center;gap:4px}
button,select,input[type=text]{font:inherit;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:4px 8px}
button{cursor:pointer}button:hover{border-color:var(--accent)}button[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:#fff}
input[type=text]{width:min(36vw,420px)}
label.check{display:flex;align-items:center;gap:4px;color:var(--muted);cursor:pointer}
.spacer{flex:1}
main{display:grid;grid-template-columns:260px 1fr;min-height:0}
aside{border-right:1px solid var(--line);background:var(--panel);overflow:auto;display:flex;flex-direction:column;min-height:0}
aside h2{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:12px 12px 6px}
.screens{list-style:none;margin:0;padding:0 8px}
.screens li{margin:0 0 6px}
.screens .path{display:flex;align-items:center;gap:6px;font-weight:600;word-break:break-all}
.dot{width:8px;height:8px;border-radius:50%;background:var(--line);flex:none}.dot.changed{background:var(--bad)}.dot.same{background:var(--ok)}
.states{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0 0 14px}
.states button{padding:2px 8px;font-size:12px}.states button.changed{border-color:var(--bad);color:var(--bad)}
.states button.current{background:var(--accent);color:#fff;border-color:var(--accent)}
.tag{font-size:10px;padding:0 6px;border-radius:999px;border:1px solid var(--line);color:var(--muted);font-weight:500}
.tag.bad{background:var(--bad);border-color:var(--bad);color:#fff}
.log{list-style:none;margin:0;padding:0 8px 12px;font-size:12px;overflow:auto;flex:1}
.log li{display:grid;grid-template-columns:auto 1fr auto;gap:6px;align-items:baseline;padding:3px 4px;border-bottom:1px solid var(--line)}
.log .dir{color:var(--muted);font-size:11px}.log .what{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip{font-size:10px;font-weight:600;padding:0 6px;border-radius:999px;background:var(--line);color:var(--muted)}
.chip.ok{background:transparent;color:var(--ok)}.chip.notfound,.chip.differs{background:var(--bad);color:#fff}.chip.position,.chip.short{background:var(--warn-bg);color:var(--warn)}.chip.error{background:var(--warn);color:#fff}
.empty{color:var(--muted);padding:0 12px}
#stage{position:relative;min-width:0;min-height:0;overflow:auto;padding:12px;display:flex;gap:16px;justify-content:center;align-items:flex-start}
.pane{display:flex;flex-direction:column;gap:6px;min-width:0}
.pane-head{display:flex;align-items:center;gap:6px;font-size:12px;min-height:22px;flex-wrap:wrap}
.side{font-weight:700;letter-spacing:.04em;font-size:11px;padding:1px 8px;border-radius:999px;color:#fff}
.side.base{background:var(--base)}.side.head{background:var(--head)}
.url{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:28ch}
.badge{font-size:11px;padding:1px 8px;border-radius:999px;font-weight:600;display:none}
.badge.show{display:inline-block}.badge.bad{background:var(--bad);color:#fff}.badge.warn{background:var(--warn-bg);color:var(--warn)}
.viewport{position:relative;overflow:hidden;border:1px solid var(--line);border-radius:8px;background:#fff;box-shadow:0 1px 3px #0001}
.viewport iframe{position:absolute;left:0;top:0;border:0;transform-origin:0 0;background:#fff}
.boxes{position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none;overflow:hidden}
.boxes i{position:absolute;border:2px solid var(--box);border-radius:3px;box-shadow:0 0 0 1px #fff9}
body.no-boxes .boxes{display:none}
.toast{position:absolute;left:8px;right:8px;bottom:8px;padding:6px 10px;border-radius:8px;font-weight:600;font-size:12px;opacity:0;transition:opacity .25s;pointer-events:none;z-index:3}
.toast.show{opacity:1}.toast.bad{background:var(--bad);color:#fff}.toast.warn{background:#e8590c;color:#fff}
body.overlay #pane-base{display:none}
.viewport iframe.base-under{display:none}body.overlay #pane-head .viewport iframe.base-under{display:block}
#opacityWrap{display:none}body.overlay #opacityWrap{display:flex}
.hint{color:var(--muted);font-size:12px}
`;

const JS = String.raw`
const $ = (s, r = document) => r.querySelector(s);
const state = await (await fetch('/__runup/state.json')).json();
const sides = ['base', 'head'];
const originOf = (side) => state.hosts === 'ports'
  ? location.protocol + '//' + location.hostname + ':' + state.ports[side]
  : location.protocol + '//' + side + '.localhost:' + location.port;
const frames = { base: $('#frame-base'), head: $('#frame-head') };
const under = $('#frame-base-under');
const urls = { base: null, head: null };
const scroll = { base: { x: 0, y: 0 }, head: { x: 0, y: 0 } };
const pendingSteps = { base: null, head: null };
let leader = null;
let current = { path: state.start, state: 'default' };
let preset = state.presets.find((p) => p.id === state.preset);
let overlay = false;
let seq = 0;
const inflight = new Map();

$('#refBase').textContent = state.base.ref + ' ' + state.base.sha.slice(0, 7);
$('#refHead').textContent = state.head.ref + ' ' + state.head.sha.slice(0, 7);
$('#clock').textContent = state.freezeTime ? 'clock ' + state.freezeTime.replace('T', ' ').replace(':00Z', ' UTC') : 'real clock';
const statusParts = { boxes: '', report: state.report ? state.report.summary.changedCuts + ' changed cuts in report' : 'no report for these commits', scale: '' };
function renderStatus() { $('#status').textContent = [statusParts.boxes, statusParts.report, statusParts.scale].filter(Boolean).join(' · '); }
if (!state.report) { $('#boxes').checked = false; $('#boxes').disabled = true; document.body.classList.add('no-boxes'); }

const presetSel = $('#preset');
for (const p of state.presets) presetSel.append(new Option(p.label + ' (' + p.width + '×' + p.height + (p.dpr !== 1 ? ' @' + p.dpr + 'x' : '') + ')', p.id));
presetSel.value = preset.id;

// ---- panes -------------------------------------------------------------------------------------
function activeFrames() { return overlay ? { base: under, head: frames.head } : frames; }
function load(path) {
  const f = activeFrames();
  for (const side of sides) { urls[side] = null; f[side].src = originOf(side) + path; }
  if (overlay) frames.base.src = 'about:blank';
  else under.src = 'about:blank';
  $('#url').value = path;
}
function post(side, msg) {
  msg.runup = 1;
  // Addressed to the side's origin, so a pane that has navigated off the app never receives it.
  activeFrames()[side].contentWindow?.postMessage(msg, originOf(side));
}
function sideOf(source) {
  const f = activeFrames();
  for (const side of sides) if (f[side].contentWindow === source) return side;
  return null;
}

function layout() {
  const stage = $('#stage');
  const availW = stage.clientWidth - 24 - (overlay ? 0 : 16);
  const availH = stage.clientHeight - 24 - 30;
  const perPane = overlay ? availW : availW / 2;
  const s = Math.min(1, perPane / preset.width, availH / preset.height);
  for (const side of sides) {
    const vp = $('#pane-' + side + ' .viewport');
    vp.style.width = Math.floor(preset.width * s) + 'px';
    vp.style.height = Math.floor(preset.height * s) + 'px';
    for (const el of vp.querySelectorAll('iframe, .boxes')) {
      el.style.width = preset.width + 'px';
      el.style.height = preset.height + 'px';
      el.style.transform = 'scale(' + s + ')';
    }
  }
  statusParts.scale = Math.round(s * 100) + '%';
  renderStatus();
}
window.addEventListener('resize', layout);

// ---- diff boxes from the report ------------------------------------------------------------------
function pathOnly(u) { return (u || '').split('#')[0].split('?')[0]; }
function currentCut() {
  const scheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const here = pathOnly(urls.head || urls.base);
  const scr = state.screens.find((s) => s.path === here);
  if (!scr) return null;
  const stateName = scr.states.find((st) => st.name === current.state && current.path === scr.path) ? current.state : 'default';
  const candidates = state.cuts.filter((c) => c.path === scr.path && c.state === stateName);
  const match = (c) => preset.cut.kind === 'device' ? c.kind === 'device' && c.device === preset.cut.device : c.kind === 'viewport' && c.width === preset.cut.width;
  return candidates.find((c) => match(c) && c.colorScheme === scheme) || candidates.find(match) || null;
}
function drawBoxes() {
  const cut = currentCut();
  for (const side of sides) {
    const layer = $('#pane-' + side + ' .boxes');
    const sc = scroll[overlay ? 'head' : side];
    layer.innerHTML = cut ? cut.boxes.map((b) => '<i style="left:' + (b.x / cut.scale - sc.x) + 'px;top:' + (b.y / cut.scale - sc.y) + 'px;width:' + b.w / cut.scale + 'px;height:' + b.h / cut.scale + 'px"></i>').join('') : '';
  }
  statusParts.boxes = cut ? cut.boxes.length + ' boxes · ' + (cut.diffRatio * 100).toFixed(2) + '% changed' : state.report ? 'no boxes for this size' : '';
  renderStatus();
}

// ---- screen list ---------------------------------------------------------------------------------
function renderScreens() {
  const ul = $('#screens');
  ul.innerHTML = '';
  if (!state.screens.length) { ul.innerHTML = '<li class="empty">No screens from the diff.</li>'; return; }
  for (const s of state.screens) {
    const li = document.createElement('li');
    const dot = s.changed === true ? 'changed' : s.changed === false ? 'same' : '';
    li.innerHTML = '<div class="path"><span class="dot ' + dot + '"></span><code></code>' + (s.unexpected ? ' <span class="tag bad">unexpected</span>' : '') + '</div><div class="states"></div>';
    li.querySelector('code').textContent = s.path;
    for (const st of s.states) {
      const b = document.createElement('button');
      b.textContent = st.name + (st.partial ? ' *' : '');
      if (st.partial) b.title = 'This state uses code or localStorage the live view cannot replay; only its query and steps are applied.';
      if (st.changed) b.classList.add('changed');
      if (current.path === s.path && current.state === st.name) b.classList.add('current');
      b.dataset.path = s.path;
      b.dataset.state = st.name;
      b.onclick = () => openScreen(s, st);
      li.querySelector('.states').append(b);
    }
    ul.append(li);
  }
}
function openScreen(s, st) {
  current = { path: s.path, state: st.name };
  for (const side of sides) pendingSteps[side] = st.steps.length ? { url: s.path + st.search, steps: st.steps } : null;
  load(s.path + st.search);
  renderScreens();
  addLog({ from: 'both', kind: 'open', label: s.path + ' · ' + st.name, status: 'ok' });
}

// ---- mirror log ------------------------------------------------------------------------------------
const STATUS_TEXT = { ok: 'ok', position: 'by position', notfound: 'not found', short: 'page shorter', differs: 'route differs', error: 'replay error', pending: '…' };
function addLog(entry) {
  const li = document.createElement('li');
  li.innerHTML = '<span class="dir"></span><span class="what"></span><span class="chip"></span>';
  li.querySelector('.dir').textContent = entry.from === 'both' ? '⇉' : entry.from === 'base' ? 'B→H' : 'H→B';
  li.querySelector('.what').textContent = entry.kind + (entry.label ? ' ' + entry.label : '');
  li.querySelector('.what').title = li.querySelector('.what').textContent;
  entry.li = li;
  setStatus(entry, entry.status || 'pending');
  const log = $('#log');
  log.prepend(li);
  while (log.children.length > 200) log.lastChild.remove();
  return entry;
}
function setStatus(entry, status) {
  const chip = entry.li.querySelector('.chip');
  chip.className = 'chip ' + status;
  chip.textContent = STATUS_TEXT[status] || status;
}
const notFound = { base: 0, head: 0 };
function toast(side, text, kind) {
  const t = $('#pane-' + (overlay ? 'head' : side) + ' .toast');
  t.textContent = text;
  t.className = 'toast show ' + kind;
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.className = 'toast ' + kind), 2600);
}
function badge(side, id, text, show) {
  const b = $('#pane-' + side + ' .' + id);
  b.textContent = text;
  b.classList.toggle('show', Boolean(show));
}

// ---- route mirroring -------------------------------------------------------------------------------
let routeTimer = null;
function reconcileRoute() {
  clearTimeout(routeTimer);
  if (!$('#mirror').checked || !leader) return;
  routeTimer = setTimeout(() => {
    const other = leader === 'base' ? 'head' : 'base';
    if (!urls[leader] || urls[other] === urls[leader]) return updateRouteBadges();
    const entry = addLog({ from: leader, kind: 'route', label: urls[leader], status: 'pending' });
    const target = urls[leader];
    post(other, { type: 'navigate', url: target });
    setTimeout(() => {
      const same = urls[other] === target;
      setStatus(entry, same ? 'ok' : 'differs');
      if (!same) toast(other, 'route differs: ' + (urls[other] || '?') + ' vs ' + target, 'bad');
      updateRouteBadges();
    }, 2500);
  }, 700);
}
function updateRouteBadges() {
  const differs = urls.base && urls.head && urls.base !== urls.head;
  for (const side of sides) badge(side, 'route', 'route differs', differs);
}

// ---- messages from the panes -------------------------------------------------------------------------
window.addEventListener('message', (e) => {
  const m = e.data;
  if (!m || m.runup !== 1) return;
  // A pane that is navigating away still delivers its last messages (the click on a link), but with a null
  // source; its origin still tells the sides apart.
  const side = e.source ? sideOf(e.source) : sides.includes(m.side) ? m.side : null;
  if (!side || side !== m.side || e.origin !== originOf(side)) return;
  const other = side === 'base' ? 'head' : 'base';
  if (m.type === 'active') leader = side;
  else if (m.type === 'ready' || m.type === 'nav') {
    urls[side] = m.url;
    $('#pane-' + side + ' .url').textContent = m.url;
    $('#pane-' + side + ' .url').title = m.url;
    if (side === 'head' || overlay) $('#url').value = m.url;
    const ps = pendingSteps[side];
    if (m.type === 'ready' && ps && ps.url === m.url) { pendingSteps[side] = null; post(side, { type: 'steps', steps: ps.steps }); }
    if (side === leader) reconcileRoute(); else updateRouteBadges();
    drawBoxes();
  } else if (m.type === 'viewport') {
    scroll[side] = { x: m.x, y: m.y };
    drawBoxes();
  } else if (m.type === 'frames') {
    badge(side, 'frames', m.count + ' iframe' + (m.count > 1 ? 's' : '') + ' controlled separately', m.count > 0);
  } else if (m.type === 'event') {
    if (!$('#mirror').checked) return;
    const id = ++seq;
    const entry = addLog({ from: side, kind: m.event.kind, label: m.event.label || '', status: 'pending' });
    inflight.set(id, { entry, to: other, event: m.event });
    post(other, { type: 'apply', id, event: m.event });
  } else if (m.type === 'result') {
    const f = inflight.get(m.id);
    if (!f) return;
    inflight.delete(m.id);
    setStatus(f.entry, m.status);
    if (m.status === 'notfound') {
      notFound[side]++;
      badge(side, 'nf', notFound[side] + ' not found', true);
      toast(side, 'not found: ' + f.event.kind + ' ' + (f.event.label || ''), 'bad');
    } else if (m.status === 'position') {
      toast(side, 'matched by position: ' + (m.label || f.event.label || ''), 'warn');
    } else if (m.status === 'error') {
      toast(side, 'could not replay ' + f.event.kind + ': ' + (m.label || ''), 'warn');
    } else if (m.status === 'short') {
      toast(side, 'page is shorter here', 'warn');
    }
  }
});

// ---- controls ----------------------------------------------------------------------------------------
$('#go').onclick = () => { current = { path: pathOnly($('#url').value), state: 'default' }; renderScreens(); load($('#url').value || '/'); };
$('#url').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#go').click(); });
for (const [id, dir] of [['back', 'back'], ['forward', 'forward'], ['reload', 'reload']]) {
  $('#' + id).onclick = () => { for (const side of sides) post(side, { type: 'history', dir }); addLog({ from: 'both', kind: dir, status: 'ok' }); };
}
presetSel.onchange = async () => {
  const r = await fetch('/__runup/preset', { method: 'POST', body: JSON.stringify({ id: presetSel.value }) });
  const j = await r.json();
  preset = state.presets.find((p) => p.id === j.preset);
  layout();
  load(urls.head || urls.base || current.path);
};
function setMode(next) {
  overlay = next;
  document.body.classList.toggle('overlay', overlay);
  $('#modeSide').setAttribute('aria-pressed', String(!overlay));
  $('#modeOverlay').setAttribute('aria-pressed', String(overlay));
  $('#pane-head .side').textContent = overlay ? 'HEAD over BASE' : 'HEAD';
  $('#opacity').dispatchEvent(new Event('input'));
  layout();
  load(urls.head || urls.base || current.path);
}
$('#modeSide').onclick = () => setMode(false);
$('#modeOverlay').onclick = () => setMode(true);
$('#opacity').oninput = () => { frames.head.style.opacity = overlay ? String($('#opacity').value / 100) : '1'; $('#opacityVal').textContent = $('#opacity').value + '%'; };
$('#boxes').onchange = () => document.body.classList.toggle('no-boxes', !$('#boxes').checked);
$('#mirror').onchange = () => addLog({ from: 'both', kind: $('#mirror').checked ? 'mirror on' : 'mirror off', status: 'ok' });
window.runup = { setMode, state, urls, scroll };

renderScreens();
layout();
const first = state.screens.find((s) => s.path === state.start);
if (first) openScreen(first, first.states[0]); else load(state.start);
frames.head.style.opacity = '1';
$('#opacity').dispatchEvent(new Event('input'));
`;

export function renderUi() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RUN-UP live</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <span class="brand">RUN-UP live</span>
  <span class="refs"><b class="b">base</b> <code id="refBase"></code> · <b class="h">head</b> <code id="refHead"></code> · <span id="clock"></span></span>
  <span class="group"><button id="back" title="Back (both)">‹</button><button id="forward" title="Forward (both)">›</button><button id="reload" title="Reload (both)">↻</button></span>
  <span class="group"><input type="text" id="url" aria-label="Path" spellcheck="false"><button id="go">Go</button></span>
  <select id="preset" aria-label="Device size"></select>
  <span class="group" role="group" aria-label="View"><button id="modeSide" aria-pressed="true">Side by side</button><button id="modeOverlay" aria-pressed="false">Overlay</button></span>
  <span class="group" id="opacityWrap"><label for="opacity" class="hint">head</label><input type="range" id="opacity" min="0" max="100" value="50"><span id="opacityVal" class="hint">50%</span></span>
  <label class="check"><input type="checkbox" id="mirror" checked> Mirror</label>
  <label class="check"><input type="checkbox" id="boxes" checked> Diff boxes</label>
  <span class="spacer"></span>
  <span class="hint" id="status"></span>
</header>
<main>
  <aside>
    <h2>Changed screens</h2>
    <ul class="screens" id="screens"></ul>
    <h2>Mirror log</h2>
    <ul class="log" id="log"></ul>
  </aside>
  <section id="stage">
    <div class="pane" id="pane-base">
      <div class="pane-head"><span class="side base">BASE</span><span class="url"></span><span class="badge bad nf"></span><span class="badge bad route"></span><span class="badge warn frames"></span></div>
      <div class="viewport"><iframe id="frame-base" title="base"></iframe><div class="boxes"></div><div class="toast"></div></div>
    </div>
    <div class="pane" id="pane-head">
      <div class="pane-head"><span class="side head">HEAD</span><span class="url"></span><span class="badge bad nf"></span><span class="badge bad route"></span><span class="badge warn frames"></span></div>
      <div class="viewport"><iframe id="frame-base-under" class="base-under" title="base (under)"></iframe><iframe id="frame-head" title="head"></iframe><div class="boxes"></div><div class="toast"></div></div>
    </div>
  </section>
</main>
<script type="module">${JS}</script>
</body>
</html>
`;
}
