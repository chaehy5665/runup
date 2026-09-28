#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { plan, runup } from '../src/run.mjs';

const HELP = `runup <base-ref> <head-ref> [options]

Compare the web app at two git refs and write one report of only what changed.

Options
  -C, --cwd <dir>          target repository (default: current directory)
  -c, --config <file>      config file (default: runup.config.{mjs,js,json} in the repo root)
  -e, --expect <screen>    screen the author expects to change; path, route pattern or glob (repeatable)
      --expect-file <file> file with one expected screen per line
      --pr <number>        read expected screens from the \`\`\`runup block of a GitHub PR body (uses gh)
  -o, --out <dir>          output root (default: config outDir, ".runup")
      --plan               print the screens that would be checked and exit (no servers, no browsers)
      --json               with --plan: print JSON
      --no-devices         skip the device emulation pass
      --base-url <url>     use an already-running base server instead of a worktree
      --head-url <url>     use an already-running head server instead of a worktree
      --keep-worktrees     keep the base/head worktrees for the next run (setup is skipped on reuse)
      --keep-all           keep images of unchanged cuts too
      --fail-on <what>     exit 2 when there is an "unexpected" change, any "change", or an "error"
  -h, --help               show this help
`;

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      cwd: { type: 'string', short: 'C' },
      config: { type: 'string', short: 'c' },
      expect: { type: 'string', short: 'e', multiple: true },
      'expect-file': { type: 'string' },
      pr: { type: 'string' },
      out: { type: 'string', short: 'o' },
      plan: { type: 'boolean' },
      json: { type: 'boolean' },
      devices: { type: 'boolean', default: true },
      'no-devices': { type: 'boolean' },
      'base-url': { type: 'string' },
      'head-url': { type: 'string' },
      'keep-worktrees': { type: 'boolean' },
      'keep-all': { type: 'boolean' },
      'fail-on': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
} catch (err) {
  console.error(`runup: ${err.message}\n\n${HELP}`);
  process.exit(64);
}

const { values: v, positionals } = args;
if (v.help || positionals.length !== 2) {
  process.stdout.write(HELP);
  process.exit(v.help ? 0 : 64);
}
if (v['fail-on'] && !['unexpected', 'change', 'error'].includes(v['fail-on'])) {
  console.error('runup: --fail-on must be unexpected, change or error');
  process.exit(64);
}

const opts = {
  base: positionals[0],
  head: positionals[1],
  cwd: v.cwd,
  config: v.config,
  expect: v.expect,
  expectFile: v['expect-file'],
  pr: v.pr,
  out: v.out,
  devices: v['no-devices'] ? false : v.devices,
  baseUrl: v['base-url'],
  headUrl: v['head-url'],
  keepWorktrees: v['keep-worktrees'],
  keepAll: v['keep-all'],
};

try {
  if (v.plan) {
    const p = await plan(opts);
    const out = {
      base: { ref: opts.base, sha: p.baseSha },
      head: { ref: opts.head, sha: p.headSha },
      config: p.configFile,
      appDir: p.discovered.appDir,
      author: p.author,
      changedFiles: p.discovered.files,
      screens: p.screens,
      skippedScreens: p.skipped,
    };
    if (v.json) {
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    } else {
      console.log(`${p.changed.length} changed files → ${p.screens.length} screens (app dir: ${p.discovered.appDir})`);
      for (const f of p.discovered.files) console.log(`  ${f.kind.padEnd(9)} ${f.file}${f.routes.length ? `  → ${f.routes.join(', ')}` : ''}`);
      console.log('screens:');
      for (const s of p.screens) console.log(`  ${s.path}  [${s.sources.join('+')}]${s.expected === false ? '  (not in author list)' : ''}`);
      for (const s of p.skipped) console.log(`  skip ${s.path ?? s.route}: ${s.reason}`);
    }
    process.exit(0);
  }

  const { report, htmlPath, jsonPath } = await runup(opts);
  const s = report.summary;
  console.log(`${s.changedScreens}/${s.screens} screens changed, ${s.changedCuts}/${s.cuts} cuts changed, ${s.unexpectedScreens} unexpected, ${s.skippedCuts} skipped, ${s.errorCuts} errors`);
  for (const w of report.warnings.filter((x) => x.type === 'unexpected-change')) console.log(`UNEXPECTED: ${w.path}`);
  console.log(htmlPath);
  console.log(jsonPath);
  const fail =
    (v['fail-on'] === 'unexpected' && s.unexpectedScreens > 0) ||
    (v['fail-on'] === 'change' && s.changedScreens > 0) ||
    (v['fail-on'] === 'error' && s.errorCuts > 0);
  process.exit(fail ? 2 : 0);
} catch (err) {
  console.error(`runup: ${err.message}`);
  if (process.env.RUNUP_DEBUG) console.error(err.stack);
  process.exit(1);
}
