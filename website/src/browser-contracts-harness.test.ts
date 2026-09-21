// Harness tests for scripts/test-browser-contracts.cjs: the retry loop, the
// hydration/TOC waits, and the step-summary writer. Stubs are hand-rolled; fs is
// the shared node:fs singleton the script also calls, so patching it reaches both.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test, { afterEach, beforeEach } from 'node:test';

// The script reads this at require time and skips its self-build mkdtemp when a
// build dir is supplied; no cleanup runs here, so no temp dir is ever created.
process.env.BROWSER_TEST_BUILD_DIR = '/tmp/browser-contracts-harness-no-build';
const require = createRequire(import.meta.url);
const {
  withRetry,
  waitForHydrated,
  waitForTocSettled,
  writeStepSummary,
  telemetry,
} = require('../../scripts/test-browser-contracts.cjs');

const realAppend = fs.appendFileSync;
const realWarn = console.warn;
const realNow = Date.now;
let appended: { target: string; data: string }[] = [];
let savedExitCode: typeof process.exitCode;

beforeEach(() => {
  savedExitCode = process.exitCode;
  telemetry.contracts = [];
  telemetry.routes = [];
  appended = [];
  delete process.env.GITHUB_STEP_SUMMARY;
  console.warn = () => {};
  fs.appendFileSync = ((target: string, data: string) => {
    appended.push({ target, data });
  }) as typeof fs.appendFileSync;
});

afterEach(() => {
  process.exitCode = savedExitCode;
  fs.appendFileSync = realAppend;
  console.warn = realWarn;
  Date.now = realNow;
  delete process.env.GITHUB_STEP_SUMMARY;
});

test('withRetry records a clean first-attempt pass', async () => {
  await withRetry(async () => 'ok', 'contract');
  const [entry] = telemetry.contracts;
  assert.equal(entry.label, 'contract');
  assert.equal(entry.attempts, 1);
  assert.equal(entry.failed, false);
});

test('withRetry records the passing attempt count for a flaky fn', async () => {
  let calls = 0;
  const value = await withRetry(async () => {
    calls += 1;
    if (calls === 1) throw new Error('transient');
    return 'recovered';
  }, 'flaky');
  assert.equal(value, 'recovered');
  assert.equal(telemetry.contracts.length, 1);
  assert.equal(telemetry.contracts[0].attempts, 2);
  assert.equal(telemetry.contracts[0].failed, false);
});

test('withRetry rethrows and records a persistent failure', async () => {
  const always = async () => {
    throw new Error('boom');
  };
  await assert.rejects(withRetry(always, 'broken'), /boom/);
  assert.equal(telemetry.contracts.length, 1);
  assert.equal(telemetry.contracts[0].attempts, 2);
  assert.equal(telemetry.contracts[0].failed, true);
});

test('writeStepSummary is a no-op without a summary target', () => {
  writeStepSummary();
  assert.equal(appended.length, 0);
});

test('writeStepSummary renders retry and deduped slowest tables', () => {
  process.env.GITHUB_STEP_SUMMARY = '/tmp/summary.md';
  process.exitCode = 0;
  telemetry.contracts = [
    { label: 'a|b', attempts: 2, ms: 1234, failed: false },
  ];
  telemetry.routes = [
    { route: '/x', width: 1440, ms: 500 },
    { route: '/x', width: 1440, ms: 900 },
    { route: '/y', width: 390, ms: 100 },
  ];
  writeStepSummary();
  assert.equal(appended.length, 1);
  const { target, data } = appended[0];
  assert.equal(target, '/tmp/summary.md');
  assert.match(data, /a\\\|b/);
  assert.match(data, /passed on retry/);
  assert.equal(data.match(/\/x/g)?.length, 1);
  assert.match(data, /\| \/x \| 1440 \| 900ms \|/);
  assert.match(data, /\| \/y \| 390 \| 100ms \|/);
});

test('writeStepSummary swallows a write error', () => {
  process.env.GITHUB_STEP_SUMMARY = '/tmp/summary.md';
  fs.appendFileSync = (() => {
    throw new Error('disk full');
  }) as typeof fs.appendFileSync;
  assert.doesNotThrow(() => writeStepSummary());
});

test('waitForHydrated probes the marker and rejects on timeout', async () => {
  let seenAttr: string | undefined;
  await waitForHydrated({
    waitForFunction: async (_fn: unknown, _opts: unknown, attr: string) => {
      seenAttr = attr;
    },
  });
  assert.equal(seenAttr, 'data-has-hydrated');
  await assert.rejects(
    waitForHydrated({
      url: () => '/intro',
      waitForFunction: async () => {
        throw new Error('timeout');
      },
    }),
    /data-has-hydrated.*at \/intro/
  );
});

const tocSignature = { nav: 'n', row: 'r', marker: 'm', hooks: 0 };

test('waitForTocSettled handles the null and settled TOC paths', async () => {
  let nullCalls = 0;
  await waitForTocSettled({
    evaluate: async () => {
      nullCalls += 1;
      return null;
    },
  });
  assert.equal(nullCalls, 1);
  let settleCalls = 0;
  await waitForTocSettled({
    evaluate: async () => {
      settleCalls += 1;
      return tocSignature;
    },
  });
  assert.equal(settleCalls, 2);
});

test('waitForTocSettled waits through the marker appearing', async () => {
  const reads = [
    { ...tocSignature, marker: 'none' },
    tocSignature,
    tocSignature,
  ];
  let calls = 0;
  await waitForTocSettled({
    url: () => '/chapter',
    evaluate: async () => reads[calls++],
  });
  assert.equal(calls, 3);
});

test('waitForTocSettled rejects when the marker never appears', async () => {
  let fake = 0;
  Date.now = () => {
    fake += 1000; // each poll advances the clock toward the 5s deadline
    return fake;
  };
  await assert.rejects(
    waitForTocSettled({
      url: () => '/chapter',
      evaluate: async () => ({ ...tocSignature, marker: 'none' }),
    }),
    /at \/chapter.*never settled/
  );
});
