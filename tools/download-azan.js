/* Downloads one Commons audio file into assets/audio/Azan-Madina.mp3. */
"use strict";
const fs = require("fs");
const path = require("path");
const https = require("https");

const UA = "SalatClocker/1.0 (prayer-times extension; contact: local dev) node-fetch";
const FILE = "The Adhan - Muslim Call to Prayer - Aaqib Azeez.mp3";
const OUT = path.join(__dirname, "..", "assets", "audio", "Azan-Madina.mp3");

function getJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": UA } }, (res) => {
        if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location) {
          return resolve(getJson(new URL(res.headers.location, url).toString()));
        }
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve(JSON.parse(b)));
      })
      .on("error", reject);
  });
}

function download(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": UA } }, (res) => {
        if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location) {
          return resolve(download(new URL(res.headers.location, url).toString()));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });
}

async function main() {
  const url =
    "https://commons.wikimedia.org/w/api.php?action=query&format=json" +
    "&titles=" + encodeURIComponent("File:" + FILE) +
    "&prop=imageinfo&iiprop=url|extmetadata|size";
  const json = await getJson(url);
  const pages = json.query.pages;
  const page = pages[Object.keys(pages)[0]];
  const ii = page.imageinfo[0];
  const data = await download(ii.url);
  if (data.length < 50000) throw new Error("suspiciously small download: " + data.length);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, data);
  const m = ii.extmetadata || {};
  const lic = (m.LicenseShortName && m.LicenseShortName.value) || "?";
  console.log(
    "downloaded Azan-Madina.mp3 (" + (data.length / 1024).toFixed(0) + " KB, " +
      lic + ") from " + ii.descriptionurl
  );
  // credit line
  const creditPath = path.join(path.dirname(OUT), "CREDITS.md");
  const line =
    "- **Azan-Madina.mp3** — " + ((m.Artist && m.Artist.value) || "Aaqib Azeez").replace(/<[^>]*>/g, "") +
    " · " + lic + " · " + ii.descriptionurl;
  fs.writeFileSync(creditPath, "# Asset credits\n\n" + line + "\n");
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
