/* Daily hadith: fetch one authentic hadith per day from ummahapi.com
   (Arabic + English + reference), add the Bangla translation from the
   jsDelivr hadith editions (same numbering), and keep a 15-day no-repeat
   history. Runs in the service worker, so no DOM is assumed. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SalatHadith = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  // One random authentic hadith (Arabic + English + grade) per call.
  const SOURCE_URL = "https://ummahapi.com/api/hadith/random";
  const NO_REPEAT_DAYS = 15;

  // Translation shown alongside the Arabic (which is always shown too).
  const LANGUAGES = [
    { id: "en", name: "English" },
    { id: "bn", name: "বাংলা — Bangla" },
  ];

  // Collections sunnah.com can serve, used only to make the reference a link.
  const LINKABLE = [
    "bukhari", "muslim", "abudawud", "tirmidhi",
    "nasai", "ibnmajah", "malik", "nawawi",
  ];

  /* ---------- ummahapi response ---------- */

  function parseUmmahJson(json) {
    const d = json && json.data;
    if (!d || !d.hadithnumber) return null;
    const collection = String(d.collection || "");
    const number = Number(d.hadithnumber);
    const name = d.collection_name || collection;
    return {
      id: String(d.id || collection + "-" + number),
      collection: collection,
      collectionName: name,
      number: number,
      arabic: String(d.arabic || "").trim(),
      english: String(d.english || "").trim(),
      grade: d.grade ? String(d.grade) : "",
      reference: name + " " + number,
      url: LINKABLE.indexOf(collection) >= 0
        ? "https://sunnah.com/" + collection + ":" + number
        : "",
    };
  }

  /* ---------- Bangla editions (numbering matches ummahapi) ---------- */

  const API_BASE = "https://cdn.jsdelivr.net/gh/fawazahmed0/hadith-api@1/editions/";
  const LANG_EDITION = { bn: "ben" };

  function apiEditionUrl(lang, collection, number) {
    const code = LANG_EDITION[lang];
    if (!code || !collection || !number) return null;
    return API_BASE + code + "-" + collection + "/" + number + ".min.json";
  }

  function parseApiJson(json) {
    try {
      const h = json && json.hadiths && json.hadiths[0];
      return h ? String(h.text || "").trim() : "";
    } catch (e) {
      return "";
    }
  }

  // The text to show for a chosen language; Bangla falls back to English.
  function translationFor(hadith, lang) {
    if (!hadith) return "";
    if (lang === "bn") return hadith.bangla || hadith.english || "";
    return hadith.english || "";
  }

  // Grades that should not be presented as the daily hadith. An unknown
  // (empty) grade is accepted — only clearly weak/fabricated ones are rejected.
  const WEAK_GRADE = /(da'?if|weak|mawdu|maudu|batil|munkar|fabricat|no\s*basis)/i;

  function isAcceptableGrade(grade) {
    if (!grade) return true;
    return !WEAK_GRADE.test(String(grade));
  }

  /* ---------- 15-day no-repeat history ---------- */

  // Drop shown-hadith entries older than NO_REPEAT_DAYS (values are epoch ms).
  function pruneHistory(history, now, days) {
    now = now == null ? Date.now() : now;
    days = days || NO_REPEAT_DAYS;
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const out = {};
    for (const k of Object.keys(history || {})) {
      if (Number(history[k]) >= cutoff) out[k] = history[k];
    }
    return out;
  }

  /* ---------- offline fallback ---------- */
  // Shown only if the source is unreachable and nothing was cached yet.
  const FALLBACK = {
    id: "bukhari-1",
    collection: "bukhari",
    collectionName: "Sahih al-Bukhari",
    number: 1,
    reference: "Sahih al-Bukhari 1",
    grade: "Sahih",
    url: "https://sunnah.com/bukhari:1",
    arabic:
      "إِنَّمَا الأَعْمَالُ بِالنِّيَّاتِ، وَإِنَّمَا لِكُلِّ امْرِئٍ مَا نَوَى، فَمَنْ كَانَتْ هِجْرَتُهُ إِلَى دُنْيَا يُصِيبُهَا أَوْ إِلَى امْرَأَةٍ يَنْكِحُهَا فَهِجْرَتُهُ إِلَى مَا هَاجَرَ إِلَيْهِ",
    english:
      "Narrated 'Umar bin Al-Khattab: I heard Allah's Messenger (ﷺ) saying, \"The reward of deeds depends upon the intentions and every person will get the reward according to what he has intended. So whoever emigrated for worldly benefits or for a woman to marry, his emigration was for what he emigrated for.\"",
  };

  return {
    SOURCE_URL,
    NO_REPEAT_DAYS,
    LANGUAGES,
    parseUmmahJson,
    apiEditionUrl,
    parseApiJson,
    translationFor,
    isAcceptableGrade,
    pruneHistory,
    FALLBACK,
  };
});
