/* Offscreen azan player: plays the bundled assets/audio/Azan-Madina.mp3.
   Reports the real outcome (playing / error) back to the service worker so a
   silent failure is never mistaken for success. */
"use strict";

const AZAN_URL = chrome.runtime.getURL("assets/audio/Azan-Madina.mp3");

let audioEl = null;
let beepTimer = null;

// Tell the service worker we're listening before it sends "play",
// so the first alarm isn't lost to a document still loading.
chrome.runtime.sendMessage({ type: "offscreen:ready" });

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return;
  if (msg.type === "play") {
    play(msg)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // async response
  }
  if (msg.type === "stop") {
    stopAll();
    sendResponse({ ok: true });
  }
});

async function play(msg) {
  stopAll();
  const volume = msg.volume == null ? 0.9 : msg.volume;
  audioEl = new Audio(AZAN_URL);
  audioEl.volume = volume;
  audioEl.onended = () => report("ended", "finished");
  audioEl.onerror = () => report("error", "audio element load error");
  try {
    await audioEl.play();
    report("playing", "volume " + volume);
  } catch (e) {
    // Most likely a blocked autoplay policy. Tell the worker so it can fall
    // back to playing inside the visible popup window, and beep as last resort.
    report("error", (e && e.name ? e.name + ": " : "") + (e && e.message ? e.message : String(e)));
    beep(volume);
  }
}

function beep(volume) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  const ctx = new Ctx();
  if (ctx.state === "suspended" && ctx.resume) ctx.resume();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.frequency.value = 880;
  gain.gain.value = volume * 0.2;
  osc.start();
  beepTimer = setTimeout(() => {
    osc.stop();
    ctx.close();
  }, 600);
}

function stopAll() {
  if (audioEl) {
    audioEl.pause();
    audioEl.src = "";
    audioEl = null;
  }
  clearTimeout(beepTimer);
  beepTimer = null;
}

function report(state, detail) {
  chrome.runtime.sendMessage({ type: "azan:" + state, detail: detail || "" });
}
