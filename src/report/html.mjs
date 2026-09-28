/**
 * Render report.json as one static HTML page. No external assets: open it from disk or over an SSH
 * tunnel (`python3 -m http.server` in the report folder).
 */

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const pct = (r) => (r == null ? '' : r === 0 ? '0%' : r < 0.0001 ? '<0.01%' : `${(r * 100).toFixed(r < 0.01 ? 2 : 1)}%`);

function cutLabel(c) {
  return c.kind === 'viewport' ? `${c.width}px · ${c.colorScheme}` : `${c.device} · ${c.browser} · ${c.colorScheme}`;
}

function viewer(c) {
  const W = c.canvas?.width ?? c.sizes?.after?.width ?? 1;
  const H = c.canvas?.height ?? c.sizes?.after?.height ?? 1;
  const layer = (name, size) => {
    if (!c.images?.[name]) return '';
    const w = size ? (size.width / W) * 100 : 100;
    return `<img class="${name}" src="${esc(c.images[name])}" alt="${name}" loading="lazy" style="width:${w}%">`;
  };
  const boxes = (c.boxes ?? [])
    .map((b) => `<i style="left:${(b.x / W) * 100}%;top:${(b.y / H) * 100}%;width:${(b.w / W) * 100}%;height:${(b.h / H) * 100}%"></i>`)
    .join('');
  const sizeNote = c.sizeChanged ? ` <span class="tag warn">size ${c.sizes.before.width}×${c.sizes.before.height} → ${c.sizes.after.width}×${c.sizes.after.height}</span>` : '';
  return `<figure class="viewer" data-mode="slider" id="cut-${esc(c.id)}" style="--w:${W}px">
  <figcaption><strong>${esc(cutLabel(c))}</strong> <span class="ratio">${pct(c.diffRatio)} changed</span>${sizeNote}
    <span class="modes" role="tablist">
      <button type="button" data-m="slider" aria-pressed="true">Slider</button><button type="button" data-m="before">Before</button><button type="button" data-m="after">After</button><button type="button" data-m="diff">Diff</button>
      <label><input type="checkbox" class="toggle-boxes" checked> Boxes</label>
    </span>
  </figcaption>
  <div class="stage" style="aspect-ratio:${W}/${H}">
    <div class="layer l-after">${layer('after', c.sizes?.after)}</div>
    <div class="layer l-before">${layer('before', c.sizes?.before)}</div>
    <div class="layer l-diff">${layer('diff')}</div>
    <div class="boxes">${boxes}</div>
    <div class="handle"></div>
    <input type="range" class="slider" min="0" max="100" value="50" aria-label="Before/after position">
  </div>
</figure>`;
}

function statusCell(c) {
  if (!c) return '<td class="na">—</td>';
  if (c.status === 'changed') {
    return `<td class="changed"><button type="button" class="open-cut" data-cut="${esc(c.id)}">${c.images?.after ? `<img src="${esc(c.images.after)}" alt="" loading="lazy">` : ''}<span>${pct(c.diffRatio)}</span></button></td>`;
  }
  if (c.status === 'unchanged') return '<td class="same">same</td>';
  if (c.status === 'skipped') return `<td class="skip" title="${esc(c.reason)}">skipped</td>`;
  return `<td class="err" title="${esc(JSON.stringify(c.errors ?? {}))}">error</td>`;
}

function viewportGrid(cuts) {
  const widths = [...new Set(cuts.map((c) => c.width))].sort((a, b) => a - b);
  const schemes = [...new Set(cuts.map((c) => c.colorScheme))];
  const rows = schemes
    .map((s) => `<tr><th>${esc(s)}</th>${widths.map((w) => statusCell(cuts.find((c) => c.width === w && c.colorScheme === s))).join('')}</tr>`)
    .join('');
  return `<table class="grid"><thead><tr><th></th>${widths.map((w) => `<th>${w}px</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
}

function deviceGrid(cuts) {
  const devices = [...new Set(cuts.map((c) => c.device))];
  const cols = [];
  for (const b of [...new Set(cuts.map((c) => c.browser))]) for (const s of [...new Set(cuts.map((c) => c.colorScheme))]) cols.push([b, s]);
  const rows = devices
    .map((d) => `<tr><th>${esc(d)}</th>${cols.map(([b, s]) => statusCell(cuts.find((c) => c.device === d && c.browser === b && c.colorScheme === s))).join('')}</tr>`)
    .join('');
  return `<table class="grid devices"><thead><tr><th></th>${cols.map(([b, s]) => `<th>${esc(b)}<br><small>${esc(s)}</small></th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
}

