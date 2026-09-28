// Record docs/live-demo.gif: `runup live` on examples/mini-app only (never a private app).
// Usage: node scripts/record-demo.mjs   (needs Chromium and ffmpeg on PATH)
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import playwright from 'playwright';
import { startLive } from '../src/live/server.mjs';
import { freePort } from '../src/util.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs', 'live-demo.gif');
const git = (cwd, ...args) => exec('git', args, { cwd });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

process.env.RUNUP_QUIET = '1';
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'runup-demo-'));
const repo = path.join(tmp, 'app');
await fs.cp(path.join(root, 'examples', 'mini-app'), repo, { recursive: true });
const cfgPath = path.join(repo, 'runup.config.mjs');
await fs.writeFile(cfgPath, (await fs.readFile(cfgPath, 'utf8')).replace("start: 'node server.mjs',", `start: 'node server.mjs',\n    worktreeDir: ${JSON.stringify(path.join(tmp, 'wt'))},`));
await git(repo, 'init', '-q', '-b', 'main');
await git(repo, 'add', '-A');
await git(repo, '-c', 'user.email=demo@example.com', '-c', 'user.name=demo', 'commit', '-q', '-m', 'base');
await git(repo, 'checkout', '-q', '-b', 'feature');
const contact = path.join(repo, 'app', 'contact', 'page.html');
await fs.writeFile(
  contact,
  (await fs.readFile(contact, 'utf8'))
    .replace('id="toggle"', 'id="toggle-details"')
    .replace(' <button type="button" class="extra">Extra</button>', '')
    .replace('<h1>Contact</h1>', '<h1>Contact us</h1>'),
);
await git(repo, '-c', 'user.email=demo@example.com', '-c', 'user.name=demo', 'commit', '-q', '-am', 'head');
await exec(process.execPath, [path.join(root, 'bin', 'runup.mjs'), 'main', 'feature', '-C', repo, '-o', path.join(tmp, 'out'), '--no-devices']);

const live = await startLive({ base: 'main', head: 'feature', cwd: repo, port: await freePort(), out: path.join(tmp, 'out') });
const browser = await playwright.chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 860 }, recordVideo: { dir: tmp, size: { width: 1440, height: 860 } } });
const page = await context.newPage();
await page.goto(live.url);
const frame = (side) => page.frames().find((f) => f.url().startsWith(`http://${side}.localhost:`));
await page.selectOption('#preset', 'device:iPad (gen 7)');
await pause(300);
while (!frame('base') || !frame('head')) await pause(100);
await frame('head').locator('h1').waitFor();
await pause(1500);

await frame('base').locator('#name').click();
await frame('base').locator('#name').pressSequentially('Ada', { delay: 180 });
await pause(900);
await frame('base').locator('#toggle').click(); // head has a new id: mirrored by position
await pause(1600);
await frame('base').locator('.extra').click(); // gone in head: "not found"
await pause(2000);
const box = await page.locator('#pane-base .viewport').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
for (let i = 0; i < 6; i++) {
  await page.mouse.wheel(0, 90);
  await pause(120);
}
await pause(1200);
for (let i = 0; i < 6; i++) {
  await page.mouse.wheel(0, -90);
  await pause(80);
}
await pause(800);
await page.click('#modeOverlay');
await pause(1200);
for (const v of [70, 50, 30, 10, 40]) {
  await page.locator('#opacity').fill(String(v));
  await page.locator('#opacity').dispatchEvent('input');
  await pause(450);
}
await pause(900);
await page.click('#modeSide');
await pause(1500);

const video = await page.video().path();
await context.close();
await browser.close();
await live.close();

await fs.mkdir(path.dirname(out), { recursive: true });
await exec('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-vf', 'fps=8,scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', '-loop', '0', out]);
await fs.rm(tmp, { recursive: true, force: true });
const { size } = await fs.stat(out);
console.log(`${out} (${Math.round(size / 1024)} KB)`);
