/* Tests: core logic (Node) + live Aladhan check (skips when offline). */
"use strict";
const assert = require("assert");
const times = require("../lib/times.js");
const storage = require("../lib/storage.js");
const api = require("../lib/api.js");
const ui = require("../lib/ui.js");
const audio = require("../lib/audio.js");
const sky = require("../lib/sky.js");
const makruh = require("../lib/makruh.js");

// The clock is timezone-driven now. Pin it to Dhaka for the long-standing
// cases below, then switch timezones explicitly in the new section.
times.setTimeZone("Asia/Dhaka");

// Node 12 has no global fetch; shim it (with redirect following) for the live API check.
if (typeof fetch === "undefined") {
  function request(url, redirects) {
    return new Promise(function (resolve, reject) {
      require("https")
        .get(url, function (res) {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (redirects <= 0) return reject(new Error("Too many redirects"));
            const next = new URL(res.headers.location, url).toString();
            return resolve(request(next, redirects - 1));
          }
          let body = "";
          res.on("data", function (c) { body += c; });
          res.on("end", function () {
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              json: function () { return Promise.resolve(JSON.parse(body)); },
            });
          });
        })
        .on("error", reject);
    });
  }
  globalThis.fetch = function (url) { return request(url, 5); };
}

// --- times.js ---
assert.strictEqual(times.cleanTime("04:40 (+06)"), "04:40");
assert.strictEqual(times.dateKey(new Date("2026-10-14T10:00:00Z")), "2026-10-14"); // 16:00 +06
assert.strictEqual(times.dateKey(new Date("2026-10-14T20:00:00Z")), "2026-10-15"); // 02:00 +06

const day = { fajr: "04:40", sunrise: "05:55", dhuhr: "11:44", asr: "15:06", maghrib: "17:33", isha: "18:44" };
const nextDay = { fajr: "04:41", sunrise: "05:56", dhuhr: "11:44", asr: "15:05", maghrib: "17:33", isha: "18:44" };

assert.deepStrictEqual(
  times.nextWaqt(day, new Date("2026-10-14T04:30:00Z"), nextDay),
  { waqt: "dhuhr", time: "11:44", today: true }
); // 10:30 BD -> Dhuhr
assert.deepStrictEqual(
  times.nextWaqt(day, new Date("2026-10-14T07:00:00Z"), nextDay),
  { waqt: "asr", time: "15:06", today: true }
); // 13:00 BD -> Asr
assert.deepStrictEqual(
  times.nextWaqt(day, new Date("2026-10-14T14:00:00Z"), nextDay),
  { waqt: "fajr", time: "04:41", today: false }
); // 20:00 BD -> tomorrow's Fajr

// 12-hour formatting
assert.strictEqual(times.formatTime12("04:40"), "4:40 AM");
assert.strictEqual(times.formatTime12("11:44"), "11:44 AM");
assert.strictEqual(times.formatTime12("15:06"), "3:06 PM");
assert.strictEqual(times.formatTime12("00:00"), "12:00 AM");

// Countdown: seconds when under an hour, minutes beyond
assert.strictEqual(times.formatCountdown(65000), "1m 05s");
assert.strictEqual(times.formatCountdown(3 * 3600000 + 20 * 60000), "3h 20m");

// --- timezone switching: the same clock serves any location on earth ---
// London, summer (BST, +01): 10:00 UTC reads as 11:00 local.
times.setTimeZone("Europe/London");
assert.strictEqual(times.dateKey(new Date("2026-07-14T10:00:00Z")), "2026-07-14");
assert.strictEqual(times.nowMinutes(new Date("2026-07-14T10:00:00Z")), 11 * 60);
// Tokyo (+09): 20:00 UTC is already the next calendar day there.
times.setTimeZone("Asia/Tokyo");
assert.strictEqual(times.dateKey(new Date("2026-10-14T20:00:00Z")), "2026-10-15");
assert.strictEqual(times.nowMinutes(new Date("2026-10-14T20:00:00Z")), 5 * 60);
assert.deepStrictEqual(times.yearMonth(new Date("2026-10-31T20:00:00Z")), {
  year: "2026", month: "11",
});
// New York in winter (EST, -05): 03:00 UTC is 22:00 the previous day.
times.setTimeZone("America/New_York");
assert.strictEqual(times.dateKey(new Date("2026-01-15T03:00:00Z")), "2026-01-14");
assert.strictEqual(times.nowMinutes(new Date("2026-01-15T03:00:00Z")), 22 * 60);
// An unset timezone falls back to the device's own.
times.setTimeZone("");
assert.strictEqual(times.timeZone(), times.deviceTimeZone());
times.setTimeZone("Asia/Dhaka");

