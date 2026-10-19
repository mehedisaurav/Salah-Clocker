/* Popup UI: natural sky background per waqt, current + next waqt, inline grid,
   azan alarm banner (snooze/stop) and prohibited (makrūh) time signals. */
"use strict";

const $ = (id) => document.getElementById(id);

let settings = null;
let data = null; // cached or freshly fetched month
let activeAlarm = null; // { waqt, startedAt } while the azan plays

// CSS-gradient fallbacks while photos load (or if one is missing).
const GRADIENTS = {
  night: "linear-gradient(180deg,#0b1026,#1a237e)",
  fajr: "linear-gradient(180deg,#241b4d,#a34a6b)",
  sunrise: "linear-gradient(180deg,#5b87b8,#f2b45c)",
  day: "linear-gradient(180deg,#2f6fb2,#4fa3d8)",
  afternoon: "linear-gradient(180deg,#2a5a80,#c17b2d)",
  maghrib: "linear-gradient(180deg,#3b2b63,#c0392b)",
};

init();

async function init() {
  settings = await SalatStorage.getSettings();
  SalatUi.applyTheme(settings); // base color behind the sky layer
  setLocationLabel(); // coordinates straight away…
  await ensureMonth(); // …then the resolved timezone + city name, and the month
  setLocationLabel();

  // Alarm banner controls.
  activeAlarm = await SalatStorage.getCache("activeAlarm");
  $("alarm-snooze").addEventListener("click", () => alarmAction("snooze"));
  $("alarm-stop").addEventListener("click", () => alarmAction("stop"));

  // Service worker updates the alarm state; mirror it here. A location or
  // calculation change from the settings panel reloads everything live.
  if (typeof chrome !== "undefined" && chrome.storage) {
    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area !== "local") return;
      if (changes.activeAlarm) {
        activeAlarm = changes.activeAlarm.newValue || null;
        tick();
      }
      if (changes.lat || changes.lng || changes.method || changes.school ||
          changes.timeZone || changes.place || changes.azanDelay) {
        settings = await SalatStorage.getSettings();
        SalatTimes.setTimeZone(settings.timeZone);
        setLocationLabel();
        await ensureMonth();
        tick();
      }
    });
  }

  $("full").addEventListener("click", () => {
    $("all-waqt").hidden = false;
    $("footer-main").hidden = true;
    document.body.classList.add("expanded"); // Now/Next panels step aside
    tick(); // render the grid immediately
  });
  $("hide").addEventListener("click", () => {
    $("all-waqt").hidden = true;
    $("footer-main").hidden = false;
    document.body.classList.remove("expanded");
  });

  // Settings: slide the options page in over the widget.
  const panel = $("settings-panel");
  document.querySelectorAll(".settings-btn").forEach((btn) =>
    btn.addEventListener("click", () => panel.classList.add("open"))
  );
  $("settings-back").addEventListener("click", () => panel.classList.remove("open"));

  tick();
  setInterval(async () => {
    // Poll the alarm state (set by the service worker) so the popup
    // stays in sync even when storage events don't fire.
    activeAlarm = await SalatStorage.getCache("activeAlarm");
    tick();
  }, 1000);
}

async function ensureMonth() {
  // Resolve the location's timezone + city before anything reads the clock.
  settings = await SalatApi.settingsWithLocation(settings);
  SalatTimes.setTimeZone(settings.timeZone);
  const key = SalatStorage.cacheKey(settings);
  data = await SalatStorage.getCache(key);
  if (data) return;
  try {
    const ym = SalatTimes.yearMonth();
    data = await SalatApi.fetchMonth(settings, ym.year, ym.month);
    await SalatStorage.setCache(key, data);
  } catch (e) {
    console.error(e);
    data = null;
  }
}

// The location label: the resolved city name on top, its coordinates beneath
// (or just the coordinates when the place is not known yet).
function setLocationLabel() {
  const at = SalatTimes.formatLatLng(settings.lat, settings.lng);
  const place = settings.place || "";
  $("city-name").textContent = place || at;
  $("city-coords").textContent = place ? at : "";
  $("city-coords").hidden = !place;
}

let lastScene = null;

