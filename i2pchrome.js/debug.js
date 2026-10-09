/* Diagnostics for the MV3 service worker, plus the message API used by
 * debug.html. Loaded from background.js only.
 *
 * Debug API (chrome.runtime.sendMessage from extension pages):
 *   {debug:"state"}  -> full snapshot: settings, DNR rules, proxy setting,
 *                       privacy control statuses, router probes (proxy +
 *                       console + reachability)
 *   {debug:"probe"}  -> re-run the three network probes only
 *   {debug:"reset"}  -> remove proxy settings, clear storage, clear DNR
 *                       rule state (re-enables the static ruleset)
 *
 * Every event in the extension is also mirrored into the shared dbg()
 * ring buffer (debuglog.js) so the panel can show a timeline even though
 * the service worker itself is ephemeral.
 */

/* Run a fetch with a hard timeout so a black-holed router console or a
 * proxy that accepts-but-never-answers cannot hang the diagnostics. */
function fetchWithTimeout(url, ms) {
  var ctrl = new AbortController();
  var timer = setTimeout(function () {
    ctrl.abort();
  }, ms);
  return fetch(url, {
    signal: ctrl.signal,
    cache: "no-store",
    credentials: "omit",
  }).finally(function () {
    clearTimeout(timer);
  });
}

function statusFromHttp(r) {
  // Router console answers 200/302/401 depending on auth settings; any
  // HTTP response at all proves something is listening.
  return "HTTP " + r.status;
}

function failReason(e) {
  // "TypeError: Failed to fetch" means nothing answered the TCP request
  // (connection refused / no router running); say so in plain words.
  var name = e && e.name ? e.name : String(e);
  if (name === "TypeError" || /Failed to fetch/.test(String(e)))
    return "no router answering (is I2P running on this machine?)";
  if (/AbortError/.test(name)) return "timed out (router not answering)";
  return "FAIL: " + name;
}

function probeRouterConsole() {
  var url =
    "http://" +
    (typeof control_host !== "undefined" ? control_host : "127.0.0.1") +
    ":" +
    (typeof control_port !== "undefined" ? control_port : 7657) +
    "/";
  return fetchWithTimeout(url, 3500)
    .then(statusFromHttp)
    .catch(failReason);
}

function probeProxyPort() {
  // Our own DNR ruleset blocks http://127.0.0.1:<anything> except :7657,
  // so probing the proxy port requires briefly suspending it. The window
  // is bounded by the fetch timeout and the ruleset is always restored.
  var url =
    "http://" +
    (typeof proxy_host !== "undefined" ? proxy_host : "127.0.0.1") +
    ":" +
    (typeof proxy_port !== "undefined" ? proxy_port : 4444) +
    "/";
  return chrome.declarativeNetRequest
    .updateEnabledRulesets({ disableRulesetIds: ["block_localhost"] })
    .then(function () {
      return fetchWithTimeout(url, 3500).then(statusFromHttp);
    })
    .catch(failReason)
    .then(function (out) {
      // await the re-enable so concurrent callers never race the window —
      // but never re-arm the firewall if the master switch is OFF
      // (status.js owns that state; probe must not resurrect it).
      var want =
        typeof i2pEnabledState !== "function" || i2pEnabledState();
      var p2 = want
        ? chrome.declarativeNetRequest.updateEnabledRulesets({
            enableRulesetIds: ["block_localhost"],
          })
        : Promise.resolve();
      return p2
        .catch(function () {})
        .then(function () {
          return out;
        });
    });
}

function probeI2PViaProxy() {
  // End-to-end .i2p load. chrome.proxy applies to tab navigation (our test
  // suite verifies this end to end); fetch() from extension pages/workers
  // bypasses the extension's own proxy config, so we use a background tab.
  var url = "http://proxy.i2p/?i2pchrome-probe=" + Date.now();
  return chrome.tabs
    .create({ url: url, active: false })
    .then(function (tab) {
      var deadline = Date.now() + 25000;
      return new Promise(function (resolve) {
        var timer = setInterval(function () {
          chrome.tabs
            .get(tab.id)
            .then(function (t) {
              var done = false;
              if (/^chrome-error:/.test(t.url || "")) {
                finish("tab failed to load (error page)");
                done = true;
              } else if (
                t.status === "complete" &&
                (t.url || "").indexOf("proxy.i2p") >= 0
              ) {
                // Title comes from an arbitrary eepsite; it is escaped on
                // render, but keep it out of persisted storage too.
                finish("loaded through I2P");
                done = true;
              }
              if (done) {
                clearInterval(timer);
                chrome.tabs.remove(tab.id).catch(function () {});
              }
            })
            .catch(function () {
              clearInterval(timer);
              resolve("FAIL: probe tab disappeared");
            });
          if (Date.now() > deadline) {
            clearInterval(timer);
            chrome.tabs.remove(tab.id).catch(function () {});
            resolve("FAIL: timed out (25s) loading http://proxy.i2p/ over the proxy");
          }
        }, 500);
        function finish(msg) {
          resolve(msg.indexOf("loaded") === 0 ? msg : "FAIL: " + msg);
        }
      });
    })
    .catch(function (e) {
      return "FAIL: " + String(e);
    });
}

