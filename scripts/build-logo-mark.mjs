// Derives `apps/web/public/logo-mark.png` — the brand mark the site header,
// the footer and the landing page's hero all use — from the owner's original
// artwork, `apps/web/src/assets/brand/logo-mark-source.png`.
//
// Run it with:  node scripts/build-logo-mark.mjs
//
// ## Why this is a script and not a one-off
//
// The original is a 2944×2848, 10.8 MB PNG of the mark **composited on a
// near-white studio ground** — not a logo file. Shipping it as-is would have
// been ten megabytes on every page load for a 40px header image, and dropping
// it on any surface that is not that exact white shows the ground as a
// rectangle. So the committed asset is processed, and a processed asset that
// nobody can reproduce is a binary with no source. This is the source.
//
// The original lives under `src/assets/` rather than `public/`, which matters:
// everything in `public/` is copied verbatim into `dist/` and served by
// CloudFront, so leaving it where the owner dropped it would have put 10.8 MB
// of unreferenced artwork on the production origin. Nothing imports it, so
// Vite emits nothing for it either — it is in the repository to be kept, and
// to be the input to this script, not to be served.
//
// ## What it does, and why each step is needed
//
//  1. **Knockout.** Alpha is derived from luminance: at or above `T_CLEAR`
//     the pixel is studio ground and goes fully transparent, at or below
//     `T_SOLID` it is artwork and stays opaque, and the band between the two
//     ramps. `GAMMA` bends that ramp and `ALPHA_CUT` discards what is left
//     below a real fraction of opacity.
//
//     `ALPHA_CUT` is the setting that matters most, and it is high (0.5) for
//     a reason worth writing down. The artwork has a broad, very soft wash
//     around the mark — a glow, painted white on white. At a low cut those
//     pixels survive at 20–40% alpha, and step 2 below then *divides the
//     white back out of them*, turning what was invisible on white into a
//     mid-grey smudge on any other ground. Un-compositing makes that wash
//     more visible, not less. Cutting it instead costs nothing: the mark's
//     own edges cross this band within a few pixels, so they stay soft,
//     while the wash — which sits in it for hundreds — disappears. Tuned by
//     rendering candidates over the site's actual surfaces and looking at
//     them, which is the only way to tune it.
//  2. **Un-compositing.** Every surviving partial pixel is divided back out
//     of the white it was composited over, so the mark carries its own colour
//     onto a tinted background instead of a white fringe.
//  3. **Speck removal.** A flood fill drops any connected component smaller
//     than `MIN_BLOB`. The original has sensor noise across the ground and a
//     pink cluster in one corner — that corner speck is dark enough to be
//     read as artwork, and it alone would defeat the crop below by pinning
//     the bounding box to (0, 0).
//  4. **Crop and resize.** Tight to what survived, then down to `WIDTH`, which
//     is a little over 3× the largest size the mark is displayed at (17rem in
//     the hero, on a 2× screen).
//
// Reads and writes exactly two paths, both named below; it never touches the
// original.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const SOURCE = 'apps/web/src/assets/brand/logo-mark-source.png';
const TARGET = 'apps/web/public/logo-mark.png';

/** At or below this luminance a pixel is artwork, and fully opaque. */
const T_SOLID = 232;
/** At or above this luminance a pixel is studio ground, and fully transparent. */
const T_CLEAR = 250;
/** Bend of the alpha ramp between the two. >1 crushes the faint outer wash. */
const GAMMA = 3;
/** Alpha below this is nothing worth keeping. */
const ALPHA_CUT = 0.5;
/** Connected components smaller than this many pixels are noise, not artwork. */
const MIN_BLOB = 12000;
/** Output width. The mark is never displayed above ~272 CSS px. */
const WIDTH = 480;

const { data, info } = await sharp(SOURCE).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width, height } = info;

const out = Buffer.alloc(data.length);
const alpha = new Uint8Array(width * height);

for (let pixel = 0; pixel < width * height; pixel += 1) {
  const i = pixel * 4;
  const r = data[i];
  const g = data[i + 1];
  const b = data[i + 2];
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;

  let a = 1;
  if (luminance >= T_CLEAR) {
    a = 0;
  } else if (luminance > T_SOLID) {
    a = ((T_CLEAR - luminance) / (T_CLEAR - T_SOLID)) ** GAMMA;
  }
  if (a < ALPHA_CUT) {
    a = 0;
  }
  if (a === 0) {
    continue;
  }

  // Un-composite from white: the source pixel is `a * colour + (1 - a) * 255`.
  const unComposite = (channel) =>
    Math.max(0, Math.min(255, Math.round((channel - 255 * (1 - a)) / a)));
  out[i] = unComposite(r);
  out[i + 1] = unComposite(g);
  out[i + 2] = unComposite(b);
  out[i + 3] = Math.round(a * 255);
  alpha[pixel] = out[i + 3];
}

// 4-connected flood fill over everything with any opacity. An explicit stack
// rather than recursion: the mark is one component of well over a million
// pixels and a recursive fill overflows the call stack on it.
const seen = new Uint8Array(width * height);
const stack = new Int32Array(width * height);
let dropped = 0;

for (let start = 0; start < width * height; start += 1) {
  if (seen[start] === 1 || alpha[start] === 0) {
    continue;
  }
  let top = 0;
  const members = [];
  stack[top] = start;
  top += 1;
  seen[start] = 1;

  while (top > 0) {
    top -= 1;
    const pixel = stack[top];
    members.push(pixel);
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    const push = (neighbour) => {
      if (seen[neighbour] === 0 && alpha[neighbour] !== 0) {
        seen[neighbour] = 1;
        stack[top] = neighbour;
        top += 1;
      }
    };
    if (x > 0) push(pixel - 1);
    if (x < width - 1) push(pixel + 1);
    if (y > 0) push(pixel - width);
    if (y < height - 1) push(pixel + width);
  }

  if (members.length < MIN_BLOB) {
    dropped += 1;
    for (const pixel of members) {
      alpha[pixel] = 0;
      out.fill(0, pixel * 4, pixel * 4 + 4);
    }
  }
}

let minX = width;
let minY = height;
let maxX = -1;
let maxY = -1;
for (let pixel = 0; pixel < width * height; pixel += 1) {
  if (alpha[pixel] < 8) {
    continue;
  }
  const x = pixel % width;
  const y = Math.floor(pixel / width);
  if (x < minX) minX = x;
  if (x > maxX) maxX = x;
  if (y < minY) minY = y;
  if (y > maxY) maxY = y;
}

const box = { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };

await sharp(out, { raw: { width, height, channels: 4 } })
  .extract(box)
  .resize({ width: WIDTH, fit: 'inside', withoutEnlargement: true })
  // A 256-entry palette with light dithering: the mark is a handful of pastel
  // gradients, which quantise cleanly, and it takes the file from ~740 kB to
  // ~110 kB with no visible banding at the sizes it is shown at.
  .png({ compressionLevel: 9, palette: true, colours: 256, dither: 0.2 })
  .toFile(TARGET);

console.log(`${TARGET}: cropped ${box.width}x${box.height} from ${width}x${height}, dropped ${dropped} specks`);
