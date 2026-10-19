/* Service worker — the alarm engine:
   - schedules a one-shot chrome.alarm per waqt from cached Aladhan data
   - on alarm: azan via offscreen document + notification with Snooze/Stop
   - badge shows the CURRENT waqt
   - re-schedules when settings change and at each local midnight */
importScripts("lib/times.js", "lib/storage.js", "lib/api.js", "lib/hadith.js");

const NOTIF_ID = "salat-waqt-alarm";
const MAX_PLAY_MS = 5 * 60 * 1000; // safety cap for azan playback

chrome.runtime.onInstalled.addListener(() => boot());
chrome.runtime.onStartup.addListener(() => boot());
chrome.alarms.onAlarm.addListener(onAlarm);
chrome.notifications.onButtonClicked.addListener(onNotifButton);
// NOTE: deliberately NOT stopping the azan on notifications.onClosed.
// Windows fires onClosed when a notification is dismissed, auto-cleared or
// clicked, which used to cut the azan off abruptly mid-recitation.
chrome.notifications.onClicked.addListener(() => focusAlarmWindow());
chrome.windows.onRemoved.addListener((id) => {
  if (id === alarmWindowId) alarmWindowId = null;
});
chrome.storage.onChanged.addListener((changes) => {
  for (const k of Object.keys(changes)) {
    if (["lat", "lng", "method", "school", "apiKey", "enabled", "snoozeMinutes", "leadMinutes", "azanDelay"].indexOf(k) >= 0) {
      refetchAndReschedule();
      return;
    }
    if (k === "hadithEnabled") {
      ensureDailyHadith(true);
      return;
    }
    if (k === "hadithLang") {
      // Texts are cached; just make sure the newly chosen one is present.
      patchTodayTranslations();
      return;
    }
  }
});
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "snooze") {
    snooze();
    sendResponse({ ok: true });
  } else if (msg.type === "stop") {
    stopAlarm();
    sendResponse({ ok: true });
  } else if (msg.type === "test") {
    startAlarm("Test");
    sendResponse({ ok: true });
  } else if (msg.type === "test-alarm") {
    // Schedule a real alarm one minute out to exercise the whole pipeline.
    const when = Date.now() + 60000;
    chrome.alarms.create("waqt:test", { when: when });
    logDiag("test alarm scheduled", "fires in 60s");
    sendResponse({ ok: true, when: when });
  } else if (msg.type === "get-alarm-status") {
    getAlarmStatus().then((status) => sendResponse(status));
    return true;
  } else if (msg.type === "get-hadith") {
    getHadithForToday()
      .then(withLanguage)
      .then((h) => sendResponse(h));
    return true;
  } else if (msg.type === "refresh-hadith") {
    ensureDailyHadith(true).then(async () => {
      sendResponse({ ok: true, hadith: await SalatStorage.getCache("hadith:today") });
    });
    return true;
  } else if (msg.type === "reschedule") {
    reschedule();
    sendResponse({ ok: true });
  }
});

/* heartbeat state */
let stopTimer = null;
let pendingPlay = null; // play request waiting for the offscreen doc to be ready
let offscreenCreating = false; // true until the new document reports ready
let playSent = false; // guard against double-sending the play request
let alarmWindowId = null; // auto-opened azan popup window
let currentVolume = 0.9; // volume used for the azan (incl. window fallback)

/* ---------- diagnostics ----------
   A small ring buffer in storage so the settings page can show exactly
   what the service worker did — alarms, offscreen creation, audio result.
   This is the ground truth when something is silent. */

async function logDiag(event, detail) {
  try {
    const store = await chrome.storage.local.get("diagLog");
    const log = store.diagLog || [];
    log.push({
      t: new Date().toISOString().slice(11, 19),
      event: event,
      detail: detail == null ? "" : String(detail),
    });
    if (log.length > 80) log.splice(0, log.length - 80);
    await chrome.storage.local.set({ diagLog: log });
  } catch (e) {
    /* diagnostics must never break the alarm */
  }
}

async function boot() {
  await logDiag("boot");
  await ensureMonth();
  await catchUpMissed();
  await scheduleToday();
  await refreshBadge();
  // The daily hadith is deliberately OFF the critical path: a slow or
  // unreachable hadith source must never delay scheduling the waqt alarms.
  ensureDailyHadith();
}

// Settings with the clock pointed at the configured location's timezone, so
// every date/time helper below works in the user's local time (anywhere).
async function loadSettings() {
  const settings = await SalatStorage.getSettings();
  SalatTimes.setTimeZone(settings.timeZone);
  return settings;
}

