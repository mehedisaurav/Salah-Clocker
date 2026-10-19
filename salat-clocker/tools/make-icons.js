/* Generates the extension's PNG icons: gold crescent on a night disc. */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

function makeIcon(size, file) {
  const bg = [26, 35, 126]; // night indigo
  const fg = [255, 213, 79]; // gold crescent
  const stride = size * 4 + 1; // filter byte + RGBA per pixel
  const raw = Buffer.alloc(stride * size);
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.42;
  // Crescent = outer disc minus an inner disc offset up-right.
  const ix = 0.3 * r;
  const iy = -0.2 * r;
  const ir = 0.92 * r;
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // PNG filter: none
    for (let x = 0; x < size; x++) {
      const dx = x - cx + 0.5;
      const dy = y - cy + 0.5;
      const d = Math.sqrt(dx * dx + dy * dy);
      const o = y * stride + 1 + x * 4;
      if (d > r) continue; // transparent outside the disc
      const d2 = Math.sqrt(Math.pow(dx - ix, 2) + Math.pow(dy - iy, 2));
      const moon = d2 >= ir;
      raw[o] = moon ? fg[0] : bg[0];
      raw[o + 1] = moon ? fg[1] : bg[1];
      raw[o + 2] = moon ? fg[2] : bg[2];
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);
  console.log("wrote " + file + " (" + size + "px)");
}

const rootDir = path.join(__dirname, "..");
makeIcon(16, path.join(rootDir, "assets", "icons", "icon-16.png"));
makeIcon(48, path.join(rootDir, "assets", "icons", "icon-48.png"));
makeIcon(128, path.join(rootDir, "assets", "icons", "icon-128.png"));
