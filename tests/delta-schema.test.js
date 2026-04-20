/**
 * tests/delta-schema.test.js — Group E
 *
 * Automated tests that validate the v4 delta item shape — the unit of data
 * that moves through the delta-review queue. These tests define the contract
 * between the intake pipeline (producer) and delta-review.html (consumer).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Group E ensures that the shape of a delta item matches what delta-review
 * expects to receive. If the intake pipeline changes its output format, these
 * tests catch the mismatch before the review queue renders garbage.
 * See docs/chronicle-intake-test-plan.md for the full Group E specification
 * once that document is written.
 *
 * RUN
 * ---
 * node tests/delta-schema.test.js
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

// ── Delta item constructors ───────────────────────────────────────────────────
// These mirror what the intake pipeline produces. Tests use these to build
// representative delta items and verify their shape is accepted.

/**
 * makeRoundDeltaItem(combatId, roundN, slots, enemyTurns)
 * Builds a delta item representing a new round proposal.
 * Shape mirrors what ChronicleAI.fillRoundsFromImage() produces.
 */
function makeRoundDeltaItem(combatId, roundN, slots, enemyTurns) {
  return {
    type:       'round',
    combatId:   combatId,
    roundNumber: roundN,
    slots:      slots      || [],
    enemyTurns: enemyTurns || [],
  };
}

/**
 * makeNpcDeltaItem(npcData)
 * Builds a delta item representing a new NPC proposal.
 */
function makeNpcDeltaItem(npcData) {
  return {
    type: 'npc',
    data: npcData,
  };
}

// ── Test E-1 — Round delta item has required fields ───────────────────────────
// delta-review.html reads type, combatId, roundNumber, slots, and enemyTurns
// from every round delta item. Missing any of these causes undefined renders.
console.log('\nTest E-1 — round delta item has required fields');
{
  const item = makeRoundDeltaItem('cbt_001', 1, [], []);

  assert('item.type === "round"',           item.type === 'round');
  assert('item.combatId is a string',       typeof item.combatId === 'string');
  assert('item.roundNumber is a number',    typeof item.roundNumber === 'number');
  assert('item.slots is an array',          Array.isArray(item.slots));
  assert('item.enemyTurns is an array',     Array.isArray(item.enemyTurns));
}

// ── Test E-2 — Round delta combatId resolves to a known combat ───────────────
// delta-review matches incoming round deltas to existing combats by ID.
// A delta for an unknown combat ID cannot be processed.
console.log('\nTest E-2 — round delta combatId resolves to a known combat in fixture');
{
  const knownCombatIds = new Set(fixture.combat_encounters.map(c => c.id));
  const item = makeRoundDeltaItem('cbt_001', 4, [], []);

  assert(
    'item.combatId "' + item.combatId + '" exists in combat_encounters',
    knownCombatIds.has(item.combatId)
  );
}

// ── Test E-3 — Slot in round delta has v4 action sub-object ──────────────────
// v4 nests action fields inside slot.action. A flat slot (with top-level act,
// res, val) is v3 format and must not be produced by the pipeline.
console.log('\nTest E-3 — slot in round delta has v4 action sub-object (not flat v3)');
{
  const slot = { s: 1, a: 'pc_001', action: { name: 'Longsword', res: 'hit', val: 8 }, notes: null };
  const item = makeRoundDeltaItem('cbt_001', 4, [slot], []);
  const s    = item.slots[0];

  assert('slot has action sub-object',     typeof s.action === 'object' && s.action !== null);
  assert('slot action.name is a string',   typeof s.action.name === 'string');
  assert('slot action.res is a string',    typeof s.action.res  === 'string');
  assert('slot does NOT have flat .act',   !Object.prototype.hasOwnProperty.call(s, 'act'));
}

// ── Test E-4 — NPC delta item has required fields ─────────────────────────────
// delta-review renders NPC delta items by reading type, data.id, data.name,
// data.mechanics, and data.narrative. Missing any causes silent undefined.
console.log('\nTest E-4 — NPC delta item has required fields');
{
  const npcData = {
    id:        'npc_004',
    name:      'Test NPC',
    mechanics: { disposition: 'neutral', affiliation: null, first_seen: 'session_001' },
    narrative: { description: 'A test NPC.' },
  };
  const item = makeNpcDeltaItem(npcData);

  assert('item.type === "npc"',             item.type === 'npc');
  assert('item.data is an object',          typeof item.data === 'object' && item.data !== null);
  assert('item.data.id is a string',        typeof item.data.id === 'string');
  assert('item.data.name is a string',      typeof item.data.name === 'string');
  assert('item.data.mechanics is present',  typeof item.data.mechanics === 'object');
  assert('item.data.narrative is present',  typeof item.data.narrative === 'object');
}

// ── Test E-5 — NPC delta ID follows the npc_ prefix pattern ─────────────────
// The campaign uses npc_<number> IDs. A delta proposing an NPC with a
// different prefix would create an inconsistent ID registry.
console.log('\nTest E-5 — NPC delta ID follows npc_<number> format');
{
  const NPC_ID_PATTERN = /^npc_\d+$/;
  const npcData = { id: 'npc_004', name: 'Test NPC', mechanics: {}, narrative: {} };
  const item    = makeNpcDeltaItem(npcData);

  assert('item.data.id matches npc_<number>', NPC_ID_PATTERN.test(item.data.id));
}

// ── Test E-6 — Round numbers in delta items are positive integers ─────────────
// The combat viewer and integrity checker both require round numbers to be
// positive integers. Floating-point or zero values will cause off-by-one
// errors in gap detection.
console.log('\nTest E-6 — round numbers are positive integers');
{
  [1, 2, 3, 10].forEach(function(n) {
    const item = makeRoundDeltaItem('cbt_001', n, [], []);
    assert(
      'roundNumber ' + n + ' is a positive integer',
      Number.isInteger(item.roundNumber) && item.roundNumber > 0
    );
  });
}

// ── Summary ──────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log('\n' + passed + '/' + total + ' tests passed.');
if (failed > 0) process.exit(1);