// A location or calculation change invalidates the month: fetch the new
// location's data first, then re-plan the alarms against it.
async function refetchAndReschedule() {
  await ensureMonth();
  await reschedule();
  await refreshBadge();
}

/* ---------- network helper ---------- */

// fetch() with a hard timeout so an unresponsive host can never wedge the
// service worker (a hung fetch has no timeout of its own).
const FETCH_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, opts, ms) {
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = setTimeout(() => {
    if (ctrl) ctrl.abort();
  }, ms || FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({}, opts, ctrl ? { signal: ctrl.signal } : {}));
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- data ---------- */

async function ensureMonth() {
  // The location's timezone (and city name) has to be known before any date
  // maths or the cache key is computed, so resolve it first (persisted once).
  const settings = await SalatApi.settingsWithLocation(await loadSettings());
  SalatTimes.setTimeZone(settings.timeZone);
  const key = SalatStorage.cacheKey(settings);
  let data = await SalatStorage.getCache(key);
  if (!data) {
    try {
      const ym = SalatTimes.yearMonth();
      data = await SalatApi.fetchMonth(settings, ym.year, ym.month);
      await SalatStorage.setCache(key, data);
      await logDiag("month fetched", key);
      await pruneCalendars(key);
    } catch (e) {
      console.error("month fetch failed", e);
      await logDiag("month fetch FAILED", String(e));
      return null;
    }
  } else {
    await logDiag("month cached", key);
  }
  return data;
}

// Drop cached months for other locations/methods — they can never be reused,
// so a globetrotter (or a method-hopper) would otherwise pile them up.
async function pruneCalendars(keepKey) {
  try {
    const all = await chrome.storage.local.get(null);
    const stale = Object.keys(all).filter(
      (k) => k.indexOf("cal:") === 0 && k !== keepKey
    );
    if (stale.length) await chrome.storage.local.remove(stale);
  } catch (e) {
    /* best effort — a leftover cache is harmless */
  }
}

/* ---------- daily hadith ---------- */

let hadithFetching = false;

// Fill in any missing translation for a hadith (numbering matches sunnah.com).
async function fillTranslations(hadith) {
  if (!hadith || !hadith.collection || !hadith.number) return hadith;
  if (!hadith.bangla) {
    try {
      const url = SalatHadith.apiEditionUrl("bn", hadith.collection, hadith.number);
      if (url) {
        const res = await fetchWithTimeout(url, { credentials: "omit", cache: "no-store" });
        if (res.ok) hadith.bangla = SalatHadith.parseApiJson(await res.json());
      }
    } catch (e) {
      await logDiag("bangla fetch failed", String(e));
    }
  }
  return hadith;
}

// Add the chosen language's text to a hadith before sending it to the popup.
async function withLanguage(hadith) {
  if (!hadith) return null;
  const settings = await loadSettings();
  const lang = settings.hadithLang || "en";
  return Object.assign({}, hadith, {
    lang: lang,
    translation: SalatHadith.translationFor(hadith, lang),
  });
}

// Backfill the chosen language onto the cached hadith (e.g. after a settings change).
async function patchTodayTranslations() {
  const h = await SalatStorage.getCache("hadith:today");
  if (!h) return;
  await fillTranslations(h);
  await SalatStorage.setCache("hadith:today", h);
}

// Fetch (once per local day) a single authentic hadith, avoiding any shown in
// the last 15 days. Falls back to the last/bundled one if the source fails.
async function ensureDailyHadith(force) {
  const settings = await loadSettings();
  if (!settings.hadithEnabled) return;
  const today = SalatTimes.dateKey();
  const current = await SalatStorage.getCache("hadith:today");
  if (!force && current && current.date === today) return;
  if (hadithFetching) return;
  hadithFetching = true;
  try {
    const now = Date.now();
    let history = SalatHadith.pruneHistory(await SalatStorage.getCache("hadith:history"), now);
    let hadith = null;
    // The endpoint returns a random hadith; re-roll if it was shown recently.
    for (let attempt = 0; attempt < 10 && !hadith; attempt++) {
      try {
        const res = await fetchWithTimeout(SalatHadith.SOURCE_URL, {
          credentials: "omit",
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        if (!res.ok) {
          await logDiag("hadith fetch HTTP " + res.status, SalatHadith.SOURCE_URL);
          continue;
        }
        const parsed = SalatHadith.parseUmmahJson(await res.json());
        if (!parsed || !parsed.english) {
          await logDiag("hadith parse came back empty");
          continue;
        }
        if (!SalatHadith.isAcceptableGrade(parsed.grade)) {
          await logDiag("hadith grade is weak, re-rolling", parsed.grade);
          continue;
        }
        if (history[parsed.id]) {
          await logDiag("hadith already shown recently, re-rolling", parsed.id);
          continue;
        }
        hadith = Object.assign(parsed, { date: today, fetchedAt: now });
      } catch (e) {
        // A network error will not fix itself by retrying — stop here.
        await logDiag("hadith fetch failed", String(e));
        break;
      }
    }
    if (!hadith) {
      hadith = Object.assign({}, SalatHadith.FALLBACK, {
        date: today, fetchedAt: now, fallback: true,
      });
      await logDiag("hadith using bundled fallback");
    }
    await fillTranslations(hadith);
    await SalatStorage.setCache("hadith:today", hadith);
    history[hadith.id] = now;
    await SalatStorage.setCache("hadith:history", SalatHadith.pruneHistory(history, now));
    await logDiag("hadith ready", hadith.reference || hadith.collection);
  } finally {
    hadithFetching = false;
  }
}

// Today's hadith, fetching it now if the day rolled over while Chrome slept.
async function getHadithForToday() {
  const settings = await loadSettings();
  if (!settings.hadithEnabled) return null;
  let h = await SalatStorage.getCache("hadith:today");
  if (!h || h.date !== SalatTimes.dateKey()) {
    await ensureDailyHadith(true);
    h = await SalatStorage.getCache("hadith:today");
  }
  return h || null;
}

/* ---------- scheduling ---------- */
// A sleeping computer or a late browser start can miss alarms entirely.
// Announce a waqt that started within this many minutes and hasn't been
// announced yet; beyond it, record it as missed instead of ringing late.
const CATCHUP_MIN = 15;

async function catchUpMissed() {
  const settings = await loadSettings();
  const data = await SalatStorage.getCache(SalatStorage.cacheKey(settings));
  if (!data) return;
  const now = new Date();
  const dateKey = SalatTimes.dateKey(now);
  const raw = data.days[dateKey];
  if (!raw) return;
  // The azan times, not the waqt times: a delayed waqt is announced later.
  const today = SalatTimes.azanTimes(raw, settings);
  const nowMin = SalatTimes.nowMinutes(now);
  for (const w of SalatTimes.NOTIFIABLE) {
    if (!settings.enabled[w]) continue;
    const diff = nowMin - SalatTimes.toMinutes(today[w]);
    if (diff < 0) continue; // not started yet
    const marker = "notified:" + dateKey + ":" + w;
    const seen = await SalatStorage.getCache(marker);
    if (seen) continue;
    if (diff <= CATCHUP_MIN) {
      await SalatStorage.setCache(marker, true);
      await logDiag("catch-up announce", w + " (+" + diff + " min)");
      await startAlarm(w);
    } else {
      await logDiag("missed waqt (Chrome started late)", w + " was " + diff + " min ago");
    }
  }
}

async function scheduleToday() {
  const settings = await loadSettings();
  const data = await SalatStorage.getCache(SalatStorage.cacheKey(settings));
  if (!data) return;

  const now = new Date();
  const todayKey = SalatTimes.dateKey(now);
  const raw = data.days[todayKey];
  if (!raw) return;
  // Alarms follow the azan time: a waqt with a user delay rings later than the
  // waqt itself, so the delay has to be baked in before anything is scheduled.
  const today = SalatTimes.azanTimes(raw, settings);

  // One alarm per enabled waqt: today's remaining ones, plus tomorrow's
  // instance for any that already passed (so a late start never drops one).
  const DAY = 24 * 60 * 60 * 1000;
  const CATCHUP_MS = CATCHUP_MIN * 60 * 1000;
  let todayCount = 0;
  const forTomorrow = [];
  for (const w of SalatTimes.NOTIFIABLE) {
    if (!settings.enabled[w]) continue;
    const lead = settings.leadMinutes || 0;
    const fireAt = SalatTimes.addMinutes(today[w], -lead);
    const signed = SalatTimes.msUntilSignedExact(fireAt, now);
    if (signed > 0) {
      chrome.alarms.create(alarmName(w, lead), { when: Date.now() + signed });
      todayCount++;
    } else if (signed > -CATCHUP_MS) {
      // The waqt has just started (this very minute). Ring now rather than
      // silently rolling it to tomorrow — e.g. a settings change at the waqt.
      // The daily marker still prevents a second ring.
      chrome.alarms.create(alarmName(w, lead), { when: Date.now() });
      todayCount++;
    } else {
      chrome.alarms.create(alarmName(w, lead), { when: Date.now() + signed + DAY });
      forTomorrow.push(w);
    }
  }
  await logDiag(
    "scheduled waqt alarms",
    todayCount + " today · tomorrow: " + (forTomorrow.join(",") || "none")
  );

  // Re-schedule at local midnight.
  const midnightDelay = SalatTimes.msUntil("00:05", now);
  chrome.alarms.create("daily-refresh", { when: Date.now() + midnightDelay });

  // Keep the "current waqt" badge fresh as the day progresses.
  chrome.alarms.create("badge-refresh", { periodInMinutes: 1 });
}

function alarmName(waqt, lead) {
  return "waqt:" + waqt + (lead ? ":-" + lead : "");
}

// Recreate waqt alarms that are missing (e.g. lost on a service-worker
// restart, or never scheduled because the first month fetch failed).
async function healAlarms() {
  const settings = await loadSettings();
  const data = await SalatStorage.getCache(SalatStorage.cacheKey(settings));
  if (!data) return;
  const now = new Date();
  const raw = data.days[SalatTimes.dateKey(now)];
  if (!raw) return;
  const today = SalatTimes.azanTimes(raw, settings);
  const existing = await chrome.alarms.getAll();
  const names = existing.map((a) => a.name);
  for (const w of SalatTimes.NOTIFIABLE) {
    if (!settings.enabled[w]) continue;
    const lead = settings.leadMinutes || 0;
    const name = alarmName(w, lead);
    const signed = SalatTimes.msUntilSignedExact(SalatTimes.addMinutes(today[w], -lead), now);
    if (signed > 0 && names.indexOf(name) === -1) {
      chrome.alarms.create(name, { when: Date.now() + signed });
      await logDiag("healed lost alarm", name);
    }
  }
}

// Find the waqt encoded in an alarm name like "waqt:maghrib" / "waqt:dhuhr:-10".
function waqtFromAlarmName(name) {
  if (name.slice(0, 5) !== "waqt:") return null;
  const body = name.slice(5);
  const i = body.indexOf(":");
  return i === -1 ? body : body.slice(0, i);
}

async function reschedule() {
  const alarms = await chrome.alarms.getAll();
  for (const a of alarms) {
    if (a.name.indexOf("waqt:") === 0) await chrome.alarms.clear(a.name);
  }
  await scheduleToday();
}

async function onAlarm(alarm) {
  if (alarm.name === "keepalive:azan") {
    return; // purely keeps the worker (and offscreen azan) alive
  }
  if (alarm.name === "daily-refresh") {
    await ensureMonth();
    await ensureDailyHadith(true);
    await scheduleToday();
    await refreshBadge();
    return;
  }
  if (alarm.name === "badge-refresh") {
    // Self-heal: retry the month fetch and recreate any lost waqt alarm,
    // so an offline install or a dropped alarm recovers on its own.
    await ensureMonth();
    await healAlarms();
    await refreshBadge();
    return;
  }
  if (alarm.name.indexOf("snooze:") === 0) {
    const waqt = alarm.name.slice(7);
    await logDiag("alarm fired", alarm.name);
    await startAlarm(waqt);
    return;
  }
  const waqt = waqtFromAlarmName(alarm.name);
  if (!waqt) return;
  await logDiag("alarm fired", alarm.name);
  if (waqt === "test") {
    // Manual test alarms always fire (they ignore the daily marker).
    await startAlarm("Test");
    return;
  }

  // If Chrome/the machine was off at the waqt, a persisted alarm fires late on
  // startup. Ring only within the catch-up window; otherwise stay silent.
  const late = alarm.scheduledTime ? Date.now() - alarm.scheduledTime : 0;
  if (late > CATCHUP_MIN * 60 * 1000) {
    await logDiag(
      "missed waqt (fired late)",
      waqt + " · " + Math.round(late / 60000) + " min late"
    );
    return;
  }

  // Skip if we already alarmed for this waqt today (e.g. after sleep wake).
  const settings = await loadSettings();
  const marker = "notified:" + SalatTimes.dateKey() + ":" + waqt;
  const seen = await SalatStorage.getCache(marker);
  if (seen) {
    await logDiag("skip (already notified today)", waqt);
    return;
  }
  await SalatStorage.setCache(marker, true);
  await startAlarm(waqt);
  await refreshBadge(); // the current waqt has changed
}

/* ---------- the alarm itself ---------- */

async function startAlarm(waqt) {
  // Never let two azans (or two popup windows) overlap: fully clear any
  // alarm still running before starting the new one.
  await stopAlarm();

  const settings = await loadSettings();
  await SalatStorage.setCache("activeAlarm", { waqt: waqt, startedAt: Date.now() });
  currentVolume = settings.volume;
  await logDiag("startAlarm", waqt);

  // Keep the worker (and the offscreen azan) alive for the whole recitation.
  chrome.alarms.create("keepalive:azan", { periodInMinutes: 0.5 });

  // Auto-open the azan popup window (graceful fallback: notification only).
  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL(
        "alarm.html?waqt=" + encodeURIComponent(waqt)
      ),
      type: "popup",
      width: 392,
      height: 540,
      focused: true,
    });
    alarmWindowId = win.id;
    await logDiag("popup window opened", "id " + win.id);
  } catch (e) {
    console.error("alarm window failed", e);
    await logDiag("popup window FAILED", String(e));
  }

  // Offscreen azan playback (queued until the document reports ready).
  pendingPlay = {
    target: "offscreen",
    type: "play",
    volume: settings.volume,
  };
  playSent = false;
  await ensureOffscreen();
  if (!offscreenCreating) sendPlay();
  // Safety net: if the ready handshake is ever lost, play anyway.
  setTimeout(sendPlay, 2500);

  // Notification with Snooze / Stop.
  const azanDelay = SalatTimes.delayFor(waqt, settings);
  chrome.notifications.create(NOTIF_ID, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("assets/icons/masjid-128.png"),
    title: (SalatTimes.LABELS[waqt] || waqt) + " — time for salah",
    message: azanDelay
      ? "Azan is playing — " + SalatTimes.formatMinutes(azanDelay) + " after the waqt. Snooze or stop it below."
      : "Azan is playing. Snooze or stop it below.",
    buttons: [
      { title: "Snooze " + (settings.snoozeMinutes || 5) + " min" },
      { title: "Stop" },
    ],
    requireInteraction: true,
    priority: 2,
  });
  await logDiag("notification shown", SalatTimes.LABELS[waqt] || waqt);

  // Safety cap.
  clearTimeout(stopTimer);
  stopTimer = setTimeout(() => stopAlarm(), MAX_PLAY_MS);
}

