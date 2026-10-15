const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { validateUf2 } = require('../desktop/firmware-install.cjs');
const root = path.resolve(__dirname, '..');
const desktop = path.join(root, 'desktop');
const renderer = path.join(desktop, 'renderer');
const firmware = path.resolve(root, process.env.DRIFTPAD_FIRMWARE || 'firmware/.pio/build/pico/firmware.uf2');
const uf2 = fs.readFileSync(firmware);
validateUf2(uf2);
fs.accessSync(path.join(root, 'dist', 'index.html'));
// Delete only this script's generated renderer directory, never source or user data.
fs.rmSync(renderer, { recursive: true, force: true });
fs.cpSync(path.join(root, 'dist'), renderer, { recursive: true });
fs.copyFileSync(firmware, path.join(renderer, 'driftpad.uf2'));
const html = path.join(renderer, 'index.html');
// The installed app uses local system fonts and makes no Google Fonts requests.
fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace(/<link\b[^>]*https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, ''));

// Generate a deterministic DP icon with no image tools or network dependencies.
const size = 256;
const rows = Buffer.alloc((size * 4 + 1) * size);
const glyphs = ['11110','10001','10001','10001','10001','10001','11110',
                '11110','10001','10001','11110','10000','10000','10000'];
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const i = y * (size * 4 + 1) + 1 + x * 4;
    const cx = Math.max(32 - x, 0, x - 223);
    const cy = Math.max(32 - y, 0, y - 223);
    const visible = cx * cx + cy * cy <= 32 * 32;
    let color = [21, 54, 65];
    const gy = Math.floor((y - 72) / 16);
    for (let letter = 0; letter < 2; letter++) {
      const gx = Math.floor((x - (40 + letter * 96)) / 16);
      if (gy >= 0 && gy < 7 && gx >= 0 && gx < 5 && glyphs[letter * 7 + gy][gx] === '1') color = [255, 255, 255];
    }
    if ((x - 216) ** 2 + (y - 40) ** 2 < 14 ** 2) color = [200, 100, 67];
    rows.set([...color, visible ? 255 : 0], i);
  }
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, body) {
  const data = Buffer.concat([Buffer.from(type), body]);
  const length = Buffer.alloc(4); length.writeUInt32BE(body.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(data));
  return Buffer.concat([length, data, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4);
ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
fs.mkdirSync(path.join(desktop, 'assets'), { recursive: true });
fs.writeFileSync(path.join(desktop, 'assets', 'icon.png'), png);
fs.writeFileSync(path.join(desktop, 'assets', 'icon.ico'), Buffer.concat([ico, png]));
console.log('Prepared offline desktop app and real RP2040 firmware.');
