/*
 * i2pchrome.js MV3 service worker.
 *
 * In Manifest V3 the background page is replaced by a service worker. All
 * extension event listeners MUST be registered synchronously at startup, so
 * anything that depends on stored settings re-applies itself from inside the
 * storage callback rather than deferring listener registration.
 */

importScripts("proxy.js", "privacy.js", "info.js", "debuglog.js", "debug.js");

dbg("service worker started");
chrome.runtime.onStartup.addListener(function () {
  dbg("browser startup");
});
chrome.runtime.onInstalled.addListener(function (d) {
  dbg("installed/updated reason=" + (d && d.reason));
});

// Group every tab that visits an .i2p origin into a yellow "I2P Browsing"
// tab group (replaces the old webRequest-based grouping hook, which needed
// the removed webRequestBlocking permission and fired on every subrequest).
const groupedTabs = new Set();
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (groupedTabs.has(tabId)) return;
  const url = tab.url || changeInfo.url || "";
  if (!/\/\/[^/]*\.i2p\//.test(url) && !/\/\/[^/]*\.i2p$/.test(url)) return;
  groupedTabs.add(tabId);
  chrome.tabs.group({ tabIds: tabId }).then((groupId) => {
    chrome.tabGroups.update(groupId, { color: "yellow", title: "I2P Browsing" });
  }).catch(() => {
    groupedTabs.delete(tabId);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => groupedTabs.delete(tabId));

// Detect someone else (policy, another extension, a manual setting)
// clearing or replacing our proxy configuration while the browser runs.
chrome.proxy.settings.onChange.addListener((details) => {
  dbg("proxy setting changed by: " + (details && details.levelOfControl));
});