// Bring the azan popup back to the front (e.g. when the notification is clicked).
async function focusAlarmWindow() {
  if (alarmWindowId == null) return;
  try {
    await chrome.windows.update(alarmWindowId, { focused: true, drawAttention: true });
  } catch (e) {
    alarmWindowId = null; // window is gone
  }
}

// Send the queued play request exactly once.
function sendPlay() {
  if (playSent || !pendingPlay) return;
  playSent = true;
  try {
    chrome.runtime.sendMessage(pendingPlay).catch(() => {});
    logDiag("play sent to offscreen");
  } catch (e) {
    logDiag("play send FAILED", String(e));
  }
}

async function snooze() {
  const active = await SalatStorage.getCache("activeAlarm");
  if (!active) return;
  const settings = await loadSettings();
  await stopPlayback();
  chrome.notifications.clear(NOTIF_ID);
  // Drop the "already notified" marker so the snooze alarm can re-fire.
  await SalatStorage.setCache(
    "notified:" + SalatTimes.dateKey() + ":" + active.waqt, false
  );
  const mins = settings.snoozeMinutes || 5;
  chrome.alarms.create("snooze:" + active.waqt, { when: Date.now() + mins * 60000 });
  await SalatStorage.setCache("activeAlarm", null);
}

async function stopAlarm() {
  await stopPlayback();
  chrome.notifications.clear(NOTIF_ID);
  if (alarmWindowId != null) {
    try {
      await chrome.windows.remove(alarmWindowId);
    } catch (e) {
      /* window already closed */
    }
    alarmWindowId = null;
  }
  await SalatStorage.setCache("activeAlarm", null);
}