function sourceTags(s) {
  const tags = s.sources.map((src) => `<span class="tag src-${esc(src)}">${esc(src)}</span>`);
  if (s.unexpected) tags.unshift('<span class="tag bad">unexpected change</span>');
  else if (s.expected === true) tags.push('<span class="tag ok">listed by author</span>');
  if (s.errored) tags.push('<span class="tag warn">capture error</span>');
  return tags.join(' ');
}

function screenSection(report, s) {
  const cuts = report.cuts.filter((c) => c.path === s.path);
  const states = [...new Set(cuts.map((c) => c.state))];
  const body = states
    .map((state) => {
      const vp = cuts.filter((c) => c.state === state && c.kind === 'viewport');
      const dev = cuts.filter((c) => c.state === state && c.kind === 'device');
      const changedVp = vp.filter((c) => c.status === 'changed').sort((a, b) => a.width - b.width);
      return `<section class="state">
  <h3>state: ${esc(state)}</h3>
  <div class="grids">
    ${vp.length ? `<div><h4>Viewports <small>Chromium</small></h4>${viewportGrid(vp)}</div>` : ''}
    ${dev.length ? `<div><h4>Devices</h4>${deviceGrid(dev)}</div>` : ''}
  </div>
  ${changedVp.length ? `<div class="viewers">${changedVp.map(viewer).join('\n')}</div>` : ''}
  ${dev
    .filter((c) => c.status === 'changed')
    .map((c) => `<dialog class="cut-dialog" data-cut="${esc(c.id)}"><form method="dialog"><button class="close" aria-label="Close">×</button></form>${viewer(c)}</dialog>`)
    .join('\n')}
</section>`;
    })
    .join('\n');
  const reasons = s.reasons.length
    ? `<details class="reasons"><summary>${s.reasons.length} changed file${s.reasons.length > 1 ? 's' : ''} lead${s.reasons.length > 1 ? '' : 's'} here</summary><ul>${s.reasons.map((r) => `<li><code>${esc(r)}</code></li>`).join('')}</ul></details>`
    : '';
  return `<article class="screen${s.unexpected ? ' unexpected' : ''}" id="screen-${esc(encodeURIComponent(s.path))}">
  <header><h2><code>${esc(s.path)}</code></h2>${s.route && s.route !== s.path ? `<span class="route">${esc(s.route)}</span>` : ''} ${sourceTags(s)}</header>
  ${reasons}
  ${body}
</article>`;
}

