/**
 * tests/intake-image.test.js — Group A
 *
 * Automated tests for the round-data shape that the image OCR pipeline
 * is expected to produce. These tests verify structural expectations
 * about the output format, not the AI output itself (which requires a
 * live API call and is tested manually).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Group A establishes the contract between the OCR pipeline and the
 * delta-review queue. Any change to the round-data shape that ChronicleAI
 * produces must be caught here before it reaches the review workflow.
 * See docs/chronicle-intake-test-plan.md for the full Group A specification
 * once that document is written.
 *
 * RUN
 * ---
 * node tests/intake-image.test.js
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

// The fixture provides a known valid combat with known round content.
// Tests assert against this known content — if the shape changes, tests fail.
const fixturePath = path.join(__dirname, 'fixtures', 'test-campaign.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

// Pull the one combat from the fixture — cbt_001 with 3 known rounds.
const combat = fixture.combat_encounters[0];

// ── Test A-1 — Fixture combat has the expected shape ─────────────────────────
// Validates that the test fixture itself provides a usable combat object with
// the fields the OCR pipeline is expected to populate.
console.log('\nTest A-1 — fixture combat has expected top-level shape');
{
  assert('combat.id is defined',             typeof combat.id === 'string' && combat.id.length > 0);
  assert('combat.name is defined',           typeof combat.name === 'string' && combat.name.length > 0);
  assert('combat.rounds is an array',        Array.isArray(combat.rounds));
  assert('combat has 3 rounds',              combat.rounds.length === 3);
  assert('mechanics.total_rounds_logged=3',  combat.mechanics?.total_rounds_logged === 3);
}

// ── Test A-2 — Each round has the required fields ────────────────────────────
// The OCR pipeline produces round objects with n (round number), slots[], and
// enemy_turns[]. All three must be present on every round for delta-review
// to process the data without errors.
console.log('\nTest A-2 — each round has n, slots[], and enemy_turns[]');
{
  let allHaveN            = true;
  let allHaveSlots        = true;
  let allHaveEnemyTurns   = true;

  combat.rounds.forEach(function(round, i) {
    if (typeof round.n !== 'number')      { allHaveN          = false; console.log('    round ' + i + ' missing n'); }
    if (!Array.isArray(round.slots))      { allHaveSlots      = false; console.log('    round ' + i + ' missing slots[]'); }
    if (!Array.isArray(round.enemy_turns)){ allHaveEnemyTurns = false; console.log('    round ' + i + ' missing enemy_turns[]'); }
  });

  assert('all rounds have n',            allHaveN);
  assert('all rounds have slots[]',      allHaveSlots);
  assert('all rounds have enemy_turns[]', allHaveEnemyTurns);
}

// ── Test A-3 — Each slot uses the 5.0.0 turn schema ──────────────────────────
// Schema 5.0.0 (issue #93) replaced the 4.x slot.action / bonus_action / …
// fields with one activities[] list, each activity tagged by its economy and
// holding outcomes[]. The stored data must use that shape, and must not carry
// the old fields alongside it. (Until #92 rebuilds publish, delta-review still
// writes 4.x slots; the viewers read both, but the fixture is 5.0.0.)
console.log('\nTest A-3 — each slot uses the 5.0.0 activities/outcomes shape');
{
  const ECONOMIES = new Set(['action', 'bonus_action', 'reaction', 'movement', 'free',
    'legendary_action', 'legendary_resistance']);
  let allHaveActivities = true;
  let allHaveEconomy    = true;
  let allHaveName       = true;
  let allHaveOutcomes   = true;
  let noOldFields       = true;

  combat.rounds.forEach(function(round) {
    round.slots.forEach(function(slot, i) {
      if (!Array.isArray(slot.activities)) {
        allHaveActivities = false;
        console.log('    slot ' + i + ' in round ' + round.n + ' missing activities[]');
        return;
      }
      ['action', 'bonus_action', 'reaction', 'movement', 'object_interaction'].forEach(function(f) {
        if (Object.prototype.hasOwnProperty.call(slot, f)) noOldFields = false;
      });
      slot.activities.forEach(function(act) {
        if (!ECONOMIES.has(act.economy))      allHaveEconomy  = false;
        if (typeof act.name !== 'string')     allHaveName     = false;
        if (!Array.isArray(act.outcomes))     allHaveOutcomes = false;
      });
    });
  });

  assert('all slots have activities[]',          allHaveActivities);
  assert('every activity has a known economy',   allHaveEconomy);
  assert('every activity has a name',            allHaveName);
  assert('every activity has outcomes[]',        allHaveOutcomes);
  assert('no slot keeps the 4.x economy fields', noOldFields);
}

// ── Test A-4 — Round numbers are contiguous and start at 1 ───────────────────
// The OCR pipeline must produce rounds numbered starting at 1 with no gaps.
// Gaps trigger integrity warnings in delta-review and confuse the combat viewer.
console.log('\nTest A-4 — round numbers are contiguous starting at 1');
{
  const ns = combat.rounds.map(r => r.n).sort((a, b) => a - b);

  assert('first round is n=1',          ns[0] === 1);
  assert('rounds are contiguous',       ns.every((n, i) => n === i + 1));
}

// ── Test A-5 — outcome res values are from the known enum ────────────────────
// The combat viewer maps res values to colour codes. Any value outside this
// enum will render without colour (undefined CSS variable). In 5.0.0 each
// result lives on an outcome; 'failure' joined the set for death saves, which
// record success or failure (issue #93).
console.log('\nTest A-5 — all outcome res values are from the valid enum');
{
  const VALID_RES = new Set(['hit', 'miss', 'crit', 'save', 'success', 'failure', 'neutral', 'unclear']);
  let allValid = true;

  combat.rounds.forEach(function(round) {
    round.slots.forEach(function(slot) {
      (slot.activities || []).forEach(function(act) {
        (act.outcomes || []).forEach(function(o) {
          if (o.res != null && !VALID_RES.has(o.res)) {
            allValid = false;
            console.log('    invalid res "' + o.res + '" in round ' + round.n);
          }
        });
      });
    });
  });

  assert('all outcome res values are valid', allValid);
}

// ── Summary ──────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log('\n' + passed + '/' + total + ' tests passed.');
if (failed > 0) process.exit(1);
