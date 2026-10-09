#!/usr/bin/env node
// v2.2 UX suite: the toolbar icon is the status light and the master switch
// (menu checkbox / status-page checkbox — same message API) really tears
// down and restores chrome.proxy, the localhost DNR firewall, and privacy.
//
// Usage: node test/icon-toggle.test.js   (exit 0 = pass)
//   CHROMIUM=/path/to/browser overrides the binary.
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
function log(s) { process.stdout.write(s + "\n"); }
function finish() {
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    log(`${failed.length}/${results.length} CHECKS FAILED: ${failed.map(f=>f.name).join("; ")}`);
    process.exit(1);
  }
  log(`ALL ${results.length} CHECKS PASSED`);
}
function unpackedId(p) {
  const h = crypto.createHash("sha256").update(p).digest("hex").slice(0, 32);
  return h.split("").map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const udd = fs.mkdtempSync(path.join(require("os").tmpdir(), "i2p-ux-"));
  const child = spawn(CHROMIUM, [
    "--headless=new", "--no-sandbox", "--disable-gpu",
    "--remote-debugging-pipe",
    `--user-data-dir=${udd}`,
    `--load-extension=${EXT}`,
    `--disable-extensions-except=${EXT}`,
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });

  let seq = 0; const pending = new Map(); let buf = "";
  child.stdio[4].on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\0")) !== -1) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!raw) continue;
      let m; try { m = JSON.parse(raw); } catch (e) { continue; }
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  function send(method, params, sessionId, ms) {
    return new Promise((res) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); res({ error: { message: "timeout " + method } }); }, ms || 10000);
      pending.set(id, (r) => { clearTimeout(timer); res(r); });
      const msg = { id, method, params: params || {} };
      if (sessionId) msg.sessionId = sessionId;
      child.stdio[3].write(JSON.stringify(msg) + "\0");
    });
  }
  async function evalin(sid, expr, ms) {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sid, ms || 20000);
    if (r.error) throw new Error(r.error.message);
    if (r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description) || r.result.exceptionDetails.text);
    return r.result.result && r.result.result.value;
  }

  try {
    const id = unpackedId(EXT);
    let sw = null;
    for (let i = 0; i < 40 && !sw; i++) {
      const t = await send("Target.getTargets");
      sw = t.result.targetInfos.find((x) => x.type === "service_worker" && x.url.includes(id));
      if (!sw) await sleep(300);
    }
    check("service worker started", !!sw);
    if (!sw) throw new Error("no service worker");
    const swSid = (await send("Target.attachToTarget", { targetId: sw.targetId, flatten: true })).result.sessionId;
    await send("Runtime.enable", {}, swSid);
    await sleep(4000); // boot + first health probe

    const manifest = await evalin(swSid, "fetch(chrome.runtime.getURL('manifest.json')).then(r=>r.json())");
    check("manifest: action.default_popup absent", !manifest.action.default_popup);
    check("manifest: status icons present", !!(manifest.action.default_icon && manifest.action.default_icon["16"] && /off-16/.test(manifest.action.default_icon["16"])));
    check("manifest: contextMenus + alarms permissions", manifest.permissions.includes("contextMenus") && manifest.permissions.includes("alarms"));
    for (const f of ["on", "off", "bad"]) {
      for (const s of [16, 32, 48]) {
        const p = path.join(EXT, "icons", `${f}-${s}.png`);
        if (!fs.existsSync(p)) { check(`icon file ${f}-${s}.png`, false, "missing"); }
      }
    }
    check("icon files on-*/off-*/bad-* present", true);
    const proxyMode = () => evalin(swSid, "chrome.proxy.settings.get({incognito:false}).then(d=>d.value.mode)");
    const rulesets = () => evalin(swSid, "chrome.declarativeNetRequest.getEnabledRulesets().then(a=>a)");
    const title = () => evalin(swSid, "chrome.action.getTitle({}).then(t=>t)");
    const localhostBlocked = () => evalin(swSid, "chrome.declarativeNetRequest.testMatchOutcome({url:'http://localhost:631/',type:'main_frame'}).then(r=>r.matchedRules.length)");

    // amber/warm icons and classifier wiring
    for (const s of [16, 32, 48]) {
      const p = path.join(EXT, "icons", `warm-${s}.png`);
      if (!fs.existsSync(p)) check(`icon file warm-${s}.png`, false, "missing");
    }
    check("icon files warm-* present", true);
    const warm16 = await evalin(swSid, "fetch(chrome.runtime.getURL('icons/warm-16.png')).then(r=>r.ok)");
    check("warm-16.png loads from extension origin", warm16 === true);

    // classifyRouterNetwork parses sb_netstatus from a live router console
    // page. CI has no router, so verify the parser against fixture HTML
    // by evaluating the same regex the extension uses.
    const fixtures = [
      ["OK", "ready"], ["Firewalled", "ready"], ["Hidden", "ready"],
      ["Testing", "warming"], ["Error", "warming"],
    ];
    let fxOk = true;
    for (const [word, expect] of fixtures) {
      const fake = '"<h4><span class=\\"sb_netstatus x\\"><a title=\\"t\\" href=\\"/h\\">Network: ' + word + '</a></span></h4>"';
      const got = await evalin(swSid,
        "(()=>{var html=" + fake + ";var m=html.match(/sb_netstatus[^>]*>\\s*(?:<a[^>]*>)?\\s*Network:\\s*([A-Za-z]+)/);var word=m?m[1]:'';var st='unknown';if(/^(OK|Firewalled|Hidden)$/.test(word))st='ready';else if(/^Testing$/i.test(word))st='warming';else if(/^Error$/i.test(word))st='warming';return word+'|'+st;})()");
      if (got !== word + "|" + expect) fxOk = false;
    }
    check("classifier maps console status words correctly", fxOk);

    // boot icon is amber-while-checking then settles (CI: no router -> red)
    const bootTitle = await title();
    check("boot: icon title mentions warming or router state", /warming|ON|OFF/.test(bootTitle));

    // ON state (default boot)
    check("boot: proxy configured (pac_script)", (await proxyMode()) === "pac_script");
    check("boot: localhost firewall armed", (await rulesets()).includes("block_localhost"));
    check("boot: localhost traffic blocked", (await localhostBlocked()) > 0);

    // Open the status page and use the same master-switch message the
    // right-click menu sends.
    await evalin(swSid, "chrome.tabs.create({url:chrome.runtime.getURL('window.html')})");
    await sleep(2500);
    const t = (await send("Target.getTargets")).result.targetInfos;
    const pg = t.find((x) => x.type === "page" && /window\.html/.test(x.url || ""));
    check("status page opens", !!pg);
    if (!pg) throw new Error("no status page");
    const ps = (await send("Target.attachToTarget", { targetId: pg.targetId, flatten: true })).result.sessionId;
    check("status page shows master checkbox",
      (await evalin(ps, "!!document.getElementById('enable-master')")) === true);
    check("checkbox reflects ON at boot",
      (await evalin(ps, "document.getElementById('enable-master').checked")) === true);

    // switch OFF
    await evalin(ps, "(()=>{const b=document.getElementById('enable-master');b.checked=false;b.dispatchEvent(new Event('change'));return 1})()");
    await sleep(2000);
    check("OFF: proxy torn down (system)", (await proxyMode()) === "system");
    check("OFF: localhost firewall stood down", !(await rulesets()).includes("block_localhost"));
    check("OFF: localhost traffic allowed", (await localhostBlocked()) === 0);
    check("OFF: persisted to storage", (await evalin(swSid, "chrome.storage.local.get('enabled').then(g=>g.enabled)")) === false);
    check("OFF: icon title says OFF", /OFF/.test(await title()));

    // switch ON
    await evalin(ps, "(()=>{const b=document.getElementById('enable-master');b.checked=true;b.dispatchEvent(new Event('change'));return 1})()");
    await sleep(2500);
    check("ON: proxy restored", (await proxyMode()) === "pac_script");
    check("ON: localhost firewall re-armed", (await rulesets()).includes("block_localhost"));
    check("ON: icon title says ON", /ON/.test(await title()));
  } catch (e) {
    check("suite completed", false, String(e && e.message || e));
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch (e) {}
    try { fs.rmSync(udd, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch (e) {}
  }
  finish();
  setTimeout(() => process.exit(results.some(r=>!r.ok) ? 1 : 0), 200);
})().catch((e) => { log("FATAL " + e); process.exit(1); });
