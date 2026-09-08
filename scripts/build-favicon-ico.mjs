// Renders `apps/web/public/favicon.ico` from the hand-authored
// `apps/web/public/favicon.svg`, so the two never disagree.
//
// Run it with:  node scripts/build-favicon-ico.mjs
//
// ## Why both files exist, and why this script does
//
// `BaseLayout.astro` links the SVG, which every current browser prefers. The
// ICO is there for the ones that ask for `/favicon.ico` by convention without
// being told to — and, more importantly, because `infra/src/auth-stack.ts`
// base64s **both** files into Cognito's managed-login branding, so the two
// hosted sign-in pages carry the site's icon too. An ICO left on the old teal
// while the SVG moved to olive would show up in exactly one place nobody
// looks at during a redesign: the login page's browser tab.
//
// ICO is a container format sharp will not write, but it is a simple one, and
// since Vista an entry's payload may be a whole PNG rather than a DIB. That is
// what this writes: a six-byte ICONDIR, one sixteen-byte ICONDIRENTRY per
// size, then the PNGs.

import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const SOURCE = 'apps/web/public/favicon.svg';
const TARGET = 'apps/web/public/favicon.ico';
/** 16 and 32 are what browsers actually ask for; 48 is what Windows uses for a pinned site. */
const SIZES = [16, 32, 48];

// A high render density before the downscale: rasterising the SVG at the
// target size directly leaves the leaf edges chewed, where rendering large and
// resampling keeps them smooth.
const pngs = await Promise.all(
  SIZES.map((size) => sharp(SOURCE, { density: 900 }).resize(size, size).png().toBuffer()),
);

const HEADER_BYTES = 6;
const ENTRY_BYTES = 16;

const header = Buffer.alloc(HEADER_BYTES);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // 1 = icon (2 would be a cursor)
header.writeUInt16LE(SIZES.length, 4);

let offset = HEADER_BYTES + ENTRY_BYTES * SIZES.length;
const entries = SIZES.map((size, index) => {
  const entry = Buffer.alloc(ENTRY_BYTES);
  // A dimension of 0 means 256 in this format; nothing here is that large, but
  // writing it modulo 256 is what the format asks for either way.
  entry.writeUInt8(size % 256, 0);
  entry.writeUInt8(size % 256, 1);
  entry.writeUInt8(0, 2); // palette size — 0 for truecolour
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(pngs[index].length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += pngs[index].length;
  return entry;
});

writeFileSync(TARGET, Buffer.concat([header, ...entries, ...pngs]));

console.log(`${TARGET}: ${SIZES.join(', ')}px from ${SOURCE}`);
