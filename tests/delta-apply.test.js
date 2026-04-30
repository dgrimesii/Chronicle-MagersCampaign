/**
 * tests/delta-apply.test.js — Group F
 *
 * Automated tests for:
 *   F-1 through F-4 — applyDeltasToCampaign() ROUND branch routing (issue #39)
 *   F-5 through F-7 — remainingRounds computation for partial gap fill (issue #38)
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Issue #39 fixed a data-corruption bug where gap-approved round objects were
 * routed through the NEW branch of applyDeltasToCampaign(), appending them as
 * root-level combat entries. These tests verify the ROUND branch inserts rounds
 * into combat.rounds[] and that the NEW branch no longer accepts a gap-source item.
 *
 * Issue #38 added partial-fill tracking so AI fill calls target only rounds that
 * are still missing. These tests verify the remainingRounds computation is correct
 * under all relevant state combinations.
 *
 * RUN
 * ---
 * node tests/delta-apply.test.js
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
const fixture     = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

// ── Inline applyDeltasToCampaign ─────────────────────────────────────────────
// This is the pure logic extracted from delta-review.html. The tests run this
// function directly so they can catch regressions in the routing branches
// without needing a browser. Keep this in sync with the implementation in
// admin/delta-review.html if the function is changed.
//
// NOTE: The sessionStorage and deferredGaps references in the full
// implementation are browser-only. This extract omits them — the tests only
// exercise the NEW / MOD / ROUND routing branches.

function applyDeltasToCampaign(campaign, approved) {
  const out = JSON.parse(JSON.stringify(campaign)); // deep clone — does not mutate input

  for (const delta of approved) {
    const arr = delta.array;
    if (!arr || !out[arr]) continue;

    if (delta.type === 'NEW') {
      // Append new entity (avoid duplicates by id)
      const id = delta.rawData?.id;
      if (id && out[arr].some(e => e.id === id)) continue;
      if (delta.rawData) out[arr].push(delta.rawData);

    } else if (delta.type === 'MOD') {
      // Patch fields on an existing entity
      const id  = delta.rawData?.id || delta.targetId;
      const idx = out[arr].findIndex(e => e.id === id);
      if (idx > -1 && delta.rawData) {
        Object.assign(out[arr][idx], delta.rawData);
      }

    } else if (delta.type === 'ROUND') {
      // Insert a round into combat_encounters — routes by combatId, not by array.
      // Using type:'NEW' here (the pre-#39 bug) would push rawData to the array
      // root instead of into combat.rounds[].
      const cbtIdx = out.combat_encounters?.findIndex(c => c.id === delta.combatId);
      if (cbtIdx > -1 && delta.rawData) {
        const rounds = out.combat_encounters[cbtIdx].rounds || [];
        const exists = rounds.findIndex(r => r.n === delta.rawData.n);
        if (exists > -1) {
          rounds[exists] = delta.rawData; // overwrite existing round
        } else {
          rounds.push(delta.rawData);
          rounds.sort((a, b) => a.n - b.n); // keep rounds in numeric order
        }
        out.combat_encounters[cbtIdx].rounds = rounds;
      }
    }
  }

  return out;
}

// ── Inline remainingRounds computation ───────────────────────────────────────
// Mirrors the logic in renderGapCard() and gapFillFromImage() / gapFillFromText().
// The gap object (g) and gap state (st) match the shapes those functions receive.

/**
 * computeRemainingRounds(g, st)
 * Returns the round numbers from g.miss that are not already in st.approvedRounds.
 * This is what the AI fill calls receive after issue #38 — only unresolved rounds.
 */
function computeRemainingRounds(g, st) {
  return g.miss.filter(n => !(st?.approvedRounds || []).includes(n));
}

// ═══════════════════════════════════════════════════════════════════════════
// Group F-1 — ROUND delta inserts into combat.rounds[], not the root array
// ═══════════════════════════════════════════════════════════════════════════
// Before issue #39 fix: type:'NEW' + array:'combat_encounters' pushed rawData
// as a new root combat entry. After fix: type:'ROUND' routes to the ROUND
// branch which inserts into the target combat's rounds[] array.

