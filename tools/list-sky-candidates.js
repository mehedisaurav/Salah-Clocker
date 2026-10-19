/* Lists Commons sky-photo candidates per scene (title + license + size). */
"use strict";
const https = require("https");

const UA = "SalatClocker/1.0 (prayer-times extension; contact: local dev) node-fetch";

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

function search(query, limit) {
  const url =
    "https://commons.wikimedia.org/w/api.php?action=query&format=json" +
    "&generator=search&gsrsearch=" +
    encodeURIComponent(query + " filetype:bitmap") +
    "&gsrnamespace=6&gsrlimit=" +
    limit +
    "&prop=imageinfo&iiprop=url|extmetadata|size&iiurlwidth=1600";
  return getJson(url).then((json) => {
    const pages = (json.query && json.query.pages) || {};
    return Object.keys(pages)
      .map((k) => pages[k])
      .filter((p) => p.imageinfo && p.imageinfo.length && p.imageinfo[0].width >= 1200)
      .map((p) => {
        const ii = p.imageinfo[0];
        const m = ii.extmetadata || {};
        return {
          title: p.title.replace("File:", ""),
          license: (m.LicenseShortName && m.LicenseShortName.value) || "?",
          width: ii.width,
          commons: ii.descriptionurl && ii.descriptionurl.indexOf("commons.wikimedia.org") >= 0,
        };
      });
  });
}

const QUERIES = [
  ["fajr", "dawn twilight sky"],
  ["sunrise", "sunrise sky sun"],
  ["day", "blue sky cumulus clouds"],
  ["afternoon", "afternoon sky clouds"],
  ["maghrib", "sunset sky clouds"],
  ["night", "night sky moon stars"],
];

async function main() {
  for (const [key, q] of QUERIES) {
    const list = await search(q, 12);
    console.log("\n=== " + key + " (" + q + ") ===");
    list.slice(0, 10).forEach((c) =>
      console.log(
        (c.commons ? "[C] " : "[!] ") + c.license.padEnd(14) + " " + c.width + "px  " + c.title
      )
    );
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