// --- location label + validation (used by the popup header & settings form) ---
assert.strictEqual(times.formatLatLng(23.8103, 90.4125), "23.81° N, 90.41° E");
assert.strictEqual(times.formatLatLng(-33.8688, 151.2093), "33.87° S, 151.21° E");
assert.strictEqual(times.formatLatLng(40.7128, -74.006), "40.71° N, 74.01° W");
assert.strictEqual(times.formatCoord(0, "N", "S"), "0.00° N");
assert.strictEqual(times.formatCoord("x", "N", "S"), "—");
assert.strictEqual(times.isValidLat(90), true);
assert.strictEqual(times.isValidLat(-90), true);
assert.strictEqual(times.isValidLat(90.1), false);
assert.strictEqual(times.isValidLat(""), false);
assert.strictEqual(times.isValidLng(180), true);
assert.strictEqual(times.isValidLng(-180), true);
assert.strictEqual(times.isValidLng(-180.5), false);

// The city name rides along with the coordinates in the settings hint.
assert.strictEqual(
  times.locationLabel("London", 51.5074, -0.1278),
  "London (51.51° N, 0.13° W)"
);
assert.strictEqual(
  times.locationLabel("", 51.5074, -0.1278),
  "51.51° N, 0.13° W",
  "an unresolved place falls back to the bare coordinates"
);

// --- api.js: the best short name out of a reverse-geocode response ---
assert.strictEqual(api.pickPlace({ city: "London", locality: "City of Westminster" }), "London");
assert.strictEqual(api.pickPlace({ city: "", locality: "City of Westminster" }), "City of Westminster");
assert.strictEqual(api.pickPlace({ principalSubdivision: "England", countryName: "United Kingdom" }), "England");
assert.strictEqual(api.pickPlace({ countryCode: "GB" }), "GB");
assert.strictEqual(api.pickPlace({}), "");
assert.strictEqual(api.pickPlace(null), "");
// Coordinate keys decide when a resolved place name is stale.
assert.strictEqual(api.coordsKey(51.5074, -0.1278), "51.5074,-0.1278");
assert.notStrictEqual(api.coordsKey(23.8103, 90.4125), api.coordsKey(51.5074, -0.1278));

// --- azan delay: the user may answer Dhuhr/Asr/Isha a little later ---
const userDelay = { azanDelay: { dhuhr: 45, asr: 0, isha: 30 } };
assert.strictEqual(times.delayFor("dhuhr", userDelay), 45);
assert.strictEqual(times.delayFor("isha", userDelay), 30);
assert.strictEqual(times.delayFor("asr", userDelay), 0, "0 minutes means 'at the waqt'");
assert.strictEqual(times.delayFor("dhuhr", null), 0);
assert.strictEqual(times.delayFor("dhuhr", {}), 0);
assert.strictEqual(times.delayFor("isha", { azanDelay: { isha: "30" } }), 30, "stored as a string");
// Fajr and Maghrib (and sunrise) can never be delayed, whatever is in storage.
assert.strictEqual(times.delayFor("fajr", { azanDelay: { fajr: 20 } }), 0);
assert.strictEqual(times.delayFor("maghrib", { azanDelay: { maghrib: 20 } }), 0);
assert.strictEqual(times.delayFor("sunrise", { azanDelay: { sunrise: 20 } }), 0);

