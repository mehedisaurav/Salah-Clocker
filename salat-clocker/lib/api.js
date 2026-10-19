/* Aladhan API client: one month of timings for any lat/lng on earth, plus
   location resolution (IANA timezone + a human city name) so the clock can run
   in the local time of wherever the user actually is. */
(function (root, factory) {
  let times, storage;
  if (typeof module === "object" && module.exports) {
    times = require("./times.js");
    storage = require("./storage.js");
  } else {
    times = root.SalatTimes;
    storage = root.SalatStorage;
  }
  const api = factory(times, storage);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SalatApi = api;
})(typeof self !== "undefined" ? self : globalThis, function (times, storage) {
  "use strict";

  const BASE = "https://api.aladhan.com/v1";
  const GEO_BASE = "https://api.bigdatacloud.net/data/reverse-geocode-client";

  // Aladhan calculation methods, in the order a global audience expects to
  // find them — the default (MWL) first, then the big regional bodies.
  const METHOD_LIST = [
    { id: 3, label: "Muslim World League" },
    { id: 2, label: "ISNA — North America" },
    { id: 1, label: "Univ. of Islamic Sciences, Karachi" },
    { id: 4, label: "Umm al-Qura, Makkah" },
    { id: 5, label: "Egyptian General Authority" },
    { id: 8, label: "Gulf Region" },
    { id: 9, label: "Kuwait" },
    { id: 10, label: "Qatar" },
    { id: 16, label: "Dubai (unofficial)" },
    { id: 11, label: "MUIS — Singapore" },
    { id: 17, label: "JAKIM — Malaysia" },
    { id: 20, label: "KEMENAG — Indonesia" },
    { id: 13, label: "Diyanet — Turkey" },
    { id: 21, label: "Morocco" },
    { id: 19, label: "Algeria" },
    { id: 18, label: "Tunisia" },
    { id: 23, label: "Ministry of Awqaf — Jordan" },
    { id: 14, label: "SAM — Russia" },
    { id: 12, label: "UOIF — France" },
    { id: 22, label: "Comunidade Islâmica de Lisboa" },
    { id: 15, label: "Moonsighting Committee" },
    { id: 7, label: "Univ. of Tehran (Shia)" },
    { id: 0, label: "Shia Ithna-Ashari, Leva Institute" },
  ];

  // id -> label, for lookups.
  const METHODS = {};
  METHOD_LIST.forEach((m) => {
    METHODS[m.id] = m.label;
  });

  function coords(settings) {
    return { lat: Number(settings.lat), lng: Number(settings.lng) };
  }

  // Identifies a coordinate pair as a settings string, used to decide whether a
  // resolved place name still belongs to the current location.
  function coordsKey(lat, lng) {
    return Number(lat).toFixed(4) + "," + Number(lng).toFixed(4);
  }

  // Every network call gets a hard timeout: a hung host must never wedge a
  // caller (the service worker, the popup) — fetch has no timeout of its own.
  const TIMEOUT_MS = 12000;

  async function fetchJson(url, ms) {
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = setTimeout(() => {
      if (ctrl) ctrl.abort();
    }, ms || TIMEOUT_MS);
    try {
      const res = await fetch(url, ctrl ? { signal: ctrl.signal } : {});
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // Aladhan wraps its payload in a code/status envelope.
  function apiData(json) {
    if (!json || json.code !== 200) {
      throw new Error((json && json.message) || "Aladhan API error");
    }
    return json;
  }

  // IANA timezone for a coordinate pair (e.g. "Europe/London"), straight from
  // Aladhan's meta. This is what lets the clock show waqt times in the local
  // time of the chosen location — anywhere in the world, DST included.
  async function resolveTimeZone(lat, lng) {
    const d = new Date();
    const date =
      String(d.getUTCDate()).padStart(2, "0") + "-" +
      String(d.getUTCMonth() + 1).padStart(2, "0") + "-" +
      d.getUTCFullYear();
    const url = new URL(BASE + "/timings/" + date);
    url.searchParams.set("latitude", String(lat));
    url.searchParams.set("longitude", String(lng));
    const json = apiData(await fetchJson(url.toString()));
    return (json.data && json.data.meta && json.data.meta.timezone) || null;
  }

  // The most useful short name out of a reverse-geocode response: the city if
  // there is one, else the locality, the region, or finally the country.
  function pickPlace(j) {
    if (!j) return "";
    const candidates = [
      j.city, j.locality, j.principalSubdivision, j.countryName, j.countryCode,
    ];
    for (const c of candidates) {
      if (c && String(c).trim()) return String(c).trim();
    }
    return "";
  }

  // A human place name for a coordinate pair ("London"), or "" if the service
  // has no name for it. Rejects on a network failure so callers can retry.
  async function resolvePlace(lat, lng) {
    const url = new URL(GEO_BASE);
    url.searchParams.set("latitude", String(lat));
    url.searchParams.set("longitude", String(lng));
    url.searchParams.set("localityLanguage", "en");
    const json = await fetchJson(url.toString(), 8000);
    return pickPlace(json);
  }

  // Settings carrying a timezone AND a place name for their coordinates.
  //
  // The timezone is retried until it resolves (scheduling depends on it). The
  // place name is looked up once per location: `placeAt` records the
  // coordinates it was resolved for, so a nameless spot is not re-queried on
  // every refresh — but a network failure leaves it unset, so it does retry.
  async function settingsWithLocation(settings) {
    const s = settings || (await storage.getSettings());
    const at = coordsKey(s.lat, s.lng);
    const needTz = !s.timeZone;
    const needPlace = s.placeAt !== at;
    if (!needTz && !needPlace) return s;

    const patch = {};
    await Promise.all([
      needTz
        ? resolveTimeZone(s.lat, s.lng)
            .then((tz) => {
              if (tz) patch.timeZone = tz;
            })
            .catch(() => {})
        : Promise.resolve(),
      needPlace
        ? resolvePlace(s.lat, s.lng)
            .then((place) => {
              patch.placeAt = at; // resolved (possibly to no name) — don't re-ask
              patch.place = place || "";
            })
            .catch(() => {}) // offline: leave placeAt unset so it retries
        : Promise.resolve(),
    ]);

    if (!Object.keys(patch).length) return s;
    return await storage.saveSettings(patch);
  }

  // Returns { lat, lng, timeZone, method, school, year, month,
  //           days: { "YYYY-MM-DD": { fajr..isha, hijri } } }
  // settings: { lat, lng, timeZone, method, apiKey, school } — school 1 = Hanafi.
  async function fetchMonth(settings, year, month) {
    const c = coords(settings);
    // Canonical form /calendar/{year}/{month} avoids a 302 redirect.
    const url = new URL(BASE + "/calendar/" + year + "/" + month);
    url.searchParams.set("latitude", String(c.lat));
    url.searchParams.set("longitude", String(c.lng));
    url.searchParams.set("method", String(settings.method == null ? 3 : settings.method));
    url.searchParams.set("school", String(settings.school == null ? 1 : settings.school));
    // Pin the timezone we resolved, so the returned clock times line up with
    // the timezone the popup shows (and follow DST through the month).
    if (settings.timeZone) url.searchParams.set("timezone", settings.timeZone);
    if (settings.apiKey) url.searchParams.set("apikey", settings.apiKey); // verify param name for your key plan
    const json = apiData(await fetchJson(url.toString()));

    const days = {};
    let timeZone = settings.timeZone || null;
    for (const row of json.data) {
      // row.date.gregorian.date is the local date as "DD-MM-YYYY"
      const parts = row.date.gregorian.date.split("-");
      const key = parts[2] + "-" + parts[1] + "-" + parts[0];
      const t = times.timingsFor(row);
      t.hijri = row.date.hijri.date; // e.g. "03-05-1448"
      t.hijriMonth = row.date.hijri.month.en; // e.g. "Jumādá al-ūlá"
      days[key] = t;
      // The API reports the timezone it used — prefer that as the truth.
      if (!timeZone && row.meta && row.meta.timezone) timeZone = row.meta.timezone;
    }
    return {
      lat: c.lat,
      lng: c.lng,
      timeZone: timeZone,
      method: settings.method,
      school: settings.school,
      year: year,
      month: month,
      days: days,
    };
  }

  return {
    BASE, GEO_BASE, METHODS, METHOD_LIST,
    coords, coordsKey, resolveTimeZone, resolvePlace, pickPlace,
    settingsWithLocation, fetchMonth,
  };
});
