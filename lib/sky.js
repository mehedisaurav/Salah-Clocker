/* Sky scene per local time of day — drives the widget's photo background. */
(function (root, factory) {
  let times;
  if (typeof module === "object" && module.exports) {
    times = require("./times.js");
  } else {
    times = root.SalatTimes;
  }
  const api = factory(times);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SalatSky = api;
})(typeof self !== "undefined" ? self : globalThis, function (times) {
  "use strict";

  // Scenes map to assets/sky/<scene>.jpg with CSS gradient fallbacks.
  const SCENES = ["night", "fajr", "sunrise", "day", "afternoon", "maghrib"];

  function sceneFor(today, now) {
    if (!today) return "day";
    const min = times.nowMinutes(now);
    const at = (w) => times.toMinutes(today[w]);
    if (min < at("fajr") || min >= at("isha")) return "night"; // deep night
    if (min < at("sunrise")) return "fajr";                   // dawn twilight
    if (min < at("dhuhr")) return "sunrise";                  // morning sky
    if (min < at("asr")) return "day";                        // midday
    if (min < at("maghrib")) return "afternoon";
    return "maghrib";                                         // sunset to Isha
  }

  return { SCENES, sceneFor };
});