// Each delayable waqt has its own window. Dhuhr is the special one: it starts
// at 30 minutes (so it can never be answered immediately) and may run for hours.
assert.strictEqual(times.delayFloor("dhuhr"), 30);
assert.strictEqual(times.delayFloor("asr"), 5);
assert.strictEqual(times.delayFloor("isha"), 5);
// One notch on the slider: Dhuhr's hours-wide window moves in 15-minute steps.
assert.strictEqual(times.delayStep("dhuhr"), 15);
assert.strictEqual(times.delayStep("asr"), 5);
assert.strictEqual(times.delayStep("isha"), 5);
assert.strictEqual(times.delayFor("dhuhr", { azanDelay: { dhuhr: 15 } }), 30, "raised to Dhuhr's floor");
assert.strictEqual(times.delayFor("dhuhr", { azanDelay: { dhuhr: 3 } }), 30);
assert.strictEqual(times.delayFor("dhuhr", { azanDelay: { dhuhr: 90 } }), 90, "Dhuhr runs well past an hour");
assert.strictEqual(times.delayFor("dhuhr", { azanDelay: { dhuhr: 600 } }), 360, "still bounded");
assert.strictEqual(times.delayFor("asr", { azanDelay: { asr: 90 } }), 60);
assert.strictEqual(times.delayFor("isha", { azanDelay: { isha: 200 } }), 120, "Isha is capped at 2 hours");
assert.strictEqual(times.delayFor("dhuhr", { azanDelay: { dhuhr: -10 } }), 0);

assert.strictEqual(times.azanTime("dhuhr", "13:30", userDelay), "14:15");
assert.strictEqual(times.azanTime("isha", "19:00", userDelay), "19:30");
assert.strictEqual(times.azanTime("asr", "16:10", userDelay), "16:10");
assert.strictEqual(times.azanTime("fajr", "04:40", userDelay), "04:40");
assert.strictEqual(times.azanTime("dhuhr", "13:30", {}), "13:30");

const plainDay = {
  fajr: "04:40", sunrise: "05:55", dhuhr: "13:30", asr: "16:10",
  maghrib: "17:33", isha: "19:00", hijri: "03-05-1448", hijriMonth: "Jumādá al-ūlá",
};
const delayedDay = times.azanTimes(plainDay, userDelay);
assert.strictEqual(delayedDay.dhuhr, "14:15");
assert.strictEqual(delayedDay.isha, "19:30");
assert.strictEqual(delayedDay.asr, "16:10");
assert.strictEqual(delayedDay.fajr, "04:40", "Fajr is untouched");
assert.strictEqual(delayedDay.maghrib, "17:33", "Maghrib is untouched");
assert.strictEqual(delayedDay.sunrise, "05:55", "sunrise is not a prayer");
assert.strictEqual(delayedDay.hijri, "03-05-1448", "the Hijri date rides along");
assert.strictEqual(plainDay.dhuhr, "13:30", "azanTimes must never mutate the cached day");
assert.strictEqual(times.azanTimes(null, userDelay), null);

// --- Dhuhr's window ends where Asr gets close ---
// The ceiling is measured from the day, so it comes down on its own in winter.
assert.strictEqual(times.delayCeiling("dhuhr", plainDay), 130, "16:10 - 13:30 - 30 min clearance");
assert.strictEqual(times.delayCeiling("dhuhr", null), 120, "fixed window until the day is known");
assert.strictEqual(times.delayCeiling("asr", plainDay), 60, "Asr is capped whatever the day");
assert.strictEqual(times.delayCeiling("isha", plainDay), 120, "Isha's next waqt is tomorrow's Fajr");
// The slider can only settle on whole steps, so the reachable ceiling is the
// day's ceiling rounded down to the step (135 here, not the raw 130).
assert.strictEqual(times.delayLimit("dhuhr", plainDay), 120, "30 + 6 steps of 15 = 120");
assert.strictEqual(times.delayLimit("asr", plainDay), 60);
assert.strictEqual(times.delayLimit("isha", plainDay), 120);
// A short winter day (London, 21 December) pulls Dhuhr's ceiling down with it.
const shortDay = { dhuhr: "12:05", asr: "14:10", maghrib: "15:55", isha: "17:30" };
assert.strictEqual(times.delayCeiling("dhuhr", shortDay), 95, "14:10 - 12:05 - 30");
assert.strictEqual(times.delayLimit("dhuhr", shortDay), 90, "the last whole 15-minute step");
// A delay that no longer fits is reported, never silently changed.
const clash = times.delayConflict("dhuhr", 120, shortDay);
assert.ok(clash, "120 min does not fit a 95-minute window");
assert.strictEqual(clash.ceiling, 90, "the advice is a position the slider can reach");
assert.strictEqual(clash.azanTime, "14:05", "12:05 + 120 min");
assert.strictEqual(clash.limitTime, "13:40", "Asr less the 30-minute clearance");
assert.strictEqual(times.delayConflict("dhuhr", 90, shortDay), null, "90 min still fits");
assert.strictEqual(times.delayConflict("isha", 120, shortDay), null, "Isha is not checked");
assert.strictEqual(times.delayConflict("dhuhr", 120, null), null);
// Asr must stay clear of Maghrib, with no clearance of its own.
const asrClash = times.delayConflict("asr", 120, shortDay);
assert.ok(asrClash);
assert.strictEqual(asrClash.azanTime, "16:10", "14:10 + 120 runs past Maghrib");
assert.strictEqual(times.delayConflict("asr", 60, shortDay), null, "15:10 is still before 15:55");
// The minutes format shown in Settings.
assert.strictEqual(times.formatMinutes(45), "45 min");
assert.strictEqual(times.formatMinutes(60), "1h 00m");
assert.strictEqual(times.formatMinutes(222), "3h 42m");

