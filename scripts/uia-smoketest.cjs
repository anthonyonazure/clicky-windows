// One-shot smoke test for the UIAService Node wrapper. Loads the
// compiled service, calls snapshot() against a launched Notepad, prints
// the result. Stubbed `electron.app` because the service only needs
// app.getAppPath() to locate the .ps1.
//
//   node scripts/uia-smoketest.cjs
//
// Expects:
//   - powershell / pwsh on PATH
//   - dist/services/uia.js already compiled (npx tsc)

"use strict";

const path = require("path");
const Module = require("module");

const ELECTRON_STUB = path.join(__dirname, ".electron-stub.cjs");
require("fs").writeFileSync(
  ELECTRON_STUB,
  "module.exports = { app: { getAppPath: () => process.cwd() } };\n"
);

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === "electron") return ELECTRON_STUB;
  return origResolve.call(this, req, ...rest);
};

const { spawn } = require("child_process");
const { UIAService } = require(path.join(process.cwd(), "dist", "services", "uia.js"));

async function main() {
  const np = spawn("notepad.exe", [], { detached: true, stdio: "ignore" });
  np.unref();
  // Notepad takes a beat to draw its WinUI surface.
  await new Promise((r) => setTimeout(r, 1800));

  const uia = new UIAService();
  const t0 = Date.now();
  const snap = await uia.snapshot({ processName: "notepad", timeoutMs: 1500 });
  const elapsed = Date.now() - t0;

  // Best-effort cleanup
  try { process.kill(np.pid); } catch {}

  if (!snap) {
    console.log("FAIL: snapshot returned null");
    process.exit(1);
  }

  console.log(
    `OK: ${snap.elements.length} elements from "${snap.windowName}" in ${elapsed}ms (PS reported ${snap.elapsedMs}ms)`
  );
  console.log("\nfirst 5 elements:");
  for (const el of snap.elements.slice(0, 5)) {
    console.log(`  [${el.id}] ${el.name} (${el.role}) @ (${el.x},${el.y})`);
  }
  console.log("\nprompt fragment (truncated to 5 items):");
  console.log(uia.toPromptList(snap, 5));

  // Cache test: second snapshot of same hwnd should be near-instant if
  // getCached is wired right. (Service.snapshot() doesn't currently consult
  // cache on its own — that's caller's job. This just verifies the data
  // round-trips.)
  const cached = uia.getCached(snap.hwnd, snap.rect);
  console.log("\ncache hit on same hwnd+rect:", cached ? "yes" : "no");

  require("fs").unlinkSync(ELECTRON_STUB);
}

main().catch((err) => {
  console.error("smoketest crashed:", err);
  process.exit(2);
});
