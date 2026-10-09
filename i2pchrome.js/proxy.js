function platformCallback(platformInfo) {
    if (platformInfo.os == "android") {
        console.log("android detected");
        return true;
    } else {
        console.log("desktop detected");
        return false;
    }
}

function isDroid() {
    return chrome.runtime.getPlatformInfo(platformCallback);
}

//chrome.privacy.network.peerConnectionEnabled.set({value: false});

function disableNetworkPredictions() {
    try {
        chrome.privacy.network.networkPredictionEnabled.set({ value: false });
        chrome.privacy.network.webRTCIPHandlingPolicy.set({
            value: "disable_non_proxied_udp",
        });
        console.log("Preliminarily disabled WebRTC.");
    } catch (e) {
        console.error("Could not apply privacy settings:", e);
    }
}
// Applied from status.js / privacy.js when the master switch is ON.

function shouldProxyRequest(requestInfo) {
    return requestInfo.parentFrameId != -1;
}

function handleProxyRequest(requestInfo) {
    console.log(`Proxying: ${requestInfo.url}`);
    console.log("   ", getScheme(), getHost(), ":", getPort());
    return { type: getScheme(), host: getHost(), port: getPort() };
}

var proxy_scheme = "HTTP";

function getScheme() {
    if (proxy_scheme == undefined) {
        proxy_scheme = "http";
    }
    if (proxy_scheme == "HTTP") {
        proxy_scheme = "http";
    }
    if (proxy_scheme == "SOCKS") {
        proxy_scheme = "socks";
    }
    console.log("Got i2p proxy scheme:", proxy_scheme);
    return proxy_scheme;
}

var proxy_host = "127.0.0.1";

function getHost() {
    if (proxy_host == undefined) {
        proxy_host = "127.0.0.1";
    }
    console.log("Got i2p proxy host:", proxy_host);
    return proxy_host;
}

var proxy_port = "4444";

function getPort() {
    if (proxy_port == undefined) {
        proxy_port = "4444";
    }
    console.log("Got i2p proxy port:", proxy_port);
    return proxy_port;
}

var control_port = "7657";

function getControlPort() {
    if (control_port == undefined) {
        return "7657";
    }
    console.log("Got i2p control port:", control_port);
    return control_port;
}

function getBrowser() {
    // Chrome 148+ also defines browser.*, so detect Firefox by an API only it
    // provides instead of by the namespace's existence.
    if (
        typeof browser !== "undefined" &&
        browser.runtime &&
        typeof browser.runtime.getBrowserInfo === "function"
    ) {
        return "Firefox";
    }
    return "Chrome";
}

function setupProxy() {
    var Host = getHost();
    var Port = getPort();
    var Scheme = getScheme();
    if (typeof dbg === "function")
        dbg(
            "setupProxy: PAC — .i2p via " +
                Scheme +
                " " +
                Host +
                ":" +
                Port +
                ", everything else DIRECT"
        );

    function handleProxyRequest(requestInfo) {
        // Firefox mirror of the PAC below: only .i2p names take the router.
        var m = /^[a-z][a-z0-9+.-]*:\/\/([^\/:?#]+)/i.exec(requestInfo.url);
        var h = (m ? m[1] : "").toLowerCase();
        if (h.slice(-4) === ".i2p" || h === "i2p") {
            return { type: Scheme, host: Host, port: Port };
        }
        return { type: "direct" };
    }
    if (getBrowser() == "Firefox") {
        console.log("Registering Firefox proxy (.i2p only)", {
            type: Scheme,
            host: Host,
            port: Port,
        });
        browser.proxy.onRequest.addListener(handleProxyRequest, {
            urls: ["<all_urls>"],
        });
    } else {
        // Mixed browsing: only I2P names go through the router; every other
        // site connects directly, so normal browsing keeps working with the
        // switch on. fixed_servers would send the WHOLE profile through the
        // I2P proxy, which refuses clearnet URLs.
        var kw = Scheme === "socks" ? "SOCKS5" : "PROXY";
        var pac =
            "function FindProxyForURL(url, host) {\n" +
            "  if (dnsDomainIs(host.toLowerCase(), '.i2p'))\n" +
            "    return '" + kw + " " + Host + ":" + Port + "';\n" +
            "  return 'DIRECT';\n" +
            "}";
        // NOTE: on current Chromium the pacScript must be the object form
        // ({data,url,mandatory}); a bare string throws "Invalid invocation"
        // and the whole set silently fails. Verified on Chromium 154/Brave 155.
        var config = {
            mode: "pac_script",
            pacScript: { data: pac, url: "", mandatory: false },
        };
        chrome.proxy.settings.set(
            {
                value: config,
                scope: "regular",
            },
            function () {
                if (typeof dbg === "function")
                    dbg(
                        "chrome.proxy.settings.set: " +
                            (chrome.runtime.lastError
                                ? "ERR " + chrome.runtime.lastError.message
                                : "ok")
                    );
            }
        );
    }
}

function checkStoredSettings(storedSettings) {
    let defaultSettings = {};
    if (!storedSettings.proxy_scheme) {
        defaultSettings["proxy_scheme"] = "http";
    }
    if (!storedSettings.proxy_host) {
        defaultSettings["proxy_host"] = "127.0.0.1";
    }
    if (!storedSettings.proxy_port) {
        defaultSettings["proxy_port"] = 4444;
    }
    if (!storedSettings.control_host) {
        defaultSettings["control_host"] = "127.0.0.1";
    }
    if (!storedSettings.control_port) {
        defaultSettings["control_port"] = 7657;
    }
    chrome.storage.local.set(defaultSettings);
}

function update(restoredSettings) {
    proxy_scheme = restoredSettings.proxy_scheme;
    console.log("restoring proxy scheme:", proxy_scheme);
    proxy_host = restoredSettings.proxy_host;
    console.log("restoring proxy host:", proxy_host);
    proxy_port = restoredSettings.proxy_port;
    console.log("restoring proxy port:", proxy_port);
    control_host = restoredSettings.control_host;
    console.log("restoring control host:", control_host);
    control_port = restoredSettings.control_port;
    console.log("restoring control port:", control_port);
}

chrome.storage.local.get(function (got) {
    if (typeof dbg === "function")
        dbg("restored settings: " + JSON.stringify(got));
    checkStoredSettings(got);
    update(got);
    // NOTE: no setupProxy() here. The master switch in status.js owns
    // (re)application so that the menu toggle can actually keep the proxy
    // off; a blanket auto-apply here used to resurrect it on every reload.
});

chrome.windows.onCreated.addListener(() => {
    // status.js may not be loaded in contexts that only pull in proxy.js
    // (popup, tests). Only auto-apply when no master switch disagrees.
    if (typeof i2pEnabledState === "function" && !i2pEnabledState()) return;
    const gettingStoredSettings = chrome.storage.local.get();
    gettingStoredSettings.then(setupProxy, onError);
});
