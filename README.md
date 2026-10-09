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

1. Download `i2pchrome.js-2.1.2-unpacked.zip` from the
   [latest release](https://github.com/quartztester/I2P-Configuration-For-Chromium/releases/latest) and unzip it.
2. Create a fresh Chromium profile (chrome://settings → Add person) —
   **do not sign in / enable sync** on it.
3. Open `chrome://extensions`, enable **Developer mode**, click
   **Load unpacked**, select the unzipped folder.
4. Browse `.i2p` sites. **Type the full URL, including `http://`**
   (e.g. `http://zzz.i2p/`) — Chrome does not recognize `.i2p` as a
   domain, so typing bare `zzz.i2p` in a new tab sends it to your search
   engine instead of the proxy. The toolbar popup links to the router
   console tools (i2ptunnel, susimail, snark) and clears browsing data
   on demand.
5. If `.i2p` sites do not load, click **Diagnostics** in the popup: it
   probes the router console and proxy ports, the browser proxy
   configuration (including who controls it), the localhost-block ruleset
   and SafeBrowsing state, runs a live `.i2p` page-load test, and keeps a
   togglable event timeline. **Copy report** produces a paste-ready
   bundle for bug reports.

The Chrome Web Store listing is the retired MV2 build and will not load
in current Chromium; use the steps above.

## What it does

| Area | Behavior |
|---|---|
| Proxy | fixed proxy `127.0.0.1:4444` via `chrome.proxy`, bypass for localhost |
| Localhost block | static declarativeNetRequest rules block `localhost`/`127.0.0.1`/`[::1]` (any port, incl. bare `http://localhost/`), allow only `:7657` |
| WebRTC | `disable_non_proxied_udp` (no UDP leak around the proxy) |
| Leak services | SafeBrowsing (leaks .i2p URL hash-prefixes to Google unproxied), hyperlink auditing, referrers, third-party cookies, predictions, translate/autofill/suggest — all off |
| Hygiene | one-click wipe of history/passwords/forms/localStorage/cache for `.i2p` hosts |
| Permissions | minimal: no `<all_urls>` host grant |

## Testing

```
make test        # all suites + launcher round-trip/tamper gate, non-zero on failure
make test-live   # needs a running router: loads real eepsites end-to-end
```

`test/mv3-extension.test.js` loads the extension in headless Chromium over
CDP and asserts service-worker startup, proxy config, DNR rule outcomes,
popup health, and real proxy routing. `test/debug-panel.test.js` opens the
Diagnostics panel itself and checks its probes, cards, timeline, e2e
`.i2p` load and reset path against a live router.
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
