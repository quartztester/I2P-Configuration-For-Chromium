/* Tiny shared event log for the service worker and extension pages.
 *
 * dbg(msg) appends a timestamped entry to a ring buffer persisted in
 * chrome.storage.local, so entries survive service-worker teardown and
 * can be shown by debug.html. Pages that use dbg() must load this file
 * first in their <head>. Logging is on by default; the debug panel can
 * turn it off (storage key debug_enabled) — the flag is checked on
 * every flush, so toggling applies within a second.
 */
var __dbgLog = null;
var __dbgQueue = [];
var __dbgEnabled = true;

function dbg(msg) {
  __dbgReadFlag();
  if (!__dbgEnabled) return;
  var entry = { t: new Date().toISOString().slice(11, 23), msg: String(msg) };
  if (__dbgLog === null) {
    __dbgQueue.push(entry);
    if (__dbgQueue.length > 500) __dbgQueue.shift();
    __dbgLoad();
    return;
  }
  __dbgLog.push(entry);
  if (__dbgLog.length > 320) __dbgLog = __dbgLog.slice(-300);
  chrome.storage.local.set({ debug_log: __dbgLog });
}

function __dbgReadFlag() {
  chrome.storage.local.get(["debug_enabled"], function (got) {
    if (!chrome.runtime.lastError) __dbgEnabled = got.debug_enabled !== false;
  });
}

function __dbgLoad() {
  chrome.storage.local.get(["debug_log"], function (got) {
    if (chrome.runtime.lastError || __dbgLog !== null) return;
    var base = Array.isArray(got.debug_log) ? got.debug_log.slice(-300) : [];
    for (var i = 0; i < __dbgQueue.length; i++) base.push(__dbgQueue[i]);
    __dbgQueue.length = 0;
    __dbgLog = base.slice(-300);
    chrome.storage.local.set({ debug_log: __dbgLog });
  });
}
