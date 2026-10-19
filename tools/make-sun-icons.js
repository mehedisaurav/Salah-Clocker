/* Generates sunrise and sunset panel icons (warm sun over a horizon). */
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

function makeIcon(size, file, draw) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  const warm = [255, 183, 77];
  const u = size / 128;

  const put = (x, y, on) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const o = y * stride + 1 + x * 4;
    raw[o] = warm[0];
    raw[o + 1] = warm[1];
    raw[o + 2] = warm[2];
    raw[o + 3] = on ? 255 : 0;
  };

  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x++) put(x, y, false);
  }

  const fillCircle = (ccx, ccy, r) => {
    for (let y = Math.round((ccy - r) * u); y < Math.round((ccy + r) * u); y++)
      for (let x = Math.round((ccx - r) * u); x < Math.round((ccx + r) * u); x++) {
        const dx = x / u - ccx, dy = y / u - ccy;
        if (dx * dx + dy * dy <= r * r) put(x, y, true);
      }
  };
  const fillRect = (x0, y0, x1, y1) => {
    for (let y = Math.round(y0 * u); y < Math.round(y1 * u); y++)
      for (let x = Math.round(x0 * u); x < Math.round(x1 * u); x++) put(x, y, true);
  };
  // Chevron pointing up or down.
  const chevron = (ccx, ccy, sizePx, dir) => {
    const half = sizePx;
    for (let i = -half; i <= half; i++) {
      const t = (half - Math.abs(i)) / half;
      const yTop = ccy - dir * t * sizePx;
      fillRect(ccx + i, yTop - 2, ccx + i + 1, yTop + 2);
    }
  };

  draw({ fillCircle, fillRect, chevron });
  // Horizon line (both icons).
  fillRect(20, 98, 108, 101);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
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
const dir = path.join(rootDir, "assets", "icons");

// Sunrise: sun rising above the horizon, up arrow.
makeIcon(64, path.join(dir, "sunrise-64.png"), ({ fillCircle, fillRect, chevron }) => {
  fillCircle(64, 78, 20);
  fillRect(44, 40, 46, 58); // ray left
  fillRect(64, 40, 66, 58); // ray center
  fillRect(82, 40, 84, 58); // ray right
  chevron(64, 24, 9, 1);
});

// Sunset: sun dipping toward the horizon, down arrow.
makeIcon(64, path.join(dir, "sunset-64.png"), ({ fillCircle, fillRect, chevron }) => {
  fillCircle(64, 60, 20);
  fillRect(44, 68, 46, 78); // ray left
  fillRect(82, 68, 84, 78); // ray right
  chevron(64, 116, 9, -1);
});
