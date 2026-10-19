/* Downloads specific Commons files by title into assets/sky/. */
"use strict";
const fs = require("fs");
const path = require("path");
const https = require("https");

const UA = "SalatClocker/1.0 (prayer-times extension; contact: local dev) node-fetch";
const OUT_DIR = path.join(__dirname, "..", "assets", "sky");
const WIDTH = 1600;

const PICKS = [
  { scene: "fajr", file: "Dawn Sky (2).jpg" },
  { scene: "day", file: "White Cumulus Clouds against Blue Sky.jpg" },
];

function getJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": UA } }, (res) => {
        if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location) {
          return resolve(getJson(new URL(res.headers.location, url).toString()));
        }
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(JSON.parse(body)));
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
        if (res.statusCode !== 200) return reject(new Error("HTTP " + res.statusCode));
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });
}

async function main() {
  for (const pick of PICKS) {
    const url =
      "https://commons.wikimedia.org/w/api.php?action=query&format=json" +
      "&titles=" + encodeURIComponent("File:" + pick.file) +
      "&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=" + WIDTH;
    const json = await getJson(url);
    const pages = json.query.pages;
    const page = pages[Object.keys(pages)[0]];
    if (!page.imageinfo) throw new Error("not found: " + pick.file);
    const ii = page.imageinfo[0];
    if (ii.descriptionurl.indexOf("commons.wikimedia.org") < 0)
      throw new Error("not a Commons file: " + pick.file);
    const data = await download(ii.thumburl || ii.url);
    const out = path.join(OUT_DIR, pick.scene + ".jpg");
    fs.writeFileSync(out, data);
    const m = ii.extmetadata || {};
    const lic = (m.LicenseShortName && m.LicenseShortName.value) || "?";
    const artist = ((m.Artist && m.Artist.value) || "unknown").replace(/<[^>]*>/g, "");
    console.log(
      "OK  " + pick.scene + ".jpg <- " + pick.file + "  [" + lic + ", " +
      Math.round(data.length / 1024) + " KB]"
    );
    // keep credits in sync
    const creditsPath = path.join(OUT_DIR, "CREDITS.md");
    let credits = fs.existsSync(creditsPath) ? fs.readFileSync(creditsPath, "utf8") : "# Photo credits (Wikimedia Commons)\n";
    const entry =
      "- **" + pick.scene + ".jpg** — " + artist + " · " + lic + " · " + ii.descriptionurl;
    const line = new RegExp("- \\*\\*" + pick.scene + "\\.jpg\\*\\*.*", "g");
    if (line.test(credits)) credits = credits.replace(line, entry);
    else credits = credits.trimEnd() + "\n" + entry + "\n";
    fs.writeFileSync(creditsPath, credits);
  }
  console.log("done");
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
