/* Snowflake-style presence: the toolbar icon is the status light and the
 * on/off switch lives in the icon's right-click menu. There is no popup —
 * left-click opens the status page (window.html) in a tab.
 *
 * State model:
 *   storage.local.enabled  true (default) | false   — master switch
 *   icon on-*.png  green dot : enabled and router console answered
 *   icon bad-*.png red   dot : enabled but router console unreachable
 *   icon off-*.png grey dot : switched off (proxy cleared)
 *
 * Loaded by background.js BEFORE proxy.js/privacy.js; those files consult
 * i2pEnabledState() before (re)applying browser-wide settings.
 */

/* ---- master switch state ------------------------------------------- */
var i2pEnabledCached = true; // assumed until storage answers

function i2pEnabledState() {
  return i2pEnabledCached;
}

function setEnabled(on, done) {
  i2pEnabledCached = !!on;
  chrome.storage.local.set({ enabled: !!on }, function () {
    dbg("master switch -> " + (on ? "ON" : "OFF"));
    applyEnabledState().then(function () {
      if (done) done();
    });
  });
}

/* Apply proxy+privacy (or tear them down) to match the current switch. */
function setLocalhostFirewall(on) {
  // block_localhost exists only to stop clearnet leaks while the I2P proxy
  // is live; when the switch is off it must stand down too.
  var d = chrome.declarativeNetRequest;
  var p = on
    ? d.updateEnabledRulesets({ enableRulesetIds: ["block_localhost"] })
    : d.updateEnabledRulesets({ disableRulesetIds: ["block_localhost"] });
  if (p && p.catch) p.catch(function (e) { dbg("localhost firewall toggle failed: " + e); });
  return p || Promise.resolve();
}

function applyEnabledState() {
  if (i2pEnabledCached) {
    setLocalhostFirewall(true);
    try {
      setupProxy();
    } catch (e) {
      dbg("setupProxy failed: " + e);
    }
    try {
      setAllPrivacy();
    } catch (e) {
      dbg("setAllPrivacy failed: " + e);
    }
    return runHealthCheck();
  }
  return disableNow();
}

function disableNow() {
  return new Promise(function (resolve) {
    setLocalhostFirewall(false);
    chrome.proxy.settings.clear({ scope: "regular" }, function () {
      dbg("proxy cleared");
      clearAllPrivacy();
      setIconState("off", "I2P is OFF — right-click the icon to enable");
      resolve();
    });
  });
}

function clearAllPrivacy() {
  if (typeof getBrowser === "function" && getBrowser() != "Chrome") return;
  var controls = [];
  try {
    controls.push(
      chrome.privacy.network.networkPredictionEnabled,
      chrome.privacy.network.webRTCIPHandlingPolicy
    );
    controls.push(
      chrome.privacy.services.alternateErrorPagesEnabled,
      chrome.privacy.services.autofillEnabled,
      chrome.privacy.services.passwordSavingEnabled,
      chrome.privacy.services.searchSuggestEnabled,
      chrome.privacy.services.spellingServiceEnabled,
      chrome.privacy.services.translationServiceEnabled,
      chrome.privacy.services.safeBrowsingEnabled
    );
    controls.push(
      chrome.privacy.websites.thirdPartyCookiesAllowed,
      chrome.privacy.websites.hyperlinkAuditingEnabled,
      chrome.privacy.websites.referrersEnabled
    );
    if (chrome.privacy.websites.doNotTrackEnabled)
      controls.push(chrome.privacy.websites.doNotTrackEnabled);
    if (chrome.privacy.websites.protectedContentEnabled)
      controls.push(chrome.privacy.websites.protectedContentEnabled);
  } catch (e) {
    dbg("clearAllPrivacy enumerate: " + e);
  }
  controls.forEach(function (c) {
    if (!c || typeof c.clear !== "function") return;
    try {
      c.clear({}, function () {
        chrome.runtime.lastError;
      });
    } catch (e) {
      /* managed builds reject some controls */
    }
  });
  dbg("privacy settings restored to browser defaults");
}

/* ---- the light on the toolbar -------------------------------------- */
var lastIconState = null;

