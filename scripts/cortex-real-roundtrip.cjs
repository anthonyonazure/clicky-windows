// End-to-end smoke test against a RUNNING Cortex service. Pushes one
// memo, prints the result. Intentionally NOT committed as a smoketest
// suite — it touches the real Cortex memos store. Delete the memo
// afterwards or filter it out by the `e2e-smoketest` tag.
//
//   node scripts/cortex-real-roundtrip.cjs [http://host:port]

"use strict";

const path = require("path");
const fs = require("fs");
const Module = require("module");

const STUB = path.join(__dirname, ".electron-stub.cjs");
fs.writeFileSync(
  STUB,
  "module.exports = { app: { isReady: () => true, getPath: () => process.cwd() } };\n"
);
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === "electron") return STUB;
  return origResolve.call(this, req, ...rest);
};

const {
  CortexClient,
  formatMemoBody,
  buildMemoTags,
} = require(path.join(__dirname, "..", "dist", "services", "cortex.js"));

const baseUrl = process.argv[2] || "http://127.0.0.1:5201";

(async () => {
  const c = new CortexClient(baseUrl);

  const ping = await c.ping();
  console.log("ping:", ping);
  if (!ping.ok) {
    fs.unlinkSync(STUB);
    process.exit(1);
  }

  const body = formatMemoBody({
    prompt: "end-to-end smoke from clicky-windows",
    response:
      "This memo was created by scripts/cortex-real-roundtrip.cjs to verify Clicky -> Cortex is wired. POINT tag [POINT:0,0:x:screen0] should be stripped. ELEMENT tag [ELEMENT:7] should also be stripped.",
    provider: "anthropic",
    window: "Clicky Roundtrip Smoke",
  });
  const tags = buildMemoTags({
    provider: "anthropic",
    window: "Clicky Roundtrip Smoke",
    extra: ["e2e-smoketest"],
  });

  const push = await c.pushMemo({ content: body, tags });
  console.log("push:", push);

  fs.unlinkSync(STUB);
  process.exit(push.ok ? 0 : 1);
})();
