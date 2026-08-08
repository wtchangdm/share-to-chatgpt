import { build } from "esbuild";

const ITERATIONS = 300_000;
const SAMPLES = 7;
const WARMUP_ITERATIONS = 30_000;

async function loadProductionPolicy() {
  const result = await build({
    entryPoints: ["src/dispatch-policy.ts"],
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
  return import(moduleUrl);
}

const pending = {
  id: "benchmark-dispatch",
  prompt: "https://example.com/article",
  sourceTabId: 10,
  targetTabId: 20,
  createdAt: 1_000,
  expiresAt: 16_000,
  status: "pending",
  autoSubmit: true,
  autoClose: true
};

function transition(policy) {
  const claimed = policy.claimDispatch(pending, 20);
  if (!claimed.ok) {
    return 0;
  }
  const armed = policy.armDispatch(claimed.dispatch, 20);
  return armed.ok && armed.dispatch.status === "submitting" ? 1 : 0;
}

function runIterations(policy, iterations) {
  let checksum = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    checksum += transition(policy);
  }
  return checksum;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

const policy = await loadProductionPolicy();
if (transition(policy) !== 1) {
  throw new Error("Dispatch policy did not produce the expected submitting state.");
}

let checksum = runIterations(policy, WARMUP_ITERATIONS);
const samples = [];
for (let sample = 0; sample < SAMPLES; sample += 1) {
  globalThis.gc?.();
  const startedAt = process.hrtime.bigint();
  checksum += runIterations(policy, ITERATIONS);
  const elapsedNanoseconds = Number(process.hrtime.bigint() - startedAt);
  samples.push(elapsedNanoseconds / ITERATIONS);
}

if (checksum === 0) {
  throw new Error("Benchmark checksum was unexpectedly zero.");
}

const medianNanoseconds = median(samples);
console.log(`Node ${process.version} on ${process.platform}/${process.arch}`);
console.log(
  `${SAMPLES} samples × ${ITERATIONS.toLocaleString("en-US")} measured transitions; ` +
  `${WARMUP_ITERATIONS.toLocaleString("en-US")} warmup transitions.`
);
console.table([{
  scenario: "claim-and-arm",
  medianNanosecondsPerTransition: Math.round(medianNanoseconds),
  minimumNanosecondsPerTransition: Math.round(Math.min(...samples)),
  transitionsPerSecond: Math.round(1_000_000_000 / medianNanoseconds)
}]);
