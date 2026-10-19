/* Settings + monthly cache. Uses chrome.storage.local in the extension,
   with an in-memory fallback so the logic is testable in Node.
   The location is a plain latitude/longitude pair, so it works anywhere. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SalatStorage = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const DEFAULTS = {
    lat: 23.8103,       // starting point (Dhaka) — the user sets their own
    lng: 90.4125,
    timeZone: "",       // IANA name resolved from the coordinates (e.g. "Europe/London")
    place: "",          // city name resolved from the coordinates (e.g. "London")
    placeAt: "",        // the lat,lng that `place` was resolved for
    method: 3,          // Aladhan method id (3 = MWL: Muslim World League)
    school: 1,          // 0 = Standard (Shafi) Asr, 1 = Hanafi Asr (later)
    apiKey: "",         // optional, for higher Aladhan rate limits
    enabled: { fajr: true, dhuhr: true, asr: true, maghrib: true, isha: true },
    volume: 0.9,
    snoozeMinutes: 5,
    leadMinutes: 0,     // notify this many minutes before the waqt
    // Azan delay, in minutes after the waqt, per delayable waqt. 0 = the azan
    // rings at the waqt itself. Fajr and Maghrib are always on the waqt.
    azanDelay: { dhuhr: 0, asr: 0, isha: 0 },
    hadithEnabled: true,                       // show a hadith during the azan
    hadithLang: "en",                          // en | bn
    bgColor: "#FAFAFA", // fallback surface colour
    makruhSunrise: 15,  // prohibited minutes after sunrise
    makruhZawal: 10,    // prohibited minutes before Dhuhr
    makruhSunset: 15,   // prohibited minutes before Maghrib
  };

  const backend =
    typeof chrome !== "undefined" && chrome.storage ? chrome.storage.local : null;
  const mem = {};

  function rawGet(keys) {
    if (backend) return new Promise((res) => backend.get(keys, res));
    if (typeof keys === "string") return Promise.resolve({ [keys]: mem[keys] });
    const out = {};
    for (const k of Object.keys(keys)) out[k] = k in mem ? mem[k] : keys[k];
    return Promise.resolve(out);
  }

  function rawSet(obj) {
    if (backend) return new Promise((res) => backend.set(obj, res));
    Object.assign(mem, obj);
    return Promise.resolve();
  }

  async function getSettings() {
    const stored = await rawGet(DEFAULTS);
    const settings = Object.assign({}, DEFAULTS, stored);
    settings.enabled = Object.assign({}, DEFAULTS.enabled, stored.enabled || {});
    settings.azanDelay = Object.assign({}, DEFAULTS.azanDelay, stored.azanDelay || {});
    return settings;
  }

  async function saveSettings(patch) {
    const next = Object.assign(await getSettings(), patch);
    await rawSet(next);
    return next;
  }

  function deviceTimeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch (e) {
      return "UTC";
    }
  }

  // Monthly cache keys look like "cal:23.8103,90.4125:3:1:2026-10"
  // (lat,lng : method : school : year-month — so a different location, method
  // or school never reuses another's month).
  function cacheKey(settings, date) {
    date = date || new Date();
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: settings.timeZone || deviceTimeZone(),
      year: "numeric", month: "2-digit",
    }).formatToParts(date);
    const p = {};
    for (const part of parts) p[part.type] = part.value;
    const at = Number(settings.lat).toFixed(4) + "," + Number(settings.lng).toFixed(4);
    return (
      "cal:" + at + ":" + settings.method + ":" + settings.school +
      ":" + p.year + "-" + p.month
    );
  }

  async function getCache(key) {
    const v = await rawGet({ [key]: null });
    return v[key];
  }

  async function setCache(key, value) {
    await rawSet({ [key]: value });
  }

  return { DEFAULTS, getSettings, saveSettings, getCache, setCache, cacheKey };
});
