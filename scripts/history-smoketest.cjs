// Standalone smoke test for HistoryStore. Stubs `electron.app` and
// redirects history.ndjson to a temp directory so the test never
// pollutes the real user data.
//
//   node scripts/history-smoketest.cjs

"use strict";

const path = require("path");
const os = require("os");
const fs = require("fs");
const Module = require("module");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "clicky-history-"));
const STUB = path.join(__dirname, ".electron-stub.cjs");
fs.writeFileSync(
  STUB,
  `module.exports = { app: { isReady: () => true, getPath: () => ${JSON.stringify(TMP)} } };\n`
);

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === "electron") return STUB;
  return origResolve.call(this, req, ...rest);
};

const { HistoryStore } = require(path.join(process.cwd(), "dist", "main", "history.js"));

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

const store = new HistoryStore();

store.append({ prompt: "where is the save button", response: "click here [POINT:100,200:save:screen0]", provider: "anthropic" });
store.append({ prompt: "how do I bold text", response: "press Ctrl+B [ELEMENT:3]", provider: "anthropic", window: "Notepad" });
store.append({ prompt: "what's in this image", response: "a sunset", attached: true });

const recent = store.recent(10);
assert(recent.length === 3, `recent returned ${recent.length}, expected 3`);
assert(recent[0].p === "what's in this image", "recent should be newest-first");
assert(recent[0].attached === true, "attached flag should round-trip");
assert(recent[2].p === "where is the save button", "oldest entry last");

const boldHits = store.search("bold", 10);
assert(boldHits.length === 1, `bold search: got ${boldHits.length}, expected 1`);
assert(boldHits[0].window === "Notepad", "window metadata should round-trip");

const noHits = store.search("nonexistent-needle-xyz", 10);
assert(noHits.length === 0, "no-match search should be empty");

const emptySearch = store.search("", 10);
assert(emptySearch.length === 3, "empty query should fall through to recent()");

// Persistence: new store instance reads the same file.
const store2 = new HistoryStore();
const reloaded = store2.recent(10);
assert(reloaded.length === 3, `persistence: reloaded ${reloaded.length}, expected 3`);

store2.clear();
assert(store2.recent(10).length === 0, "clear should empty the store");

const onDisk = fs.readFileSync(path.join(TMP, "history.ndjson"), "utf-8");
assert(onDisk === "", `clear should truncate file; got ${onDisk.length} bytes`);

fs.rmSync(TMP, { recursive: true, force: true });
fs.unlinkSync(STUB);

console.log("OK: history-smoketest passed");
