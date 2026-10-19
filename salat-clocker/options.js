/* Settings page: location (lat/lng, detect or typed), method, toggles,
   azan audio, theme. */
"use strict";

const $ = (id) => document.getElementById(id);

let settings = null;
let dayTimings = null; // today's true waqt times, once known (see loadDayTimings)

init();

async function init() {
  settings = await SalatStorage.getSettings();
  SalatUi.applyTheme(settings);

  // Location: a plain latitude/longitude pair — anywhere on earth. Saving it
  // clears the resolved timezone so the service worker looks it up again.
  $("lat").value = settings.lat;
  $("lng").value = settings.lng;
  $("detect").addEventListener("click", detectLocation);
  $("save-location").addEventListener("click", saveLocation);
  showLocationHint();

  // Calculation method — listed in the intended order (default first).
  const methodSel = $("method");
  methodSel.innerHTML = SalatApi.METHOD_LIST
    .map((m) => '<option value="' + m.id + '">' + m.label + "</option>")
    .join("");
  methodSel.value = String(settings.method);
  methodSel.addEventListener("change", () => save({ method: Number(methodSel.value) }));

  // Asr school (Hanafi vs Standard).
  $("school").value = String(settings.school == null ? 1 : settings.school);
  $("school").addEventListener("change", () => save({ school: Number($("school").value) }));

  // Azan timing: the three waqts the user may choose to answer a little later.
  SalatTimes.setTimeZone(settings.timeZone);
  renderAzanDelays();
  $("delays").addEventListener("input", onDelayPreview);
  $("delays").addEventListener("change", onDelayChange);
  // Dhuhr's window ends where Asr gets close, so it wants today's timetable.
  // Best effort: the rows above already work with a fixed window.
  loadDayTimings().then((day) => {
    dayTimings = day;
    renderAzanDelays();
    updateDelayHint();
  });

  // Per-waqt notification toggles.
  $("toggles").innerHTML = SalatTimes.NOTIFIABLE
    .map(
      (w) =>
        '<label class="toggle"><input type="checkbox" data-waqt="' + w + '"' +
        (settings.enabled[w] ? " checked" : "") + "> " + SalatTimes.LABELS[w] + "</label>"
    )
    .join("");
  $("toggles").addEventListener("change", (e) => {
    const box = e.target;
    if (box.type !== "checkbox") return;
    const enabled = Object.assign({}, settings.enabled);
    enabled[box.dataset.waqt] = box.checked;
    save({ enabled: enabled });
  });

  // Azan audio is the bundled assets/audio/Azan-Madina.mp3 — nothing to set up.

  // Volume.
  $("volume").value = Math.round(settings.volume * 100);
  $("volume-value").textContent = Math.round(settings.volume * 100) + "%";
  $("volume").addEventListener("input", () => {
    $("volume-value").textContent = $("volume").value + "%";
    save({ volume: Number($("volume").value) / 100 });
  });

  // Snooze / lead time.
  $("snooze").value = String(settings.snoozeMinutes);
  $("snooze").addEventListener("change", () =>
    save({ snoozeMinutes: Number($("snooze").value) })
  );
  $("lead").value = String(settings.leadMinutes);
  $("lead").addEventListener("change", () =>
    save({ leadMinutes: Number($("lead").value) })
  );

  // Prohibited (makrūh) frames, in minutes.
  for (const key of ["sunrise", "zawal", "sunset"]) {
    const el = $("makruh-" + key);
    el.value = settings["makruh" + key.charAt(0).toUpperCase() + key.slice(1)];
    el.addEventListener("change", () => {
      const patch = {};
      patch["makruh" + key.charAt(0).toUpperCase() + key.slice(1)] = Number(el.value) || 0;
      save(patch);
    });
  }

  // Daily hadith during the azan.
  $("hadith-enabled").checked = settings.hadithEnabled !== false;
  $("hadith-enabled").addEventListener("change", () => {
    save({ hadithEnabled: $("hadith-enabled").checked });
  });
  // Only English / Bangla are offered; anything else (or a legacy value) -> English.
  $("hadith-lang").value = settings.hadithLang === "bn" ? "bn" : "en";
  $("hadith-lang").addEventListener("change", () => {
    save({ hadithLang: $("hadith-lang").value });
  });
  $("hadith-refresh").addEventListener("click", fetchNewHadith);

  $("test").addEventListener("click", test);
  $("test-alarm").addEventListener("click", testAlarm);
  refreshAlarmStatus();
}

