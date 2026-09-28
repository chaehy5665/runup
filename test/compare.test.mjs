import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PNG } from 'pngjs';
import { comparePngs, diffBoxes } from '../src/compare.mjs';

function png(width, height, paint = () => [255, 255, 255]) {
  const img = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const i = (y * width + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(img);
}

const inRect = (x, y, r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

describe('comparePngs', () => {
  it('reports identical images as unchanged', () => {
    const a = png(100, 80);
    const res = comparePngs(a, png(100, 80));
    assert.equal(res.changed, false);
    assert.equal(res.diffPixels, 0);
    assert.deepEqual(res.boxes, []);
  });

  it('finds a changed block and boxes it', () => {
    const block = { x: 40, y: 20, w: 20, h: 10 };
    const res = comparePngs(png(200, 100), png(200, 100, (x, y) => (inRect(x, y, block) ? [0, 0, 0] : [255, 255, 255])));
    assert.equal(res.changed, true);
    assert.equal(res.diffPixels, 200);
    assert.equal(res.diffRatio, 200 / 20000);
    assert.equal(res.boxes.length, 1);
    const [box] = res.boxes;
    assert.ok(box.x <= block.x && box.y <= block.y, 'box starts at or before the block');
    assert.ok(box.x + box.w >= block.x + block.w && box.y + box.h >= block.y + block.h, 'box covers the block');
    assert.ok(box.w < 80 && box.h < 50, 'box stays tight');
  });

  it('separates distant changes into separate boxes', () => {
    const a = { x: 5, y: 5, w: 8, h: 8 };
    const b = { x: 150, y: 70, w: 8, h: 8 };
    const res = comparePngs(png(200, 100), png(200, 100, (x, y) => (inRect(x, y, a) || inRect(x, y, b) ? [0, 0, 0] : [255, 255, 255])));
    assert.equal(res.boxes.length, 2);
  });

  it('counts a size change as changed even with equal content', () => {
    const res = comparePngs(png(100, 80), png(100, 120));
    assert.equal(res.changed, true);
    assert.equal(res.sizeChanged, true);
    assert.deepEqual(res.sizes, { before: { width: 100, height: 80 }, after: { width: 100, height: 120 } });
    assert.equal(res.height, 120);
  });

  it('ignores differences below the configured floor', () => {
    const tiny = comparePngs(png(100, 100), png(100, 100, (x, y) => (x === 3 && y === 3 ? [0, 0, 0] : [255, 255, 255])), { minDiffPixels: 5 });
    assert.equal(tiny.diffPixels, 1);
    assert.equal(tiny.changed, false);
  });

  it('ignores colour shifts under the pixel threshold', () => {
    const res = comparePngs(png(50, 50), png(50, 50, () => [252, 252, 252]), { threshold: 0.1 });
    assert.equal(res.changed, false);
  });
});

describe('diffBoxes', () => {
  it('returns no boxes for a diff with no marked pixels', () => {
    assert.deepEqual(diffBoxes(new Uint8Array(10 * 10 * 4), 10, 10), []);
  });
});
