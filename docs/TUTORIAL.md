# Illustrated walkthrough (original)

Long-form companion to the concise [README](../README.md). Written for
the MV2 era; the store-install step is outdated and annotated below, the
rest still applies.

### Don't enable syncing for this Profile

You should not enable the use of a google account or plugin syncing for this
profile. If you see something like these:

 * **Syncing Options:**
  - ![sync](../sync.png) No!
  - ![plugins](../plugins.png) No!

Say no, otherwise you will be sharing your profile data with google!

Profile+Plugin Solution, All Platforms
--------------------------------------

This solution is probably the easiest for the majority of people, but it may not
have the best privacy characteristics because it relies on API's and tooling
that Google makes available via extensions, which is pretty narrow.

**Step 1: Create an I2P Browsing Profile**

 * **1A:** Open the people manager to create your I2P persona within Chromium.
  - ![Open the people manager.](../people.png)
 * **1B:** Add a person named I2P Browsing Mode.
  - ![Add a person.](../manager.png)
 * **1C:** Give the person some cool shades to protect them on the *darkweb*.
  - ![Give them some cool shades.](../shades.png)
 * **1D:** Awwwwwww...
  - ![Feels bad.](../done.png)

**Step 2: Install Extension on profile**

 * **2A:** Open the following link in your I2P Browsing Mode persona and install
 the extension like you normally would, by clicking the "Install in Chrome"
 button. This is an *experimental* extension.
 [i2pchrome.js](https://chrome.google.com/webstore/detail/i2pchromejs/ikdjcmomgldfciocnpekfndklkfgglpe)

 The store listing is the retired Manifest V2 build; current Chromium
 refuses to load it. Instead download `i2pchrome.js-2.0.0-unpacked.zip`
 from [releases](https://github.com/quartztester/I2P-Configuration-For-Chromium/releases),
 unzip it, open `chrome://extensions`, enable **Developer mode**, click
 **Load unpacked** and select the unzipped folder.

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
