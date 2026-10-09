/* Page-side logic for debug.html. Talks to the service worker's debug API
 * (debug.js) and renders a status panel + event timeline. Also runs the
 * one test the worker cannot: fetch an .i2p site THROUGH the proxy, since
 * requests from this extension page are routed by chrome.proxy just like
 * normal tabs. */

var lastState = null;
window.__debugpageLoaded = new Date().toISOString();

function el(id) {
  return document.getElementById(id);
}

function card(title, valueHtml, cls) {
  return (
    '<div class="card"><h2>' +
    title +
    '</h2><div class="' +
    (cls || "mono") +
    '">' +
    valueHtml +
    "</div></div>"
  );
}

function verdict(text, ok, note) {
  var cls = ok === true ? "ok" : ok === false ? "bad" : "warn";
  return (
    '<span class="' +
    cls +
    '">' +
    (ok === true ? "● " : ok === false ? "✗ " : "◐ ") +
    text +
    "</span>" +
    (note ? '<div class="hint">' + note + "</div>" : "")
  );
}

function classifyProbe(s) {
  if (typeof s !== "string") return { ok: null, s: String(s) };
  if (s.indexOf("HTTP") === 0) return { ok: true, s: s };
  if (s.indexOf("FAIL: TypeError") === 0)
    return {
      ok: false,
      s: "connection refused/reset (nothing listening)",
    };
  if (s.indexOf("AbortError") >= 0)
    return { ok: false, s: "timed out (3.5s) — port filtered or black-holed" };
  return { ok: false, s: s };
}

function renderState(st) {
  lastState = st;
  var c = [];
  if (!st || st.error) {
    el("cards").innerHTML = card(
      "service worker",
      verdict("no response from background worker", false,
        "open chrome://extensions, check for errors, then click Refresh")
    );
    return;
  }
  var stored = st.stored || {};
  var consoleV = classifyProbe(st.probes && st.probes.router_console);
  var proxyV = classifyProbe(st.probes && st.probes.proxy_port);

  c.push(
    card(
      "router console",
      verdict(
        "127.0.0.1:" + (stored.control_port || 7657) + " → " + consoleV.s,
        consoleV.ok,
        consoleV.ok
          ? undefined
          : "start the I2P router; check its console port in Router Console → Configuration"
      )
    )
  );
  c.push(
    card(
      "router HTTP proxy port",
      verdict(
        (stored.proxy_host || "127.0.0.1") + ":" + (stored.proxy_port || 4444) +
          " → " + proxyV.s,
        proxyV.ok,
        proxyV.ok
          ? undefined
          : "the router's HTTP proxy (usually 4444) is not listening"
      )
    )
  );

  var ps = st.proxySetting;
  var proxySet =
    ps && typeof ps === "object" && ps.mode === "fixed_servers";
  var psJson = JSON.stringify(ps || {});
  var pointsAtRouter = /4444|"http"|"socks"/.test(psJson);
  c.push(
    card(
      "chrome proxy config",
      verdict(
        proxySet ? pointsAtRouter ? "fixed_servers → router" : "fixed_servers (unexpected values)" : String((ps && ps.mode) || "not set"),
        proxySet && pointsAtRouter,
        !proxySet
          ? "something cleared the proxy (level: " +
              ((st.proxyRaw && st.proxyRaw.levelOfControl) || "?") +
              ") — click Refresh; if it stays broken, Reset extension"
          : undefined
      )
    )
  );

  var dnr = st.dnr || {};
  var staticOn = (dnr.enabledRulesets || []).indexOf("block_localhost") >= 0;
  c.push(
    card(
      "localhost block (DNR)",
      verdict(staticOn ? "ruleset active" : "ruleset NOT active", staticOn)
    )
  );

  var pv = st.privacy || {};
  var pb =
    pv.safeBrowsing ||
    (pv.services && pv.services.safeBrowsingEnabled) ||
    {};
  var pbOff = pb.value === false;
  var pbUnknown = pb.value === undefined && !pb.levelOfControl;
  var pbManaged = pb.levelOfControl === "controlled_by_other_extensions" || pb.levelOfControl === "controlled_by_master";
  var pbNote;
  if (pbManaged)
    pbNote =
      "controlled by " +
      (pb.levelOfControl === "controlled_by_master" ? "enterprise policy" : "another extension") +
      " — SafeBrowsing lookups may leak .i2p URL prefixes to Google";
  else if (pbUnknown)
    pbNote = "browser does not expose this control (headless/managed build?) — cannot confirm off";
  c.push(
    card(
      "safeBrowsing",
      verdict(
        pbOff
          ? "off"
          : pbManaged
          ? "not controllable (" + pb.levelOfControl + ")"
          : pbUnknown
          ? "unknown"
          : "value=" + pb.value,
        pbOff ? true : pbManaged || pbUnknown ? null : false,
        pbNote
      )
    )
  );

  el("cards").innerHTML = c.join("");

  // advice block for the most common failure
  var advice = "";
  if (!consoleV.ok && !proxyV.ok) {
    advice =
      '<div class="card bad" style="margin-bottom:12px"><h2>most likely cause</h2>' +
      "Nothing is listening on 127.0.0.1:4444 or :7657 — the I2P router is not " +
      "running on this machine, or it listens elsewhere. Start I2P (or set the " +
      "right host/ports in the extension's options page). This extension only " +
      "configures the browser; it does not run I2P itself.</div>";
  } else if (consoleV.ok && !proxyV.ok) {
    advice =
      '<div class="card warn" style="margin-bottom:12px"><h2>most likely cause</h2>' +
      "The console answers but the HTTP proxy port does not — enable/configure " +
      "the HTTP proxy in Router Console → Web Server settings, or fix the proxy " +
      "port in this extension's options.</div>";
  } else if (consoleV.ok && proxyV.ok && !(proxySet && pointsAtRouter)) {
    advice =
      '<div class="card warn" style="margin-bottom:12px"><h2>most likely cause</h2>' +
      "The router is fine but the browser is not pointed at it — another " +
      "extension or a policy (level above) is controlling the proxy. Reset " +
      "extension, and check chrome://extensions for conflicting proxy " +
      "extensions / enterprise policy.</div>";
  }
  el("advice").innerHTML = advice;
  el("raw").textContent = JSON.stringify(st, null, 2);
}

