import { build } from "esbuild";

const ITERATIONS = 300_000;
const SAMPLES = 7;
const WARMUP_ITERATIONS = 30_000;

const scenarios = [
  {
    name: "no-query",
    input: "https://example.com/articles/42#details",
    expected: "https://example.com/articles/42#details"
  },
  {
    name: "clean-query",
    input: "https://example.com/articles/42?a=1&b=two&c=3#details",
    expected: "https://example.com/articles/42?a=1&b=two&c=3#details"
  },
  {
    name: "tracked-query",
    input: "https://example.com/articles/42?a=1&utm_source=newsletter&fbclid=x&b=two#details",
    expected: "https://example.com/articles/42?a=1&b=two#details"
  },
  {
    name: "encoded-tracked-query",
    input: "https://example.com/path?keep=~&space=%20&%75tm_source=x#frag",
    expected: "https://example.com/path?keep=~&space=%20#frag"
  }
];

async function loadProductionStripper() {
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
  if (!source) {
    throw new Error("esbuild did not produce benchmarkable output.");
  }

  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  const module = await import(moduleUrl);
  if (typeof module.stripCommonTrackingParameters !== "function") {
    throw new Error("stripCommonTrackingParameters is not exported.");
  }
  return module.stripCommonTrackingParameters;
}

function runIterations(strip, input, iterations) {
  let checksum = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    checksum += strip(input).length;
  }
  return checksum;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

const strip = await loadProductionStripper();
const results = [];
let checksum = 0;

for (const scenario of scenarios) {
  const actual = strip(scenario.input);
  if (actual !== scenario.expected) {
    throw new Error(
      `${scenario.name} produced ${JSON.stringify(actual)}; expected ` +
      `${JSON.stringify(scenario.expected)}.`
    );
  }

  checksum += runIterations(strip, scenario.input, WARMUP_ITERATIONS);
  const samples = [];
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    globalThis.gc?.();
    const startedAt = process.hrtime.bigint();
    checksum += runIterations(strip, scenario.input, ITERATIONS);
    const elapsedNanoseconds = Number(process.hrtime.bigint() - startedAt);
    samples.push(elapsedNanoseconds / ITERATIONS);
  }

  const medianNanoseconds = median(samples);
  results.push({
    scenario: scenario.name,
    medianNanosecondsPerOperation: Math.round(medianNanoseconds),
    minimumNanosecondsPerOperation: Math.round(Math.min(...samples)),
    operationsPerSecond: Math.round(1_000_000_000 / medianNanoseconds)
  });
}

if (checksum === 0) {
  throw new Error("Benchmark checksum was unexpectedly zero.");
}

console.log(`Node ${process.version} on ${process.platform}/${process.arch}`);
console.log(
  `${SAMPLES} samples × ${ITERATIONS.toLocaleString("en-US")} measured operations; ` +
  `${WARMUP_ITERATIONS.toLocaleString("en-US")} warmup operations per scenario.`
);
console.table(results);
