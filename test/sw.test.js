/* Headless service-worker test: stubs chrome.* APIs, loads sw.js in a VM,
   then simulates install + alarm firing to verify the alarm path. */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const https = require("https");

const LIB = path.join(__dirname, "..");

/* ---------- fake chrome ---------- */
const store = {};
const createdAlarms = [];
const notifications = [];
const sentMessages = [];
const badges = [];
const createdWindows = [];
const removedWindows = [];
const listeners = {
  install: [], startup: [], alarm: [], message: [],
  notifButton: [], notifClick: [], notifClosed: [], winRemoved: [], changed: [],
};
let offscreenCreated = false;

function rawGet(keys) {
  return new Promise((res) => {
    // get(null) returns the whole store (used to prune stale months).
    if (keys === null || keys === undefined) return res(Object.assign({}, store));
    if (typeof keys === "string") return res({ [keys]: store[keys] });
    const out = {};
    for (const k of Object.keys(keys)) out[k] = k in store ? store[k] : keys[k];
    res(out);
  });
}
function rawSet(obj) {
  return new Promise((res) => {
    Object.assign(store, obj);
    res();
  });
}

const chromeStub = {
  runtime: {
    onInstalled: { addListener: (f) => listeners.install.push(f) },
    onStartup: { addListener: (f) => listeners.startup.push(f) },
    onMessage: { addListener: (f) => listeners.message.push(f) },
    sendMessage: (m) => {
      sentMessages.push(m);
      return Promise.resolve();
    },
    getURL: (p) => "chrome-extension://fake/" + p,
    getContexts: async () => (offscreenCreated ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : []),
    id: "fake",
  },
  alarms: {
    onAlarm: { addListener: (f) => listeners.alarm.push(f) },
    create: (name, info) => createdAlarms.push({ name, when: info.when, period: info.periodInMinutes }),
    getAll: async () => createdAlarms,
    clear: async (name) => {
      const i = createdAlarms.findIndex((a) => a.name === name);
      if (i >= 0) createdAlarms.splice(i, 1);
    },
  },
  notifications: {
    create: (id, opts) => notifications.push({ id, opts }),
    clear: () => {},
    onButtonClicked: { addListener: (f) => listeners.notifButton.push(f) },
    onClicked: { addListener: (f) => listeners.notifClick.push(f) },
    onClosed: { addListener: (f) => listeners.notifClosed.push(f) },
  },
  storage: {
    onChanged: { addListener: (f) => listeners.changed.push(f) },
    local: {
      get: (k, cb) => rawGet(k).then(cb),
      set: (o, cb) => rawSet(o).then(cb || (() => {})),
      remove: (keys, cb) =>
        Promise.resolve()
          .then(() => {
            for (const k of [].concat(keys)) delete store[k];
          })
          .then(cb || (() => {})),
    },
  },
  action: {
    setBadgeText: (o) => badges.push({ kind: "text", text: o.text }),
    setBadgeBackgroundColor: (o) => badges.push({ kind: "color", color: o.color }),
  },
  offscreen: {
    createDocument: async () => {
      offscreenCreated = true;
    },
    closeDocument: async () => {
      offscreenCreated = false;
    },
  },
  windows: {
    create: async (opts) => {
      const w = { id: createdWindows.length + 1, ...opts };
      createdWindows.push(w);
      return w;
    },
    remove: async (id) => {
      removedWindows.push(id);
    },
    update: async (id) => ({ id }),
    onRemoved: { addListener: (f) => listeners.winRemoved.push(f) },
  },
};