function renderLog(entries) {
  var box = el("log");
  box.innerHTML = (entries || [])
    .slice(-300)
    .map(function (e) {
      return (
        "<div><span class='t'>" +
        e.t +
        "</span>" +
        String(e.msg).replace(/&/g, "&amp;").replace(/</g, "&lt;") +
        "</div>"
      );
    })
    .join("");
  box.scrollTop = box.scrollHeight;
}

function refreshLog() {
  chrome.storage.local.get(["debug_log"], function (got) {
    renderLog(got.debug_log);
  });
}

function refreshAll() {
  chrome.runtime.sendMessage({ debug: "state" }, renderState);
  refreshLog();
  runPageProbe();
}

/* End-to-end: fetch an .i2p site through the proxy. The fetch runs in the
 * service worker — chrome.proxy applies there (the test suite proves it);
 * chrome-extension:// page fetches bypass the extension's own proxy. */
function runPageProbe() {
  var t0 = Date.now();
  var done = false;
  var timer = setTimeout(function () {
    finish("timed out (30s)", false);
  }, 30000);

  function finish(msg, ok) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    var old = el("e2e");
    if (old) old.remove();
    // #e2ewrap is separate from #cards so renderState()'s innerHTML
    // refresh cannot wipe this card out from under the user.
    var div = document.createElement("div");
    div.className = "card";
    div.id = "e2e";
    div.style.gridColumn = "1 / -1";
    div.innerHTML =
      "<h2>end-to-end .i2p load (over the proxy)</h2>" +
      verdict("http://proxy.i2p/ → " + msg + " (" + (Date.now() - t0) + "ms)", ok) +
      (ok
        ? ""
        : '<div class="hint">If the router cards are green but this fails, the proxy is reachable but cannot build paths to that destination — check the router\'s reachability page.</div>');
    el("e2ewrap").appendChild(div);
  }

  chrome.runtime.sendMessage({ debug: "reachability" }, function (resp) {
    if (chrome.runtime.lastError || !resp || !resp.reachability) {
      finish(
        "worker unreachable: " +
          (chrome.runtime.lastError && chrome.runtime.lastError.message),
        false
      );
      return;
    }
    var s = resp.reachability;
    finish(s, /^FAIL/.test(s) ? false : true);
  });
}

function copyReport() {
  chrome.storage.local.get(["debug_log"], function (got) {
    var text =
      "I2P-Configuration-For-Chromium debug report " +
      new Date().toISOString() +
      "\n\nSTATE\n" +
      JSON.stringify(lastState, null, 2) +
      "\n\nLOG\n" +
      (got.debug_log || []).map(function (e) { return e.t + " " + e.msg; }).join("\n");
    navigator.clipboard.writeText(text).then(function () {
      el("copy").textContent = "Copied ✓";
      setTimeout(function () {
        el("copy").textContent = "Copy report";
      }, 1500);
    });
  });
}

el("refresh").addEventListener("click", refreshAll);
el("copy").addEventListener("click", copyReport);
el("reset").addEventListener("click", function () {
  if (!confirm("Clear the extension's proxy settings and stored options? Your router is not touched.")) return;
  chrome.runtime.sendMessage({ debug: "reset" }, function () {
    location.reload();
  });
});

chrome.storage.local.get(["debug_enabled"], function (got) {
  el("logging").checked = got.debug_enabled !== false;
});
el("logging").addEventListener("change", function (ev) {
  chrome.storage.local.set({ debug_enabled: ev.target.checked });
  if (!ev.target.checked) {
    chrome.storage.local.set({ debug_log: [] }, refreshLog);
  }
});

// live tail
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === "local" && changes.debug_log) renderLog(changes.debug_log.newValue);
});

refreshAll();
setInterval(refreshLog, 1000);