// Diagnostic summary for the settings page.
async function getAlarmStatus() {
  const settings = await loadSettings();
  const data = await SalatStorage.getCache(SalatStorage.cacheKey(settings));
  const alarms = await chrome.alarms.getAll();
  const store = await chrome.storage.local.get("diagLog");
  const log = store.diagLog || [];
  const now = new Date();
  const today = data ? data.days[SalatTimes.dateKey(now)] : null;
  let next = null;
  if (today) {
    // Report the next azan (a delayed waqt rings later than its waqt time).
    const n = SalatTimes.nextWaqt(SalatTimes.azanTimes(today, settings), now, null);
    if (n) next = { waqt: n.waqt, time: n.time, label: SalatTimes.LABELS[n.waqt] };
  }
  return {
    scheduled: alarms.filter((a) => a.name.indexOf("waqt:") === 0).length,
    hasCache: !!data,
    next: next,
    enabledToggles: settings.enabled,
    waqtAlarms: alarms
      .filter((a) => a.name.indexOf("waqt:") === 0)
      .map((a) => {
        const when = a.scheduledTime || a.when || 0;
        return {
          name: a.name.replace(/^waqt:/, ""),
          when: when,
          inMin: Math.round((when - Date.now()) / 60000),
        };
      })
      .sort((x, y) => x.when - y.when),
    diag: log,
  };
}

