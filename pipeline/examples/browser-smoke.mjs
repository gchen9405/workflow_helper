/**
 * Drives the browser demo in headless Chrome over the DevTools protocol and
 * checks the page state after each run — the smoke test of §6.6 of the
 * integration plan, scripted, for a machine with Chrome but no browser
 * automation. Needs Node ≥ 22 (global WebSocket) and a Chrome binary.
 *
 *   npm run serve:browser -- --mock                # in another terminal (or the Flask harness + the mock)
 *   node examples/browser-smoke.mjs                # → http://127.0.0.1:8788/
 *   node examples/browser-smoke.mjs http://127.0.0.1:8080/api/workflow-helper/
 *   CHROME="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" node examples/browser-smoke.mjs
 *
 * Every case is a deep link (`?text=…&auto=answer`) against a mock upstream,
 * so the steering words in examples/mock-llm.ts decide the path taken. The
 * "stop" case presses the Stop button one second in. Exit code 1 when any
 * case fails; console errors and uncaught exceptions count as failures.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const BASE = (process.argv[2] ?? "http://127.0.0.1:8788/").replace(/\/?$/, "/");
const CHROME =
  process.env.CHROME ??
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : process.platform === "win32"
      ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      : "google-chrome");
const DEVTOOLS_PORT = Number(process.env.DEVTOOLS_PORT ?? 9333);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CASES = [
  { name: "happy", query: "text=An+order+comes+in+and+sales+validates+it&auto=answer",
    expect: (s) => s.result?.status === "complete" && s.result.preRounds === 0 && s.reportShown },
  { name: "thin, questions answered in both stages", query: "text=thin+process&auto=answer",
    expect: (s) => s.result?.status === "complete" && s.result.pre === "validated" && s.result.preRounds === 1 && s.result.recRounds === 1 && s.batches.length === 2 },
  { name: "thin, questions skipped", query: "text=thin+process&auto=skip",
    expect: (s) => s.result?.status === "complete" && s.result.pre === "partial" && s.result.rec === "partial" },
  { name: "reject → notice", query: "text=reject+this&auto=answer",
    expect: (s) => s.result?.status === "notice" },
  { name: "summary fails → fallback", query: "text=fail&auto=answer", allowNetworkErrors: true,
    expect: (s) => s.result?.status === "fallback" },
  { name: "triage fails → stage error", query: "text=boom&auto=answer", allowNetworkErrors: true,
    expect: (s) => s.errorShown && /preprocess/.test(s.errorStage) && /500/.test(s.errorText) },
  { name: "image input", query: "pixel=1&auto=answer",
    expect: (s) => s.result?.status === "complete" && /pixel\.png/.test(s.attachment) && s.result.inputLabel === "pixel.png" },
  { name: "stop mid-run", query: "text=slow&auto=answer",
    during: async (evaluate) => { await sleep(1000); await evaluate(`document.getElementById("stop").click(), "clicked"`); },
    expect: (s) => s.progress.includes("Stopped.") && !s.reportShown && !s.errorShown },
];

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions",
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "wfh-smoke-"))}`, `--remote-debugging-port=${DEVTOOLS_PORT}`, "about:blank",
], { stdio: "ignore" });
chrome.on("error", (err) => { console.error(`could not start Chrome at ${CHROME}: ${err.message} (set CHROME=<path>)`); process.exit(2); });

let targets;
for (let i = 0; i < 100 && !targets; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/list`)).json(); } catch { await sleep(200); }
}
if (!targets) { console.error("Chrome's devtools endpoint never came up"); chrome.kill(); process.exit(2); }
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));

let nextId = 1;
const waiting = new Map();
const events = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
  else if (msg.method) events.push(msg);
};
const send = (method, params = {}) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
// Record each question batch as it appears, so a case can assert what was asked.
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__batches = [];
  new MutationObserver(() => {
    const q = document.getElementById("questions");
    if (q && !q.hidden && !q.dataset.seen) {
      q.dataset.seen = "1";
      window.__batches.push({
        title: document.getElementById("questions-title").textContent,
        legends: [...q.querySelectorAll("legend")].map((l) => l.textContent),
        radios: q.querySelectorAll('input[type="radio"]').length,
        texts: q.querySelectorAll('input[type="text"]').length,
      });
    }
    if (q && q.hidden) delete q.dataset.seen;
  }).observe(document, { attributes: true, childList: true, subtree: true });
` });

const SUMMARY = `(() => {
  const $ = (id) => document.getElementById(id);
  let result = null;
  try { const r = JSON.parse($("result-json").textContent); result = { status: r.status, pre: r.preprocess.status, rec: r.recommendation.status, preRounds: (r.preprocess.rounds || []).length, recRounds: (r.recommendation.rounds || []).length, inputLabel: (r.narration.source || {}).inputLabel }; } catch {}
  return {
    reportShown: !$("report").hidden, errorShown: !$("error").hidden,
    status: $("report-status").textContent, reportHead: $("report-text").textContent.slice(0, 60),
    errorText: $("error-text").textContent, errorStage: $("error-stage").textContent,
    progress: [...$("progress-lines").children].map((li) => li.textContent),
    attachment: $("attachment").textContent, batches: window.__batches, result,
  };
})()`;
const DONE = `(() => { const $ = (id) => document.getElementById(id); return !$("report").hidden || !$("error").hidden || [...$("progress-lines").children].some((li) => li.textContent === "Stopped."); })()`;

let failures = 0;
for (const c of CASES) {
  events.length = 0;
  await send("Page.navigate", { url: BASE + "?" + c.query });
  await sleep(300);
  if (c.during) await c.during(evaluate);
  for (let i = 0; i < 480; i++) { if (await evaluate(DONE)) break; await sleep(250); }
  const summary = await evaluate(SUMMARY);
  const problems = events.filter((e) =>
    e.method === "Runtime.exceptionThrown" ||
    (e.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(e.params.type)) ||
    (e.method === "Log.entryAdded" && e.params.entry.level === "error" && !(c.allowNetworkErrors && e.params.entry.source === "network")));
  const ok = summary && c.expect(summary) && problems.length === 0;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}`);
  if (!ok) {
    console.log("   state:", JSON.stringify(summary));
    for (const p of problems.slice(0, 4)) console.log("   problem:", JSON.stringify(p.params).slice(0, 300));
  }
}

ws.close();
chrome.kill();
console.log(failures === 0 ? `all ${CASES.length} cases passed` : `${failures} of ${CASES.length} cases failed`);
process.exit(failures === 0 ? 0 : 1);