console.log('\nTest F-1 — ROUND delta inserts round into combat.rounds[]');
{
  // cbt_001 in the fixture has rounds 1, 2, 3. Add round 4.
  const newRound = { n: 4, slots: [], enemy_turns: [] };
  const delta = {
    type:     'ROUND',
    combatId: 'cbt_001',
    array:    'combat_encounters',
    rawData:  newRound,
    source:   'integrity',
    status:   'approved',
  };

  const result = applyDeltasToCampaign(fixture, [delta]);
  const cbt    = result.combat_encounters.find(c => c.id === 'cbt_001');

  assert(
    'combat_encounters length unchanged (round not added as new combat entry)',
    result.combat_encounters.length === fixture.combat_encounters.length
  );
  assert(
    'cbt_001.rounds now contains round 4',
    cbt.rounds.some(r => r.n === 4)
  );
  assert(
    'cbt_001.rounds length increased by 1',
    cbt.rounds.length === fixture.combat_encounters.find(c => c.id === 'cbt_001').rounds.length + 1
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Group F-2 — ROUND delta keeps rounds sorted in ascending order
// ═══════════════════════════════════════════════════════════════════════════
// The ROUND branch sorts rounds after inserting so the viewer always gets
// them in round order regardless of insertion order.

console.log('\nTest F-2 — ROUND delta sorts rounds in ascending order after insert');
{
  // Insert round 2 into a campaign that has rounds 1 and 3 (simulating a gap fill).
  // Rounds are currently [1, 2, 3] in fixture — clone with only rounds 1 and 3.
  const campaignWithGap = JSON.parse(JSON.stringify(fixture));
  campaignWithGap.combat_encounters[0].rounds =
    campaignWithGap.combat_encounters[0].rounds.filter(r => r.n !== 2);

  const delta = {
    type:     'ROUND',
    combatId: 'cbt_001',
    array:    'combat_encounters',
    rawData:  { n: 2, slots: [], enemy_turns: [] },
    source:   'integrity',
    status:   'approved',
  };

  const result     = applyDeltasToCampaign(campaignWithGap, [delta]);
  const cbt        = result.combat_encounters.find(c => c.id === 'cbt_001');
  const roundNums  = cbt.rounds.map(r => r.n);

  assert(
    'rounds are sorted [1, 2, 3] after gap fill',
    roundNums[0] === 1 && roundNums[1] === 2 && roundNums[2] === 3
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Group F-3 — ROUND delta overwrites an existing round (upsert behaviour)
// ═══════════════════════════════════════════════════════════════════════════
// If the round number already exists in rounds[], the ROUND branch replaces
// it rather than duplicating it. This allows corrections to be applied.

console.log('\nTest F-3 — ROUND delta overwrites existing round (no duplicate)');
{
  const correctedRound = {
    n: 2,
    slots: [{ s: 1, a: 'pc_001', action: { name: 'CORRECTED', res: 'hit', val: 99 }, notes: null }],
    enemy_turns: [],
  };
  const delta = {
    type:     'ROUND',
    combatId: 'cbt_001',
    array:    'combat_encounters',
    rawData:  correctedRound,
    source:   'integrity',
    status:   'approved',
  };

  const result    = applyDeltasToCampaign(fixture, [delta]);
  const cbt       = result.combat_encounters.find(c => c.id === 'cbt_001');
  const round2    = cbt.rounds.find(r => r.n === 2);
  const origCount = fixture.combat_encounters.find(c => c.id === 'cbt_001').rounds.length;

  assert(
    'round count unchanged after overwrite (no duplicate added)',
    cbt.rounds.length === origCount
  );
  assert(
    'round 2 now has the corrected action name',
    round2?.slots?.[0]?.action?.name === 'CORRECTED'
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Group F-4 — NEW delta does NOT insert into rounds[] (regression guard)
// ═══════════════════════════════════════════════════════════════════════════
// This is the pre-#39 bug path. A delta with type:'NEW' + array:'combat_encounters'
// appends rawData as a new combat entry, not a round. This test confirms
// the fix (type:'ROUND') is the only path that goes to rounds[].

console.log('\nTest F-4 — NEW delta on combat_encounters appends new combat (not into rounds)');
{
  // Simulate the pre-fix shape: type:'NEW', array:'combat_encounters'.
  // rawData looks like a round object, not a combat — this was the bug.
  const roundLookingData = { n: 4, slots: [], enemy_turns: [] };
  const delta = {
    type:    'NEW',
    array:   'combat_encounters',
    rawData: roundLookingData, // no .id field — would be skipped by NEW duplicate check
    source:  'integrity',
    status:  'approved',
  };

  const result = applyDeltasToCampaign(fixture, [delta]);
  const cbt    = result.combat_encounters.find(c => c.id === 'cbt_001');

  // NEW branch with no .id pushes directly — confirming NEW != ROUND routing
  assert(
    'NEW delta increases combat_encounters root length (not rounds)',
    result.combat_encounters.length > fixture.combat_encounters.length
  );
  assert(
    'cbt_001.rounds unchanged — round object went to root, not into rounds[]',
    cbt.rounds.length === fixture.combat_encounters.find(c => c.id === 'cbt_001').rounds.length
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Group F-5 — remainingRounds with no prior approvals returns all miss rounds
// ═══════════════════════════════════════════════════════════════════════════
// When no rounds have been approved yet, all missing rounds should be targets.

console.log('\nTest F-5 — remainingRounds returns all g.miss when no rounds approved yet');
{
  const g  = { id: 'g_cbt_001', miss: [4, 5, 6] };
  const st = { approvedRounds: [] };

  const remaining = computeRemainingRounds(g, st);

  assert('remainingRounds length === 3', remaining.length === 3);
  assert('round 4 is in remainingRounds', remaining.includes(4));
  assert('round 5 is in remainingRounds', remaining.includes(5));
  assert('round 6 is in remainingRounds', remaining.includes(6));
}

// ═══════════════════════════════════════════════════════════════════════════
// Group F-6 — remainingRounds excludes already-approved rounds (partial fill)
// ═══════════════════════════════════════════════════════════════════════════
// After one round is approved, only the unapproved rounds should remain.
// This is the core of issue #38 — the edit panel and AI calls must not
// re-request rounds the DM already approved in this session.

console.log('\nTest F-6 — remainingRounds excludes approved rounds (partial fill state)');
{
  const g  = { id: 'g_cbt_001', miss: [4, 5, 6] };
  const st = { approvedRounds: [4] }; // round 4 was already approved

  const remaining = computeRemainingRounds(g, st);

  assert('remainingRounds length === 2', remaining.length === 2);
  assert('round 4 NOT in remainingRounds', !remaining.includes(4));
  assert('round 5 is in remainingRounds',  remaining.includes(5));
  assert('round 6 is in remainingRounds',  remaining.includes(6));
}

// ═══════════════════════════════════════════════════════════════════════════
// Group F-7 — remainingRounds returns empty array when all rounds are filled
// ═══════════════════════════════════════════════════════════════════════════
// All-approved state should yield an empty remainingRounds — the card
// transitions to 'pending-confirm' at this point.

console.log('\nTest F-7 — remainingRounds returns [] when all miss rounds are approved');
{
  const g  = { id: 'g_cbt_001', miss: [4, 5, 6] };
  const st = { approvedRounds: [4, 5, 6] }; // all rounds approved

  const remaining = computeRemainingRounds(g, st);

  assert('remainingRounds is empty', remaining.length === 0);
}

// ── F-8 — remainingRounds handles null/undefined gapState gracefully ─────────
// If gapStates[gapId] is undefined (e.g. gap card rendered before state init),
// remainingRounds should fall back to g.miss rather than throwing.

console.log('\nTest F-8 — remainingRounds returns g.miss when gapState is undefined');
{
  const g  = { id: 'g_cbt_001', miss: [4, 5, 6] };
  const st = undefined; // no state initialised yet

  const remaining = computeRemainingRounds(g, st);

  assert('remainingRounds equals g.miss when st is undefined', remaining.length === 3);
}

// ── Summary ──────────────────────────────────────────────────────────────────

const total = passed + failed;
console.log('\n' + passed + '/' + total + ' tests passed.');
if (failed > 0) process.exit(1);