// Node 12 fetch shim (with redirects) for the live month fetch.
function getJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "SalatClocker/1.0" } }, (res) => {
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

async function run() {
  // Real Hanafi Dhaka times, cached up-front (no network inside the SW test).
  const month = await getJson(
    "https://api.aladhan.com/v1/calendar/2026/10?latitude=23.8103&longitude=90.4125&month=10&year=2026&method=3&school=1"
  );
  const days = {};
  for (const row of month.data) {
    const p = row.date.gregorian.date.split("-");
    const key = p[2] + "-" + p[1] + "-" + p[0];
    days[key] = {
      fajr: row.timings.Fajr.split(" ")[0],
      sunrise: row.timings.Sunrise.split(" ")[0],
      dhuhr: row.timings.Dhuhr.split(" ")[0],
      asr: row.timings.Asr.split(" ")[0],
      maghrib: row.timings.Maghrib.split(" ")[0],
      isha: row.timings.Isha.split(" ")[0],
      hijri: row.date.hijri.date,
      hijriMonth: row.date.hijri.month.en,
    };
  }
  // Location + resolved timezone live in storage, as the settings page saves them.
  store.lat = 23.8103;
  store.lng = 90.4125;
  store.timeZone = "Asia/Dhaka";
  store.place = "Dhaka";
  store.placeAt = "23.8103,90.4125";
  store["cal:23.8103,90.4125:3:1:2026-10"] = { method: 3, school: 1, year: "2026", month: "10", days };

  // Freeze the clock so scheduling is deterministic: 2026-10-14 13:00 Dhaka
  // (Fajr and Dhuhr already passed, Asr/Maghrib/Isha still ahead).
  const FIXED = new Date("2026-10-14T13:00:00+06:00").getTime();
  let NOW = FIXED; // mutable so boundary scenarios can move the clock
  const RealDate = globalThis.Date;
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(NOW);
      else super(...args);
    }
    static now() {
      return NOW;
    }
  }
  globalThis.Date = FakeDate;

  // Load the service worker with the stubs in scope.
  globalThis.chrome = chromeStub;

  // A canned London month (real Hanafi times for 2026-10-14) used to prove the
  // location switch re-plans against the new place's own timetable.
  function londonRows() {
    const t = {
      Fajr: "05:32", Sunrise: "07:23", Dhuhr: "12:47",
      Asr: "16:19", Maghrib: "18:09", Isha: "19:54",
    };
    const rows = [];
    for (let d = 1; d <= 31; d++) {
      const dd = String(d).padStart(2, "0");
      const timings = {};
      for (const k of Object.keys(t)) timings[k] = t[k] + " (+01)";
      rows.push({
        timings: timings,
        date: {
          gregorian: { date: dd + "-10-2026" },
          hijri: { date: "03-05-1448", month: { en: "Rabīʿ al-awwal" } },
        },
        meta: { timezone: "Europe/London" },
      });
    }
    return rows;
  }

  // Stubbed network: Aladhan supplies months + timezone lookups, ummahapi the
  // hadith, jsDelivr the Bangla edition.
  const fetchStub = async (url) => {
    const u = String(url);
    if (u.indexOf("aladhan") >= 0) {
      if (u.indexOf("/timings/") >= 0) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ code: 200, data: { meta: { timezone: "Europe/London" } } }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ code: 200, data: londonRows() }) };
    }
    if (u.indexOf("bigdatacloud") >= 0) {
      // Reverse geocoding: the name of whatever coordinates were asked about.
      const lat = Number((u.match(/latitude=(-?[\d.]+)/) || [])[1]);
      const london = Math.abs(lat - 51.5074) < 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          city: london ? "London" : "Dhaka",
          locality: london ? "City of Westminster" : "Dhaka",
          principalSubdivision: london ? "England" : "Dhaka",
          countryName: london ? "United Kingdom" : "Bangladesh",
          countryCode: london ? "GB" : "BD",
        }),
      };
    }
    if (u.indexOf("ummahapi.com") >= 0) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            id: "muslim-1",
            collection: "muslim",
            collection_name: "Sahih Muslim",
            hadithnumber: 1,
            arabic: "arabic-text",
            english: "english-text",
            grade: "Sahih",
          },
        }),
      };
    }
    if (u.indexOf("jsdelivr") >= 0) {
      return { ok: true, status: 200, json: async () => ({ hadiths: [{ text: "bengali-text" }] }) };
    }
    return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
  };
  globalThis.fetch = fetchStub;
  globalThis.importScripts = function () {
    for (const f of arguments) {
      vm.runInThisContext(fs.readFileSync(path.join(LIB, f), "utf8"), { filename: f });
    }
  };
  const src = fs.readFileSync(path.join(LIB, "sw.js"), "utf8");
  vm.runInThisContext(src, { filename: "sw.js" });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Wait a beat so the module-level listener registrations settle.
  await sleep(50);

  // --- simulate install ---
  listeners.install.forEach((f) => f());
  for (let i = 0; i < 50 && createdAlarms.length === 0; i++) await sleep(100);
  const alarmNames = createdAlarms.map((a) => a.name);
  console.log("alarms created:", JSON.stringify(alarmNames));

  const res = {};
  res.boot = {
    hasAsr: alarmNames.indexOf("waqt:asr") !== -1,
    hasMaghrib: alarmNames.indexOf("waqt:maghrib") !== -1,
    hasIsha: alarmNames.indexOf("waqt:isha") !== -1,
    hasDaily: alarmNames.indexOf("daily-refresh") !== -1,
    hasBadge: alarmNames.indexOf("badge-refresh") !== -1,
  };

  // A waqt that already passed must be scheduled for TOMORROW, not dropped
  // and not fired immediately (this was the Dhuhr bug).
  const dhuhrAlarm = createdAlarms.find((a) => a.name === "waqt:dhuhr");
  res.boot.dhuhrWhen = dhuhrAlarm ? dhuhrAlarm.when : null;
  res.boot.dhuhrIsTomorrow =
    !!dhuhrAlarm && dhuhrAlarm.when - FIXED > 20 * 60 * 60 * 1000;

  // --- self-heal: drop the asr alarm, badge-refresh must recreate it ---
  const lostIdx = createdAlarms.findIndex((a) => a.name === "waqt:asr");
  createdAlarms.splice(lostIdx, 1);
  await listeners.alarm.forEach((f) => f({ name: "badge-refresh" }));
  await sleep(200);
  res.heal = { asrRecreated: createdAlarms.some((a) => a.name === "waqt:asr") };

  // --- fire the asr alarm: play is queued until the doc reports ready ---
  sentMessages.length = 0;
  notifications.length = 0;
  createdWindows.length = 0;
  listeners.alarm.forEach((f) => f({ name: "waqt:asr" }));
  await sleep(200);
  res.asrAlarm = {
    notifications: notifications.length,
    notifTitle: notifications.length ? notifications[0].opts.title : null,
    playBeforeReady: sentMessages.filter((m) => m.type === "play").length,
    offscreenCreated: offscreenCreated,
    activeAlarm: store["activeAlarm"],
  };

  // the offscreen document comes up and reports ready -> queued play flushes
  listeners.message.forEach((f) => f({ type: "offscreen:ready" }));
  await sleep(100);
  res.asrAlarm.playAfterReady = sentMessages.filter((m) => m.type === "play").length;
  res.asrAlarm.playUrlsAreBundled = sentMessages.every((m) => m.type !== "play" || m.audioId === undefined);
  // auto-popup window
  res.asrAlarm.windowCount = createdWindows.length;
  res.asrAlarm.windowUrl = createdWindows.length ? createdWindows[0].url : null;
  res.asrAlarm.windowType = createdWindows.length ? createdWindows[0].type : null;

  // --- autoplay blocked: the worker must fall back to the visible window ---
  sentMessages.length = 0;
  listeners.message.forEach((f) => f({ type: "azan:error", detail: "NotAllowedError" }));
  await sleep(100);
  res.asrAlarm.windowFallback = sentMessages.some(
    (m) => m.target === "alarm" && m.type === "play-here"
  );

  // --- diagnostics were recorded ---
  res.asrAlarm.diagEvents = (store.diagLog || []).map((e) => e.event);

  // --- a persisted alarm firing hours late (Chrome was off) must stay silent ---
  notifications.length = 0;
  createdWindows.length = 0;
  listeners.alarm.forEach((f) =>
    f({ name: "waqt:maghrib", scheduledTime: FIXED - 3 * 60 * 60 * 1000 })
  );
  await sleep(150);
  res.lateAlarm = { notifications: notifications.length, window: createdWindows.length };

  // --- marker skip on second fire ---
  listeners.alarm.forEach((f) => f({ name: "waqt:asr" }));
  await sleep(100);
  res.twice = { notifications: notifications.length };

  // --- snooze via notification button ---
  listeners.notifButton.forEach((f) => f("salat-waqt-alarm", 0));
  await sleep(200);
  res.snooze = {
    offscreenClosed: !offscreenCreated,
    activeAlarmCleared: store["activeAlarm"] === null,
    marker: store["notified:" + new Date().toISOString().slice(0, 10) + ":asr"],
  };

  // --- manual test alarm fires once, without the daily marker ---
  notifications.length = 0;
  createdWindows.length = 0;
  listeners.alarm.forEach((f) => f({ name: "waqt:test" }));
  await sleep(200);
  res.testAlarm = {
    fired: notifications.length === 1,
    window: createdWindows.length === 1,
  };
  // and again (same day) — must not be blocked by the marker
  notifications.length = 0;
  listeners.alarm.forEach((f) => f({ name: "waqt:test" }));
  await sleep(100);
  res.testAlarm.firesTwice = notifications.length === 1;

  assert.ok(res.boot.hasAsr, "asr alarm must be created");
  assert.ok(
    res.boot.dhuhrIsTomorrow,
    "a waqt that already passed (Dhuhr) must be scheduled for tomorrow, not dropped"
  );
  assert.ok(res.heal.asrRecreated, "lost asr alarm must be recreated by self-heal");
  assert.strictEqual(res.asrAlarm.notifications, 1, "asr alarm must create a notification");
  assert.strictEqual(res.asrAlarm.notifTitle, "Asr — time for salah");
  assert.strictEqual(res.asrAlarm.playBeforeReady, 0, "play must wait for offscreen:ready");
  assert.strictEqual(res.asrAlarm.playAfterReady, 1, "play must flush after offscreen:ready");
  assert.ok(res.asrAlarm.playUrlsAreBundled, "play must use the bundled azan (no audioId)");
  assert.strictEqual(res.asrAlarm.windowCount, 1, "asr alarm must auto-open the popup window");
  assert.ok(res.asrAlarm.windowUrl.indexOf("alarm.html?waqt=asr") >= 0, "window opens alarm.html?waqt=asr");
  assert.strictEqual(res.asrAlarm.windowType, "popup");
  assert.ok(res.asrAlarm.windowFallback, "blocked autoplay must fall back to the visible window");
  assert.ok(
    res.asrAlarm.diagEvents.indexOf("play sent to offscreen") >= 0 &&
      res.asrAlarm.diagEvents.indexOf("azan PLAY FAILED") >= 0,
    "diagnostics log must record the playback attempt and the failure"
  );
  assert.ok(res.testAlarm.fired, "test alarm must fire");
  assert.ok(res.testAlarm.window, "test alarm must open the popup window");
  assert.ok(res.testAlarm.firesTwice, "test alarm must be repeatable the same day");
  assert.strictEqual(res.lateAlarm.notifications, 0, "a 3h-late alarm must not ring");
  assert.strictEqual(res.lateAlarm.window, 0, "a 3h-late alarm must not open a window");
  assert.strictEqual(res.twice.notifications, 0, "second asr fire must be skipped by the daily marker");

  // Daily hadith: fetched from ummahapi, Bangla edition merged, history kept.
  const hadith = store["hadith:today"];
  assert.ok(hadith, "hadith:today must be cached after boot");
  assert.strictEqual(hadith.reference, "Sahih Muslim 1", "hadith parsed from ummahapi");
  assert.strictEqual(hadith.grade, "Sahih", "grade carried through");
  assert.strictEqual(hadith.bangla, "bengali-text", "Bangla edition merged in");
  assert.ok(store["hadith:history"]["muslim-1"], "shown hadith recorded for the 15-day window");

  // --- a hung hadith source must NOT delay scheduling the waqt alarms ---
  globalThis.fetch = () => new Promise(() => {}); // never resolves
  delete store["hadith:today"];
  createdAlarms.length = 0;
  listeners.startup.forEach((f) => f());
  await sleep(400);
  res.hang = {
    alarmsScheduled: createdAlarms.filter((a) => a.name.indexOf("waqt:") === 0).length,
    hadithPending: !store["hadith:today"],
  };

  // --- a waqt reached this very minute must ring NOW, not roll to tomorrow ---
  NOW = new Date("2026-10-14T15:56:00+06:00").getTime(); // Asr is 15:56 in Dhaka
  listeners.message.forEach((f) => f({ type: "reschedule" }, null, () => {}));
  await sleep(250);
  const asrNow = createdAlarms.find((a) => a.name === "waqt:asr");
  res.boundary = {
    asrWhen: asrNow ? asrNow.when : null,
    ringsNow: !!asrNow && Math.abs(asrNow.when - NOW) < 60000,
    passedStillTomorrow: (() => {
      const d = createdAlarms.find((a) => a.name === "waqt:dhuhr");
      return !!d && d.when - NOW > 18 * 60 * 60 * 1000;
    })(),
  };

  // --- global: a new location resolves its own timezone and re-plans ---
  globalThis.fetch = fetchStub; // the hang scenario above replaced it
  NOW = new Date("2026-10-14T08:00:00+01:00").getTime(); // 08:00 in London
  store.lat = 51.5074;
  store.lng = -0.1278;
  store.timeZone = ""; // as "Save location" leaves it, pending a lookup
  // …and the user answers Dhuhr 45 minutes after the waqt itself.
  store.azanDelay = { dhuhr: 45, asr: 0, isha: 0 };
  createdAlarms.length = 0;
  listeners.changed.forEach((f) =>
    f(
      {
        lat: { newValue: 51.5074 },
        lng: { newValue: -0.1278 },
        timeZone: { newValue: "" },
        azanDelay: { newValue: store.azanDelay },
      },
      "local"
    )
  );
  await sleep(800);
  const londonAsr = createdAlarms.find((a) => a.name === "waqt:asr");
  const londonDhuhr = createdAlarms.find((a) => a.name === "waqt:dhuhr");
  res.global = {
    timeZone: store.timeZone,
    place: store.place,
    placeAt: store.placeAt,
    londonCache: !!store["cal:51.5074,-0.1278:3:1:2026-10"],
    dhakaCachePruned: !store["cal:23.8103,90.4125:3:1:2026-10"],
    asrInMinutes: londonAsr ? Math.round((londonAsr.when - NOW) / 60000) : null,
    // Dhuhr is 12:47 in the canned London month; +45 = 13:32, i.e. 332 min out.
    dhuhrInMinutes: londonDhuhr ? Math.round((londonDhuhr.when - NOW) / 60000) : null,
  };

  // --- a delayed waqt: the waqt time has passed, but its azan has not ---
  // At 12:50 London, Dhuhr itself began at 12:47 but its azan is 13:32. The
  // alarm must be minutes away — not rolled to tomorrow as a "passed" waqt.
  NOW = new Date("2026-10-14T12:50:00+01:00").getTime();
  createdAlarms.length = 0;
  listeners.message.forEach((f) => f({ type: "reschedule" }, null, () => {}));
  await sleep(250);
  const dhuhrPending = createdAlarms.find((a) => a.name === "waqt:dhuhr");
  res.delayWindow = {
    dhuhrInMinutes: dhuhrPending ? Math.round((dhuhrPending.when - NOW) / 60000) : null,
  };

  // Regression: a notification closing (Windows dismisses/auto-clears these)
  // must never cut the azan short — no onClosed handler may be registered.
  assert.strictEqual(
    listeners.notifClosed.length,
    0,
    "the azan must not be stopped by chrome.notifications.onClosed"
  );

  // Regression: a hanging hadith source must not block alarm scheduling.
  assert.ok(
    res.hang.alarmsScheduled >= 5,
    "waqt alarms must still be scheduled while the hadith fetch hangs"
  );

  // Regression: a waqt that started this minute rings now instead of tomorrow.
  assert.ok(res.boundary.ringsNow, "a waqt reached this minute must ring now");
  assert.ok(res.boundary.passedStillTomorrow, "an older waqt still rolls to tomorrow");

  // Global: a new location's own timezone must drive the whole timetable.
  assert.strictEqual(
    res.global.timeZone,
    "Europe/London",
    "saving a location must resolve its timezone from the coordinates"
  );
  assert.ok(res.global.londonCache, "the new location's month must be fetched");
  assert.ok(res.global.dhakaCachePruned, "the old location's cached month must be pruned");
  assert.strictEqual(
    res.global.place,
    "London",
    "a new location's city name must be reverse-geocoded from its coordinates"
  );
  assert.strictEqual(
    res.global.placeAt,
    "51.5074,-0.1278",
    "the resolved city name must be stamped with the coordinates it belongs to"
  );
  assert.strictEqual(
    res.global.asrInMinutes,
    499,
    "waqt alarms must use the new location's Asr (16:19 London from 08:00)"
  );
  assert.strictEqual(
    res.global.dhuhrInMinutes,
    332,
    "a delayed Dhuhr must ring at the waqt plus the delay (12:47 + 45 min = 13:32)"
  );

  // Delay window: the waqt has begun but its azan is still ahead.
  assert.strictEqual(
    res.delayWindow.dhuhrInMinutes,
    42,
    "a waqt whose azan is still ahead must ring today, not roll to tomorrow"
  );

  console.log("SW harness test passed:", JSON.stringify(res, null, 1));
  process.exit(0);
}

run().catch((e) => {
  console.error("SW test FAILED:", e);
  process.exit(1);
});