/* ---------- azan timing (Dhuhr, Asr & Isha) ---------- */

// One row per delayable waqt: a toggle to answer a little later, the chosen
// delay as a live readout, and a slider to set it. Off (the default) rings at
// the waqt. The slider runs from the waqt's floor up to its ceiling — for Dhuhr
// that is just before Asr — so the row is rebuilt when the day's timetable
// arrives. A delay Dhuhr's window no longer reaches keeps its own top position
// rather than being silently pulled back (the warning below explains it).
function renderAzanDelays() {
  $("delays").innerHTML = SalatTimes.DELAYABLE.map(azanDelayRow).join("");
}

function azanDelayRow(waqt) {
  const mins = SalatTimes.delayFor(waqt, settings);
  const floor = SalatTimes.delayFloor(waqt);
  const step = SalatTimes.delayStep(waqt);
  const limit = SalatTimes.delayLimit(waqt, dayTimings);
  // Snap the stored value onto the step grid, then let the slider reach it even
  // when it sits past today's ceiling.
  const stored = mins ? floor + Math.round((mins - floor) / step) * step : 0;
  const top = Math.max(limit, stored);
  // While the toggle is off the thumb rests at a modest starting choice.
  const value = mins ? Math.min(top, stored) : Math.min(limit, waqt === "dhuhr" ? 60 : 15);
  const on = mins ? "" : " disabled";
  return (
    '<div class="delays-row">' +
      '<div class="delay-head">' +
        '<label class="toggle"><input type="checkbox" data-delay="' + waqt + '"' +
          (mins ? " checked" : "") + "> " + SalatTimes.LABELS[waqt] + "</label>" +
        '<span class="delay-value' + (mins ? "" : " off") + '" id="delay-value-' + waqt + '">' +
          delayLabel(mins) + "</span>" +
      "</div>" +
      '<input type="range" data-delay-range="' + waqt + '" min="' + floor + '" max="' + top +
        '" step="' + step + '" value="' + value + '"' + on +
        ' aria-label="' + SalatTimes.LABELS[waqt] + ' azan delay">' +
      '<div class="delay-range"><span>' + SalatTimes.formatMinutes(floor) + "</span><span>" +
        SalatTimes.formatMinutes(top) + "</span></div>" +
    "</div>"
  );
}

function delayLabel(mins) {
  return mins ? SalatTimes.formatMinutes(mins) : "at the waqt";
}

// Live readout while the handle is being dragged — nothing is written yet.
function onDelayPreview(e) {
  if (!e.target.dataset.delayRange) return;
  const waqt = e.target.dataset.delayRange;
  setDelayValue(waqt, Number(e.target.value));
}

function setDelayValue(waqt, mins) {
  const el = $("delay-value-" + waqt);
  if (!el) return;
  el.textContent = delayLabel(mins);
  el.classList.toggle("off", !mins);
}

async function onDelayChange(e) {
  const el = e.target;
  const waqt = el.dataset.delay || el.dataset.delayRange;
  if (!waqt) return;
  const next = Object.assign({}, settings.azanDelay);
  const slider = $("delays").querySelector('[data-delay-range="' + waqt + '"]');
  if (el.dataset.delay) {
    next[waqt] = el.checked ? Number(slider.value) : 0;
    slider.disabled = !el.checked;
  } else {
    next[waqt] = Number(el.value);
  }
  setDelayValue(waqt, next[waqt]);
  await save({ azanDelay: next });
  updateDelayHint();
}

// Today's true waqt times: from the cached month when the service worker has
// already fetched it, otherwise fetched once here so Dhuhr's window is exact.
// Returns null when neither works (offline with an empty cache).
async function loadDayTimings() {
  const key = SalatStorage.cacheKey(settings);
  let data = await SalatStorage.getCache(key);
  if (!data) {
    try {
      const ym = SalatTimes.yearMonth();
      data = await SalatApi.fetchMonth(settings, ym.year, ym.month);
      // Only store it under a real timezone key: right after a location change
      // the timezone is still blank, and the service worker re-resolves it
      // within seconds — a key built from a guess would only linger.
      if (settings.timeZone) await SalatStorage.setCache(key, data);
    } catch (e) {
      return null;
    }
  }
  return (data && data.days && data.days[SalatTimes.dateKey()]) || null;
}

