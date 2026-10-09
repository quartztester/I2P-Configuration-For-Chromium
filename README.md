# I2P Configuration for Chromium (i2pchrome.js)

Manifest V3 browser extension that turns a Chromium **profile** into an
I2P browsing profile: all traffic is routed through your local I2P HTTP
proxy (`127.0.0.1:4444`), direct localhost connections are blocked (router
console on `:7657` stays reachable), leak-prone browser services are
disabled, and tabs on `.i2p` sites are grouped and badged yellow.

> **Experimental.** A dedicated profile is mandatory — `chrome.proxy` and
> `chrome.privacy` are browser-wide, so an extension like this affects
> every window using that profile. Never browse the clearnet from the
> same profile. The Firefox equivalent is better designed:
> [I2P in Private Browsing Mode](https://eyedeekay.github.io/I2P-in-Private-Browsing-Mode-Firefox/).

## Install

**Requires:** a running I2P router with the HTTP proxy on `4444`
(default) and console on `7657`.

1. Download `i2pchrome.js-2.2.1-unpacked.zip` from the
   [latest release](https://github.com/quartztester/I2P-Configuration-For-Chromium/releases/latest) and unzip it.
2. Create a fresh Chromium profile (chrome://settings → Add person) —
   **do not sign in / enable sync** on it.
3. Open `chrome://extensions`, enable **Developer mode**, click
   **Load unpacked**, select the unzipped folder.
   The toolbar icon is the status light: **green dot** = I2P on and the
   router answers, **red dot** = on but the router is unreachable (start
   I2P), **grey dot** = switched off.
4. Browse normally — `.i2p` and clearnet side by side. **Type the full
   `.i2p` URL, including `http://`** (e.g. `http://zzz.i2p/`) — Chrome
   does not recognize `.i2p` as a domain, so typing bare `zzz.i2p` in a
   new tab sends it to your search engine instead of the proxy.
5. **Right-click the toolbar icon** for the menu: toggle **Enable I2P
   proxy** off/on (off restores your normal browsing proxy instantly),
   open the status page (left-click does this too), Diagnostics, or
   options. The status page links to the router console tools (i2ptunnel,
   susimail, snark) and clears browsing data on demand.
6. If `.i2p` sites do not load (red dot), right-click → **Diagnostics**:
   it probes the router console and proxy ports, the browser proxy
   configuration (including who controls it), the localhost-block ruleset
   and SafeBrowsing state, runs a live `.i2p` page-load test, and keeps a
   togglable event timeline. **Copy report** produces a paste-ready
   bundle for bug reports.

The Chrome Web Store listing is the retired MV2 build and will not load
in current Chromium; use the steps above.

**Brave:** works — the full test suite (service worker, proxy config, DNR
rules, status icon + master switch, Diagnostics panel, live `.i2p` loads) passes on
`brave-browser`, including `chrome.proxy` and `chrome.privacy` effects.
One Brave-specific gotcha: with **HTTPS-First Mode** enabled
(`brave://settings/security`), Brave force-upgrades `http://zzz.i2p/` to
https and you'll get a connection error. Turn HTTPS-First Mode off in
the I2P browsing profile, or click "Continue to HTTP site" when Brave
shows its upgrade warning.

## What it does

| Area | Behavior |
|---|---|
| Proxy | mixed browsing via PAC: **only `.i2p`** goes through `127.0.0.1:4444`, every other site connects directly — normal browsing keeps working with I2P on. (Firefox: equivalent `proxy.onRequest` filter. Older builds proxied the whole profile, which broke clearnet sites.) |
| Localhost block | static declarativeNetRequest rules block `localhost`/`127.0.0.1`/`[::1]` (any port, incl. bare `http://localhost/`), allow only `:7657` |
| WebRTC | `disable_non_proxied_udp` (no UDP leak around the proxy) |
| Leak services | SafeBrowsing (leaks .i2p URL hash-prefixes to Google unproxied), hyperlink auditing, referrers, third-party cookies, predictions, translate/autofill/suggest — all off |
| Hygiene | one-click wipe of history/passwords/forms/localStorage/cache for `.i2p` hosts |
| Master switch | toolbar icon = status light (green/red/grey dot); right-click menu or status-page checkbox toggles proxy + leak protections + localhost firewall on/off |
| Permissions | minimal: no `<all_urls>` host grant |

## Testing

```
make test        # all suites + launcher round-trip/tamper gate, non-zero on failure
make test-live   # needs a running router: loads real eepsites end-to-end
```

`test/mv3-extension.test.js` loads the extension in headless Chromium over
CDP and asserts service-worker startup, proxy config, DNR rule outcomes,
status page health, and real proxy routing. `test/icon-toggle.test.js`
flips the master switch off and on and verifies the proxy, the localhost
firewall, storage, and the icon title follow it. `test/debug-panel.test.js`
opens the Diagnostics panel itself and checks its probes, cards, timeline,
e2e `.i2p` load and reset path against a live router.
`test/live-i2p-e2e.test.js` applies
no CLI proxy flags, lets the extension configure itself, and requires
≥2/3 live eepsites (zzz, proxy, planet) to render; it self-skips when no
router is listening. CI runs both plus launcher builds for
Windows/macOS/Linux.

## Launcher binaries

The self-configuring launchers under the release assets embed the
extension and verify it before use: a SHA-256 over the extension
directory's file paths **and contents** is checked before Chromium is
launched with `--load-extension`, and the launcher refuses to start on
mismatch.

Rebuild after modifying `i2pchrome.js/`:

```
go run -tags generate gen.go    # regenerate embedded assets
# update EXTENSIONHASHES in main.go with: go run ./path/to/hashcalc i2pchrome.js
make                            # builds windows/darwin/linux launchers
```

## Known limitations

- `chrome.proxy`/`chrome.privacy` are browser-wide: use a dedicated profile
  and never mix clearnet browsing into it.
- Chromium's own quota-integrity/parsing telemetry bypasses `chrome.proxy`
  and cannot be disabled by extensions; use ungoogled-chromium if that
  matters to you.
- Eepsite traffic is only as private as the destination's I2P keys; plain
  HTTP is not end-to-end encrypted past the router.

See [docs/TUTORIAL.md](docs/TUTORIAL.md) for the original illustrated
walkthrough (profiles, sync warnings, pure-terminal flag recipe).

## Privacy policy

No information is collected or transmitted to third parties, ever. The
extension stores only your proxy settings locally and uses browsing-data
permissions solely to delete data when you click. Free, open-source
software (MIT).
