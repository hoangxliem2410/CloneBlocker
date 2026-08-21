/**
 * Generates the extension's PNG icons with no dependencies.
 *
 * Node can already do everything needed: zlib for the IDAT stream and
 * Buffer/CRC for the chunk framing. Drawing is done by evaluating a signed
 * distance field per pixel, which gives clean antialiased edges without a
 * canvas library and stays sharp at 16px where a downscaled bitmap turns to
 * mush.
 *
 * The mark is two head-and-shoulders figures, the second offset behind the
 * first and struck through: an impersonator standing behind you, cancelled.
 * A plain ring-and-slash would only say "blocked", which is what every other
 * blocker in the store already says.
 *
 *   node tools/make-icons.js
 *
 * Writes icons/icon{16,32,48,128}.png for the manifest, plus
 * store/icon128.png -- the same mark inset to 96px inside a 128px transparent
 * frame, which is what the Chrome Web Store asks for its listing icon.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// -- PNG container ---------------------------------------------------------

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

// -- distance fields -------------------------------------------------------

/** Signed distance to a rounded rectangle, centred at (cx, cy). */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Signed distance to a circle. */
function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

/** Signed distance to a thick line segment, used for the slash. */
function sdSegment(px, py, ax, ay, bx, by, thick) {
  const pax = px - ax, pay = py - ay;
  const bax = bx - ax, bay = by - ay;
  const h = Math.min(1, Math.max(0, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h) - thick;
}

/**
 * Head-and-shoulders figure: a circle over a wide capsule. Deliberately not a
 * detailed silhouette -- at 16px anything with a neck reads as noise.
 */
function sdPerson(px, py, cx, cy, s) {
  const head = sdCircle(px, py, cx, cy - 0.30 * s, 0.29 * s);
  const body = sdRoundRect(px, py, cx, cy + 0.28 * s, 0.50 * s, 0.21 * s, 0.21 * s);
  return Math.min(head, body);
}

// -- palette ---------------------------------------------------------------
//
// One deep indigo field, one near-white figure, one desaturated figure for the
// impersonator, one warm accent for the strike. The badge has to hold up on
// both a light and a dark toolbar, which rules out anything mid-tone.
const BADGE = [30, 36, 64];
const REAL  = [244, 246, 252];
const CLONE = [124, 136, 184];
const STRIKE = [255, 94, 91];

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * @param {number} size    output edge in pixels
 * @param {number} inset   artwork scale inside the frame (1 = full bleed)
 */
function render(size, inset) {
  const S = size;
  const buf = Buffer.alloc(S * S * 4);
  const SS = 4;             // 4x4 supersampling; cheap at these sizes
  const k = inset || 1;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let r = 0, g = 0, b = 0, a = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          // Normalised to [-1, 1], then divided by the inset so the artwork
          // shrinks inside the frame rather than the frame growing.
          const px = (((x + (sx + 0.5) / SS) / S) * 2 - 1) / k;
          const py = (((y + (sy + 0.5) / SS) / S) * 2 - 1) / k;

          // Coverage from a distance, in pixels, so edges stay one pixel wide
          // at every size instead of blurring as the icon grows.
          const px2px = (S * k) / 2;
          const cover = (d) => Math.min(1, Math.max(0, 0.5 - d * px2px));

          const badge = cover(sdRoundRect(px, py, 0, 0, 0.94, 0.94, 0.30));
          if (badge <= 0) continue;

          const dClone = sdPerson(px, py, 0.315, -0.06, 0.64);
          const dReal  = sdPerson(px, py, -0.265, 0.08, 0.74);

          // The front figure carries a badge-coloured halo, or where the two
          // overlap they fuse into one shape and the whole point -- that there
          // are two of you -- is lost.
          const halo  = cover(dReal + 0.060);
          const clone = cover(dClone);
          const real  = cover(dReal);

          // The strike runs over the impersonator only. Striking both would
          // read as "block people"; striking the copy is the actual claim.
          // It is drawn twice, a wider cut in the badge colour underneath, so
          // the accent reads as a gap through the figure rather than a stripe
          // painted across it.
          const ax = 0.315 - 0.44, ay = -0.06 + 0.44;
          const bx = 0.315 + 0.44, by = -0.06 - 0.44;
          const cut    = cover(sdSegment(px, py, ax, ay, bx, by, 0.115));
          const strike = cover(sdSegment(px, py, ax, ay, bx, by, 0.062));

          let c = BADGE;
          c = mix(c, CLONE, clone);
          c = mix(c, BADGE, cut);
          c = mix(c, STRIKE, strike);
          c = mix(c, BADGE, halo);
          c = mix(c, REAL, real);

          r += c[0] * badge; g += c[1] * badge; b += c[2] * badge;
          a += badge;
        }
      }

      const n = SS * SS;
      const i = (y * S + x) * 4;
      const alpha = a / n;
      // Un-premultiply, or the antialiased rim darkens towards black.
      buf[i]     = alpha > 0 ? Math.round(r / n / alpha) : 0;
      buf[i + 1] = alpha > 0 ? Math.round(g / n / alpha) : 0;
      buf[i + 2] = alpha > 0 ? Math.round(b / n / alpha) : 0;
      buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePNG(S, S, buf);
}

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const iconDir = path.join(root, 'icons');
  const storeDir = path.join(root, 'store');
  fs.mkdirSync(iconDir, { recursive: true });
  fs.mkdirSync(storeDir, { recursive: true });

  for (const size of [16, 32, 48, 128]) {
    const file = path.join(iconDir, `icon${size}.png`);
    fs.writeFileSync(file, render(size, 1));
    console.log('wrote', path.relative(root, file), fs.statSync(file).size, 'bytes');
  }

  // The store listing icon wants 96px of artwork centred in a 128px canvas,
  // so Chrome can add its own shadow and hover states without clipping ours.
  const store = path.join(storeDir, 'icon128.png');
  fs.writeFileSync(store, render(128, 96 / 128));
  console.log('wrote', path.relative(root, store), fs.statSync(store).size, 'bytes');
}

module.exports = { render, encodePNG };
