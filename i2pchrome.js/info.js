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
