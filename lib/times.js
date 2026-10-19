/* Waqt time logic: parsing, local "now" (any timezone), next-waqt, countdown.
   The timezone comes from the user's saved location, so the same clock serves
   Bangladesh or anywhere else on earth. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SalatTimes = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  // The timezone every clock calculation runs in. It is set from the user's
  // saved location (its IANA name, resolved from the coordinates) and falls
  // back to the device timezone until then. DST is handled by Intl.
  let TZ = null;

  function deviceTimeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch (e) {
      return "UTC";
    }
  }

  // Point the clock at a location's timezone ("Europe/London"); empty/invalid
  // falls back to the device's own timezone.
  function setTimeZone(tz) {
    TZ = tz || deviceTimeZone();
    return TZ;
  }

  function timeZone() {
    return TZ || deviceTimeZone();
  }
  // Display order. Sunrise is informational only (no notification).
  const WAQT_ORDER = ["fajr", "sunrise", "dhuhr", "asr", "maghrib", "isha"];
  const NOTIFIABLE = ["fajr", "dhuhr", "asr", "maghrib", "isha"];

  // Waqts whose azan the user may deliberately answer a little later. It is
  // common practice to wait after Dhuhr, Asr and Isha; Fajr and Maghrib are left
  // out because those two are meant to be answered as soon as they begin.
  //
  // Dhuhr is the special one: it is often answered noticeably later, so its
  // choices start at 30 minutes and run up to just before Asr, leaving a
  // 30-minute clearance. `next` names the waqt the ceiling is measured against,
  // so Dhuhr's longest delay follows the season by itself. Isha's next waqt is
  // tomorrow's Fajr, far outside the day, so it is capped instead. `fallback` is
  // the fixed window used while the day's timetable is not known yet, and `step`
  // is the size of one notch on the slider — Dhuhr's window is hours wide, so it
  // moves in coarser 15-minute steps.
  const DELAYABLE = ["dhuhr", "asr", "isha"];
  const DELAY_SPEC = {
    dhuhr: { min: 30, max: 360, fallback: 120, step: 15, margin: 30, next: "asr" },
    asr:   { min: 5,  max: 60,  fallback: 60,  step: 5,  margin: 0,  next: "maghrib" },
    isha:  { min: 5,  max: 120, fallback: 120, step: 5,  margin: 0,  next: null },
  };
  const ALADHAN_KEY = {
    fajr: "Fajr", sunrise: "Sunrise", dhuhr: "Dhuhr",
    asr: "Asr", maghrib: "Maghrib", isha: "Isha",
  };
  const LABELS = {
    fajr: "Fajr", sunrise: "Sunrise", dhuhr: "Dhuhr",
    asr: "Asr", maghrib: "Maghrib", isha: "Isha",
  };

  // Accent / badge color per waqt (readable with white badge text).
  const WAQT_COLORS = {
    fajr: "#5E35B1",      // pre-dawn violet
    sunrise: "#E65100",   // sunrise orange
    dhuhr: "#C49000",     // midday gold
    asr: "#E64A19",       // afternoon ember
    maghrib: "#C62828",   // sunset red
    isha: "#1A237E",      // night indigo
  };

  // Toolbar badge labels (Chrome truncates past 4 characters).
  const BADGE_TEXT = {
    fajr: "Fajr", sunrise: "Sun", dhuhr: "Dhr",
    asr: "Asr", maghrib: "Mgh", isha: "Isha",
  };

  // "04:40 (+06)" -> "04:40"
  function cleanTime(s) {
    return String(s || "").split(" ")[0];
  }

  // Format parts in the location's timezone.
  function tzParts(date, opts) {
    date = date || new Date();
    const parts = new Intl.DateTimeFormat("en-CA", Object.assign({ timeZone: timeZone() }, opts))
      .formatToParts(date);
    const p = {};
    for (const part of parts) p[part.type] = part.value;
    return p;
  }

  // Current date at the location: "YYYY-MM-DD"
  function dateKey(date) {
    const p = tzParts(date, { year: "numeric", month: "2-digit", day: "2-digit" });
    return p.year + "-" + p.month + "-" + p.day;
  }

  // Current year/month at the location, for API queries: { year:"2026", month:"10" }
  function yearMonth(date) {
    const p = tzParts(date, { year: "numeric", month: "2-digit" });
    return { year: p.year, month: p.month };
  }

  // Current minutes since midnight at the location
  function nowMinutes(date) {
    date = date || new Date();
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timeZone(), hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(date);
    const p = {};
    for (const part of parts) p[part.type] = part.value;
    return Number(p.hour) * 60 + Number(p.minute);
  }

  // Aladhan row -> { fajr:"04:40", ... } keyed by WAQT_ORDER
  function timingsFor(row) {
    const out = {};
    for (const w of WAQT_ORDER) out[w] = cleanTime(row.timings[ALADHAN_KEY[w]]);
    return out;
  }

  function toMinutes(t) {
    const pair = t.split(":");
    return Number(pair[0]) * 60 + Number(pair[1]);
  }

  // Next waqt from now. Rolls to the next day's Fajr when today is done.
  function nextWaqt(dayTimings, now, nextDayTimings) {
    now = now || new Date();
    const nowMin = nowMinutes(now);
    for (const w of NOTIFIABLE) {
      if (toMinutes(dayTimings[w]) > nowMin) {
        return { waqt: w, time: dayTimings[w], today: true };
      }
    }
    if (nextDayTimings) return { waqt: "fajr", time: nextDayTimings.fajr, today: false };
    return null;
  }

  // Milliseconds from now until "HH:MM" (rolls to tomorrow if already passed).
  function msUntil(t, now) {
    now = now || new Date();
    const pair = t.split(":");
    const targetMin = Number(pair[0]) * 60 + Number(pair[1]);
    let delta = targetMin - nowMinutes(now);
    if (delta <= 0) delta += 24 * 60;
    return delta * 60 * 1000;
  }

  // Same, but SIGNED: negative when "HH:MM" already passed today.
  // Used for scheduling so a passed waqt is not silently moved to tomorrow.
  function msUntilSigned(t, now) {
    now = now || new Date();
    const pair = t.split(":");
    const targetMin = Number(pair[0]) * 60 + Number(pair[1]);
    return (targetMin - nowMinutes(now)) * 60 * 1000;
  }

  // Exact signed ms until "HH:MM:00" — second precision, so an alarm created
  // just before a waqt fires at the waqt rather than up to a minute late.
  function msUntilSignedExact(t, now) {
    now = now || new Date();
    const pair = t.split(":");
    const targetMs = (Number(pair[0]) * 60 + Number(pair[1])) * 60 * 1000;
    const p = tzParts(now, {
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    const nowMs =
      (Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second)) * 1000 +
      now.getMilliseconds();
    return targetMs - nowMs;
  }

  // "11:44" + 15 -> "11:59"; "04:40" - 15 -> "04:25" (same day, clamped at midnight)
  function addMinutes(t, mins) {
    let total = toMinutes(t) + mins;
    if (total < 0) total += 24 * 60;
    if (total >= 24 * 60) total -= 24 * 60;
    const h = Math.floor(total / 60);
    const m = total % 60;
    return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
  }

  /* ---------- user-set azan delay (Dhuhr, Asr, Isha) ---------- */

  // The shortest delay offered for a waqt: 30 minutes after Dhuhr, 5 after Asr
  // and Isha. Fajr and Maghrib are never delayed.
  function delayFloor(waqt) {
    const spec = DELAY_SPEC[waqt];
    return spec ? spec.min : 0;
  }

  // One notch on the slider, in minutes — 15 for Dhuhr (its window is hours
  // wide), 5 for Asr and Isha.
  function delayStep(waqt) {
    const spec = DELAY_SPEC[waqt];
    return spec ? spec.step : 0;
  }

  // The longest delay that still leaves the waqt's clearance before the next
  // waqt. Measured from the given day, so it follows the season on its own: on a
  // short winter day Dhuhr→Asr is narrow and the ceiling comes down with it.
  // Falls back to the fixed window while that day is not known.
  function delayCeiling(waqt, day) {
    const spec = DELAY_SPEC[waqt];
    if (!spec) return 0;
    if (!spec.next || !day || !day[waqt] || !day[spec.next]) return spec.fallback;
    const gap = toMinutes(day[spec.next]) - toMinutes(day[waqt]);
    return Math.max(spec.min, Math.min(spec.max, gap - spec.margin));
  }

  // The largest delay the slider can actually settle on: the day's ceiling
  // rounded down to a whole step, counted from the floor. Never below the floor.
  function delayLimit(waqt, day) {
    const floor = delayFloor(waqt);
    const step = delayStep(waqt);
    if (!step) return delayCeiling(waqt, day);
    return floor + Math.floor((delayCeiling(waqt, day) - floor) / step) * step;
  }

  // How many minutes after the waqt this waqt's azan plays. 0 means "at the
  // waqt" — the default, and the only answer for Fajr and Maghrib.
  //
  // The value is held inside the waqt's absolute window. A value that no longer
  // fits *today's* window is deliberately left alone: the settings page warns
  // about it rather than quietly changing what the user asked for.
  function delayFor(waqt, settings) {
    const spec = DELAY_SPEC[waqt];
    if (!spec) return 0;
    const map = (settings && settings.azanDelay) || {};
    const n = Math.round(Number(map[waqt]) || 0);
    if (!(n > 0)) return 0;
    return Math.min(spec.max, Math.max(spec.min, n));
  }

  // A delay that no longer fits that day, described for the settings page, or
  // null when it is fine. Dhuhr has to clear Asr by `margin` minutes; Asr has to
  // stay clear of Maghrib. (Isha's next waqt is tomorrow's Fajr, which is not in
  // this day's timings, so it is not checked.)
  function delayConflict(waqt, mins, day) {
    const spec = DELAY_SPEC[waqt];
    if (!spec || !spec.next || !mins || !day || !day[waqt] || !day[spec.next]) return null;
    const azanAt = toMinutes(day[waqt]) + mins;
    const limit = toMinutes(day[spec.next]) - spec.margin;
    if (azanAt <= limit) return null;
    return {
      waqt: waqt,
      next: spec.next,
      delay: mins,
      margin: spec.margin,
      waqtTime: day[waqt],
      nextTime: day[spec.next],
      azanTime: addMinutes(day[waqt], mins),
      limitTime: addMinutes(day[spec.next], -spec.margin),
      ceiling: delayLimit(waqt, day),
    };
  }

  // The clock time the azan actually plays for a waqt.
  //
  // The delay is added to the waqt's own *local* clock time, which is what makes
  // it survive the winter/summer change with nothing to re-adjust: if Dhuhr is
  // 12:10 in January and 13:10 in June, a 30-minute delay gives 12:40 and 13:40.
  // A fixed clock time could not do that — it would have to be edited twice a
  // year (and a DST shift moves the clock, not the sun).
  function azanTime(waqt, waqtTime, settings) {
    const delay = delayFor(waqt, settings);
    return delay ? addMinutes(waqtTime, delay) : waqtTime;
  }

  // A day's timings with each delayable waqt moved to its azan time. Everything
  // that schedules or counts down (alarms, badge "next", the popup countdown)
  // runs on this; the waqt list keeps the true times so the user can still see
  // exactly when the waqt itself begins.
  function azanTimes(day, settings) {
    if (!day) return day;
    const out = {};
    for (const k of Object.keys(day)) out[k] = day[k];
    for (const w of DELAYABLE) {
      if (out[w]) out[w] = azanTime(w, out[w], settings);
    }
    return out;
  }

  function formatCountdown(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return h + "h " + String(m).padStart(2, "0") + "m";
    return m + "m " + String(s).padStart(2, "0") + "s";
  }

  // 45 -> "45 min", 90 -> "1h 30m", 240 -> "4h 00m"
  function formatMinutes(mins) {
    const total = Math.max(0, Math.round(mins));
    const h = Math.floor(total / 60);
    return h ? h + "h " + String(total % 60).padStart(2, "0") + "m" : total + " min";
  }

  // "15:06" -> "3:06 PM"
  function formatTime12(t) {
    const pair = t.split(":");
    const h24 = Number(pair[0]);
    let h = h24 % 12;
    if (h === 0) h = 12;
    return h + ":" + String(pair[1]).padStart(2, "0") + " " + (h24 < 12 ? "AM" : "PM");
  }

  // A coordinate as "23.81° N" (the heading tells you which hemisphere).
  function formatCoord(value, positive, negative) {
    const n = Number(value);
    if (!isFinite(n)) return "—";
    return Math.abs(n).toFixed(2) + "° " + (n >= 0 ? positive : negative);
  }

  // A lat/lng pair as "23.81° N, 90.41° E" — the popup's location label.
  function formatLatLng(lat, lng) {
    return formatCoord(lat, "N", "S") + ", " + formatCoord(lng, "E", "W");
  }

  // A readable "where" for the settings hint: the resolved city name followed
  // by the coordinates ("London (51.51° N, 0.13° W)"), or just the coordinates
  // when the place is not known yet.
  function locationLabel(place, lat, lng) {
    const at = formatLatLng(lat, lng);
    return place ? place + " (" + at + ")" : at;
  }

  // Valid ranges; used by the settings page before saving a location.
  // Blank input is invalid (Number("") would otherwise read as 0).
  function inRange(n, min, max) {
    if (n === "" || n === null || n === undefined) return false;
    if (String(n).trim() === "") return false;
    const v = Number(n);
    return isFinite(v) && v >= min && v <= max;
  }
  function isValidLat(n) {
    return inRange(n, -90, 90);
  }
  function isValidLng(n) {
    return inRange(n, -180, 180);
  }

  return {
    WAQT_ORDER, NOTIFIABLE, ALADHAN_KEY, LABELS,
    DELAYABLE, DELAY_SPEC,
    WAQT_COLORS, BADGE_TEXT,
    setTimeZone, timeZone, deviceTimeZone,
    cleanTime, dateKey, yearMonth, tzParts, nowMinutes, timingsFor,
    toMinutes, addMinutes, nextWaqt, msUntil, msUntilSigned, msUntilSignedExact,
    delayFor, delayFloor, delayStep, delayCeiling, delayLimit, delayConflict,
    azanTime, azanTimes,
    formatCountdown, formatTime12, formatMinutes, formatLatLng, formatCoord, locationLabel,
    isValidLat, isValidLng,
  };
});
