// Standalone smoke test for CortexClient. Spawns a one-shot HTTP
// server that mimics Cortex's POST /api/memos contract, exercises
// pushMemo + ping + formatMemoBody + buildMemoTags, and asserts the
// request body shape the real server expects.
//
//   node scripts/cortex-smoketest.cjs

"use strict";

const http = require("http");
const path = require("path");
const Module = require("module");

// CortexClient doesn't actually import electron — only TS type hints reference
// it indirectly via other modules. But our other smoketests stub electron
// defensively; doing the same here keeps the script portable if someone
// later adds an electron import to cortex.ts.
const STUB = path.join(__dirname, ".electron-stub.cjs");
require("fs").writeFileSync(
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
} = require(path.join(process.cwd(), "dist", "services", "cortex.js"));

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

async function withStubServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let body = null;
        try {
          body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : null;
        } catch {}
        handler(req, res, body);
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

async function main() {
  // ── happy path: pushMemo posts JSON to /api/memos and gets {id} back
  let receivedRequest = null;
  const { server, port } = await withStubServer((req, res, body) => {
    receivedRequest = { url: req.url, method: req.method, body };
    if (req.url === "/api/memos" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "stub-id-123", fileName: "2026-05-10.md" }));
    } else if (req.url.startsWith("/api/memos") && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ memos: [] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const client = new CortexClient(baseUrl);

  const body = formatMemoBody({
    prompt: "where is the save button",
    response: "click here [POINT:100,200:save:screen0] then confirm [ELEMENT:3]",
    attached: false,
    provider: "anthropic",
    window: "Untitled - Notepad",
  });
  assert(body.includes("**Q:** where is the save button"), "memo body should start with Q");
  assert(body.includes("click here  then confirm"), "POINT and ELEMENT tags should be stripped");
  assert(body.includes("provider: anthropic"), "provider should appear in meta line");

  const tags = buildMemoTags({
    attached: false,
    provider: "anthropic",
    window: "Untitled - Notepad",
  });
  assert(tags.includes("clicky"), "tags should always include clicky");
  assert(tags.includes("anthropic"), "tags should include provider");
  assert(tags.includes("untitled-notepad"), `window slug; got tags=${tags.join(",")}`);

  const pushRes = await client.pushMemo({ content: body, tags });
  assert(pushRes.ok, `pushMemo failed: ${pushRes.error}`);
  assert(pushRes.memoId === "stub-id-123", `memoId mismatch: ${pushRes.memoId}`);

  // Verify request shape
  assert(receivedRequest.url === "/api/memos", `wrong url: ${receivedRequest.url}`);
  assert(receivedRequest.method === "POST", `wrong method: ${receivedRequest.method}`);
  assert(typeof receivedRequest.body.content === "string", "body.content should be string");
  assert(Array.isArray(receivedRequest.body.tags), "body.tags should be array");

  // Ping success
  const pingRes = await client.ping();
  assert(pingRes.ok, `ping failed: ${pingRes.error}`);

  server.close();

  // ── failure path: client should swallow errors when server is unreachable
  const deadClient = new CortexClient("http://127.0.0.1:1");
  const deadRes = await deadClient.pushMemo({ content: "x", tags: ["clicky"] });
  assert(!deadRes.ok, "dead server should return ok:false");
  assert(typeof deadRes.error === "string" && deadRes.error.length > 0, "should have an error string");

  const deadPing = await deadClient.ping();
  assert(!deadPing.ok, "dead ping should return ok:false");

  require("fs").unlinkSync(STUB);
  console.log("OK: cortex-smoketest passed");
}

main().catch((err) => {
  console.error("smoketest crashed:", err);
  process.exit(2);
});
