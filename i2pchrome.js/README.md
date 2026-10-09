I2P Plugin For Chromium Persona
===============================

Manifest V3 browser extension that configures a Chromium browsing profile
for use with an I2P router: all traffic is sent through the I2P HTTP proxy
at `127.0.0.1:4444`, direct localhost connections are blocked (the router
console on port 7657 stays reachable), WebRTC/IPv6 leak surfaces are
disabled where the `chrome.privacy` API allows, and I2P tabs are grouped
and badged so you always know which window is darknet-only.

Layout
------

 * `manifest.json`              – Manifest V3; service worker + DNR ruleset
 * `background.js`              – service worker entry; imports the rest
 * `proxy.js`                   – fixed-proxy setup (`chrome.proxy`)
 * `privacy.js`                 – browsing-data wiping, leak mitigations
 * `info.js`                    – proxy/router status shown in the popup
 * `rules/block_localhost.json` – static declarativeNetRequest rules
 * `window.html` + `info.css`   – action popup
 * `home.html` + `home.css` + `home.js` – bundled how-to page
 * `options/`                   – options page

Testing
-------

From the repository root: `node test/mv3-extension.test.js`
(or `make test`). Requires a Chromium binary (`CHROMIUM=/path/to/chromium`
to override).