async function stopPlayback() {
  clearTimeout(stopTimer);
  stopTimer = null;
  chrome.alarms.clear("keepalive:azan");
  playSent = false;
  pendingPlay = null;
  try {
    chrome.runtime.sendMessage({ target: "alarm", type: "stop-here" });
  } catch (e) {
    /* window already gone */
  }
  try {
    await chrome.offscreen.closeDocument();
  } catch (e) {
    /* document may not exist */
  }
}

function onNotifButton(id, buttonIndex) {
  if (id !== NOTIF_ID) return;
  if (buttonIndex === 0) snooze(); // Snooze
  else stopAlarm(); // Stop
}

/* ---------- azan playback status from the offscreen doc ---------- */

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "offscreen:ready") {
    // The new document is listening — flush the queued play request.
    offscreenCreating = false;
    logDiag("offscreen ready");
    sendPlay();
    return;
  }
  if (msg && msg.type === "azan:playing") {
    logDiag("azan PLAYING", msg.detail || "");
    return;
  }
  if (msg && msg.type === "azan:error") {
    // Playback failed (blocked autoplay / decode). Keep the alarm visible
    // instead of silently ending it, and fall back to the visible window.
    logDiag("azan PLAY FAILED", msg.detail || "");
    try {
      chrome.runtime.sendMessage({
        target: "alarm",
        type: "play-here",
        volume: currentVolume,
      });
    } catch (e) {
      /* window already gone */
    }
    return;
  }
  if (msg && msg.type === "azan:ended") {
    // Recitation finished on its own — stop the alarm state.
    logDiag("azan ended");
    setTimeout(() => stopAlarm(), 500);
  }
});