// Spell out what the chosen delays mean for today, and warn — without changing
// anything — when a delay no longer fits the day's window.
function updateDelayHint() {
  const hint = $("delay-hint");
  const warn = $("delay-warn");
  SalatTimes.setTimeZone(settings.timeZone);
  const active = SalatTimes.DELAYABLE.filter((w) => SalatTimes.delayFor(w, settings) > 0);
  if (!active.length) {
    hint.textContent = "";
    warn.textContent = "";
    return;
  }
  if (!dayTimings) {
    hint.textContent = active
      .map(
        (w) =>
          SalatTimes.LABELS[w] + " azan " +
          SalatTimes.formatMinutes(SalatTimes.delayFor(w, settings)) + " after the waqt"
      )
      .join(" · ");
    warn.textContent = "";
    return;
  }
  hint.textContent = active
    .map(
      (w) =>
        SalatTimes.LABELS[w] + " " + SalatTimes.formatTime12(dayTimings[w]) +
        " → azan " + SalatTimes.formatTime12(SalatTimes.azanTime(w, dayTimings[w], settings))
    )
    .join(" · ");
  warn.textContent = active
    .map((w) => SalatTimes.delayConflict(w, SalatTimes.delayFor(w, settings), dayTimings))
    .filter(Boolean)
    .map(describeConflict)
    .join(" ");
}

// "⚠ Dhuhr +4h 00m would play at 3:44 PM — inside the 30 min before Asr
//  (3:56 PM). Use 3h 42m or less." The delay itself is left as the user set it.
function describeConflict(c) {
  const late = c.margin
    ? "inside the " + SalatTimes.formatMinutes(c.margin) + " before " + SalatTimes.LABELS[c.next]
    : "at or after " + SalatTimes.LABELS[c.next];
  return (
    "⚠ " + SalatTimes.LABELS[c.waqt] + " +" + SalatTimes.formatMinutes(c.delay) +
    " would play at " + SalatTimes.formatTime12(c.azanTime) + " — " + late +
    " (" + SalatTimes.formatTime12(c.nextTime) + "). Use " +
    SalatTimes.formatMinutes(c.ceiling) + " or less."
  );
}

/* ---------- daily hadith ---------- */

async function fetchNewHadith() {
  const hint = $("hadith-hint");
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) {
    hint.textContent = "Hadith is fetched inside the extension";
    return;
  }
  hint.textContent = "Fetching…";
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ type: "refresh-hadith" });
  } catch (e) {
    res = null;
  }
  if (!res || !res.hadith) {
    hint.textContent = "Could not fetch a hadith — the last one stays in use";
    return;
  }
  hint.textContent =
    "Today: " + (res.hadith.reference || res.hadith.collection) +
    (res.hadith.fallback ? " (bundled fallback)" : "");
}

/* ---------- test + status ---------- */

async function testAlarm() {
  // Schedules a real chrome.alarm one minute out — exercises the exact
  // pipeline a waqt uses (alarm -> popup window + notification + azan).
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) {
    $("alarm-status").textContent = "Only works inside the extension";
    return;
  }
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ type: "test-alarm" });
  } catch (e) {
    res = null;
  }
  if (!res || !res.ok) {
    $("alarm-status").textContent =
      "Service worker did NOT respond — reload the extension at chrome://extensions";
    return;
  }
  $("alarm-status").textContent =
    "Test alarm scheduled — the popup + azan will fire in ~1 minute";
  setTimeout(refreshAlarmStatus, 75000);
}

async function refreshAlarmStatus() {
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) {
    $("alarm-status").textContent = "Alarm status is shown inside the extension";
    return;
  }
  const status = await chrome.runtime.sendMessage({ type: "get-alarm-status" });
  if (!status) {
    $("alarm-status").textContent = "Service worker not reachable — reload the extension";
    return;
  }
  $("alarm-status").textContent =
    status.scheduled + " alarm(s) scheduled · next: " +
    (status.next ? status.next.label + " " + status.next.time : "none") +
    (status.hasCache ? "" : " · NO cached times yet");
}

async function save(patch) {
  settings = await SalatStorage.saveSettings(patch);
  const el = $("status");
  el.textContent = "Saved ✓";
  clearTimeout(el._t);
  el._t = setTimeout(() => {
    el.textContent = "";
  }, 1500);
  return settings;
}

