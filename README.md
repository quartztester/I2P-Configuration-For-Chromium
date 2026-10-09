How to tweak a Chromium-Based Web Browser to work with I2P
==========================================================

This is not a recommendation! This is a much more complicated procedure than
we wish to recommend to anyone. A great deal of thought went into the design of
the [Firefox extension](https://eyedeekay.github.io/I2P-in-Private-Browsing-Mode-Firefox/),
which is safer and better because of the way Mozilla has designed and maintained
it's webextension privacy API's. Moreover, Chrome is bad for the Internet. So is
Google. If you **must**, absolutely must, use Chrome, then you are part of a
different anonymity set, and in all likelihood, unique. You are subject to
changes in the way Chrome is configured, including possibly unstable
command-line flags which you might use to configure the proxy. This procedure
does not make these risks, which are inherent to the use of Chromium, any
greater or lesser, rather it teaches you to encapsulate a Chromium-based
browsing profile for I2P which is the best that is possible to create with
technology available across all Chromium variants. Also use Chromium or even
better, ungoogled-chromium because Chrome is an advertising delivery vehicle
with trivial browser-like characteristics.

This is an *EXPERIMENTAL* Procedure.

## What's new in version 2.0.0 (Manifest V3)

Manifest V2 was retired by Google and Chromium; MV2 extensions no longer
load in current Chromium builds. Version 2.0.0 of this extension is
Manifest V3:

 * The persistent background page is now a **service worker**
   (`background.js` + `importScripts` of `proxy.js`/`privacy.js`/`info.js`).
 * `browser_action` is now `action`.
 * Blocking of `localhost`/`127.0.0.1`/`[::1]` traffic (so your I2P profile
   can't leak to local services, with the router console on port 7657 still
   allowed) moved from blocking `webRequest` — whose `webRequestBlocking`
   permission MV3 extensions can't have — to a static
   **`declarativeNetRequest`** ruleset (`rules/block_localhost.json`).
 * Tab-grouping of I2P windows now uses the `chrome.tabs.onUpdated` +
   `chrome.tabGroups` APIs instead of a webRequest hook.
 * Dead references to `home.js`/`index.html` pages that were never shipped
   in the extension were fixed, and a small `home.js` provides the options
   page's collapsible sections.

Build the launcher binaries (embeds the extension; regenerate `assets.go`
after any change under `i2pchrome.js/`, then update `EXTENSIONHASHES` in
`main.go` with the new `sha256` of the extension directory):

    go run -tags generate gen.go   # regenerate embedded assets
    make                            # builds .exe, -darwin, and linux launchers

Run the headless automated test (see below) after regenerating to confirm
the extension still loads and routes.

Privacy Policy
--------------

This browser extension does not collect any personal information. It requires
access to local storage and browsing data permissions in order to delete them
when directed to by the user. This browser extension does not transmit any
information to any third party, nor will it, ever.

This browser extension cannot influence telemetry carried out by browser vendors
to determine performance in their distribution channels, nor can it mitigate any
other browser vendor telemetry. 

This browser extension is entirely Free, Open-Source software.

### Don't enable syncing for this Profile

You should not enable the use of a google account or plugin syncing for this
profile. If you see something like these:

 * **Syncing Options:**
  - ![sync](sync.png) No!
  - ![plugins](plugins.png) No!

Say no, otherwise you will be sharing your profile data with google!

Profile+Plugin Solution, All Platforms
--------------------------------------

This solution is probably the easiest for the majority of people, but it may not
have the best privacy characteristics because it relies on API's and tooling
that Google makes available via extensions, which is pretty narrow.

**Step 1: Create an I2P Browsing Profile**

 * **1A:** Open the people manager to create your I2P persona within Chromium.
  - ![Open the people manager.](people.png)
 * **1B:** Add a person named I2P Browsing Mode.
  - ![Add a person.](manager.png)
 * **1C:** Give the person some cool shades to protect them on the *darkweb*.
  - ![Give them some cool shades.](shades.png)
 * **1D:** Awwwwwww...
  - ![Feels bad.](done.png)

**Step 2: Install Extension on profile**

 * **2A:** Open the following link in your I2P Browsing Mode persona and install
 the extension like you normally would, by clicking the "Install in Chrome"
 button. This is an *experimental* extension.
 [i2pchrome.js](https://chrome.google.com/webstore/detail/i2pchromejs/ikdjcmomgldfciocnpekfndklkfgglpe)

 Note: the Chrome Web Store listing is the old Manifest V2 build, which
 current Chromium refuses to load. Until a new store build is published,
 load this repository's `i2pchrome.js/` directory unpacked: open
 `chrome://extensions`, enable **Developer mode**, click **Load unpacked**
 and select `i2pchrome.js/`.

Pure Terminal Solution, Unix-Only
---------------------------------

This solution uses a shell script to wrap the Chromium executable and apply
I2P-ready settings.

**Step 1: Create a file named /usr/bin/chromium-i2p with the following**
**contents.**

        #! /usr/bin/env sh
        # Launches Chromium, pre-configured for I2P
        #
        CHROMIUM_I2P="$HOME/i2p/chromium"
        mkdir -p "$CHROMIUM_I2P"
        /usr/bin/chromium --user-data-dir="$CHROMIUM_I2P" \
          --proxy-server="http://127.0.0.1:4444" \
          --proxy-bypass-list=127.0.0.1:7657 \
          --safebrowsing-disable-download-protection \
          --disable-client-side-phishing-detection \
          --disable-3d-apis \
          --disable-accelerated-2d-canvas \
          --disable-remote-fonts \
          --disable-sync-preferences \
          --disable-sync \
          --disable-speech \
          --disable-webgl \
          --disable-reading-from-canvas \
          --disable-gpu \
          --disable-auto-reload \
          --disable-background-networking \
          --disable-d3d11 \
          --disable-file-system $@

### Notes

As you can see, it simply sets a group of flags. Of particular note are
the ```--user-data-dir=$CHROMIUM_I2P``` flag, which forces Chromium to treat
a new directory as the user data directory and prevents your clearnet Chromium
profile from polluting your I2P Chromium profile, and
```--proxy-server="http://127.0.0.1:4444" --proxy-bypass-list=127.0.0.1:7657```
which configure Chromium to use I2P's HTTP Proxy for everything *except* for
router console administration. The rest is just disabling telemetry and features
which may be fingerprintable in an effort to reduce the granularity available to
an attacker trying to measure Chromium.

**Step 2: To also add a shortcut for incognito mode, create another file named**
**/usr/bin/chromium-i2p-incognito with the following contents:**

        #! /usr/bin/env sh
        # Launches Chromium, pre-configured for I2P
        #
        CHROMIUM_I2P="$HOME/i2p/chromium"
        mkdir -p "$CHROMIUM_I2P"
        /usr/bin/chromium-i2p --incognito \
          $@

Automated Extension Test
------------------------

The Manifest V3 extension can be verified headlessly (needs Chromium at
`/usr/bin/chromium`; override the path with the `CHROMIUM` environment
variable):

    node test/mv3-extension.test.js

The test loads `i2pchrome.js/` unpacked in headless Chromium
(`--headless=new --no-sandbox --load-extension=... --disable-extensions-except=... --remote-debugging-pipe`)
and checks that the extension's MV3 service worker target starts, that the
service worker ran `background.js` plus `proxy.js`/`privacy.js`/`info.js`,
that `chrome.proxy.settings` is a fixed proxy at `127.0.0.1:4444`, that the
`block_localhost` declarativeNetRequest ruleset is enabled and actually
blocks plain localhost URLs while still allowing the router console on port
7657, and that the `window.html` popup loads without console or script
errors. If the extension's proxy port (4444) is free it stands up a stub
proxy and counts proxied hits; if a real I2P router owns the port it proves
routing instead by fetching `http://proxy.i2p/` from the popup — a `.i2p`
name only resolves through the I2P proxy, so any HTTP response confirms the
browser is honoring the extension's proxy configuration. It prints one
`PASS`/`FAIL` line per check and exits 0 only when every check passes.
GitHub Actions (`.github/workflows/ci.yml`) runs this test headlessly and
builds the three launcher binaries on every push and pull request.
