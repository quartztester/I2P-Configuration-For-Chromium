#!/usr/bin/env node
// Verifies the diagnostics panel (debug.html + debug.js + debuglog.js):
// the service worker exposes the debug API, the panel renders state cards,
// the event timeline receives service-worker entries, and the panel's
// end-to-end probe fetches an .i2p site through the proxy (needs a live
// router on 127.0.0.1:4444, like live-i2p-e2e.test.js).
//
// Usage: node test/debug-panel.test.js   (exit 0 = pass)
//   CHROMIUM=/path/to/chromium overrides the browser binary.
"use strict";

const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const EXT = path.resolve(__dirname, "..", "i2pchrome.js");
const CHROMIUM = process.env.CHROMIUM || "/usr/bin/chromium";

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? " -- " + detail : ""}`);
}
function log(...a) {
  fs.writeSync(1, a.join(" ") + "\n");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function unpackedId(p) {
  const hex = crypto.createHash("sha256").update(p).digest("hex").slice(0, 32);
  return hex
    .split("")
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join("");
}

class Browser {
  constructor(args) {
    this.child = spawn(CHROMIUM, args, {
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
      detached: true,
    });
    this.pending = new Map();
    this.seq = 0;
    this.sessions = new Map();
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
  async attach(targetId, label) {
    const a = await this.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    if (!a.result) return null;
    const sid = a.result.sessionId;
    this.sessions.set(sid, { label });
    await this.send("Runtime.enable", {}, sid);
    await this.send("Runtime.runIfWaitingForDebugger", {}, sid, 2000);
    return sid;
  }
  async evaluate(sessionId, expression, timeoutMs = 15000) {
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

async function main() {
  // live router prerequisite
  let haveRouter = false;
  try {
    const r = await fetch("http://127.0.0.1:4444/", { signal: AbortSignal.timeout(2000) });
    haveRouter = r.status > 0;
  } catch (e) {}
  if (!haveRouter) {
    log("SKIP: no I2P router on 127.0.0.1:4444 (debug panel e2e requires one)");
    process.exit(0);
  }

  const udd = fs.mkdtempSync(path.join("/tmp", "i2pdbg-"));
  const browser = new Browser([
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--remote-debugging-pipe",
    `--user-data-dir=${udd}`,
    `--load-extension=${EXT}`,
    "about:blank",
  ]);

  try {
    const extId = unpackedId(EXT);

    // wait for SW
    let sw = null;
    for (let i = 0; i < 40 && !sw; i++) {
      const t = await browser.getTargets();
      sw = t.find(
        (x) => x.type === "service_worker" && x.url.includes(extId)
      );
      if (!sw) await sleep(300);
    }
    check("service worker present", !!sw, sw && sw.url);
    const swSid = sw && (await browser.attach(sw.targetId, "sw"));
    check("service worker attaches", !!swSid);
    // let background.js finish startup
    await sleep(1500);

    const api = await browser.evaluate(
      swSid,
      `JSON.stringify({
         state: typeof debugState, reset: typeof debugReset,
         dbg: typeof dbg, probe: typeof probeRouterConsole })`
    );
    const apiObj = JSON.parse(api);
    check(
      "worker exposes debug API (debugState/debugReset/dbg)",
      apiObj.state === "function" && apiObj.reset === "function" && apiObj.dbg === "function",
      api
    );

    // ask the worker directly: probes should report the live router
    const st = await browser.evaluate(
      swSid,
      `debugState().then(s => JSON.stringify({
         console: s.probes.router_console,
         proxyPort: s.probes.proxy_port,
         proxyMode: s.proxySetting && s.proxySetting.mode,
         dnr: (s.dnr.enabledRulesets||[]).join(","),
         ver: s.version }))`
    );
    const stObj = JSON.parse(st);
    check(
      "debugState probes router console + proxy port",
      /^HTTP \d+/.test(stObj.console) && /^HTTP \d+/.test(stObj.proxyPort),
      st
    );
    check(
      "debugState reports proxy config + DNR",
      stObj.proxyMode === "fixed_servers" && stObj.dnr.includes("block_localhost"),
      st
    );

    // open debug.html in a tab
    await browser.evaluate(
      swSid,
      `chrome.tabs.create({url: chrome.runtime.getURL("debug.html"), active: true})`
    );
    let page = null;
    for (let i = 0; i < 40 && !page; i++) {
      const t = await browser.getTargets();
      page = t.find((x) => x.type === "page" && x.url.includes("debug.html"));
      if (!page) await sleep(300);
    }
    check("debug.html opens as extension page", !!page, page && page.url);
    const pSid = page && (await browser.attach(page.targetId, "page"));
    // poll up to 40s for the panel to finish its probes + e2e tab probe
    let d = null;
    for (let i = 0; i < 80; i++) {
      await sleep(500);
      const dom = await browser.evaluate(
        pSid,
        `JSON.stringify({
           cards: document.querySelectorAll('#cards .card').length,
           ok: document.querySelectorAll('#cards .ok').length,
           bad: document.querySelectorAll('#cards .bad').length,
           logLines: document.querySelectorAll('#log div').length,
           rawLen: (document.getElementById('raw').textContent||'').length,
           e2e: (document.getElementById('e2e')||{}).textContent || null,
           bad: document.querySelectorAll('#cards .bad').length,
           badText: Array.prototype.map.call(
             document.querySelectorAll('#cards .card'),
             function(c){return c.textContent}).filter(function(t){return /✗/.test(t)}).join(' | ').slice(0,200),
           toggle: !!document.getElementById('logging') })`
      );
      d = JSON.parse(dom);
      if (d.e2e && /loaded through I2P|timed out|FAIL|error page/.test(d.e2e))
        break;
    }
    check(
      "panel renders status cards with live state",
      d.cards >= 5 && d.ok >= 3 && d.bad === 0,
      JSON.stringify(d)
    );
    let errs = null;
    try {
      errs = await browser.evaluate(
        pSid,
        "JSON.stringify(window.__dbgErr) + ' | loaded=' + window.__debugpageLoaded + ' started=' + window.__pageProbeStarted + ' result=' + window.__pageProbeResult"
      );
    } catch (e) {}
    check(
      "e2e .i2p tab-load probe succeeds over proxy",
      !!d.e2e && /loaded through I2P/.test(d.e2e),
      "e2e=" + d.e2e + " pageErrors=" + errs
    );
    check(
      "timeline shows service-worker events (persisted via storage)",
      d.logLines >= 2,
      JSON.stringify(d)
    );
    check("logging toggle present", d.toggle === true);

    // reset button path: invoke reset, storage should clear
    const after = await browser.evaluate(
      swSid,
      `debugReset().then(()=>chrome.storage.local.get(null)).then(g=>JSON.stringify(g))`
    );
    check(
      "reset clears stored settings (re-seeded on next worker boot)",
      after === "{}" || after === "null",
      after
    );
  } catch (e) {
    check("unexpected error", false, String((e && e.stack) || e));
  } finally {
    browser.kill();
    try {
      fs.rmSync(udd, { recursive: true, force: true });
    } catch (e) {}
  }

  const failed = results.filter((r) => !r.ok);
  log(failed.length ? `${failed.length} CHECK(S) FAILED` : `ALL ${results.length} CHECKS PASSED`);
  process.exit(failed.length ? 1 : 0);
}

main();