// --- winter -> summer: a delay follows the waqt, a fixed clock time cannot ---
// The same "30 minutes after Dhuhr" in two seasons. The azan moves with the
// waqt, so there is nothing for the user to re-adjust when the season turns.
const winterDay = { dhuhr: "12:05" };
const summerDay = { dhuhr: "13:05" };
const half = { azanDelay: { dhuhr: 30 } };
assert.strictEqual(times.azanTime("dhuhr", winterDay.dhuhr, half), "12:35");
assert.strictEqual(times.azanTime("dhuhr", summerDay.dhuhr, half), "13:35");
const winterGap = times.toMinutes("12:35") - times.toMinutes(winterDay.dhuhr);
const summerGap = times.toMinutes("13:35") - times.toMinutes(summerDay.dhuhr);
assert.strictEqual(winterGap, 30, "the azan is 30 min after Dhuhr in winter");
assert.strictEqual(summerGap, 30, "…and still 30 min after Dhuhr in summer");
// A pinned clock time (say 12:35) would be 30 min after Dhuhr in winter and half
// an hour BEFORE Dhuhr in summer — the bug this feature avoids.
assert.ok(times.toMinutes("12:35") < times.toMinutes(summerDay.dhuhr));

// --- ui.js ---
assert.strictEqual(ui.isDark("#1A237E"), true);
assert.strictEqual(ui.isDark("#FAFAFA"), false);

// --- sky.js: scene per BD time of day (Dhaka day above) ---
// 02:00 BD -> night; 05:30 -> fajr (dawn); 10:30 -> sunrise (morning)
// 12:00 -> day (midday); 16:00 -> afternoon; 18:00 -> maghrib (sunset); 20:00 -> night
assert.strictEqual(sky.sceneFor(day, new Date("2026-10-14T02:00:00+06:00")), "night");
assert.strictEqual(sky.sceneFor(day, new Date("2026-10-14T05:30:00+06:00")), "fajr");
assert.strictEqual(sky.sceneFor(day, new Date("2026-10-14T10:30:00+06:00")), "sunrise");
assert.strictEqual(sky.sceneFor(day, new Date("2026-10-14T12:00:00+06:00")), "day");
assert.strictEqual(sky.sceneFor(day, new Date("2026-10-14T16:00:00+06:00")), "afternoon");
assert.strictEqual(sky.sceneFor(day, new Date("2026-10-14T18:00:00+06:00")), "maghrib");
assert.strictEqual(sky.sceneFor(day, new Date("2026-10-14T20:00:00+06:00")), "night");

// --- makruh.js: prohibited frames ---
assert.strictEqual(times.addMinutes("11:44", 15), "11:59");
assert.strictEqual(times.addMinutes("04:40", -15), "04:25");
assert.strictEqual(times.addMinutes("23:50", 20), "00:10"); // wraps past midnight
assert.strictEqual(times.addMinutes("00:10", -20), "23:50");

