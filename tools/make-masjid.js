/* Generates masjid icons (gold silhouette on transparent) for the azan alarm. */
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

function makeMasjid(size, file) {
  const gold = [255, 213, 79];
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  const cx = size / 2;
  const u = size / 128; // design units

  const put = (x, y, on) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const o = y * stride + 1 + x * 4;
    raw[o] = gold[0];
    raw[o + 1] = gold[1];
    raw[o + 2] = gold[2];
    raw[o + 3] = on ? 255 : 0;
  };

  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      put(x, y, false); // start transparent everywhere
    }
  }

  const fillRect = (x0, y0, x1, y1) => {
    for (let y = Math.round(y0 * u); y < Math.round(y1 * u); y++)
      for (let x = Math.round(x0 * u); x < Math.round(x1 * u); x++) put(x, y, true);
  };
  const fillCircle = (ccx, ccy, r) => {
    for (let y = Math.round((ccy - r) * u); y < Math.round((ccy + r) * u); y++)
      for (let x = Math.round((ccx - r) * u); x < Math.round((ccx + r) * u); x++) {
        const dx = (x / u - ccx), dy = (y / u - ccy);
        if (dx * dx + dy * dy <= r * r) put(x, y, true);
      }
  };
  // Semicircle (upper half) for the dome.
  const fillDome = (ccx, ccy, r, top) => {
    for (let y = Math.round(top * u); y < Math.round((ccy + r) * u); y++)
      for (let x = Math.round((ccx - r) * u); x < Math.round((ccx + r) * u); x++) {
        const dx = x / u - ccx, dy = y / u - ccy;
        if (dx * dx + dy * dy <= r * r && dy <= r) put(x, y, true);
      }
  };
  // Crescent via circle minus offset circle.
  const fillCrescent = (ccx, ccy, r) => {
    const ix = 0.38 * r, iy = 0, ir = 0.9 * r;
    for (let y = Math.round((ccy - r) * u); y < Math.round((ccy + r) * u); y++)
      for (let x = Math.round((ccx - r) * u); x < Math.round((ccx + r) * u); x++) {
        const dx = x / u - ccx, dy = y / u - ccy;
        const d2 = Math.hypot(dx - ix, dy - iy);
        if (dx * dx + dy * dy <= r * r && d2 >= ir) put(x, y, true);
      }
  };

  // Design (128x128 canvas):
  fillRect(52, 66, 76, 104);       // main hall
  fillDome(64, 66, 13, 50);        // central dome
  fillCrescent(64, 47, 4);         // crescent on the dome
  fillRect(20, 60, 30, 104);       // left minaret
  fillRect(98, 60, 108, 104);      // right minaret
  fillCircle(25, 56, 4);           // minaret caps
  fillCircle(103, 56, 4);
  fillRect(0, 104, 128, 116);      // ground
  // Arched doorway (cut out).
  for (let y = Math.round(88 * u); y < Math.round(104 * u); y++)
    for (let x = Math.round(59 * u); x < Math.round(69 * u); x++) {
      const dx = x / u - 64, dy = y / u - 104;
      const inDoor = y / u < 96 ? true : (dx * dx + (y / u - 96) * (y / u - 96) <= 25);
      if (inDoor) put(x, y, false);
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

const rootDir = path.join(__dirname, "..");
makeMasjid(64, path.join(rootDir, "assets", "icons", "masjid-64.png"));
makeMasjid(128, path.join(rootDir, "assets", "icons", "masjid-128.png"));