/* ---------- location ---------- */

function locationHint(s) {
  const where = SalatTimes.locationLabel(s.place, s.lat, s.lng);
  return "Times are shown in " + s.timeZone + " — " + where + ".";
}

function showLocationHint() {
  if (settings.timeZone) {
    $("city-hint").textContent = locationHint(settings);
    // The city name is resolved in the background; pick it up when it lands.
    if (!settings.place) refreshLocationHint(0);
    return;
  }
  $("city-hint").textContent = "Looking up this location's timezone…";
  refreshLocationHint(0);
}

// The service worker (or the popup) resolves and stores the timezone and the
// city name; poll briefly for both, then say so plainly rather than spinning.
async function refreshLocationHint(attempt) {
  attempt = attempt || 0;
  const fresh = await SalatStorage.getSettings();
  if (fresh.timeZone && fresh.place) {
    settings = fresh;
    $("city-hint").textContent = locationHint(fresh);
    return;
  }
  if (attempt < 6) {
    setTimeout(() => refreshLocationHint(attempt + 1), 1500);
    return;
  }
  if (fresh.timeZone) {
    settings = fresh;
    $("city-hint").textContent = locationHint(fresh);
    return;
  }
  $("city-hint").textContent =
    "Saved. The timezone will be resolved automatically when you are online.";
}

function readLocation() {
  const lat = Number($("lat").value);
  const lng = Number($("lng").value);
  if (!SalatTimes.isValidLat(lat)) {
    $("city-hint").textContent = "Latitude must be a number between -90 and 90";
    return null;
  }
  if (!SalatTimes.isValidLng(lng)) {
    $("city-hint").textContent = "Longitude must be a number between -180 and 180";
    return null;
  }
  return { lat: lat, lng: lng };
}

async function saveLocation() {
  const at = readLocation();
  if (!at) return;
  await saveNewLocation(at.lat, at.lng);
  $("city-hint").textContent =
    "Saved " + SalatTimes.formatLatLng(at.lat, at.lng) + " — looking up the place…";
  await resolveNow();
}

// Store the new coordinates and forget the old timezone/city name, so the next
// lookup resolves both afresh for this place.
async function saveNewLocation(lat, lng) {
  settings = await save({ lat: lat, lng: lng, timeZone: "", place: "", placeAt: "" });
  return settings;
}

// Resolve the place name + timezone right here rather than waiting for the
// service worker to wake up, so the hint answers immediately.
async function resolveNow() {
  try {
    settings = await SalatApi.settingsWithLocation(settings);
  } catch (e) {
    // fall through to the plain-language message below
  }
  $("city-hint").textContent = settings.timeZone
    ? locationHint(settings)
    : "Saved. The place and timezone will be resolved when you are online.";
}

function detectLocation() {
  const hint = $("city-hint");
  if (!navigator.geolocation) {
    hint.textContent = "Geolocation is not available in this browser";
    return;
  }
  hint.textContent = "Detecting…";
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lat = Number(pos.coords.latitude.toFixed(4));
      const lng = Number(pos.coords.longitude.toFixed(4));
      $("lat").value = lat;
      $("lng").value = lng;
      await saveNewLocation(lat, lng);
      hint.textContent =
        "Detected " + SalatTimes.formatLatLng(lat, lng) + " — looking up the place…";
      await resolveNow();
    },
    () => {
      hint.textContent = "Location permission denied — enter coordinates manually";
    },
    { timeout: 10000, maximumAge: 600000 }
  );
}

async function test() {
  // In the extension, the service worker drives the full alarm
  // (notification + offscreen azan); locally, play the bundled file here.
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) {
    chrome.runtime.sendMessage({ type: "test" });
    return;
  }
  if (chrome.notifications) {
    chrome.notifications.create("salat-test", {
      type: "basic",
      iconUrl: chrome.runtime.getURL("assets/icons/masjid-128.png"),
      title: "Salat Clocker",
      message: "Azan will play at every waqt.",
    });
  }
  const a = new Audio("assets/audio/Azan-Madina.mp3");
  a.volume = settings.volume;
  a.play().catch(beep);
}

function beep() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  const ctx = new Ctx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.frequency.value = 880;
  gain.gain.value = settings.volume * 0.2;
  osc.start();
  setTimeout(() => {
    osc.stop();
    ctx.close();
  }, 600);
}