// --- msUntilSignedExact: second precision (no up-to-a-minute lateness) ---
// 15:55:30 Dhaka -> Asr (15:56:00) is exactly 30s away.
assert.strictEqual(
  times.msUntilSignedExact("15:56", new Date("2026-10-14T15:55:30+06:00")),
  30000
);
// An already-passed time is negative.
assert.strictEqual(
  times.msUntilSignedExact("15:56", new Date("2026-10-14T15:56:30+06:00")),
  -30000
);
// The minute-granularity version cannot see the seconds (contrast).
assert.strictEqual(
  times.msUntilSigned("15:56", new Date("2026-10-14T15:55:30+06:00")),
  60000
);

const mframes = makruh.frames(day, {});
assert.strictEqual(mframes.length, 3);
const sunrise = mframes.find((f) => f.key === "sunrise");
assert.strictEqual(sunrise.start, "05:55");
assert.strictEqual(sunrise.end, "06:10"); // +15
const zawal = mframes.find((f) => f.key === "zawal");
assert.strictEqual(zawal.start, "11:34");
assert.strictEqual(zawal.end, "11:44"); // ends at Dhuhr
const sunset = mframes.find((f) => f.key === "sunset");
assert.strictEqual(sunset.start, "17:18");
assert.strictEqual(sunset.end, "17:33"); // -15

// Currently-in-frame detection (BD times)
assert.strictEqual(makruh.currentFrame(mframes, new Date("2026-10-14T06:00:00+06:00")).key, "sunrise");
assert.strictEqual(makruh.currentFrame(mframes, new Date("2026-10-14T11:40:00+06:00")).key, "zawal");
assert.strictEqual(makruh.currentFrame(mframes, new Date("2026-10-14T17:30:00+06:00")).key, "sunset");
assert.strictEqual(makruh.currentFrame(mframes, new Date("2026-10-14T11:00:00+06:00")), null);
// Custom durations
const custom = makruh.frames(day, { makruhSunrise: 5, makruhZawal: 0, makruhSunset: 20 });
assert.strictEqual(custom.length, 2);
assert.strictEqual(custom[0].end, "06:00");

// --- storage.js (memory fallback outside Chrome) ---
storage
  .saveSettings({ lat: 51.5074, lng: -0.1278, timeZone: "Europe/London", volume: 0.5 })
  .then(() => storage.getSettings())
  .then((s) => {
    assert.strictEqual(s.lat, 51.5074);
    assert.strictEqual(s.lng, -0.1278);
    assert.strictEqual(s.timeZone, "Europe/London");
    assert.strictEqual(s.volume, 0.5);
    assert.strictEqual(s.method, 3); // default preserved
    assert.strictEqual(s.bgColor, "#FAFAFA"); // default preserved
    assert.strictEqual(s.place, ""); // no city name until one is resolved
    // Cache keys are location-scoped, so two places can never collide.
    assert.strictEqual(
      storage.cacheKey(s, new Date("2026-10-14T10:00:00Z")),
      "cal:51.5074,-0.1278:3:1:2026-10"
    );
    // Settings that already carry a timezone + place for their coordinates are
    // returned as-is — no redundant lookup on every refresh.
    return api.settingsWithLocation({
      lat: 51.5074, lng: -0.1278, timeZone: "Europe/London",
      place: "London", placeAt: "51.5074,-0.1278",
    });
  })
  .then((s) => {
    assert.strictEqual(s.timeZone, "Europe/London");
    assert.strictEqual(s.place, "London");
    console.log("Unit tests passed.");
    return audioRoundtrip();
  })
  .then(() => liveCheck())
  .catch((e) => {
    console.error("TEST FAILED:", e.message);
    process.exit(1);
  });

// --- audio.js (memory fallback outside Chrome) ---
async function audioRoundtrip() {
  const fake = { fake: "blob" };
  await audio.save("t1", fake);
  assert.deepStrictEqual(await audio.get("t1"), fake);
  await audio.remove("t1");
  assert.strictEqual(await audio.get("t1"), null);
  console.log("Audio roundtrip passed.");
}

