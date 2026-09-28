# RUN-UP

**One command before merge: base vs head, only the screens that changed, one report.**

[한국어](README.ko.md)

`runup` compares a web app at two git refs. It works out which screens a diff can reach, starts the app twice (base and head, each in its own git worktree), takes the same screenshots on both, and writes one static report that shows only the cuts that changed. The goal is a PR review that takes tens of seconds instead of clicking around a preview deployment.

```
runup origin/main HEAD --pr 123
```

```
2/3 screens changed, 12/18 cuts changed, 1 unexpected, 0 skipped, 0 errors
UNEXPECTED: /blog/hello
.runup/090848f-94fb4a9/index.html
.runup/090848f-94fb4a9/report.json
```

## What it does

1. **Changed screens.** It reads `git diff base...head` and maps each file to routes. For a Next.js App Router project, `page.*` is a screen; `layout`, `template`, `loading`, `error` and `not-found` affect every page below them; route groups `(x)` and slots `@x` are dropped; private `_x` folders and intercepting routes are not screens. Other files (components, hooks, CSS) are followed through a light import graph (relative imports, tsconfig `paths`, `baseUrl`) to the pages and layouts that reach them. Files that only reach route handlers are non-visual. Files it cannot place send the run to the config's default screens. The PR author can add screens (`--expect`, `--expect-file`, or a `runup` block in the PR body).
2. **Two servers.** Base and head are checked out as detached git worktrees and started with the same setup, seed and env on the configured ports.
3. **Before/after.** Every screen is shot at each width × light/dark × state. Iframes, video and configured selectors are masked, animations are disabled, the clock is frozen. Pixel comparison uses [pixelmatch](https://github.com/mapbox/pixelmatch); only changed cuts keep their images.
4. **Devices.** The same shots run on Playwright device profiles (iPhone, Pixel, iPad by default) in Chromium and WebKit.
5. **One report.** `index.html` is a static page: changed cuts only, a before/after slider, boxes around changed regions, a device grid, and an **unexpected change** warning when a screen the author did not list changed. `report.json` carries the same data for tools and agents.

It uses Playwright, pixelmatch and static HTML. Nothing is uploaded; there is no service.

## Install

Requires Node 20+ and git 2.36+.

```sh
git clone https://github.com/chaehy5665/runup.git
cd runup && npm install
npx playwright install chromium webkit
# WebKit on Linux also needs system libraries:
sudo npx playwright install-deps webkit
npm link   # puts `runup` on your PATH
```

If a browser cannot launch, its cuts are marked skipped in the report instead of failing the run.

## Use

Run it from the project you want to check (or pass `-C <dir>`):

```sh
runup <base-ref> <head-ref> [options]

runup origin/main HEAD                       # screens from the diff
runup origin/main HEAD --pr 123              # + the author's list from PR #123
runup origin/main HEAD -e '/en/blog/[slug]' -e /en
runup origin/main HEAD --plan                # just print which screens would be checked
runup origin/main HEAD --no-devices          # viewports only
runup origin/main HEAD --base-url http://127.0.0.1:3001 --head-url http://127.0.0.1:3002
```

| Option | |
|---|---|
| `-C, --cwd <dir>` | target repository |
| `-c, --config <file>` | config file (default `runup.config.{mjs,js,json}` in the repo root) |
| `-e, --expect <screen>` | a screen the author expects to change: a path, a route pattern or a glob (repeatable) |
| `--expect-file <file>` | one expected screen per line |
| `--pr <number>` | read the ```` ```runup ```` block of a GitHub PR body (uses `gh`) |
| `-o, --out <dir>` | output root (default: config `outDir`, `.runup`) |
| `--plan` / `--json` | print the screen plan and exit, optionally as JSON |
| `--no-devices` | skip the device pass |
| `--base-url`, `--head-url` | use servers that are already running |
| `--keep-worktrees` | keep worktrees; the next run at the same commits skips setup |
| `--keep-all` | keep images of unchanged cuts |
| `--fail-on unexpected\|change\|error` | exit 2 in that case (for CI or agents) |

### The author's list

Put a fenced `runup` block in the PR body. Paths, route patterns and globs all work:

````md
```runup
/en/blog/[slug]
/en
/en/account/*
```
````

Screens in the list are always checked. A screen that changed but is not in the list is reported as an **unexpected change**. Without a list, nothing is flagged as unexpected, and the report says so.

## Config

`runup.config.mjs` lives in the target repository. Everything is optional except `server.start`.

```js
export default {
  appDir: 'src/app',                           // auto-detected: src/app or app
  pageExtensions: ['tsx', 'ts', 'jsx', 'js', 'mdx'],
  params: { locale: ['en'], slug: ['demo'] },  // samples for dynamic segments
  paths: { '/[locale]/blog/[slug]': ['/en/blog/demo'] }, // or concrete paths per route
  defaultScreens: ['/en'],                     // used when a change cannot be placed
  exclude: ['/[locale]/dashboard/**'],         // never shot (login-only screens, admin …)
  ignore: ['fixtures/**'],                     // files that never matter (added to the built-in list)
  impact: [                                    // explicit mappings, checked before the import graph
    { files: 'messages/**', screens: 'default' },  // 'all' | 'default' | 'none' | [paths]
  ],
  states: [
    { name: 'default' },
    { name: 'comments', routes: ['/[locale]/blog/[slug]'], query: { tab: 'comments' } },
    { name: 'menu', steps: [{ click: 'button[aria-label=Menu]' }, { waitFor: '[role=menu]' }] },
    { name: 'filled', run: async ({ page }) => { await page.fill('input', 'hello'); } },
  ],
  server: {
    setup: ['npm ci'],                          // run once in each fresh worktree
    copy: ['.env.local'],                       // untracked files copied from the repo (missing ones are skipped)
    seed: 'npm run db:seed',                    // run before each start
    start: 'npx next dev --port $PORT',
    ports: { base: 3101, head: 3102 },          // or 'auto'
    ready: '/',                                 // polled until it answers
    timeoutMs: 180000,
    worktreeDir: '../.runup-worktrees',         // default: sibling of the repo
  },
  capture: {
    widths: [390, 768, 1280],
    colorSchemes: ['light', 'dark'],
    schemeInit: { dark: "localStorage.setItem('theme','dark')" }, // for class-based themes
    mask: ['iframe', 'video', '[data-runup-mask]'],
    hide: ['.toast'],
    freezeTime: '2026-01-01T09:00:00Z',
    fullPage: true,
    maxHeight: 10000,
  },
  devices: {
    profiles: ['iPhone 15', 'Pixel 7', 'iPad (gen 7)'],
    browsers: ['chromium', 'webkit'],
    colorSchemes: ['light'],                    // default: same as capture
  },
  compare: { threshold: 0.1, minDiffPixels: 0, minDiffRatio: 0 },
  outDir: '.runup',
};
```

In globs over routes (`exclude`, `states[].routes`, the author's list), `[param]` and `(group)` are literal, so `/[locale]/dashboard/**` means what it looks like.

Commands in `server.*` run with `PORT`, `RUNUP_SIDE` (`base` or `head`), `RUNUP_REPO` (the checkout you ran from) and `RUNUP_WORKTREE` set. Add `.runup/` to the target repo's `.gitignore`.

State steps: `click`, `hover`, `fill: [selector, value]`, `press: key | [selector, key]`, `scroll`, `waitFor`, `wait: ms`, `evaluate: 'js'`. A state can also set `query` and `localStorage`, or run any Playwright code with `run`.

## report.json

```jsonc
{
  "schema": "runup.report/v1",
  "base": { "ref": "origin/main", "sha": "…" },
  "head": { "ref": "HEAD", "sha": "…" },
  "summary": { "screens": 3, "changedScreens": 2, "unexpectedScreens": 1, "cuts": 18, "changedCuts": 12, "skippedCuts": 0, "errorCuts": 0 },
  "warnings": [{ "type": "unexpected-change", "path": "/blog/hello", "message": "…" }],
  "changedFiles": [{ "file": "app/blog/[slug]/page.html", "kind": "routes", "routes": ["/blog/[slug]"] }],
  "screens": [{ "path": "/blog/hello", "route": "/blog/[slug]", "sources": ["diff"], "expected": false, "changed": true, "unexpected": true, "maxDiffRatio": 0.0026 }],
  "cuts": [{ "id": "…", "path": "/blog/hello", "state": "default", "kind": "viewport", "browser": "chromium", "width": 390, "colorScheme": "light",
             "status": "changed", "diffRatio": 0.0026, "boxes": [{ "x": 16, "y": 212, "w": 360, "h": 72 }],
             "images": { "before": "cuts/…/before.png", "after": "cuts/…/after.png", "diff": "cuts/…/diff.png" } }],
  "paths": { "reportDir": "/abs/path", "html": "index.html", "json": "report.json" }
}
```

`status` is `changed`, `unchanged`, `skipped` (with `reason`) or `error` (with `errors.base`/`errors.head`). Image paths are relative to `paths.reportDir`. `changedFiles[].kind` is `routes`, `nonVisual`, `unmapped`, `rule` or `ignored`.

## Viewing the report remotely

The report is plain files. On a remote machine:

```sh
cd .runup/<run> && python3 -m http.server 8765
# on your laptop
ssh -L 8765:127.0.0.1:8765 <host>   # then open http://localhost:8765
```

## Develop

```sh
npm run lint
npm test            # unit tests: screen discovery, diff selection, screens, config
npm run test:e2e    # runs the CLI on examples/mini-app in a temporary git repo (needs Chromium)
```

`examples/mini-app` is a zero-dependency app that follows App Router file conventions (`page.html`, `layout.html`, `(group)`, `[param]`, `_private`), so the whole pipeline can run in CI without Next.js.

## Roadmap

Not in the MVP:

- Screens behind login (storage state per side, test accounts)
- iOS Simulator and real devices
- Component-level isolation (Storybook-style stories)
- Accessibility checks (axe)
- Frameworks other than Next.js App Router (Pages Router, Remix, Vite routes)
- Re-shooting noisy cuts to drop flaky diffs automatically

## License

MIT
