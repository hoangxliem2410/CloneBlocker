/**
 * Generates the extension's PNG icons with no dependencies.
 *
 * Node can already do everything needed: zlib for the IDAT stream and
 * Buffer/CRC for the chunk framing. Drawing is done by evaluating a signed
 * distance field per pixel, which gives clean antialiased edges without a
 * canvas library.
 *
 * Run: node tools/make-icons.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Each scanline is prefixed with a filter byte (0 = None).
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** Signed distance to a rounded rectangle, centred at the origin. */
function sdRoundRect(px, py, hw, hh, r) {
  const qx = Math.abs(px) - (hw - r);
  const qy = Math.abs(py) - (hh - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Signed distance to a line segment, used for the slash. */
function sdSegment(px, py, ax, ay, bx, by, thick) {
  const pax = px - ax, pay = py - ay;
  const bax = bx - ax, bay = by - ay;
  const h = Math.min(1, Math.max(0, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h) - thick;
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const S = size;
  // Supersample 3x3 for smooth edges at 16px.
  const SS = 3;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = ((x + (sx + 0.5) / SS) / S) * 2 - 1;
          const py = ((y + (sy + 0.5) / SS) / S) * 2 - 1;

          // Rounded-square badge.
          const dBadge = sdRoundRect(px, py, 0.92, 0.92, 0.34);
          // Ring + slash = the universal "blocked" mark.
          const dRingOuter = Math.hypot(px, py) - 0.56;
          const dRingInner = Math.hypot(px, py) - 0.40;
          const dRing = Math.max(dRingOuter, -dRingInner);
          const dSlash = sdSegment(px, py, -0.36, -0.36, 0.36, 0.36, 0.085);
          const dMark = Math.min(dRing, dSlash);

          const cover = (d) => Math.min(1, Math.max(0, 0.5 - d * S * 0.5));

          const badgeA = cover(dBadge);
          const markA = cover(dMark);

          // Deep indigo badge, near-white mark.
          const bg = [37, 45, 74];
          const fg = [242, 245, 252];
          const outR = bg[0] * (1 - markA) + fg[0] * markA;
          const outG = bg[1] * (1 - markA) + fg[1] * markA;
          const outB = bg[2] * (1 - markA) + fg[2] * markA;

          r += outR * badgeA; g += outG * badgeA; b += outB * badgeA;
          a += badgeA;
        }
      }
      const n = SS * SS;
      const i = (y * S + x) * 4;
      const alpha = a / n;
      buf[i] = alpha > 0 ? Math.round(r / n / alpha) : 0;
      buf[i + 1] = alpha > 0 ? Math.round(g / n / alpha) : 0;
      buf[i + 2] = alpha > 0 ? Math.round(b / n / alpha) : 0;
      buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePNG(S, S, buf);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, render(size));
  console.log('wrote', file, fs.statSync(file).size, 'bytes');
}