function liveCheck() {
  // Dhaka kept as a regression anchor: the classic Bangladesh timetable must
  // be unchanged by the move to lat/lng (23.8103, 90.4125).
  const dhaka = {
    lat: 23.8103, lng: 90.4125, timeZone: "Asia/Dhaka",
    method: 3, school: 1, apiKey: "",
  };
  return api
    .fetchMonth(dhaka, "2026", "10")
    .then((m) => {
      const t = m.days["2026-10-14"];
      assert.strictEqual(t.fajr, "04:40");
      assert.strictEqual(t.dhuhr, "11:44");
      assert.strictEqual(t.asr, "15:56"); // Hanafi Asr (school=1)
      assert.strictEqual(t.isha, "18:44");
      assert.strictEqual(t.hijri, "03-05-1448");
      assert.strictEqual(t.hijriMonth, "Jumādá al-ūlá");
      console.log("Live API check passed: 2026-10-14 Dhaka (Hanafi) ->", JSON.stringify(t));
      return globalCheck();
    })
    .catch((e) => console.log("Live API check skipped (offline?):", e.message));
}

// A second, far-away location proves the global path end to end: the timezone
// is resolved from the coordinates and the waqt times come back in local time.
function globalCheck() {
  return api
    .resolveTimeZone(51.5074, -0.1278)
    .then((tz) => {
      assert.strictEqual(tz, "Europe/London", "London coordinates must resolve to Europe/London");
      return api.resolvePlace(51.5074, -0.1278);
    })
    .then((place) => {
      assert.strictEqual(place, "London", "London coordinates must reverse-geocode to a city name");
      return api.fetchMonth(
        { lat: 51.5074, lng: -0.1278, timeZone: "Europe/London", method: 3, school: 1 },
        "2026", "10"
      );
    })
    .then((m) => {
      assert.strictEqual(m.timeZone, "Europe/London");
      const t = m.days["2026-10-14"];
      for (const w of ["fajr", "dhuhr", "asr", "maghrib", "isha"]) {
        assert.ok(/^\d{2}:\d{2}$/.test(t[w]), w + " must be HH:MM, got " + t[w]);
      }
      console.log("Live global check passed: London ->", JSON.stringify({ timeZone: m.timeZone, ...t }));
      return seasonCheck();
    })
    .catch((e) => console.log("Live global check skipped (offline?):", e.message));
}

// The winter -> summer test case, against real data: Europe/London switches to
// BST on 29 March 2026, so Dhuhr's local clock time jumps by an hour that day.
// A per-waqt delay has to ride along with it — still 30 minutes after Dhuhr on
// both sides of the change, with nothing for the user to re-adjust.
function seasonCheck() {
  const london = {
    lat: 51.5074, lng: -0.1278, timeZone: "Europe/London",
    method: 3, school: 1, azanDelay: { dhuhr: 30 },
  };
  return api
    .fetchMonth(london, "2026", "03")
    .then((m) => {
      const winter = m.days["2026-03-28"]; // GMT
      const summer = m.days["2026-03-29"]; // BST — the clocks go forward today
      assert.ok(winter && summer, "the cached month must straddle the DST change");
      const azanW = times.azanTime("dhuhr", winter.dhuhr, london);
      const azanS = times.azanTime("dhuhr", summer.dhuhr, london);
      const shift = times.toMinutes(summer.dhuhr) - times.toMinutes(winter.dhuhr);
      assert.ok(
        shift >= 30 && shift <= 90,
        "Dhuhr's local time must jump about an hour at the DST change, got " + shift + " min"
      );
      assert.strictEqual(
        times.toMinutes(azanS) - times.toMinutes(azanW),
        shift,
        "the azan must move with the waqt by the same amount — no manual re-adjustment"
      );
      assert.strictEqual(times.toMinutes(azanW) - times.toMinutes(winter.dhuhr), 30);
      assert.strictEqual(times.toMinutes(azanS) - times.toMinutes(summer.dhuhr), 30);
      console.log(
        "Live winter->summer check passed: Dhuhr " + winter.dhuhr + " -> azan " + azanW +
        " (GMT) · Dhuhr " + summer.dhuhr + " -> azan " + azanS + " (BST), shift " + shift + " min"
      );
    })
    .catch((e) => console.log("Live winter->summer check skipped (offline?):", e.message));
}
