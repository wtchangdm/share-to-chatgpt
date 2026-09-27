import assert from "node:assert/strict";
import { build } from "esbuild";

const ITERATIONS = 300_000;
const SAMPLES = 7;
const WARMUP_ITERATIONS = 30_000;
const url = "https://example.com/article?item=42";
const multiline = "Summarize the page.\n\nAssess the evidence.\nInclude caveats.";
const scenarios = [
  { name: "url-only", text: "", expected: url },
  { name: "single-line", text: "Summarize the page.", expected: `Summarize the page. ${url}` },
  {
    name: "multiline",
    text: multiline,
    expected: `${multiline} ${url}`
  }
];

const result = await build({
  entryPoints: ["src/prompt.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "node20",
  logLevel: "silent"
});
const source = result.outputFiles[0]?.text;
assert.ok(source, "esbuild did not produce benchmarkable output");
const { buildPrompt } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);

function runIterations(settings, iterations) {
  let checksum = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    checksum += buildPrompt(url, settings).length;
  }
  return checksum;
}

const results = [];
let checksum = 0;
for (const scenario of scenarios) {
  const settings = { optionalText: scenario.text, placement: "prepend" };
  assert.equal(buildPrompt(url, settings), scenario.expected, scenario.name);
  checksum += runIterations(settings, WARMUP_ITERATIONS);
  const samples = [];
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    globalThis.gc?.();
    const start = process.hrtime.bigint();
    checksum += runIterations(settings, ITERATIONS);
    samples.push(Number(process.hrtime.bigint() - start) / ITERATIONS);
  }
  samples.sort((left, right) => left - right);
  results.push({
    scenario: scenario.name,
    medianNanosecondsPerOperation: Math.round(samples[Math.floor(SAMPLES / 2)])
  });
}
assert.ok(checksum > 0);
console.log(`Node ${process.version} on ${process.platform}/${process.arch}`);
console.log(
  `${SAMPLES} samples × ${ITERATIONS} measured operations; ` +
  `${WARMUP_ITERATIONS} warmup operations per scenario.`
);
console.table(results);