function tick() {
  const now = new Date();
  // 12-hour clock, no seconds, in the location's local time.
  $("clock").textContent = new Intl.DateTimeFormat("en-US", {
    timeZone: SalatTimes.timeZone(), hour: "numeric", minute: "2-digit", hourCycle: "h12",
  }).format(now);
  $("gdate").textContent = new Intl.DateTimeFormat("en-GB", {
    timeZone: SalatTimes.timeZone(),
    weekday: "short", day: "numeric", month: "short", year: "numeric",
  }).format(now);

  let today = null;
  let azan = null;
  let next = null;
  let current = null;
  let tomorrow = null;

  if (data) {
    // Hijri date for today, from the cached month.
    today = data.days[SalatTimes.dateKey(now)];
    if (today && today.hijri) {
      const h = today.hijri.split("-"); // "DD-MM-YYYY"
      $("hijri").textContent =
        "Hijri " + h[0] + " " + (today.hijriMonth || "") + " " + h[2];
    }
    tomorrow = data.days[SalatTimes.dateKey(new Date(now.getTime() + 24 * 60 * 60 * 1000))];
    // The countdown and the alarms follow the azan time (the waqt plus whatever
    // delay the user set); `today` keeps the true waqt times for display.
    azan = SalatTimes.azanTimes(today, settings);
    next = azan
      ? SalatTimes.nextWaqt(azan, now, SalatTimes.azanTimes(tomorrow, settings))
      : null;

    // Current = last waqt that has started (the prayer period we are in).
    if (today) {
      const nowMin = SalatTimes.nowMinutes(now);
      for (const w of SalatTimes.NOTIFIABLE) {
        if (SalatTimes.toMinutes(today[w]) <= nowMin) current = w;
      }
    }
  }

  // Natural sky background, switched by waqt time.
  const scene = SalatSky.sceneFor(today, now);
  if (scene !== lastScene) {
    lastScene = scene;
    applySky(scene);
  }

  // Sunrise (left) and sunset (right) beside the current time.
  if (today) {
    $("sunrise-time").textContent = SalatTimes.formatTime12(today.sunrise);
    $("sunset-time").textContent = SalatTimes.formatTime12(today.maghrib);
  } else {
    $("sunrise-time").textContent = "--:--";
    $("sunset-time").textContent = "--:--";
  }

  renderAlarm(alarmWaqtFor(activeAlarm));
  renderProhibited(
    today ? SalatMakruh.currentFrame(SalatMakruh.frames(today, settings), now) : null
  );

  if (current) {
    const color = SalatTimes.WAQT_COLORS[current];
    $("current-name").textContent = SalatTimes.LABELS[current];
    $("current-time").textContent = SalatTimes.formatTime12(today[current]);
    $("current-card").style.borderLeftColor = color;
    $("current-name").style.color = color;
  } else {
    $("current-name").textContent = "—";
    $("current-time").textContent = "";
    $("current-card").style.borderLeftColor = "";
    $("current-name").style.color = "";
  }

  if (next) {
    const color = SalatTimes.WAQT_COLORS[next.waqt];
    $("next-name").textContent = SalatTimes.LABELS[next.waqt];
    $("next-time").textContent = SalatTimes.formatTime12(next.time);
    $("countdown").textContent =
      "in " + SalatTimes.formatCountdown(SalatTimes.msUntil(next.time, now));
    $("next-card").style.borderLeftColor = color;
    $("next-name").style.color = color;
    // Flag an azan the user delayed, so the time shown is not read as the
    // start of the waqt.
    const delay = SalatTimes.delayFor(next.waqt, settings);
    const chip = $("next-delay");
    chip.hidden = !delay;
    chip.textContent = delay ? "+" + SalatTimes.formatMinutes(delay) : "";
    chip.title =
      delay && next.today
        ? SalatTimes.LABELS[next.waqt] + " begins at " +
          SalatTimes.formatTime12(today[next.waqt]) + " — the azan plays " +
          SalatTimes.formatMinutes(delay) + " later."
        : "";
  } else {
    $("next-delay").hidden = true;
  }

  renderGrid(today, azan, current, alarmWaqtFor(activeAlarm), frameWaqtOf(today, now));
}

// The waqt currently alarming, if any.
function alarmWaqtFor(alarm) {
  if (!alarm || !alarm.waqt) return null;
  return alarm.waqt;
}

// The waqt affected by a prohibited (makrūh) frame, if any.
function frameWaqtOf(today, now) {
  if (!today) return null;
  const frame = SalatMakruh.currentFrame(SalatMakruh.frames(today, settings), now);
  return frame ? SalatMakruh.FRAME_WAQT[frame.key] : null;
}

// Layer order (top first): scrim, natural photo, gradient fallback.
// The scrim strength and text palette are chosen by measuring the photo's
// top-strip luminance (calibrated: >200 raw -> dark text on a bright sky).
function applySky(scene) {
  const url = "assets/sky/" + scene + ".jpg";
  document.body.style.setProperty("--sky-img", "url('" + url + "')");
  analyzeTopLuminance(url);
}

