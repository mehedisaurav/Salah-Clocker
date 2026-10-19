/* Hadith unit tests: parse an ummahapi.com response, build the Bangla edition
   URL, choose the display language, and enforce the 15-day no-repeat window.
   Live checks run only if the network is reachable. */
"use strict";
const assert = require("assert");
const https = require("https");

const SalatHadith = require("../lib/hadith.js");

// A real ummahapi /api/hadith/random response.
const SAMPLE = {
  success: true,
  service: "hadith-random",
  data: {
    id: "muslim-5587",
    collection: "muslim",
    collection_name: "Sahih Muslim",
    hadithnumber: 5587,
    arabic: "حَدَّثَنِي إِبْرَاهِيمُ بْنُ زِيَادٍ ... إِنَّ أَحَبَّ أَسْمَائِكُمْ إِلَى اللَّهِ عَبْدُ اللَّهِ وَعَبْدُ الرَّحْمَنِ",
    english:
      "Ibn Umar reported that Allah's Messenger (ﷺ) said: The names dearest to Allah are 'Abdullah and 'Abd al-Rahman",
    grade: "Sahih",
  },
  timestamp: "2026-10-17T07:22:44.019Z",
};

function run() {
  // --- ummahapi parsing ---
  const h = SalatHadith.parseUmmahJson(SAMPLE);
  assert.strictEqual(h.id, "muslim-5587", "id");
  assert.strictEqual(h.collection, "muslim");
  assert.strictEqual(h.collectionName, "Sahih Muslim");
  assert.strictEqual(h.number, 5587);
  assert.strictEqual(h.reference, "Sahih Muslim 5587", "reference = collection + number");
  assert.strictEqual(h.url, "https://sunnah.com/muslim:5587", "linkable collection gets a link");
  assert.ok(h.english.indexOf("'Abdullah") > 0, "english text");
  assert.ok(/[\u0600-\u06FF]/.test(h.arabic), "arabic text is Arabic script");
  assert.strictEqual(h.grade, "Sahih", "grade carried through");

  // A collection sunnah.com cannot serve should not get a link.
  const qudsi = SalatHadith.parseUmmahJson({
    data: {
      id: "qudsi-25", collection: "qudsi", collection_name: "Hadith Qudsi",
      hadithnumber: 25, arabic: "ن", english: "x", grade: null,
    },
  });
  assert.strictEqual(qudsi.url, "", "non-linkable collection has no url");
  assert.strictEqual(qudsi.grade, "");

  // Defensive: malformed bodies return null, not a throw.
  assert.strictEqual(SalatHadith.parseUmmahJson(null), null);
  assert.strictEqual(SalatHadith.parseUmmahJson({ success: false }), null);
  assert.strictEqual(SalatHadith.parseUmmahJson({ data: {} }), null);

  // --- languages ---
  assert.deepStrictEqual(
    SalatHadith.LANGUAGES.map((l) => l.id),
    ["en", "bn"],
    "only English and Bangla are offered"
  );

  const sample = { arabic: "AR", english: "EN", bangla: "BN" };
  assert.strictEqual(SalatHadith.translationFor(sample, "en"), "EN");
  assert.strictEqual(SalatHadith.translationFor(sample, "bn"), "BN");
  assert.strictEqual(
    SalatHadith.translationFor({ arabic: "AR", english: "EN" }, "bn"),
    "EN",
    "missing Bangla falls back to English"
  );

  // --- Bangla edition URL + parse (numbering matches ummahapi) ---
  assert.strictEqual(
    SalatHadith.apiEditionUrl("bn", "muslim", 5587),
    "https://cdn.jsdelivr.net/gh/fawazahmed0/hadith-api@1/editions/ben-muslim/5587.min.json"
  );
  assert.strictEqual(SalatHadith.apiEditionUrl("xx", "muslim", 1), null, "unknown language");
  assert.strictEqual(SalatHadith.parseApiJson({ hadiths: [{ text: "  hi  " }] }), "hi");
  assert.strictEqual(SalatHadith.parseApiJson(null), "", "bad API body is safe");

  // --- weak-grade filter ---
  assert.ok(SalatHadith.isAcceptableGrade("Sahih"), "Sahih accepted");
  assert.ok(SalatHadith.isAcceptableGrade("Hasan"), "Hasan accepted");
  assert.ok(SalatHadith.isAcceptableGrade(""), "unknown grade accepted");
  assert.ok(SalatHadith.isAcceptableGrade(null), "missing grade accepted");
  assert.ok(!SalatHadith.isAcceptableGrade("Daif"), "Daif rejected");
  assert.ok(!SalatHadith.isAcceptableGrade("Da'if"), "Da'if rejected");
  assert.ok(!SalatHadith.isAcceptableGrade("Mawdu"), "Mawdu (fabricated) rejected");

  // --- 15-day no-repeat window ---
  const now = Date.now();
  const old = now - 20 * 24 * 60 * 60 * 1000;
  const pruned = SalatHadith.pruneHistory({ keep: now, drop: old }, now, 15);
  assert.ok(pruned.keep, "recent history kept");
  assert.ok(!pruned.drop, "history older than 15 days dropped");

  // --- fallback is complete ---
  assert.ok(SalatHadith.FALLBACK.arabic && SalatHadith.FALLBACK.english);
  assert.ok(SalatHadith.FALLBACK.reference && SalatHadith.FALLBACK.id);

  console.log("Hadith unit tests passed.");
}

function getText(url) {
  return new Promise((resolve) => {
    https
      .get(url, { headers: { "User-Agent": "SalatClocker/1.0" } }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode, body: b }));
      })
      .on("error", () => resolve({ status: 0, body: "" }));
  });
}

async function liveCheck() {
  // 1. The configured source.
  const src = await getText(SalatHadith.SOURCE_URL);
  if (src.status === 200) {
    const h = SalatHadith.parseUmmahJson(JSON.parse(src.body));
    assert.ok(h && h.english.length > 10, "live ummahapi parsed to english text");
    assert.ok(/[\u0600-\u06FF]/.test(h.arabic), "live ummahapi arabic text");
    console.log("Live ummahapi check passed:", JSON.stringify({
      id: h.id, reference: h.reference, grade: h.grade,
      arabicChars: h.arabic.length, englishChars: h.english.length,
    }));
  } else {
    console.log("Live ummahapi check skipped (HTTP " + src.status + ").");
  }

  // 2. Bangla translation for the same hadith (matching numbering).
  const api = await getText(SalatHadith.apiEditionUrl("bn", "muslim", 5587));
  if (api.status === 200) {
    const text = SalatHadith.parseApiJson(JSON.parse(api.body));
    assert.ok(text.length > 20, "live bangla text fetched");
    assert.ok(/[\u0980-\u09FF]/.test(text), "live bangla text is Bengali script");
    console.log("Live Bangla check passed:", JSON.stringify({
      chars: text.length, sample: [...text.slice(0, 12)].join(""),
    }));
  } else {
    console.log("Live Bangla check skipped (HTTP " + api.status + ").");
  }
}

try {
  run();
} catch (e) {
  console.error("Hadith test FAILED:", e);
  process.exit(1);
}

liveCheck()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Hadith live check FAILED:", e);
    process.exit(1);
  });
