/**
 * tests/run-all.js
 *
 * Runs every Chronicle test file and reports a pass/fail summary.
 * Exits 0 if all test files pass; exits 1 if any fail.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Provides a single entry point for running the full test suite so CI (or
 * a developer) does not need to know the individual file names. Each test
 * file is spawned as a separate child process so a crash in one test file
 * does not prevent the others from running.
 *
 * RUN
 * ---
 * node tests/run-all.js
 */

'use strict';

const { spawnSync } = require('child_process');
const path          = require('path');

// All test files to run. Add new test files here in the order they should run.
// Each path is relative to the repository root.
const TEST_FILES = [
  'tests/integrity.test.js',
  'tests/intake-image.test.js',
  'tests/intake-preparation.test.js',
  'tests/delta-schema.test.js',
  'tests/delta-apply.test.js',
];

// ── Run each test file ───────────────────────────────────────────────────────

const results = [];

TEST_FILES.forEach(function(file) {
  const filePath = path.join(__dirname, '..', file);
  console.log('\n══════════════════════════════════════════════════════');
  console.log('Running: ' + file);
  console.log('══════════════════════════════════════════════════════');

  // spawnSync inherits stdio so the child's output prints directly.
  // The child exits 1 if any assertion failed (see individual test files).
  const result = spawnSync(process.execPath, [filePath], { stdio: 'inherit' });

  const passed = result.status === 0;
  results.push({ file: file, passed: passed });
});

// ── Print summary ────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════');
console.log('SUMMARY');
console.log('══════════════════════════════════════════════════════');

let anyFailed = false;

results.forEach(function(r) {
  const label = r.passed ? '  PASS  ' : '  FAIL  ';
  console.log(label + r.file);
  if (!r.passed) anyFailed = true;
});

const passCount = results.filter(r => r.passed).length;
console.log('\n' + passCount + '/' + results.length + ' test files passed.');

// Exit 1 so CI correctly flags a failed run.
if (anyFailed) process.exit(1);