function analyzeTopLuminance(url, scene) {
  const img = new Image();
  img.onload = () => {
    const n = 32;
    const c = document.createElement("canvas");
    c.width = c.height = n;
    const ctx = c.getContext("2d");
    const h = Math.round(n * 0.3); // top strip: where clock text renders
    ctx.drawImage(img, 0, 0, n, h, 0, 0, n, h);
    const d = ctx.getImageData(0, 0, n, h).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    }
    const avg = sum / (d.length / 4);
    setReadingPalette(avg);
  };
  img.onerror = () => {
    // Photo missing: fall back to the scene's dark gradient.
    document.body.style.setProperty(
      "--sky-img",
      "linear-gradient(180deg,#1a1f3a,#2c3a67)"
    );
    document.body.classList.remove("sky-light");
  };
  img.src = url;
}

function setReadingPalette(topLum) {
  const root = document.body.style;
  if (topLum > 200) {
    // Bright sky (e.g. afternoon): dark text, light scrim.
    document.body.classList.add("sky-light");
    root.setProperty("--sky-scrim", "linear-gradient(rgba(255,255,255,.30), rgba(255,255,255,.42))");
  } else if (topLum > 120) {
    // Mid-bright sky (e.g. dawn): white text, stronger scrim for contrast.
    document.body.classList.remove("sky-light");
    root.setProperty("--sky-scrim", "linear-gradient(rgba(8,12,32,.55), rgba(8,12,32,.68))");
  } else {
    // Dark/dusky sky: white text, standard scrim.
    document.body.classList.remove("sky-light");
    root.setProperty("--sky-scrim", "linear-gradient(rgba(8,12,32,.42), rgba(8,12,32,.58))");
  }
}

/* ---------- azan alarm ---------- */

function renderAlarm(alarmWaqt) {
  const banner = $("alarm");

  if (alarmWaqt) {
    banner.hidden = false;
    $("alarm-text").textContent =
      (SalatTimes.LABELS[alarmWaqt] || alarmWaqt) + " — azan playing";
    $("alarm-snooze").textContent = "Snooze " + (settings.snoozeMinutes || 5) + "m";
  } else {
    banner.hidden = true;
  }

  // Shake + highlight the alarm's waqt panel.
  const alarmLabel = alarmWaqt ? SalatTimes.LABELS[alarmWaqt] || alarmWaqt : null;
  $("current-card").classList.toggle("alarm", alarmLabel === $("current-name").textContent);
  $("next-card").classList.toggle("alarm", alarmLabel === $("next-name").textContent);
}

function alarmAction(type) {
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) return;
  chrome.runtime.sendMessage({ type: type });
}

/* ---------- prohibited (makrūh) times ---------- */

function renderProhibited(frame) {
  const banner = $("prohibited");

  if (frame) {
    banner.hidden = false;
    $("prohibited-text").textContent =
      frame.label + " — salah not allowed until " +
      SalatTimes.formatTime12(frame.end);
  } else {
    banner.hidden = true;
  }

  // Signal the affected waqt panel in red.
  const frameWaqt = frame ? SalatMakruh.FRAME_WAQT[frame.key] : null;
  const frameLabel = frameWaqt ? SalatTimes.LABELS[frameWaqt] || frameWaqt : null;
  $("current-card").classList.toggle("prohibited", frameLabel === $("current-name").textContent);
  $("next-card").classList.toggle("prohibited", frameLabel === $("next-name").textContent);
}

/* ---------- inline grid of every waqt ---------- */

function renderGrid(today, azan, current, alarmWaqt, frameWaqt) {
  if ($("all-waqt").hidden || !today) return;
  // Five prayer waqt only — sunrise/sunset live beside the clock now.
  $("grid").innerHTML = SalatTimes.NOTIFIABLE
    .map((w) => {
      const color = SalatTimes.WAQT_COLORS[w];
      const cls = [];
      if (w === current) cls.push("current");
      if (w === alarmWaqt) cls.push("alarm");
      if (w === frameWaqt) cls.push("prohibited");
      // A delayed waqt keeps its real time and names the azan time beneath.
      const azanNote =
        azan && azan[w] && azan[w] !== today[w]
          ? '<span class="sazan">azan ' + SalatTimes.formatTime12(azan[w]) + "</span>"
          : "";
      return (
        '<div class="slot ' + cls.join(" ") + '">' +
        '<span class="sname"><span class="scolor" style="background:' + color + '"></span>' +
        SalatTimes.LABELS[w] + "</span>" +
        '<span class="stime">' + SalatTimes.formatTime12(today[w]) + azanNote + "</span>" +
        "</div>"
      );
    })
    .join("");
}
