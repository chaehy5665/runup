// A zero-dependency server that follows Next.js App Router file conventions closely enough for
// runup's own tests: app/**/page.html is a screen, layout.html files wrap it ({{children}}),
// (group) and _private folders behave as in Next.js, and [param] folders match one segment.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'app');
const port = Number(process.env.PORT ?? 3000);

function pages(dir = root, segs = []) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('_')) continue;
    out.push(...pages(path.join(dir, e.name), [...segs, e.name]));
  }
  if (fs.existsSync(path.join(dir, 'page.html'))) out.push(segs);
  return out;
}

function match(urlPath) {
  const parts = urlPath.split('/').filter(Boolean);
  for (const segs of pages()) {
    const routeSegs = segs.filter((s) => !/^\(.+\)$/.test(s));
    if (routeSegs.length !== parts.length) continue;
    const params = {};
    const ok = routeSegs.every((s, i) => {
      const dyn = s.match(/^\[(.+)\]$/);
      if (dyn) params[dyn[1]] = decodeURIComponent(parts[i]);
      return dyn || s === parts[i];
    });
    if (ok) return { segs, params };
  }
  return null;
}

function render({ segs, params }) {
  let html = fs.readFileSync(path.join(root, ...segs, 'page.html'), 'utf8');
  for (let i = segs.length; i >= 0; i--) {
    const layout = path.join(root, ...segs.slice(0, i), 'layout.html');
    if (fs.existsSync(layout)) html = fs.readFileSync(layout, 'utf8').replace('{{children}}', html);
  }
  html = html.replace(/\{\{include:([\w./-]+)\}\}/g, (_, rel) => fs.readFileSync(path.join(root, rel), 'utf8'));
  return html.replace(/\{\{(\w+)\}\}/g, (_, k) => params[k] ?? '');
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/globals.css') {
      res.writeHead(200, { 'content-type': 'text/css' });
      return res.end(fs.readFileSync(path.join(root, 'globals.css')));
    }
    const hit = match(url.pathname);
    if (!hit) {
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end('<!doctype html><h1>Not found</h1>');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(render(hit));
  })
  .listen(port, '127.0.0.1', () => console.log(`mini-app on http://127.0.0.1:${port}`));
