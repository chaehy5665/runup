# runup — working rules

RUN-UP is a public MIT repository. Read this before changing anything.

## Workflow
- Work in a git worktree on a `claude/` branch (for example `git worktree add -b claude/<topic> ../worktrees/runup-<topic> origin/main`). Never edit or commit in the main checkout directly.
- No force-push, no history rewrites on shared branches, no branch deletion without being asked.
- Open a PR for every change. structure reviews it; SUPERVISOR merges. Do not merge your own PR.
- Before asking for review: `npm run lint`, `npm test`, and `npm run test:e2e` (needs Chromium: `npx playwright install chromium`) all pass.

## Public-repo boundary
- Nothing from private projects goes in here: no vocado (or other private) code, screenshots, URLs, hostnames, project ids, env names, credentials or copied configs. That includes tests, fixtures, examples, docs, commit messages and PR bodies.
- runup's own tests run only against `examples/mini-app` and `test/fixtures/`. A target project's `runup.config.*` and its reports live in that project (or a local, git-ignored `output/`), never here.
- `output/` and `.runup/` are git-ignored. Do not commit reports.

## Scope
- Do not build new engines. Browsers are Playwright; pixel diff is pixelmatch; the report is static HTML with inline CSS/JS. No hosted service, no uploads, no external assets in the report.
- Out of the MVP (listed in the README roadmap): screens behind login, iOS Simulator, component isolation, axe. Discuss before starting any of them.

## Code
- Plain ESM JavaScript (`.mjs`), Node 20+, no build step. Keep dependencies few; add one only when it replaces real work.
- Layout: `bin/runup.mjs` (CLI) → `src/run.mjs` (pipeline) → `src/discover/` (diff → routes, import graph), `src/screens.mjs` (routes → paths, author list), `src/server.mjs` + `src/git.mjs` (worktrees and servers), `src/capture.mjs` (Playwright), `src/compare.mjs` + `src/results.mjs` (pixel diff), `src/report/` (report.json and HTML).
- `report.json` is a contract for atc and other agents (`schema: runup.report/v1`). Additive changes are fine; renaming or removing a field needs a schema bump and a note in the PR.
- Screen discovery and diff selection changes come with unit tests (`test/discover.test.mjs`, `test/screens.test.mjs`, `test/compare.test.mjs`).
- Keep README.md and README.ko.md in step when behaviour or options change.