const CSS = `
:root{--bg:#f7f7f8;--panel:#fff;--ink:#16181d;--muted:#5d6370;--line:#e2e4e9;--accent:#3b5bdb;--bad:#d6336c;--bad-bg:#fff0f5;--warn:#b35c00;--warn-bg:#fff6e6;--ok:#2b8a3e;--ok-bg:#ebfbee;--box:#ff1f5a;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--panel:#171a21;--ink:#e8eaf0;--muted:#9aa1b0;--line:#2a2f3a;--accent:#8ea2ff;--bad:#ff6b9a;--bad-bg:#2a1520;--warn:#ffb454;--warn-bg:#2a2012;--ok:#69db7c;--ok-bg:#13261a;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1320px;margin:0 auto;padding:24px 16px 80px}
code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace}
h1{font-size:22px;margin:0 0 4px}h1 span{color:var(--accent)}
.meta{color:var(--muted);margin:0 0 16px}.meta code{color:var(--ink)}
.summary{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 16px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px 14px;min-width:120px}
.stat b{display:block;font-size:20px}.stat.bad{border-color:var(--bad);background:var(--bad-bg)}.stat.bad b{color:var(--bad)}
.warnings{list-style:none;padding:0;margin:0 0 16px;display:grid;gap:6px}
.warnings li{padding:8px 12px;border-radius:8px;background:var(--warn-bg);color:var(--warn);border:1px solid color-mix(in srgb,var(--warn) 30%,transparent)}
.warnings li.bad{background:var(--bad-bg);color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,transparent);font-weight:600}
nav.toc{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:20px}nav.toc a{padding:4px 10px;border-radius:999px;border:1px solid var(--line);background:var(--panel);color:var(--ink);text-decoration:none}
nav.toc a.unexpected{border-color:var(--bad);color:var(--bad)}
.screen{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;margin:0 0 20px}
.screen.unexpected{border:2px solid var(--bad)}
.screen>header{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.screen h2{margin:0;font-size:17px}.route{color:var(--muted)}
.tag{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;border:1px solid var(--line);color:var(--muted)}
.tag.bad{background:var(--bad);color:#fff;border-color:var(--bad)}.tag.ok{color:var(--ok);background:var(--ok-bg);border-color:transparent}.tag.warn{color:var(--warn);background:var(--warn-bg);border-color:transparent}
.reasons{margin:8px 0;color:var(--muted)}.reasons ul{margin:6px 0;padding-left:20px}
.state{border-top:1px solid var(--line);margin-top:12px;padding-top:8px}.state h3{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:4px 0 8px}
h4{margin:0 0 6px;font-size:13px}h4 small{color:var(--muted);font-weight:400}
.grids{display:flex;flex-wrap:wrap;gap:24px;margin-bottom:12px}
table.grid{border-collapse:collapse;font-size:12px}table.grid th,table.grid td{border:1px solid var(--line);padding:4px 8px;text-align:center;vertical-align:middle}
table.grid th{font-weight:600;background:color-mix(in srgb,var(--line) 35%,transparent)}
td.same{color:var(--ok)}td.skip{color:var(--muted);font-style:italic}td.err{color:var(--bad);font-weight:600}td.na{color:var(--muted)}
td.changed{background:var(--bad-bg);padding:3px}td.changed button{all:unset;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:2px;color:var(--bad);font-weight:600}
td.changed img{width:56px;max-height:84px;object-fit:cover;object-position:top;border-radius:4px;border:1px solid var(--line)}
td.changed a{color:var(--bad)}
.viewers{display:flex;flex-wrap:wrap;gap:20px 24px;align-items:flex-start;margin:12px 0 8px}.viewer{margin:0;width:min(100%,var(--w));min-width:min(100%,300px)}.viewer figcaption{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:6px}.ratio{color:var(--bad);font-weight:600}
.modes{margin-left:auto;display:flex;flex-wrap:wrap;gap:2px;align-items:center}.modes button{border:1px solid var(--line);background:var(--panel);color:var(--ink);padding:3px 10px;cursor:pointer;font:inherit;font-size:12px}
.modes button:first-child{border-radius:6px 0 0 6px}.modes button:nth-child(4){border-radius:0 6px 6px 0}.modes button[aria-pressed=true]{background:var(--accent);color:#fff;border-color:var(--accent)}
.modes label{margin-left:10px;font-size:12px;color:var(--muted)}
.stage{position:relative;width:100%;border:1px solid var(--line);background:repeating-conic-gradient(#8881 0 25%,transparent 0 50%) 0 0/16px 16px;overflow:hidden;--pos:50%}
.layer{position:absolute;inset:0}.layer img{display:block;height:auto}
.l-before{clip-path:inset(0 calc(100% - var(--pos)) 0 0)}.l-diff{display:none}
.handle{position:absolute;top:0;bottom:0;left:var(--pos);width:2px;background:var(--accent);box-shadow:0 0 0 1px #fff8;pointer-events:none}
.slider{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:ew-resize;margin:0;touch-action:pan-y}
.boxes i{position:absolute;border:2px solid var(--box);border-radius:3px;box-shadow:0 0 0 1px #fff9;pointer-events:none}
.viewer.no-boxes .boxes{display:none}
.viewer[data-mode=before] .l-after,.viewer[data-mode=after] .l-before,.viewer[data-mode=diff] .l-before,.viewer[data-mode=diff] .l-after{display:none}
.viewer[data-mode=before] .l-before,.viewer[data-mode=after] .l-after{clip-path:none}
.viewer[data-mode=diff] .l-diff{display:block}.viewer:not([data-mode=slider]) .handle,.viewer:not([data-mode=slider]) .slider{display:none}
dialog.cut-dialog{max-width:min(96vw,1400px);max-height:94vh;overflow:auto;border:1px solid var(--line);border-radius:14px;background:var(--panel);color:var(--ink);padding:16px}
dialog::backdrop{background:#0009}.close{float:right;border:0;background:none;color:var(--ink);font-size:22px;cursor:pointer}
.quiet{color:var(--muted)}.legend{font-size:12.5px;margin:0 0 12px}
details.block{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 16px;margin:0 0 12px}details.block summary{cursor:pointer;font-weight:600}
table.files{border-collapse:collapse;width:100%;font-size:12.5px;margin-top:8px}table.files td,table.files th{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}
`;

