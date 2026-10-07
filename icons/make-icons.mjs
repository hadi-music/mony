// Draws the MONY mark (a donut split 40/10/15/35, savings slice in green) to PNG. Run: node icons/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
const BG = [13, 13, 12], PAPER = [243, 243, 240], GREEN = [212, 255, 0]; // ink, paper, lime
const SPLIT = [40, 10, 15, 35], COLORS = [PAPER, PAPER, PAPER, GREEN];
const GAP = 0.024; // gap width as a share of icon size; constant width keeps each gap's edges parallel
const R_OUT = 0.34, R_IN = 0.19;
const slices = () => { const out = []; let a = 0; for (const p of SPLIT) { out.push([a, a + p / 100 * Math.PI * 2]); a += p / 100 * Math.PI * 2; } return out; };
function draw(size) {
  const px = Buffer.alloc(size * size * 3), c = size / 2, R = size * R_OUT, r = size * R_IN, SS = 4, half = GAP * size / 2;
  const bounds = slices();
  const cuts = bounds.map(([s]) => [Math.sin(s), -Math.cos(s)]); // unit vector along each slice boundary
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let acc = [0, 0, 0];
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const dx = x + (sx + .5) / SS - c, dy = y + (sy + .5) / SS - c, d = Math.hypot(dx, dy);
      let col = BG;
      if (d <= R && d >= r) {
        let t = Math.atan2(dx, -dy); if (t < 0) t += Math.PI * 2;
        bounds.forEach(([s, e], i) => { if (t >= s && t < e) col = COLORS[i]; });
        for (const [ux, uy] of cuts) if (dx * ux + dy * uy > 0 && Math.abs(dx * uy - dy * ux) < half) col = BG;
      }
      acc[0] += col[0]; acc[1] += col[1]; acc[2] += col[2];
    }
    const o = (y * size + x) * 3; for (let k = 0; k < 3; k++) px[o + k] = Math.round(acc[k] / (SS * SS));
  }
  return png(size, px);
}
function svg() {
  const size = 512, c = 256, R = size * R_OUT, r = size * R_IN;
  const pt = (rad, t) => [(c + rad * Math.sin(t)).toFixed(2), (c - rad * Math.cos(t)).toFixed(2)];
  const hex = rgb => '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
  let paths = '', cuts = '';
  slices().forEach(([s, e], i) => {
    const L = e - s > Math.PI ? 1 : 0;
    const [x1, y1] = pt(R, s), [x2, y2] = pt(R, e), [x3, y3] = pt(r, e), [x4, y4] = pt(r, s);
    paths += `<path fill="${hex(COLORS[i])}" d="M${x1} ${y1}A${R} ${R} 0 ${L} 1 ${x2} ${y2}L${x3} ${y3}A${r} ${r} 0 ${L} 0 ${x4} ${y4}Z"/>`;
    const [a1, b1] = pt(r - 2, s), [a2, b2] = pt(R + 2, s);
    cuts += `<line x1="${a1}" y1="${b1}" x2="${a2}" y2="${b2}"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="${hex(BG)}"/>${paths}<g stroke="${hex(BG)}" stroke-width="${(GAP * size).toFixed(2)}">${cuts}</g></svg>`;
}
function crc32(buf) { let c, t = crc32.t || (crc32.t = Array.from({ length: 256 }, (_, n) => { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; }));
  let x = 0xffffffff; for (const b of buf) x = t[(x ^ b) & 255] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png(size, px) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) { raw[y * (size * 3 + 1)] = 0; px.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const dir = new URL('.', import.meta.url);
for (const [n, s] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) writeFileSync(new URL(n, dir), draw(s));
writeFileSync(new URL('icon.svg', dir), svg());
console.log('icons written');