function readChromeSetting(key) {
  return new Promise(function (resolve) {
    try {
      var node =
        key === "proxy"
          ? chrome.proxy.settings
          : key === "networkPrediction"
          ? chrome.privacy.network.networkPredictionEnabled
          : key === "webRTC"
          ? chrome.privacy.network.webRTCIPHandlingPolicy
          : key === "safeBrowsing"
          ? chrome.privacy.services.safeBrowsingEnabled
          : null;
      if (!node) return resolve("unknown key");
      node.get({}, function (d) {
        if (chrome.runtime.lastError) {
          resolve("ERR: " + chrome.runtime.lastError.message);
          return;
        }
        resolve(d && d.value !== undefined ? d.value : d);
      });
    } catch (e) {
      resolve("ERR: " + String(e));
    }
  });
}

function readPrivacyStatuses() {
  var keys = [
    "networkPredictionEnabled",
    "webRTCIPHandlingPolicy",
    "safeBrowsingEnabled",
  ];
  return new Promise(function (resolve) {
    var out = {};
    try {
      chrome.privacy.services.settings.get({}, function (d) {
        if (chrome.runtime.lastError) {
          out.services = "ERR: " + chrome.runtime.lastError.message;
        } else {
          out.services = d;
        }
        chrome.privacy.network.settings.get({}, function (dn) {
          if (chrome.runtime.lastError) {
            out.network = "ERR: " + chrome.runtime.lastError.message;
          } else {
            out.network = dn;
          }
          // direct read of the one control we care about most; the
          // services.settings.get() map omits safeBrowsingEnabled on some
          // Chrome versions/controls
          chrome.privacy.services.safeBrowsingEnabled.get({}, function (sb) {
            if (!chrome.runtime.lastError && sb) out.safeBrowsing = sb;
            resolve(out);
          });
        });
      });
    } catch (e) {
      resolve({ error: String(e) });
    }
  });
}

function dnrSnapshot() {
  return chrome.declarativeNetRequest.getDynamicRules().then(function (dyn) {
    var enabled = chrome.runtime.getManifest().declarative_net_request
      .rule_resources;
    return chrome.declarativeNetRequest
      .getEnabledRulesets()
      .then(function (on) {
        return { dynamic: dyn, staticRulesets: enabled, enabledRulesets: on };
      })
      .catch(function (e) {
        return { dynamic: dyn, error: String(e) };
      });
  });
}

function debugState() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(null, function (stored) {
      // snapshot DNR state up front: probeProxyPort() below temporarily
      // disables block_localhost to reach the proxy port, and a concurrent
      // getEnabledRulesets() would catch it mid-flight.
      dnrSnapshot().then(function (dnr) {
        Promise.all([
          probeRouterConsole(),
          probeProxyPort(),
          readChromeSetting("proxy"),
          readPrivacyStatuses(),
          chrome.proxy.settings.get({ incognito: false }),
        ])
          .then(function (r) {
            resolve({
              version: chrome.runtime.getManifest().version,
              mv: chrome.runtime.getManifest().manifest_version,
              time: new Date().toISOString(),
              stored: stored,
              probes: {
                router_console: r[0],
                proxy_port: r[1],
              },
              proxySetting: r[2],
              proxyRaw: r[4],
              dnr: dnr,
              privacy: r[3],
            });
          })
          .catch(function (e) {
            resolve({ error: String(e) });
          });
      });
    });
  });
}

function debugReset() {
  return new Promise(function (resolve) {
    chrome.proxy.settings.clear({ scope: "regular" }, function () {
      chrome.storage.local.clear(function () {
        chrome.declarativeNetRequest
          .getDynamicRules()
          .then(function (dyn) {
            if (dyn.length) {
              return chrome.declarativeNetRequest.updateDynamicRules({
                removeRuleIds: dyn.map(function (r) {
                  return r.id;
                }),
              });
            }
          })
          .then(function () {
            resolve({ reset: true });
          });
      });
    });
  });
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.debug !== "string") return;
  dbg("debug request: " + msg.debug);
  if (msg.debug === "state") {
    debugState().then(sendResponse);
    return true;
  }
  if (msg.debug === "probe" || msg.debug === "probes") {
    Promise.all([probeRouterConsole(), probeProxyPort()])
      .then(function (r) {
        var out = { router_console: r[0], proxy_port: r[1] };
        chrome.storage.local.set({ debug_last_probe: out });
        sendResponse(out);
      })
      .catch(function (e) {
        sendResponse({ error: String(e) });
      });
    return true;
  }
  if (msg.debug === "reachability") {
    probeI2PViaProxy()
      .then(function (s) {
        // persist: callers like the popup may be gone by the time the
        // background-tab probe finishes (~5-25s)
        chrome.storage.local.set({
          debug_last_e2e: { at: new Date().toISOString(), result: s },
        });
        sendResponse({ reachability: s });
      })
      .catch(function (e) {
        sendResponse({ reachability: "FAIL: " + String(e) });
      });
    return true;
  }
  if (msg.debug === "reset") {
    debugReset().then(sendResponse);
    return true;
  }
});
