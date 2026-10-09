"use strict";
// End-to-end v2.2.3 verification in a real Chromium:
//
//  Part A (no router required): mock console serves the exact I2P console
//  sb_netstatus markup. The extension service worker's real health check must
//  drive the toolbar icon amber (Testing) -> green (OK) -> red (down).
//
//  Part B (skips without a live router): navigate a real tab to a .i2p
//  eepsite and verify it renders through the PAC-routed I2P proxy.
//
// Usage: node test/e2e-v223.test.js [--live]
// --live runs Part B; without it only Part A runs.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const EXT = path.join(__dirname, "..", "i2pchrome.js");
const PROXY = process.env.I2P_PROXY || "127.0.0.1:4444";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launchChromium() {
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "e2ev223-"));
  const child = spawn(process.env.CHROMIUM || "/usr/bin/chromium", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-pipe",
    `--user-data-dir=${udd}`, `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`,
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
  child.stdio[3].on("error", () => {});
  child.stdio[4].on("error", () => {});
  const cdp = { child, udd, seq: 0, pending: new Map(), buf: "" };
  child.stdio[4].on("data", (d) => {
    cdp.buf += d.toString();
    let i;
    while ((i = cdp.buf.indexOf("\0")) !== -1) {
      const raw = cdp.buf.slice(0, i); cdp.buf = cdp.buf.slice(i + 1);
      if (!raw) continue;
      let m; try { m = JSON.parse(raw); } catch (e) { continue; }
      if (m.id && cdp.pending.has(m.id)) { cdp.pending.get(m.id)(m); cdp.pending.delete(m.id); }
    }
  });
  cdp.send = (method, params, sessionId, ms) => new Promise((res) => {
    const id = ++cdp.seq;
    const timer = setTimeout(() => { cdp.pending.delete(id); res({ error: { message: "timeout" } }); }, ms || 8000);
    cdp.pending.set(id, (r) => { clearTimeout(timer); res(r); });
    const msg = { id, method, params: params || {} };
    if (sessionId) msg.sessionId = sessionId;
    child.stdio[3].write(JSON.stringify(msg) + "\0");
  });
  cdp.evalin = async (sid, expr, ms) => {
    const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sid, ms || 8000);
    if (r.error) throw new Error(r.error.message);
    if (r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description) || r.result.exceptionDetails.text);
    return r.result.result && r.result.result.value;
  };
  cdp.findSW = async () => {
    // with --disable-extensions-except the only chrome-extension worker is ours
    for (let i = 0; i < 60; i++) {
      const t = await cdp.send("Target.getTargets");
      const sw = t.result.targetInfos.find((x) => x.type === "service_worker" && /chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(x.url));
      if (sw) return sw;
      await sleep(300);
    }
    return null;
  };
  cdp.cleanup = () => {
    try { process.kill(-child.pid, "SIGKILL"); } catch (e) {}
    try { fs.rmSync(udd, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch (e) {}
  };
  return cdp;
}

// ---------------------------------------------------------------------------
// Part A: amber state machine against a mock console
// ---------------------------------------------------------------------------
async function partA() {
  const STATE = { word: "Testing" };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      "<html><body><h4><span class=\"sb_netstatus testing\"><a href=\"/help#reachabilityhelp\" title=\"Information about the network status\">Network: " +
        STATE.word + "</a></span></h4></body></html>"
    );
  });
  await new Promise((r) => server.listen(17657, "127.0.0.1", r));
  const cdp = launchChromium();
  try {
    const sw = await cdp.findSW();
    if (!sw) throw new Error("service worker never appeared");
    const sid = (await cdp.send("Target.attachToTarget", { targetId: sw.targetId, flatten: true })).result.sessionId;
    await cdp.send("Runtime.enable", {}, sid);
    await sleep(2000); // let the SW finish booting

    const scenario = (phase) =>
      "(async () => {" +
      "  const title = () => new Promise(r => chrome.action.getTitle({}, t => r(t)));" +
      "  await chrome.declarativeNetRequest.updateEnabledRulesets({disableRulesetIds:['block_localhost']});" +
      "  control_port = '17657'; control_host = '127.0.0.1';" +
      "  lastIconState = null;" +
      "  let s = await runHealthCheck();" +
      "  return {phase:'" + phase + "', state:s, title: await title()};" +
      "})()";

    const r1 = await cdp.evalin(sid, scenario("testing"), 30000);
    console.log("  console=Testing  ->", r1.state, "|", r1.title);
    STATE.word = "OK";
    const r2 = await cdp.evalin(sid, scenario("ok"), 30000);
    console.log("  console=OK       ->", r2.state, "|", r2.title);
    server.close();
    server.closeAllConnections && server.closeAllConnections();
    await sleep(400);
    const r3 = await cdp.evalin(sid, scenario("down"), 30000);
    console.log("  console=down     ->", r3.state, "|", r3.title);

    const pass = r1.state === "warm" && /warming/i.test(r1.title) &&
                 r2.state === "on" && /network OK/.test(r2.title) &&
                 r3.state === "bad" && /unreachable/.test(r3.title);
    console.log(pass ? "PART A (amber state machine): PASS" : "PART A (amber state machine): FAIL");
    return pass;
  } finally {
    cdp.cleanup();
    server.close();
    try { server.closeAllConnections && server.closeAllConnections(); } catch (e) {}
  }
}

// ---------------------------------------------------------------------------
// Part B: live .i2p routing through the real router
// ---------------------------------------------------------------------------
async function partB() {
  // reachability check: skip if no router
  const net = require("net");
  const hostPort = PROXY.split(":");
  const reachable = await new Promise((res) => {
    const s = net.connect({ host: hostPort[0], port: parseInt(hostPort[1], 10) || 4444 }, () => { s.destroy(); res(true); });
    s.on("error", () => res(false));
    setTimeout(() => { try { s.destroy(); } catch (e) {} res(false); }, 2000);
  });
  if (!reachable) {
    console.log("PART B (live .i2p routing): SKIP — no I2P proxy at " + PROXY);
    return true;
  }
  const cdp = launchChromium();
  try {
    let page = null;
    for (let i = 0; i < 40 && !page; i++) {
      const t = await cdp.send("Target.getTargets");
      page = t.result.targetInfos.find((x) => x.type === "page");
      if (!page) await sleep(300);
    }
    const sid = (await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true })).result.sessionId;
    await cdp.send("Runtime.enable", {}, sid);
    await sleep(4500); // let the SW apply PAC settings

    await cdp.send("Page.enable", {}, sid);
    await cdp.send("Page.navigate", { url: "http://stats.i2p/" }, sid);
    let title = "";
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      await sleep(3000);
      try {
        title = await cdp.evalin(sid, "document.title", 5000);
        if (title && !/problem|error|denied/i.test(title)) break;
      } catch (e) { /* still navigating */ }
    }
    console.log("  http://stats.i2p/ ->", JSON.stringify(title));
    const pass = /stats\.i2p/i.test(title);
    console.log(pass ? "PART B (live .i2p routing): PASS" : "PART B (live .i2p routing): FAIL");
    return pass;
  } finally {
    cdp.cleanup();
  }
}

(async () => {
  const wantLive = process.argv.includes("--live") || process.env.E2E_LIVE === "1";
  const a = await partA();
  const b = wantLive ? await partB() : (console.log("PART B (live .i2p routing): SKIP — pass --live to run"), true);
  console.log(a && b ? "e2e-v223: ALL PASS" : "e2e-v223: FAIL");
  process.exit(a && b ? 0 : 1);
})().catch((e) => { console.log("FATAL", e.message); process.exit(1); });
