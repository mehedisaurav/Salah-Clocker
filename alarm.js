/* Auto-opened azan popup window: shows the waqt, snoozes, or stops the azan.
   Closes itself as soon as the alarm ends. */
"use strict";

const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.search);
const waqtKey = params.get("waqt");
const WAQT_LABELS = {
  fajr: "Fajr", dhuhr: "Dhuhr", asr: "Asr", maghrib: "Maghrib",
  isha: "Isha", test: "Test",
};

$("waqt").textContent = (WAQT_LABELS[waqtKey] || waqtKey || "Azan") + " — azan";
$("snooze").addEventListener("click", () => send("snooze"));
$("stop").addEventListener("click", () => send("stop"));

const inExtension = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id;

const AZAN_URL = inExtension
  ? chrome.runtime.getURL("assets/audio/Azan-Madina.mp3")
  : "assets/audio/Azan-Madina.mp3";

let audioEl = null;

// The service worker asks us to play when the offscreen player was blocked.
if (inExtension) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.target !== "alarm") return;
    if (msg.type === "play-here") playHere(msg.volume);
    if (msg.type === "stop-here") stopHere();
  });
}

async function playHere(volume) {
  if (audioEl) return;
  audioEl = new Audio(AZAN_URL);
  audioEl.volume = volume == null ? 0.9 : volume;
  try {
    await audioEl.play();
    $("status").textContent = "azan is playing";
  } catch (e) {
    // Autoplay blocked even here: the user can unlock it with one tap.
    $("status").textContent = "tap anywhere to play the azan";
    document.body.addEventListener("click", function once() {
      document.body.removeEventListener("click", once);
      if (audioEl) audioEl.play();
      $("status").textContent = "azan is playing";
    });
  }
}

function stopHere() {
  if (audioEl) {
    audioEl.pause();
    audioEl.src = "";
    audioEl = null;
  }
}

function send(type) {
  if (inExtension) chrome.runtime.sendMessage({ type: type });
  else window.close();
}

/* ---------- hadith of the day ---------- */

loadHadith();

async function loadHadith() {
  let h = null;
  if (inExtension) {
    try {
      h = await chrome.runtime.sendMessage({ type: "get-hadith" });
    } catch (e) {
      h = null;
    }
  } else {
    // Preview outside the extension: show the bundled sample, and pull the
    // real Bangla text when ?lang=bn so each language can be eyeballed.
    h = Object.assign({}, SalatHadith.FALLBACK);
    const lang = params.get("lang") || "en";
    h.lang = lang;
    if (lang === "bn" && typeof fetch === "function") {
      try {
        const r = await fetch(SalatHadith.apiEditionUrl("bn", h.collection, h.number));
        if (r.ok) h.bangla = SalatHadith.parseApiJson(await r.json());
      } catch (e) {
        /* keep the English fallback */
      }
    }
  }
  if (!h) return;
  if (h.translation == null) h.translation = SalatHadith.translationFor(h, h.lang || "en");
  const arabic = h.arabic || "";
  const translation = h.translation != null ? h.translation : h.english || "";
  $("hadith-ar").textContent = arabic;
  $("hadith-ar").hidden = !arabic;
  $("hadith-en").textContent = translation;
  $("hadith-en").hidden = !translation;
  const label =
    (h.reference || h.collection + " " + h.number) +
    (h.grade ? "  ·  " + h.grade : "");
  const ref = $("hadith-ref");
  ref.textContent = "";
  if (h.url) {
    const a = document.createElement("a");
    a.href = h.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = label;
    ref.appendChild(a);
  } else {
    ref.textContent = label;
  }
  $("hadith").hidden = false;
}

// Mirror the alarm state; close when it ends (azān finished, snoozed, stopped).
async function poll() {
  const active = await SalatStorage.getCache("activeAlarm");
  if (!active) {
    // Outside the extension (preview) keep the page visible for verification.
    if (inExtension) window.close();
    return;
  }
  if (active.waqt !== waqtKey) {
    $("waqt").textContent = (WAQT_LABELS[active.waqt] || active.waqt) + " — azan";
  }
  setTimeout(poll, 1000);
}

poll();
