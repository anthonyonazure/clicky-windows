// UIA Phase 0 Aggregator — reads N probe-result JSONs and prints a coverage
// table + go/no-go verdict against the decision threshold.
//
// Usage:
//   node scripts/uia-aggregate.cjs results/*.json
//
// The decision threshold is documented in docs/plans/uia-benchmark.md.

"use strict";

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: node scripts/uia-aggregate.cjs <result.json> [...]");
  process.exit(1);
}

// Manual glob so the script runs whether or not the shell expanded `*`.
function expand(arg) {
  if (!arg.includes("*")) return [arg];
  const dir = path.dirname(arg) || ".";
  const pattern = path
    .basename(arg)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  const re = new RegExp(`^${pattern}$`);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => re.test(f))
    .map((f) => path.join(dir, f));
}

const files = args.flatMap(expand);
if (files.length === 0) {
  console.error("no files matched");
  process.exit(1);
}

const cols = [
  ["window", 30],
  ["total", 6],
  ["interact", 8],
  ["visible", 7],
  ["named", 5],
  ["named%", 7],
  ["vis-named%", 10],
  ["ms", 6],
];

function row(values) {
  return values
    .map((v, i) => String(v).padEnd(cols[i][1]).slice(0, cols[i][1]))
    .join("  ");
}

console.log(row(cols.map((c) => c[0])));
console.log("-".repeat(cols.reduce((a, c) => a + c[1] + 2, 0)));

const totals = { total: 0, interactive: 0, visible: 0, named: 0, visibleNamed: 0 };
const latencies = [];
const perAppRatios = [];
const failures = [];

for (const file of files) {
  let r;
  try {
    r = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    console.error(`skip ${file}: ${err.message}`);
    continue;
  }

  const interact = r.interactiveCount || 0;
  const visible = r.visibleInteractiveCount || 0;
  const named = r.namedInteractiveCount || 0;
  const visibleNamed = r.visibleNamedCount || 0;
  const namedPct = interact > 0 ? ((named / interact) * 100).toFixed(1) : "—";
  const visNamedPct = visible > 0 ? ((visibleNamed / visible) * 100).toFixed(1) : "—";
  const label = (r.window || path.basename(file)).slice(0, 30);

  console.log(
    row([label, r.totalElements ?? 0, interact, visible, named, namedPct, visNamedPct, r.elapsedMs ?? 0])
  );

  totals.total += r.totalElements || 0;
  totals.interactive += interact;
  totals.visible += visible;
  totals.named += named;
  totals.visibleNamed += visibleNamed;
  if (typeof r.elapsedMs === "number") latencies.push(r.elapsedMs);
  if (visible > 0) perAppRatios.push(visibleNamed / visible);

  if (r.hitTimeout || r.hitElementCap) {
    failures.push({
      file,
      reason: r.hitTimeout ? "timeout" : "element-cap",
    });
  }
}

console.log("-".repeat(cols.reduce((a, c) => a + c[1] + 2, 0)));

const aggNamed = totals.interactive > 0
  ? ((totals.named / totals.interactive) * 100).toFixed(1)
  : "—";
const aggVisNamed = totals.visible > 0
  ? ((totals.visibleNamed / totals.visible) * 100).toFixed(1)
  : "—";
const sorted = latencies.slice().sort((a, b) => a - b);
const p50 = sorted.length ? sorted[Math.floor(sorted.length * 0.5)] : 0;
const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;

console.log(
  row(["AGGREGATE", totals.total, totals.interactive, totals.visible, totals.named, aggNamed, aggVisNamed, `p50=${p50} p95=${p95}`])
);

console.log("");
console.log(`Latency: p50=${p50}ms  p95=${p95}ms  (${latencies.length} apps)`);
if (failures.length) {
  console.log(`Partial walks: ${failures.length}`);
  for (const f of failures) console.log(`  - ${f.file}: ${f.reason}`);
}

const passNamed = totals.visible > 0 && totals.visibleNamed / totals.visible >= 0.7;
const passLatency = p95 <= 500;
const minPerApp = perAppRatios.length ? Math.min(...perAppRatios) : 0;
const passFloor = minPerApp >= 0.5; // no single app should drop below 50% — that means UIA is broken there

console.log("");
console.log("Decision threshold: visible-named% ≥ 70 (aggregate) AND p95 ≤ 500ms AND no single app < 50%");
console.log(`  visible-named%: ${aggVisNamed} ${passNamed ? "PASS" : "FAIL"}`);
console.log(`  p95 latency:    ${p95}ms ${passLatency ? "PASS" : "FAIL"}`);
console.log(`  worst app:      ${(minPerApp * 100).toFixed(1)}% ${passFloor ? "PASS" : "FAIL"}`);

const verdict = passNamed && passLatency && passFloor;
console.log("");
console.log(`Verdict: ${verdict ? "PROCEED to UIA Phase 1" : "HOLD on UIA investment — gaps need a strategy first"}`);
