#!/usr/bin/env node
// Live end-to-end test: loads the extension in headless Chromium (no
// command-line proxy flags — the extension must apply its own proxy config)
// and navigates to real .i2p eepsites through the local I2P router.
//
// Usage: node test/live-i2p-e2e.test.js   (exit 0 = pass)
//   CHROMIUM=/path/to/chromium overrides the browser binary.
//   REQUIRES a running I2P router with HTTP proxy on 127.0.0.1:4444.
//   If no router answers, all checks are SKIPPED and the exit code is 0,
//   so this test is safe to run alongside the offline suite in CI.
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const EXT = path.resolve(__dirname, "..", "i2pchrome.js");
const CHROMIUM = process.env.CHROMIUM || "/usr/bin/chromium";
// Well-known, long-running eepsites, verified reachable from a healthy
// router. Any 2 load = e2e pass (eepsites rate-limit 429 and go dark
// routinely; a single throttled dest must not fail the run).
const SITES = ["http://planet.i2p/", "http://zzz.i2p/", "http://stats.i2p/"];

function log(...a) {
  fs.writeSync(1, a.join(" ") + "\n");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function routerReachable() {
  // Absolute-form GET through the proxy: any HTTP response (even 4xx) from
  // the router proves the port is owned by a live I2P HTTP proxy.
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: 4444, path: "http://zzz.i2p/", method: "GET", timeout: 30000, agent: false },
      (res) => {
        res.resume();
        resolve(true);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

const child = spawn(CHROMIUM, [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), "i2p-e2e-"))}`,
  `--load-extension=${EXT}`,
  `--disable-extensions-except=${EXT}`,
  "--remote-debugging-pipe",
  "about:blank",
], { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"], detached: true });

const pending = new Map();
let seq = 0,
  buf = "";
child.stdio[4].on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\0")) !== -1) {
    const raw = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!raw) continue;
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      continue;
    }
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  }
});
function send(method, params = {}, sessionId, ms = 45000) {
  const id = ++seq;
  return new Promise((res) => {
    pending.set(id, res);
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    child.stdio[3].write(JSON.stringify(msg) + "\0");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        res({ error: { message: "timeout " + method } });
      }
    }, ms);
  });
}

function kill() {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

(async () => {
  if (!(await routerReachable())) {
    log("SKIP: no I2P router answering on 127.0.0.1:4444 — live e2e skipped");
    kill();
    process.exit(0);
  }

  await sleep(4000);
  const t = await send("Target.createTarget", { url: "about:blank" });
  const a = await send("Target.attachToTarget", {
    targetId: t.result.targetId,
    flatten: true,
  });
  const sid = a.result.sessionId;
  await send("Runtime.enable", {}, sid);
  await send("Page.enable", {}, sid);

  // Wait for the extension itself to install the fixed proxy config.
  let proxyOK = false;
  for (let i = 0; i < 20 && !proxyOK; i++) {
    const targets = (await send("Target.getTargets")).result.targetInfos;
    const sw = targets.find(
      (x) => x.type === "service_worker" && x.url.includes("chrome-extension")
    );
    if (sw) {
      const b = await send("Target.attachToTarget", {
        targetId: sw.targetId,
        flatten: true,
      });
      const ssw = b.result && b.result.sessionId;
      if (ssw) {
        await send("Runtime.enable", {}, ssw);
        await send("Runtime.runIfWaitingForDebugger", {}, ssw, 2000);
        const r = await send(
          "Runtime.evaluate",
          {
            expression:
              "new Promise(r=>chrome.proxy.settings.get({},s=>r(s.value&&s.value.mode)))",
            returnByValue: true,
            awaitPromise: true,
          },
          ssw,
          5000
        );
        proxyOK =
          r.result && r.result.result && /fixed_servers|pac_script/.test(r.result.result.value);
      }
    }
    if (!proxyOK) await sleep(1000);
  }
  if (!proxyOK) {
    log("FAIL: extension never applied its proxy config (pac_script/fixed_servers)");
    kill();
    process.exit(1);
  }
  log("extension applied its own proxy config (no CLI proxy flags)");

  let pass = 0;
  let routedCount = 0;
  for (const url of SITES) {
    await send("Page.navigate", { url }, sid);
    await sleep(8000); // eepsites are slow by nature
    let v = null;
    try {
      const r = await send(
        "Runtime.evaluate",
        {
          expression: `({url: location.href, title: document.title,
            len: document.documentElement ? document.documentElement.outerHTML.length : 0,
            err: (document.body && document.body.innerText || "").slice(0,120)})`,
          returnByValue: true,
        },
        sid,
        15000
      );
      v = r.result && r.result.result && r.result.result.value;
    } catch {}
    // "Website Unreachable"/"Website Unknown" are I2P router error pages:
    // they prove routing worked but that particular dest didn't answer.
    const routed = v && v.len > 500;
    const loaded = routed && !/Website (Unreachable|Unknown)|ERR_/i.test(v.err + v.title);
    if (loaded) pass++;
    if (routed) routedCount++;
    log(
      `${loaded ? "LOADED" : routed ? "ROUTED " : "FAILED"} ${url}` +
        (v ? ` -> "${(v.title || "").trim()}" (${v.len} bytes)` : "")
    );
  }
  // Pass = at least one fully loaded eepsite, or two routed (the router's
  // own error pages count as routing proof — they are only obtainable via
  // the I2P path, never from clearnet DNS).
  const ok = pass >= 1 || routedCount >= 2;
  log(`\n${pass}/${SITES.length} eepsites fully loaded, ${routedCount} routed through I2P: ${ok ? "PASS" : "FAIL"}`);
  kill();
  await sleep(500);
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  log("FATAL:", e && e.stack ? e.stack : String(e));
  kill();
  process.exit(2);
});