/* ---------- offscreen lifecycle ---------- */

async function ensureOffscreen() {
  try {
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
      });
      if (contexts.length > 0) {
        // An offscreen document is already up and listening — don't wait
        // for a ready handshake that will never be repeated.
        offscreenCreating = false;
        logDiag("offscreen already open");
        return;
      }
    }
  } catch (e) {
    /* older Chrome: fall through to createDocument */
  }
  try {
    offscreenCreating = true;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Playing the azan at prayer time",
    });
    logDiag("offscreen created");
  } catch (e) {
    // Already exists or unsupported: send the play message directly.
    offscreenCreating = false;
    await logDiag("offscreen create FAILED", String(e));
  }
}

/* ---------- badge: current waqt ---------- */

async function refreshBadge() {
  try {
    const settings = await loadSettings();
    const data = await SalatStorage.getCache(SalatStorage.cacheKey(settings));
    if (!data) {
      chrome.action.setBadgeText({ text: "" });
      return;
    }
    const current = currentFromData(data);
    if (!current) {
      chrome.action.setBadgeText({ text: "" });
      return;
    }
    chrome.action.setBadgeText({ text: SalatTimes.BADGE_TEXT[current.waqt] });
    chrome.action.setBadgeBackgroundColor({ color: SalatTimes.WAQT_COLORS[current.waqt] });
  } catch (e) {
    console.error("badge refresh failed", e);
  }
}

function currentFromData(data) {
  const now = new Date();
  const today = data.days[SalatTimes.dateKey(now)];
  if (!today) return null;
  const nowMin = SalatTimes.nowMinutes(now);
  let current = null;
  for (const w of SalatTimes.NOTIFIABLE) {
    if (SalatTimes.toMinutes(today[w]) <= nowMin) current = w;
  }
  if (!current) current = "isha"; // between midnight and Fajr: Isha's night
  return { waqt: current, time: today[current] };
}
