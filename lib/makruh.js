/* Prohibited (makrūh) prayer-time frames: sunrise, Zawāl (midday), sunset.
   Frame durations are user-configurable (minutes), defaults 15 / 10 / 15. */
(function (root, factory) {
  let times;
  if (typeof module === "object" && module.exports) {
    times = require("./times.js");
  } else {
    times = root.SalatTimes;
  }
  const api = factory(times);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SalatMakruh = api;
})(typeof self !== "undefined" ? self : globalThis, function (times) {
  "use strict";

  // Frames: sunrise (after sunrise), zawal (before Dhuhr), sunset (before Maghrib).
  // Zawāl ends at Dhuhr time — praying Dhuhr at its time is permitted.
  function frames(today, settings) {
    if (!today) return [];
    const s = settings || {};
    const sunriseMins = s.makruhSunrise == null ? 15 : s.makruhSunrise;
    const zawalMins = s.makruhZawal == null ? 10 : s.makruhZawal;
    const sunsetMins = s.makruhSunset == null ? 15 : s.makruhSunset;

    const out = [];
    if (sunriseMins > 0) {
      out.push({
        key: "sunrise",
        label: "Time of sunrise",
        start: today.sunrise,
        end: times.addMinutes(today.sunrise, sunriseMins),
      });
    }
    if (zawalMins > 0) {
      out.push({
        key: "zawal",
        label: "Zawāl (midday)",
        start: times.addMinutes(today.dhuhr, -zawalMins),
        end: today.dhuhr,
      });
    }
    if (sunsetMins > 0) {
      out.push({
        key: "sunset",
        label: "Time of sunset",
        start: times.addMinutes(today.maghrib, -sunsetMins),
        end: today.maghrib,
      });
    }
    return out;
  }

  // The frame currently in effect (if any), given the local time.
  function currentFrame(list, now) {
    if (!list || !list.length) return null;
    const nowMin = times.nowMinutes(now);
    for (const f of list) {
      if (nowMin >= times.toMinutes(f.start) && nowMin < times.toMinutes(f.end)) return f;
    }
    return null;
  }

  // Which waqt a frame overlaps, used to signal the matching panel.
  const FRAME_WAQT = { sunrise: "sunrise", zawal: "dhuhr", sunset: "maghrib" };

  return { frames, currentFrame, FRAME_WAQT };
});
