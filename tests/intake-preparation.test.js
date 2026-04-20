/**
 * tests/intake-preparation.test.js — Group C
 *
 * Automated tests for intake preparation — the data validation and structure
 * checks that must pass before a session's data enters the delta-review queue.
 * These tests validate what the fixture looks like from the intake pipeline's
 * perspective: required top-level sections, ID format, session references.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Group C ensures that the fixture (and by extension any real incoming session
 * data) satisfies the structural preconditions delta-review.html expects.
 * Without these checks, a malformed session could silently produce empty or
 * broken delta items. See docs/chronicle-intake-test-plan.md for the full
 * Group C specification once that document is written.
 *
 * RUN
 * ---
 * node tests/intake-preparation.test.js
 *
 * Plain Node.js — no external test framework required.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

/**
 * assert(label, condition)
 * Prints PASS or FAIL with the test label and increments counters.
 * All tests run regardless of earlier failures.
 */
function assert(label, condition) {
  if (condition) {
    console.log('  PASS  ' + label);
    passed++;
  } else {
    console.log('  FAIL  ' + label);
    failed++;
  }
}

// ── Load test fixture ────────────────────────────────────────────────────────

const fixturePath = path.join(__dirname, 'fixtures', 'test-campaign.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

// ── Test C-1 — Fixture has all required top-level sections ───────────────────
// The intake pipeline reads these arrays when preparing its delta proposals.
// A missing array causes a silent empty-array fallback, masking the problem.
console.log('\nTest C-1 — fixture has all required top-level sections');
{
  const REQUIRED_KEYS = [
    '_schema_version',
    'party',
    'session_logs',
    'combat_encounters',
    'npc_directory',
    'locations',
    'quest_ledger',
    'inventory_and_loot',
    'deferred_gaps',
  ];

  REQUIRED_KEYS.forEach(function(key) {
    assert('fixture has "' + key + '"', Object.prototype.hasOwnProperty.call(fixture, key));
  });
}

// ── Test C-2 — Schema version is exactly 4.0.0 ───────────────────────────────
// The intake pipeline expects v4 schema. Older versions have different nesting
// (flat vs mechanics/narrative). A mismatch would silently read wrong paths.
console.log('\nTest C-2 — schema version is 4.0.0');
{
  assert('_schema_version is "4.0.0"', fixture._schema_version === '4.0.0');
}

// ── Test C-3 — All entity IDs follow the <type>_<number> format ──────────────
// The intake pipeline assigns new IDs by reading the current max. Malformed
// existing IDs would break the next-ID calculation.
console.log('\nTest C-3 — entity IDs follow <type>_<number> format');
{
  const ID_PATTERN = /^[a-z]+_\d+$/;

  function checkIds(arr, label) {
    arr.forEach(function(item) {
      assert(label + ' id "' + item.id + '" matches pattern', ID_PATTERN.test(item.id));
    });
  }

  checkIds(fixture.party,              'party');
  checkIds(fixture.session_logs,       'session_logs');
  checkIds(fixture.combat_encounters,  'combat_encounters');
  checkIds(fixture.npc_directory,      'npc_directory');
  checkIds(fixture.locations,          'locations');
  checkIds(fixture.quest_ledger,       'quest_ledger');
  checkIds(fixture.inventory_and_loot, 'inventory_and_loot');
}

// ── Test C-4 — Session IDs referenced in combats exist in session_logs ───────
// Delta-review cross-references combat sessions against known sessions.
// A combat that references a non-existent session_id cannot be matched.
console.log('\nTest C-4 — combat session references resolve to existing sessions');
{
  const sessionIds = new Set(fixture.session_logs.map(s => s.id));

  fixture.combat_encounters.forEach(function(combat) {
    const sessions = combat.mechanics?.sessions || [];
    sessions.forEach(function(sid) {
      assert(
        'combat "' + combat.id + '" ref "' + sid + '" exists in session_logs',
        sessionIds.has(sid)
      );
    });
  });
}

// ── Test C-5 — All quest objectives have description and is_completed ─────────
// The delta-review queue renders objectives. Missing fields produce undefined
// in the UI. Both fields must be present on every objective.
console.log('\nTest C-5 — quest objectives have description and is_completed');
{
  fixture.quest_ledger.forEach(function(quest) {
    const objectives = quest.mechanics?.objectives || [];
    objectives.forEach(function(obj, i) {
      assert(
        'quest "' + quest.id + '" obj[' + i + '] has description',
        typeof obj.description === 'string'
      );
      assert(
        'quest "' + quest.id + '" obj[' + i + '] has is_completed (boolean)',
        typeof obj.is_completed === 'boolean'
      );
    });
  });
}

// ── Test C-6 — deferred_gaps is an array (may be empty) ──────────────────────
// delta-review appends to deferred_gaps during publish. If this field is
// missing or not an array, the append will throw or corrupt the JSON.
console.log('\nTest C-6 — deferred_gaps is a (possibly empty) array');
{
  assert('deferred_gaps is an array', Array.isArray(fixture.deferred_gaps));
}

// ── Summary ──────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log('\n' + passed + '/' + total + ' tests passed.');
if (failed > 0) process.exit(1);
