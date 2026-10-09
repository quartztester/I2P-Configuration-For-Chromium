// Loaded by both the popup and the MV3 service worker, which has no DOM.
const onPopupClick = (clickEvent) => {
  if (clickEvent.target.id === "generate-fresh-tunnel") {
    refreshIdentity();
  } else if (
    clickEvent.target.id === "window-preface-title" ||
    clickEvent.target.id === "window-visit-homepage"
  ) {
    console.log("attempting to create homepage tab");
    goHome();
  } else if (clickEvent.target.id === "window-visit-debug") {
    console.log("opening diagnostics panel");
    chrome.tabs.create({ url: chrome.runtime.getURL("debug.html") });
  } else if (clickEvent.target.id === "window-visit-readme") {
    console.log("attempting to create readme tab");
    goIndex();
  } else if (clickEvent.target.id === "window-visit-i2ptunnel") {
    console.log("attempting to create i2ptunnel tab");
    goTunnel();
  } else if (clickEvent.target.id === "window-visit-susimail") {
    console.log("attempting to create susimail tab");
    goMail();
  } else if (clickEvent.target.id === "window-visit-snark") {
    console.log("attempting to create snark tab");
    goSnark();
  } else if (
    clickEvent.target.id === "clear-chrome-data" ||
    clickEvent.target.id === "clear-browser-data"
  ) {
    forgetBrowsingData();
  } else if (clickEvent.target.id === "enable-web-rtc") {
    if (clickEvent.target.checked) {
      chrome.runtime.sendMessage({ rtc: "enableWebRTC" });
    } else {
      chrome.runtime.sendMessage({ rtc: "disableWebRTC" });
    }
    return;
  } else if (clickEvent.target.id === "disable-history") {
    if (clickEvent.target.checked) {
      chrome.runtime.sendMessage({ history: "disableHistory" });
    } else {
      chrome.runtime.sendMessage({ history: "enableHistory" });
    }
    return;
  }

  if (clickEvent.target.tagName === "A") {
    clickEvent.preventDefault();
  }
};

if (typeof document !== "undefined") {
  document.addEventListener("click", onPopupClick);
}

// Popup readiness indicators. The old markup was static text plus images
// fetched from http://proxy.i2p/ which 404 even on healthy routers, so the
// popup claimed "Proxy is not ready." forever. These ask the service worker
// instead and report what it actually sees.
function popupStatusInit() {
  var router = document.getElementById("status-router-text");
  var i2p = document.getElementById("status-i2p-text");
  if (!router || !i2p) return;
  function render(last) {
    var ok = last && last.router_console && last.router_console.indexOf("HTTP") === 0;
    var warm = ok && last.net_status && last.net_status !== "ready";
    router.textContent = !ok
      ? "● Router console unreachable: " + (last ? last.router_console : "?")
      : warm
      ? "● Router reachable — warming up: " + (last.net_text || "network integrating") + ". First .i2p loads typically take a few minutes after I2P starts."
      : "● Router console OK — network ready (" + (last.net_text || "OK") + ")";
    router.style.color = !ok ? "#c62828" : warm ? "#e6a000" : "#2e7d32";
  }
  chrome.storage.local.get(["debug_last_probe"], function (got) {
    var last = got.debug_last_probe;
    if (last) render(last);
  });
  chrome.runtime.sendMessage({ debug: "probes" }, function (resp) {
    if (chrome.runtime.lastError || !resp) return;
    render({
      router_console: resp.router_console,
      net_status: resp.net_status,
      net_text: resp.net_text,
    });
  });
  // re-render when the worker's periodic health check updates storage
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === "local" && changes.debug_last_probe) render(changes.debug_last_probe.newValue);
  });
  function showE2e(rec) {
    var ok = rec && !/^FAIL/.test(rec.result);
    i2p.textContent = "● " + (rec ? rec.result : "?");
    i2p.style.color = ok ? "#2e7d32" : "#c62828";
  }
  chrome.storage.local.get(["debug_last_e2e"], function (got) {
    if (got.debug_last_e2e) showE2e(got.debug_last_e2e);
    else i2p.textContent = "● Last .i2p test: none yet";
  });
  // poll storage: the probe outlives the popup when it opens its tab
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === "local" && changes.debug_last_e2e)
      showE2e(changes.debug_last_e2e.newValue);
  });
  function runE2e(ev) {
    if (ev) ev.preventDefault();
    i2p.textContent = "Testing .i2p load (opens a background tab)…";
    i2p.style.color = "";
    chrome.runtime.sendMessage({ debug: "reachability" }, function () {
      if (chrome.runtime.lastError) {
        i2p.textContent = "● Worker not reachable — reload the extension";
        i2p.style.color = "#c62828";
      }
    });
  }
  var link = document.getElementById("run-e2e");
  if (link) link.addEventListener("click", runE2e);
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", popupStatusInit);
}

// Master switch on the status page: mirrors the toolbar-icon checkbox.
function masterSwitchInit() {
  var box = document.getElementById("enable-master");
  if (!box) return;
  chrome.runtime.sendMessage({ i2p: "master", op: "getState" }, function (resp) {
    if (!chrome.runtime.lastError && resp) box.checked = !!resp.enabled;
  });
  box.addEventListener("change", function () {
    chrome.runtime.sendMessage(
      { i2p: "master", op: "setEnabled", on: box.checked },
      function (resp) {
        if (!chrome.runtime.lastError && resp) box.checked = !!resp.enabled;
      }
    );
  });
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", masterSwitchInit);
}

// The router console host/port, overridable from the options page.
var control_host = "localhost";
var control_port = "7657";
chrome.storage.local.get(["control_host", "control_port"], function (got) {
  if (got && got.control_host) control_host = got.control_host;
  if (got && got.control_port) control_port = got.control_port;
});

function refreshIdentity() {
  console.log("Generating new identity");
  const url = "http://" + control_host + ":" + control_port;
  fetch(url)
    .then((r) => console.log("control response:", r.status))
    .catch((e) => console.log("control fetch failed:", e));
}

function goIndex() {
  console.log("visiting readme");
  chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
}

function goHome() {
  console.log("visiting homepage");
  chrome.tabs.create({ url: chrome.runtime.getURL("home.html") });
}

function goTunnel() {
  console.log("visiting i2ptunnel");
  chrome.tabs.create({
    url: "http://" + control_host + ":" + control_port + "/i2ptunnel",
  });
}

function goMail() {
  console.log("visiting mail");
  chrome.tabs.create({
    url: "http://" + control_host + ":" + control_port + "/susimail",
  });
}

function goSnark() {
  console.log("visiting snark");
  chrome.tabs.create({
    url: "http://" + control_host + ":" + control_port + "/i2psnark",
  });
}