const JS = `
document.addEventListener('input',e=>{if(e.target.classList.contains('slider')){e.target.closest('.stage').style.setProperty('--pos',e.target.value+'%')}});
document.addEventListener('change',e=>{if(e.target.classList.contains('toggle-boxes')){e.target.closest('.viewer').classList.toggle('no-boxes',!e.target.checked)}});
document.addEventListener('click',e=>{
  const m=e.target.closest('.modes button');
  if(m){const v=m.closest('.viewer');v.dataset.mode=m.dataset.m;v.querySelectorAll('.modes button').forEach(b=>b.setAttribute('aria-pressed',b===m));return}
  const o=e.target.closest('.open-cut');
  if(o){const d=document.querySelector('dialog[data-cut="'+CSS.escape(o.dataset.cut)+'"]');if(d)d.showModal();else{const v=document.getElementById('cut-'+o.dataset.cut);if(v)v.scrollIntoView({behavior:'smooth',block:'start'})}}
});
`;

export function renderHtml(report) {
  const { summary } = report;
  const changed = report.screens.filter((s) => s.changed || s.errored);
  const unchanged = report.screens.filter((s) => !s.changed && !s.errored);
  changed.sort((a, b) => Number(b.unexpected) - Number(a.unexpected) || b.maxDiffRatio - a.maxDiffRatio);
  const warnings = report.warnings
    .map((w) => `<li class="${w.type === 'unexpected-change' ? 'bad' : ''}">${w.type === 'unexpected-change' ? '⚠ Unexpected change: ' : ''}${esc(w.message)}</li>`)
    .join('');
  const toc = changed.map((s) => `<a href="#screen-${esc(encodeURIComponent(s.path))}" class="${s.unexpected ? 'unexpected' : ''}">${esc(s.path)}</a>`).join('');
  const fileRows = report.changedFiles
    .map((f) => `<tr><td><code>${esc(f.file)}</code></td><td>${esc(f.kind)}</td><td>${f.routes.map((r) => `<code>${esc(r)}</code>`).join(', ')}</td></tr>`)
    .join('');
  const short = (s) => s.slice(0, 7);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RUN-UP ${esc(short(report.base.sha))}…${esc(short(report.head.sha))}</title>
<style>${CSS}</style>
</head>
<body>
<main>
  <h1><span>RUN-UP</span> ${esc(report.base.ref)} → ${esc(report.head.ref)}</h1>
  <p class="meta">base <code>${esc(short(report.base.sha))}</code> · head <code>${esc(short(report.head.sha))}</code> · ${esc(new Date(report.generatedAt).toLocaleString('en-GB', { timeZone: 'UTC' }))} UTC · ${Math.round(report.durationMs / 1000)}s${report.author.sources.length ? ` · author list from ${esc(report.author.sources.join(', '))}` : ''}</p>
  <div class="summary">
    <div class="stat"><b>${summary.changedScreens}/${summary.screens}</b>screens changed</div>
    <div class="stat${summary.unexpectedScreens ? ' bad' : ''}"><b>${summary.unexpectedScreens}</b>unexpected</div>
    <div class="stat"><b>${summary.changedCuts}/${summary.cuts}</b>cuts changed</div>
    ${summary.skippedCuts ? `<div class="stat"><b>${summary.skippedCuts}</b>cuts skipped</div>` : ''}
    ${summary.errorCuts ? `<div class="stat bad"><b>${summary.errorCuts}</b>capture errors</div>` : ''}
  </div>
  ${warnings ? `<ul class="warnings">${warnings}</ul>` : ''}
  <p class="legend quiet">Slider: left of the line is <b>before</b> (base), right is <b>after</b> (head). Red boxes mark changed regions. Magenta areas were masked before comparing (iframes, video, configured selectors).</p>
  ${toc ? `<nav class="toc">${toc}</nav>` : '<p class="quiet">No visual changes on the screens checked.</p>'}
  ${changed.map((s) => screenSection(report, s)).join('\n')}
  ${unchanged.length ? `<details class="block"><summary>${unchanged.length} screen${unchanged.length > 1 ? 's' : ''} checked with no visual change</summary><ul>${unchanged.map((s) => `<li><code>${esc(s.path)}</code> <span class="quiet">${esc(s.sources.join('+'))} · ${s.cuts.total} cuts${s.errored ? ' · capture error' : ''}</span></li>`).join('')}</ul></details>` : ''}
  <details class="block"><summary>${report.changedFiles.length} changed files → screens</summary><table class="files"><thead><tr><th>file</th><th>kind</th><th>screens</th></tr></thead><tbody>${fileRows}</tbody></table></details>
</main>
<script>${JS}</script>
</body>
</html>
`;
}
