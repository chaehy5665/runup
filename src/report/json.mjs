import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version } = require('../../package.json');

export const REPORT_SCHEMA = 'runup.report/v1';

/**
 * The machine-readable report. atc and agents read this; the HTML is rendered from it too.
 * Image paths are relative to `paths.reportDir`.
 */
export function buildReport({ root, configFile, opts, baseSha, headSha, discovered, author, screens, skipped, cuts, reportDir, serverNotes = [], durationMs }) {
  const cutOut = cuts.map((c) => ({
    id: c.id,
    path: c.path,
    state: c.state,
    kind: c.kind,
    browser: c.browser,
    ...(c.kind === 'viewport' ? { width: c.width, height: c.height } : { device: c.device }),
    colorScheme: c.colorScheme,
    status: c.status,
    changed: c.status === 'changed',
    diffRatio: c.diffRatio ?? null,
    diffPixels: c.diffPixels ?? null,
    sizeChanged: c.sizeChanged ?? null,
    sizes: c.sizes ?? null,
    canvas: c.canvas ?? null,
    boxes: c.boxes ?? [],
    images: c.images ?? null,
    ...(c.retakes ? { retakes: c.retakes, flaky: Boolean(c.flaky) } : {}),
    ...(c.skipped ? { reason: c.skipped } : {}),
    ...(c.errors ? { errors: c.errors } : {}),
  }));

  const screenOut = screens.map((s) => {
    const mine = cutOut.filter((c) => c.path === s.path);
    const changed = mine.some((c) => c.changed);
    const errored = mine.some((c) => c.status === 'error');
    return {
      path: s.path,
      route: s.route,
      sources: s.sources,
      reasons: s.reasons,
      expected: s.expected,
      changed,
      unexpected: changed && s.expected === false,
      errored,
      maxDiffRatio: Math.max(0, ...mine.map((c) => c.diffRatio ?? 0)),
      cuts: { total: mine.length, changed: mine.filter((c) => c.changed).length },
    };
  });

  const warnings = [];
  for (const note of serverNotes) warnings.push({ type: 'server-setup', message: note });
  for (const s of screenOut) {
    if (s.unexpected) warnings.push({ type: 'unexpected-change', path: s.path, message: `${s.path} changed but the author did not list it` });
  }
  if (!author.screens.length) {
    warnings.push({ type: 'no-author-list', message: 'No author screen list was given (--expect, --expect-file or --pr), so unexpected changes cannot be flagged' });
  }
  const skippedReasons = new Map();
  for (const c of cutOut.filter((x) => x.status === 'skipped')) skippedReasons.set(c.reason, (skippedReasons.get(c.reason) ?? 0) + 1);
  for (const [reason, count] of skippedReasons) warnings.push({ type: 'cuts-skipped', count, message: `${count} cuts skipped: ${reason}` });
  const flaky = cutOut.filter((c) => c.flaky).length;
  if (flaky) warnings.push({ type: 'flaky-cuts', count: flaky, message: `${flaky} cuts differed on the first shot but not on the retake; they count as unchanged` });
  const errorCount = cutOut.filter((c) => c.status === 'error').length;
  if (errorCount) warnings.push({ type: 'capture-errors', count: errorCount, message: `${errorCount} cuts failed to capture on base or head` });
  for (const s of skipped) warnings.push({ type: 'screen-skipped', path: s.path ?? s.route, message: `${s.path ?? s.route}: ${s.reason}` });
  if (discovered.unmapped.length) {
    warnings.push({ type: 'unmapped-files', files: discovered.unmapped, message: `${discovered.unmapped.length} changed files did not map to a screen; the default set was added` });
  }

  return {
    schema: REPORT_SCHEMA,
    tool: { name: 'runup', version },
    generatedAt: new Date().toISOString(),
    durationMs,
    base: { ref: opts.base, sha: baseSha },
    head: { ref: opts.head, sha: headSha },
    config: configFile,
    author: { sources: author.sources, screens: author.screens },
    summary: {
      screens: screenOut.length,
      changedScreens: screenOut.filter((s) => s.changed).length,
      unexpectedScreens: screenOut.filter((s) => s.unexpected).length,
      cuts: cutOut.length,
      changedCuts: cutOut.filter((c) => c.changed).length,
      unchangedCuts: cutOut.filter((c) => c.status === 'unchanged').length,
      skippedCuts: cutOut.filter((c) => c.status === 'skipped').length,
      errorCuts: errorCount,
    },
    warnings,
    changedFiles: discovered.files,
    screens: screenOut,
    skippedScreens: skipped,
    cuts: cutOut,
    paths: { repo: root, reportDir, html: 'index.html', json: 'report.json' },
  };
}
