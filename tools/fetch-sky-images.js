/* Downloads natural sky photos from Wikimedia Commons (permissive licenses).
   Run: node tools/fetch-sky-images.js  → writes assets/sky/<scene>.jpg + CREDITS.md */
"use strict";
const fs = require("fs");
const path = require("path");
const https = require("https");

const OUT_DIR = path.join(__dirname, "..", "assets", "sky");

const SCENES = [
  { key: "fajr", query: "dawn twilight sky horizon" },
  { key: "sunrise", query: "morning sun sky landscape" },
  { key: "day", query: "blue sky white clouds" },
  { key: "afternoon", query: "afternoon sky clouds landscape" },
  { key: "maghrib", query: "sunset sky clouds" },
  { key: "night", query: "full moon night sky stars" },
];

const PREFERRED = [/^public domain/i, /^cc0/i, /^cc by/i];
const WIDTH = 1600;

// Content blacklist: sky scenes must not show buildings or other religions'
// places of worship, statues, monks, etc.
const BLACKLIST = [
  "temple", " wat ", "wat ", "vihara", "church", "cathedral", "pagoda",
  "stupa", "monastery", "monk", "buddha", "buddhist", "mosque", "statue",
  "monument", "synagogue", "shrine", "tower", "bridge", "building",
  "cityscape", "skyline", "flag", "crowd", "festival",
];
const UA =
  "SalatClocker/1.0 (prayer-times extension; contact: local dev) node-fetch";

function getJson(url) {
  return download(url).then((buf) => JSON.parse(buf.toString("utf8")));
}

function download(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": UA, Accept: "*/*" } }, (res) => {
        if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location) {
          return resolve(download(new URL(res.headers.location, url).toString()));
        }
        if (res.statusCode !== 200) return reject(new Error("HTTP " + res.statusCode + " for " + url));
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });
}

function licenseOf(info) {
  const m = info.extmetadata || {};
  return (m.LicenseShortName && m.LicenseShortName.value) || "";
}

function search(query, limit) {
  const url =
    "https://commons.wikimedia.org/w/api.php?action=query&format=json" +
    "&generator=search&gsrsearch=" +
    encodeURIComponent(query + " filetype:bitmap") +
    "&gsrnamespace=6&gsrlimit=" +
    limit +
    "&prop=imageinfo&iiprop=url|extmetadata|size&iiurlwidth=" +
    WIDTH;
  return getJson(url).then((json) => {
    const pages = (json.query && json.query.pages) || {};
    return Object.keys(pages)
      .map((k) => pages[k])
      .filter((p) => p.imageinfo && p.imageinfo.length)
      .map((p) => p.imageinfo[0])
      .filter((ii) => ii.width >= 1200);
  });
}

function pick(infoList) {
  const clean = infoList.filter((ii) => !isBlacklisted(ii));
  for (const re of PREFERRED) {
    const found = clean.find((ii) => re.test(licenseOf(ii)));
    if (found) return found;
  }
  return clean[0] || null; // prefer a clean candidate over a tainted one
}

function isBlacklisted(info) {
  const meta = info.extmetadata || {};
  const title = ((meta.ObjectName && meta.ObjectName.value) || "") + " " +
    ((meta.ImageDescription && meta.ImageDescription.value) || "");
  const text = title.toLowerCase();
  return BLACKLIST.some((bad) => text.indexOf(bad) !== -1);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const credits = [];
  let failed = 0;

  for (const scene of SCENES) {
    let chosen = null;
    for (const limit of [5, 10]) {
      const list = await search(scene.query, limit);
      chosen = pick(list);
      if (chosen) break;
    }
    if (!chosen) {
      console.log("SKIP  " + scene.key + " (no suitable image)");
      failed++;
      continue;
    }
    const file = path.join(OUT_DIR, scene.key + ".jpg");
    const data = await download(chosen.thumburl || chosen.url);
    if (data.length < 20000) {
      console.log("SKIP  " + scene.key + " (image too small: " + data.length + " bytes)");
      failed++;
      continue;
    }
    fs.writeFileSync(file, data);
    const lic = licenseOf(chosen);
    const artist = (chosen.extmetadata.Artist && chosen.extmetadata.Artist.value || "").replace(/<[^>]*>/g, "") || "unknown";
    credits.push({
      scene: scene.key,
      license: lic,
      artist: artist,
      page: chosen.descriptionurl,
    });
    console.log(
      "OK    " + scene.key + ".jpg (" + Math.round(data.length / 1024) + " KB) — " + lic
    );
  }

  if (credits.length) {
    fs.writeFileSync(
      path.join(OUT_DIR, "CREDITS.md"),
      "# Photo credits (Wikimedia Commons)\n\n" +
        credits
          .map(
            (c) =>
              "- **" + c.scene + ".jpg** — " + c.artist + " · " + c.license + " · " + c.page
          )
          .join("\n") +
        "\n"
    );
  }
  console.log(failed ? "done with " + failed + " missing scene(s) (CSS gradient fallback applies)" : "done");
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
