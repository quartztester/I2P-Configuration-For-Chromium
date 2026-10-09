#!/usr/bin/env node
// Loads the i2pchrome.js Manifest V3 extension in headless Chromium and
// verifies the migration: service worker startup, proxy config, DNR ruleset
// and a clean popup load. Plain Node, no npm dependencies (CDP over
// --remote-debugging-pipe).
//
// Usage: node test/mv3-extension.test.js   (exit 0 = pass)
//   CHROMIUM=/path/to/chromium overrides the browser binary.
"use strict";

const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const EXT = path.resolve(__dirname, "..", "i2pchrome.js");
const CHROMIUM = process.env.CHROMIUM || "/usr/bin/chromium";
const PROXY_PORT = 4444; // I2P's default HTTP proxy port
const GIF_1PX = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? " -- " + detail : ""}`);
}
function log(...a) {
  fs.writeSync(1, a.join(" ") + "\n");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chromium derives an unpacked extension's ID from sha256 of its absolute path.
function unpackedId(p) {
  const hex = crypto.createHash("sha256").update(p).digest("hex").slice(0, 32);
  return hex
    .split("")
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join("");
}

// Minimal fake HTTP proxy on 127.0.0.1:4444. Serves a 1x1 gif for anything,
// so the popup's remote images load and every hit proves the browser is
// really routing through the extension's fixed proxy config.
const proxyHits = [];
let fakeProxy = null;
function startFakeProxy() {
  return new Promise((resolve) => {
    fakeProxy = http.createServer((req, res) => {
      proxyHits.push(req.url);
      res.writeHead(200, { "Content-Type": "image/gif" });
      res.end(GIF_1PX);
    });
    fakeProxy.on("error", () => resolve(false));
    fakeProxy.listen(PROXY_PORT, "127.0.0.1", () => resolve(true));
  });
}

// CDP transport over --remote-debugging-pipe (write fd 3, read fd 4, \0 framed).
class Browser {
  constructor(args) {
    this.child = spawn(CHROMIUM, args, {
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
      detached: true, // own process group: kill Chromium's subprocesses too
    });
    this.pending = new Map();
    this.seq = 0;
    this.sessions = new Map(); // sessionId -> { label, errors: [], ignored: [] }
    this.stderr = "";
    this.child.stderr.on("data", (d) => (this.stderr += d));
    let buf = "";
    this.child.stdio[4].on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\0")) !== -1) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!raw) continue;
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch (e) {
          continue;
        }
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          p.resolve(msg);
        } else if (msg.method) {
          this.onEvent(msg);
        }
      }
    });
  }
  send(method, params = {}, sessionId, timeoutMs = 10000) {
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ id, error: { message: `timeout waiting for ${method}` } });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.child.stdio[3].write(JSON.stringify(msg) + "\0");
    });
  }
  onEvent(msg) {
    if (msg.method === "Target.detachedFromTarget") {
      this.sessions.delete(msg.params.sessionId);
      return;
    }
    if (
      msg.method === "Target.attachedToTarget" &&
      msg.params.targetInfo.type === "service_worker" &&
      !this.sessions.has(msg.params.sessionId)
    ) {
      log(
        `INFO: SW attachedToTarget waitingForDebugger=${msg.params.waitingForDebugger}`
      );
    }
    const s = this.sessions.get(msg.sessionId);
    if (!s) return;
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      s.errors.push(
        "exception: " +
          ((d.exception && (d.exception.description || d.exception.value)) ||
            d.text)
      );
    } else if (
      msg.method === "Runtime.consoleAPICalled" &&
      msg.params.type === "error"
    ) {
      s.errors.push(
        "console.error: " +
          msg.params.args.map((a) => a.value || a.description || "").join(" ")
      );
    } else if (msg.method === "Log.entryAdded") {
      const e = msg.params.entry;
      if (e.level === "error") {
        // The popup embeds http://proxy.i2p/* indicator images; whether they
        // load depends on the external I2P network, not on the extension.
        if (e.url && e.url.startsWith("http://proxy.i2p/")) {
          s.ignored.push(`${e.text} (${e.url})`);
        } else {
          s.errors.push(`log error: ${e.text}${e.url ? " (" + e.url + ")" : ""}`);
        }
      }
    }
  }
  async attach(targetId, label) {
    const a = await this.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    if (!a.result) return null;
    const sid = a.result.sessionId;
    this.sessions.set(sid, { label, errors: [], ignored: [] });
    await this.send("Runtime.enable", {}, sid);
    await this.send("Log.enable", {}, sid);
    // A worker attached while starting is paused until we say go; without
    // this its script (and the chrome.* bindings) never run.
    await this.send("Runtime.runIfWaitingForDebugger", {}, sid, 2000);
    return sid;
  }
  async evaluate(sessionId, expression, timeoutMs) {
    if (!this.sessions.has(sessionId)) throw new Error("session detached");
    const r = await this.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
      timeoutMs
    );
    if (r.error) throw new Error(r.error.message);
    if (r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      throw new Error(
        (d.exception && d.exception.description) || d.text || "evaluate failed"
      );
    }
    return r.result.result && r.result.result.value;
  }
  async getTargets() {
    const r = await this.send("Target.getTargets");
    return (r.result && r.result.targetInfos) || [];
  }
  sessionFor(label) {
    for (const s of this.sessions.values()) {
      if (s.label === label) return s;
    }
    return null; // never attached
  }
  kill() {
    try {
      process.kill(-this.child.pid, "SIGKILL");
    } catch (e) {
      try {
        this.child.kill("SIGKILL");
      } catch (e2) {}
    }
  }
}

let udd = null;
let browser = null;

// Attach to the SW target and wait until background.js has actually executed
// (chrome.* visible). If the first attach lands on a starting or stale
// worker, look for a fresh target once and try again.
async function attachAndWaitForWorker(browser, target) {
  let t = target;
  for (let round = 0; round < 2; round++) {
    const sid = await browser.attach(t.targetId, "sw");
    if (sid) {
      for (let i = 0; i < 25; i++) {
        try {
          if (
            await browser.evaluate(
              sid,
              "typeof chrome !== 'undefined' && typeof chrome.runtime !== 'undefined'",
              3000
            )
          ) {
            return sid;
          }
        } catch (e) {
          break; // session gone or context exploded -> fresh target round
        }
        await sleep(200);
      }
      browser.sessions.delete(sid);
    }
    t = null;
    for (let i = 0; i < 20 && !t; i++) {
      const targets = await browser.getTargets();
      t = targets.find(
        (x) =>
          x.type === "service_worker" &&
          x.url.startsWith("chrome-extension://") &&
          x.url.endsWith("/background.js")
      );
      if (!t) await sleep(500);
    }
    if (!t) return null;
  }
  return null;
}

async function main() {
  if (!fs.existsSync(CHROMIUM)) {
    check("chromium binary present", false, `${CHROMIUM} not found`);
    return await finish();
  }

  const proxyOk = await startFakeProxy();
  log(
    proxyOk
      ? `fake I2P proxy listening on 127.0.0.1:${PROXY_PORT}`
      : `no fake proxy (port ${PROXY_PORT} busy?) -- proxy-hit check skipped`
  );

  udd = fs.mkdtempSync(path.join(os.tmpdir(), "i2pchrome-test-"));
  browser = new Browser([
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    `--user-data-dir=${udd}`,
    `--load-extension=${EXT}`,
    `--disable-extensions-except=${EXT}`,
    "--remote-debugging-pipe",
    "about:blank",
  ]);

  try {
    // (a)+(b) find the extension's MV3 service worker target
    let swTarget = null;
    for (let i = 0; i < 30 && !swTarget; i++) {
      swTarget = (await browser.getTargets()).find(
        (t) =>
          t.type === "service_worker" &&
          t.url.startsWith("chrome-extension://") &&
          t.url.endsWith("/background.js")
      );
      if (!swTarget) await sleep(500);
    }
    let extId = swTarget ? swTarget.url.split("/")[2] : unpackedId(EXT);
    let swSid = swTarget ? await attachAndWaitForWorker(browser, swTarget) : null;

    // Wake fallback: messaging an extension page starts a stopped worker.
    if (!swTarget) {
      const t = await browser.send("Target.createTarget", {
        url: `chrome-extension://${extId}/window.html`,
      });
      if (t.result) {
        const sid = await browser.attach(t.result.targetId, "wake");
        if (sid) {
          await browser
            .evaluate(
              sid,
              `new Promise((r) => {
                 chrome.runtime.sendMessage({ ping: 1 }, () => r("sent"));
                 setTimeout(() => r("timeout"), 2000);
               })`
            )
            .catch(() => {});
        }
        browser.sessions.clear();
      }
      for (let i = 0; i < 20 && !swTarget; i++) {
        swTarget = (await browser.getTargets()).find(
          (t) =>
            t.type === "service_worker" &&
            t.url.startsWith("chrome-extension://")
        );
        if (!swTarget) await sleep(500);
      }
      if (swTarget) swSid = await attachAndWaitForWorker(browser, swTarget);
    }

    check(
      "extension loads: MV3 service worker target present",
      !!swTarget,
      swTarget ? swTarget.url : "no chrome-extension service_worker target"
    );
    if (!swTarget) {
      check("service worker runs shared scripts", false, "no worker");
      check("chrome.proxy.settings: fixed_servers -> 127.0.0.1:4444", false, "no worker");
      check("DNR ruleset block_localhost enabled; blocks localhost but allows :7657", false, "no worker");
      await checkPopup(browser, extId, false);
      return;
    }
    extId = swTarget.url.split("/")[2];
    check(
      "service worker attaches and evaluates",
      !!swSid,
      swSid ? `session ${swSid}` : "attach/readiness failed"
    );

    if (swSid) {
      // (b) the importScripts chain must have loaded proxy/privacy/info
      let loaded = null;
      try {
        loaded = await browser.evaluate(
          swSid,
          `({
            manifest: chrome.runtime.getManifest().version,
            setupProxy: typeof setupProxy,
            forgetBrowsingData: typeof forgetBrowsingData,
            refreshIdentity: typeof refreshIdentity,
            groupedTabs: typeof groupedTabs,
          })`
        );
      } catch (e) {
        loaded = { error: String(e) };
      }
      check(
        "service worker runs background.js + proxy.js/privacy.js/info.js",
        !!loaded &&
          loaded.setupProxy === "function" &&
          loaded.forgetBrowsingData === "function" &&
          loaded.refreshIdentity === "function" &&
          typeof loaded.groupedTabs !== "undefined",
        JSON.stringify(loaded)
      );

      // (c) chrome.proxy.settings shows the extension's fixed proxy config
      let settings = null;
      try {
        settings = await browser.evaluate(
          swSid,
          `new Promise((r) => chrome.proxy.settings.get({}, (s) => r(s)))`
        );
      } catch (e) {
        settings = { error: String(e) };
      }
      const single =
        settings && settings.value && settings.value.rules
          ? settings.value.rules.singleProxy
          : null;
      check(
        "chrome.proxy.settings: fixed_servers -> 127.0.0.1:4444",
        !!single &&
          settings.value.mode === "fixed_servers" &&
          single.host === "127.0.0.1" &&
          single.port === PROXY_PORT,
        JSON.stringify(settings && settings.value)
      );

      // (d) declarativeNetRequest static ruleset enabled, and its rules
      // really match: block an ordinary localhost URL, allow the router
      // console on port 7657 (testMatchOutcome is unpacked-only, fine here).
      let rulesets = null;
      try {
        rulesets = await browser.evaluate(
          swSid,
          `Promise.all([
             chrome.declarativeNetRequest.getEnabledRulesets(),
             chrome.declarativeNetRequest.testMatchOutcome({
               url: "http://localhost:12345/asset", type: "main_frame",
             }),
             chrome.declarativeNetRequest.testMatchOutcome({
               url: "http://localhost:7657/i2ptunnel", type: "main_frame",
             }),
           ]).then(([enabled, blocked, consoleUrl]) => ({
             enabled,
             blocked: blocked.matchedRules,
             console: consoleUrl.matchedRules,
           }))`
        );
      } catch (e) {
        rulesets = { error: String(e) };
      }
      check(
        "DNR ruleset block_localhost enabled; blocks localhost but allows :7657",
        !!rulesets &&
          Array.isArray(rulesets.enabled) &&
          rulesets.enabled.includes("block_localhost") &&
          Array.isArray(rulesets.blocked) &&
          rulesets.blocked.some((r) => r.ruleId === 1) &&
          Array.isArray(rulesets.console) &&
          rulesets.console.some((r) => r.ruleId === 2),
        JSON.stringify(rulesets)
      );
    }

    // (e) popup window.html loads without console/JS errors
    await checkPopup(browser, extId, proxyOk);

    const swSession = browser.sessionFor("sw");
    check(
      "service worker produced no console/JS errors",
      swSession !== null && swSession.errors.length === 0,
      swSession === null
        ? "not attached"
        : swSession.errors.join("; ") || "clean"
    );
  } finally {
    browser.kill();
  }
  await finish();
}

