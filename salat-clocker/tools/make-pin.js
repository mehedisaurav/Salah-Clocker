/* Generates a location pin icon (white silhouette) for the city label. */
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

function makePin(size, file) {
  const white = [255, 255, 255];
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  const u = size / 128;

  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x++) {
      const o = y * stride + 1 + x * 4;
      raw[o] = white[0];
      raw[o + 1] = white[1];
      raw[o + 2] = white[2];
      raw[o + 3] = 0;
    }
  }

  const put = (x, y) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    raw[y * stride + 1 + x * 4 + 3] = 255;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x / u - 64;
      const dy = y / u - 50;
      const inHead = dx * dx + dy * dy <= 30 * 30;
      // Triangle from the head down to the tip (64,116).
      const inTip =
        y / u >= 70 && dy <= 0
          ? false
          : y / u >= 70 && Math.abs(dx) <= (116 - y / u) * 0.92 && y / u <= 116;
      if (inHead || inTip) put(x, y);
    }
  }
  // Punch the hole.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x / u - 64;
      const dy = y / u - 50;
      if (dx * dx + dy * dy <= 12 * 12) {
        raw[y * stride + 1 + x * 4 + 3] = 0;
      }
    }
  }

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

makePin(64, path.join(__dirname, "..", "assets", "icons", "pin-64.png"));
