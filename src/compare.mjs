import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

/**
 * Compare two PNG buffers. Images of different sizes are padded to a common canvas, so a page that got
 * taller or shorter always counts as changed.
 *
 * @returns {{changed: boolean, diffPixels: number, diffRatio: number, width: number, height: number,
 *   sizeChanged: boolean, sizes: object, boxes: {x:number,y:number,w:number,h:number}[], diffPng: Buffer}}
 */
export function comparePngs(beforeBuf, afterBuf, { threshold = 0.1, minDiffPixels = 0, minDiffRatio = 0 } = {}) {
  const before = PNG.sync.read(beforeBuf);
  const after = PNG.sync.read(afterBuf);
  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  const sizeChanged = before.width !== after.width || before.height !== after.height;
  const a = pad(before, width, height);
  const b = pad(after, width, height);
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(a, b, diff.data, width, height, {
    threshold,
    includeAA: false,
    alpha: 0.2,
    diffColor: [255, 0, 64],
    diffColorAlt: [0, 160, 255],
  });
  const diffRatio = width * height ? diffPixels / (width * height) : 0;
  const changed = sizeChanged || (diffPixels > minDiffPixels && diffRatio > minDiffRatio);
  const boxes = changed ? diffBoxes(diff.data, width, height) : [];
  return {
    changed,
    diffPixels,
    diffRatio,
    width,
    height,
    sizeChanged,
    sizes: { before: { width: before.width, height: before.height }, after: { width: after.width, height: after.height } },
    boxes,
    diffPng: PNG.sync.write(diff),
  };
}

function pad(png, width, height) {
  if (png.width === width && png.height === height) return png.data;
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < png.height; y++) {
    png.data.copy(out, y * width * 4, y * png.width * 4, (y + 1) * png.width * 4);
  }
  return out;
}

/**
 * Bounding boxes of changed regions. Pixelmatch paints differing pixels in the diff colors; we bucket
 * them into a coarse grid, join touching cells, and return one box per cluster (largest first).
 */
export function diffBoxes(diffData, width, height, { cell = 16, pad: margin = 4, max = 12 } = {}) {
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const hot = new Uint8Array(cols * rows);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = diffData[i];
      const g = diffData[i + 1];
      const bl = diffData[i + 2];
      if ((r === 255 && g === 0 && bl === 64) || (r === 0 && g === 160 && bl === 255)) {
        hot[Math.floor(y / cell) * cols + Math.floor(x / cell)] = 1;
      }
    }
  }
  const seen = new Uint8Array(cols * rows);
  const boxes = [];
  for (let start = 0; start < hot.length; start++) {
    if (!hot[start] || seen[start]) continue;
    let minC = cols;
    let maxC = 0;
    let minR = rows;
    let maxR = 0;
    let cells = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const idx = stack.pop();
      const c = idx % cols;
      const r = (idx - c) / cols;
      cells++;
      minC = Math.min(minC, c);
      maxC = Math.max(maxC, c);
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
          const n = nr * cols + nc;
          if (hot[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    const x = Math.max(0, minC * cell - margin);
    const y = Math.max(0, minR * cell - margin);
    boxes.push({
      x,
      y,
      w: Math.min(width, (maxC + 1) * cell + margin) - x,
      h: Math.min(height, (maxR + 1) * cell + margin) - y,
      cells,
    });
  }
  boxes.sort((p, q) => q.w * q.h - p.w * p.h);
  return boxes.slice(0, max).map(({ x, y, w, h }) => ({ x, y, w, h }));
}