async function checkPopup(browser, extId, proxyOk) {
  const t = await browser.send("Target.createTarget", { url: "about:blank" });
  if (!t.result) {
    check("popup window.html loads without console errors", false, "could not create target");
    return;
  }
  const sid = await browser.attach(t.result.targetId, "popup");
  if (!sid) {
    check("popup window.html loads without console errors", false, "could not attach");
    return;
  }
  await browser.send("Page.enable", {}, sid);
  const nav = await browser.send(
    "Page.navigate",
    { url: `chrome-extension://${extId}/window.html` },
    sid
  );
  if (nav.error || (nav.result && nav.result.errorText)) {
    check(
      "popup window.html loads without console errors",
      false,
      JSON.stringify(nav.error || (nav.result && nav.result.errorText))
    );
    return;
  }
  // let scripts, privacy calls and image fetches settle
  await sleep(3500);
  let version = null;
  try {
    version = await browser.evaluate(sid, "chrome.runtime.getManifest().version");
  } catch (e) {
    version = null;
  }
  const session = browser.sessionFor("popup");
  const errors = (session && session.errors) || [];
  const ignored = (session && session.ignored) || [];
  for (const i of ignored) log(`INFO: ignored external-image error: ${i}`);
  check(
    "popup window.html loads without console errors",
    errors.length === 0 && version !== null,
    errors.length
      ? errors.join("; ")
      : `chrome APIs available (manifest v${version})`
  );
  if (proxyOk) {
    check(
      "browser actually routes traffic through 127.0.0.1:4444",
      proxyHits.length > 0,
      `${proxyHits.length} proxied request(s), e.g. ${proxyHits[0] || "none"}`
    );
    return;
  }
  // Port 4444 was busy: if a real I2P router owns it, prove routing a
  // different way. .i2p names resolve nowhere but through an I2P proxy, so
  // navigating a real tab to http://proxy.i2p/ and getting an I2P router
  // response (even a 404 page) means traffic went through 127.0.0.1:4444;
  // without the proxy it dies in DNS. Navigated pages need no host
  // permissions, unlike an extension-page fetch (MV3 least-privilege).
  let live = null;
  const pt = await browser.send("Target.createTarget", { url: "about:blank" });
  if (pt.result) {
    const psid = await browser.attach(pt.result.targetId, "probe");
    if (psid) {
      await browser.send("Page.enable", {}, psid);
      await browser.send(
        "Page.navigate",
        { url: "http://proxy.i2p/?i2pchrome-probe=" + Date.now() },
        psid
      );
      await sleep(12000); // the router may take a while to reach the dest
      try {
        live = await browser.evaluate(
          psid,
          `JSON.stringify({t: document.title, l: (document.body &&
             document.body.innerText || "").slice(0,200)})`,
          15000
        );
      } catch (e) {
        live = "evaluate failed: " + e.message;
      }
    }
  }
  // Any document served means we reached the router's HTTP proxy.
  const routed = typeof live === "string" && live.length > 2 && live !== "{}";
  check(
    "browser routes traffic through 127.0.0.1:4444 (live I2P proxy)",
    routed,
    `http://proxy.i2p/ -> ${String(live).slice(0, 160)}`
  );
}

async function finish() {
  const failed = results.filter((r) => !r.ok);
  log("");
  log(
    failed.length === 0
      ? `ALL ${results.length} CHECKS PASSED`
      : `${failed.length}/${results.length} CHECKS FAILED: ${failed
          .map((r) => r.name)
          .join("; ")}`
  );
  cleanup();
  await cleanupProfile();
  const code = failed.length === 0 ? 0 : 1;
  setTimeout(() => process.exit(code), 200);
}

function cleanup() {
  if (browser) browser.kill();
  if (fakeProxy) fakeProxy.close();
}

async function cleanupProfile() {
  if (!udd) return;
  // Give Chromium a moment to die; it recreates profile files while alive.
  await sleep(750);
  try {
    fs.rmSync(udd, { recursive: true, force: true });
  } catch (e) {
    log("INFO: could not remove " + udd + ": " + e.message);
  }
  udd = null;
}

main().catch(async (e) => {
  log("FATAL:", e && e.stack ? e.stack : String(e));
  cleanup();
  await cleanupProfile();
  process.exit(2);
});
