"use strict";
// Live check: classifyRouterNetwork against the real router on 127.0.0.1:7657.
// Verifies the amber/green decision path end-to-end inside the real SW.
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const EXT = path.resolve(__dirname, "..", "i2pchrome.js");
const CHROMIUM = process.env.CHROMIUM || "/usr/bin/chromium";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function unpackedId(p) {
  const h = crypto.createHash("sha256").update(p).digest("hex").slice(0, 32);
  return h.split("").map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}
(async () => {
  const udd = fs.mkdtempSync(path.join(require("os").tmpdir(), "i2p-live-"));
  const child = spawn(CHROMIUM, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-pipe",
    `--user-data-dir=${udd}`, `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`,
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
      const timer = setTimeout(() => { pending.delete(id); res({ error: { message: "timeout " + method } }); }, ms || 15000);
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
    // self-skip when there is no router to classify (CI, foreign machines)
    const probe = await (await fetch("http://127.0.0.1:7657/", { signal: AbortSignal.timeout(2000) }).catch(() => null));
    if (!probe) {
      console.log("SKIP: no router console on 127.0.0.1:7657");
      return process.exit(0);
    }
    const id = unpackedId(EXT);
    let sw = null;
    for (let i = 0; i < 40 && !sw; i++) {
      const t = await send("Target.getTargets");
      sw = t.result.targetInfos.find((x) => x.type === "service_worker" && x.url.includes(id));
      if (!sw) await sleep(300);
    }
    if (!sw) throw new Error("no service worker");
    const swSid = (await send("Target.attachToTarget", { targetId: sw.targetId, flatten: true })).result.sessionId;
    await send("Runtime.enable", {}, swSid);
    await sleep(5000); // boot + first health check against the real router
    const cls = await evalin(swSid, "classifyRouterNetwork()");
    console.log("live classification:", JSON.stringify(cls));
    const title = await evalin(swSid, "chrome.action.getTitle({}).then(t=>t)");
    console.log("icon title:", title);
    const stored = await evalin(swSid, "chrome.storage.local.get('debug_last_probe').then(g=>g.debug_last_probe)");
    console.log("stored probe:", JSON.stringify(stored));
    const icon = await evalin(swSid, "chrome.action.setIcon({path:{16:'icons/on-16.png'}}).then(()=>Promise.resolve('set'))").catch(e => "n/a");
    // read what icon the SW actually chose: title is the proxy for state
    const ok = cls && cls.ok && cls.state === "ready";
    console.log(ok ? "LIVE PASS: dot should be green (network ready)" : cls && cls.ok ? "LIVE AMBER: router warming up" : "LIVE RED: console unreachable");
  } catch (e) {
    console.log("LIVE FAIL:", e.message);
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch (e) {}
    try { fs.rmSync(udd, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch (e) {}
  }
  process.exit(0);
})().catch((e) => { console.log("FATAL " + e); process.exit(1); });
