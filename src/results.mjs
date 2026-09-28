import fs from 'node:fs/promises';
import path from 'node:path';
import { comparePngs } from './compare.mjs';

/**
 * Decide the status of every captured cut and write images. Only changed cuts keep their images
 * unless `keepAll` is set; unchanged cuts stay in report.json without pictures.
 */
export async function compareCuts(cuts, { reportDir, compare, keepAll = false }) {
  for (const cut of cuts) {
    if (cut.skipped) {
      cut.status = 'skipped';
      continue;
    }
    if (!cut.before || !cut.after) {
      cut.status = 'error';
      await writeImages(cut, reportDir, { before: cut.before, after: cut.after });
      continue;
    }
    const result = comparePngs(cut.before, cut.after, compare);
    Object.assign(cut, {
      status: result.changed ? 'changed' : 'unchanged',
      diffPixels: result.diffPixels,
      diffRatio: result.diffRatio,
      sizeChanged: result.sizeChanged,
      boxes: result.boxes,
      canvas: { width: result.width, height: result.height },
      sizes: result.sizes,
    });
    if (result.changed || keepAll) {
      await writeImages(cut, reportDir, { before: cut.before, after: cut.after, diff: result.diffPng });
    }
  }
  for (const cut of cuts) {
    delete cut.before;
    delete cut.after;
  }
  return cuts;
}

async function writeImages(cut, reportDir, images) {
  const dir = path.join(reportDir, 'cuts', cut.id);
  await fs.mkdir(dir, { recursive: true });
  cut.images = {};
  for (const [name, buf] of Object.entries(images)) {
    if (!buf) continue;
    await fs.writeFile(path.join(dir, `${name}.png`), buf);
    cut.images[name] = `cuts/${cut.id}/${name}.png`;
  }
}