function setIconState(state, title) {
  if (state === lastIconState) return;
  lastIconState = state;
  var paths = {};
  [16, 32, 48].forEach(function (s) {
    paths[s] = "icons/" + state + "-" + s + ".png";
  });
  chrome.action.setIcon({ path: paths }, function () {
    if (chrome.runtime.lastError)
      dbg("setIcon failed: " + chrome.runtime.lastError.message);
  });
  if (title) chrome.action.setTitle({ title: title });
  // the menu checkbox should agree with reality
  try {
    var u = chrome.contextMenus.update("i2p-toggle", { checked: i2pEnabledCached });
    if (u && u.catch) u.catch(function () {});
  } catch (e) {}
}

/* Lightweight health check: does the router console answer? (The proxy-port
 * probe would need to suspend the localhost firewall rules, which is too
 * invasive to run on a timer; debug.html still offers the full set.) */
function runHealthCheck() {
  if (!i2pEnabledCached) {
    setIconState("off", "I2P is OFF — right-click the icon to enable");
    return Promise.resolve("off");
  }
  if (typeof probeRouterConsole !== "function") return Promise.resolve("no-probe");
  return probeRouterConsole().then(function (result) {
    var ok = result.indexOf("HTTP") === 0;
    chrome.storage.local.set({
      debug_last_probe: { router_console: result, at: new Date().toISOString() },
    });
    setIconState(
      ok ? "on" : "bad",
      ok
        ? "I2P is ON — router reachable (" + result + ")"
        : "I2P is ON but the router console is unreachable — start I2P, or right-click the icon for diagnostics"
    );
    return ok ? "on" : "bad";
  });
}

/* ---- right-click menu ----------------------------------------------- */
function buildMenu() {
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({
      id: "i2p-toggle",
      title: "Enable I2P proxy",
      type: "checkbox",
      checked: i2pEnabledCached,
      contexts: ["action"],
    });
    chrome.contextMenus.create({
      id: "i2p-open",
      title: "Open I2P status page",
      contexts: ["action"],
    });
    chrome.contextMenus.create({
      id: "i2p-debug",
      title: "Diagnostics",
      contexts: ["action"],
    });
    chrome.contextMenus.create({ id: "i2p-sep", type: "separator", contexts: ["action"] });
    chrome.contextMenus.create({
      id: "i2p-options",
      title: "Extension options",
      contexts: ["action"],
    });
  });
}

chrome.contextMenus.onClicked.addListener(function (info) {
  if (info.menuItemId === "i2p-toggle") {
    setEnabled(!!info.checked);
  } else if (info.menuItemId === "i2p-open") {
    chrome.tabs.create({ url: chrome.runtime.getURL("window.html") });
  } else if (info.menuItemId === "i2p-debug") {
    chrome.tabs.create({ url: chrome.runtime.getURL("debug.html") });
  } else if (info.menuItemId === "i2p-options") {
    chrome.runtime.openOptionsPage();
  }
});

/* Left-click opens the status page in a tab (no popup in the manifest). */
chrome.action.onClicked.addListener(function () {
  chrome.tabs.create({ url: chrome.runtime.getURL("window.html") });
});

/* ---- boot ------------------------------------------------------------ */
buildMenu();

chrome.storage.local.get(null, function (got) {
  i2pEnabledCached = !(got && got.enabled === false);
  // make sure proxy.js module vars reflect stored host/port before first apply
  try {
    if (typeof update === "function") update(got || {});
  } catch (e) {}
  dbg("boot: enabled=" + i2pEnabledCached);
  applyEnabledState();
});

/* Messages used by the status page (window.html) toggle. */
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.i2p !== "master") return;
  if (msg.op === "getState") {
    sendResponse({ enabled: i2pEnabledCached });
    return;
  }
  if (msg.op === "setEnabled") {
    setEnabled(!!msg.on, function () {
      sendResponse({ enabled: i2pEnabledCached });
    });
    return true;
  }
});

chrome.alarms.create("i2p-health", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(function (a) {
  if (a.name === "i2p-health") runHealthCheck();
});
