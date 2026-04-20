/**
 * tests/integrity.test.js
 *
 * Automated tests for shared/chronicle-integrity.js.
 * Plain Node.js — no test framework required. Run with: node tests/integrity.test.js
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Proves that ChronicleIntegrity.checks() was correctly extracted from
 * integrity.html into a shared module and that its three gap-detection
 * algorithms (existing gaps, incoming gaps, continuity gaps) produce the
 * correct output shapes. Also confirms the function is pure — it reads
 * only its explicit parameters, never any module-level globals.
 *
 * LOAD NOTE
 * ---------
 * chronicle-integrity.js writes to window.ChronicleIntegrity. Node.js has
 * no window object, so we stub global.window = {} before requiring the file.
 * After require(), window.ChronicleIntegrity holds the real module object.
 */

// Stub window so chronicle-integrity.js can attach to it, just as a browser would.
// This must come before require() — the module assigns to window on load.
global.window = {};

require('../shared/chronicle-integrity.js');

// After require, the module is attached to our stubbed window.
const CI = window.ChronicleIntegrity;

// ── Helpers ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

/**
 * assert(label, condition)
 * Prints PASS or FAIL with the test label and increments counters.
 * All tests run regardless of earlier failures — no bail-on-first-fail.
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

/**
 * makeCampaign(combats)
 * Builds the minimal campaignData shape that ChronicleIntegrity.checks() requires.
 * Each combat entry: { id, name, sessions, totalRounds, rounds: [{n},...] }
 */
function makeCampaign(combats) {
  return { combat_encounters: combats };
}

// ── Test 1 — No gaps when all rounds are present ─────────────────────────────
// When a combat has a contiguous round sequence and no incoming data,
// checks() should return an empty array (nothing to flag).
console.log('\nTest 1 — checks() returns [] when no gaps exist');
{
  const campaign = makeCampaign([{
    id: 'cbt_001',
    name: 'Test Combat',
    sessions: ['session_001'],
    totalRounds: 3,
    rounds: [{ n: 1 }, { n: 2 }, { n: 3 }],
  }]);

  const result = CI.checks(campaign, []);

  // No gaps at all — empty array expected.
  // totalRounds === rounds.length so no count-mismatch gap either.
  assert('returns empty array', Array.isArray(result) && result.length === 0);
}

// ── Test 2 — Detects an existing-round gap ───────────────────────────────────
// A combat with rounds 1 and 3 but not 2 should produce one gap object
// with id prefix 'g_', cbtId matching the combat, and miss containing [2].
console.log('\nTest 2 — checks() detects a gap in existing rounds');
{
  const campaign = makeCampaign([{
    id: 'cbt_002',
    name: 'Gap Combat',
    sessions: ['session_001'],
    totalRounds: 3,   // Declared 3 rounds; only 1 and 3 exist — round 2 missing.
    rounds: [{ n: 1 }, { n: 3 }],
  }]);

  const result = CI.checks(campaign, []);

  // Expect exactly one gap (the existing-round gap; count-mismatch is suppressed
  // when there is already a hard round-gap for the same combat — or may also appear;
  // we filter to the g_ prefixed entry to avoid coupling this test to that detail).
  const gap = result.find(g => g.id === 'g_cbt_002');

  assert('returns at least one gap',   result.length >= 1);
  assert('gap id has g_ prefix',       gap != null);
  assert('gap.cbtId is cbt_002',       gap?.cbtId === 'cbt_002');
  assert('gap.miss contains [2]',      Array.isArray(gap?.miss) && gap.miss.length === 1 && gap.miss[0] === 2);
  assert('gap.block is true',          gap?.block === true);
  assert('gap.isNew is false',         gap?.isNew === false);
}

// ── Test 3 — Detects an incoming-round gap ───────────────────────────────────
// Incoming delta items covering rounds 1, 2, and 4 (skipping 3) should
// produce one gap with id prefix 'gi_' and miss containing [3].
console.log('\nTest 3 — checks() detects a gap in incoming (staged) rounds');
{
  const campaign = makeCampaign([{
    id: 'cbt_003',
    name: 'Incoming Gap Combat',
    sessions: ['session_002'],
    totalRounds: null,  // Not declared yet — incoming data is being staged.
    rounds: [],         // No existing rounds — this is first intake for this combat.
  }]);

  // Incoming data: rounds 1, 2, and 4 for cbt_003 — round 3 is missing.
  const incoming = [
    { combatId: 'cbt_003', roundNumber: 1 },
    { combatId: 'cbt_003', roundNumber: 2 },
    { combatId: 'cbt_003', roundNumber: 4 },
  ];

  const result = CI.checks(campaign, incoming);

  const gap = result.find(g => g.id === 'gi_cbt_003');

  assert('returns at least one gap',   result.length >= 1);
  assert('gap id has gi_ prefix',      gap != null);
  assert('gap.cbtId is cbt_003',       gap?.cbtId === 'cbt_003');
  assert('gap.miss contains [3]',      Array.isArray(gap?.miss) && gap.miss.length === 1 && gap.miss[0] === 3);
  assert('gap.isNew is true',          gap?.isNew === true);
}

// ── Test 4 — Detects a continuity gap ────────────────────────────────────────
// A combat where the existing record ends at round 5 and the incoming data
// starts at round 8 has a continuity gap (rounds 6 and 7 were never captured).
// The continuity gap has id prefix 'ct_' and block === false (advisory, not critical).
console.log('\nTest 4 — checks() detects a continuity gap across sessions');
{
  const campaign = makeCampaign([{
    id: 'cbt_004',
    name: 'Multi-Session Combat',
    sessions: ['session_001', 'session_002'],
    totalRounds: null,
    // Existing record: rounds 1–5 (session 1 ended here)
    rounds: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }],
  }]);

  // Incoming data picks up at round 8, skipping 6 and 7.
  const incoming = [
    { combatId: 'cbt_004', roundNumber: 8 },
    { combatId: 'cbt_004', roundNumber: 9 },
  ];

  const result = CI.checks(campaign, incoming);

  const gap = result.find(g => g.id === 'ct_cbt_004');

  assert('returns at least one gap',   result.length >= 1);
  assert('gap id has ct_ prefix',      gap != null);
  assert('gap.cbtId is cbt_004',       gap?.cbtId === 'cbt_004');
  // Continuity gaps store the boundary in rmin/rmax rather than an explicit miss[],
  // because the specific round numbers between sessions may not be knowable from data alone.
  assert('gap.rmin is 6 (exMax+1)',    gap?.rmin === 6);
  assert('gap.rmax is 8 (incMin)',     gap?.rmax === 8);
  assert('gap.block is false',         gap?.block === false);
  assert('gap.isNew is true',          gap?.isNew === true);
}

// ── Test 5 — Parameter isolation: function reads only its parameters ──────────
// The function must be pure — its output must reflect only the data passed in,
// never any variables defined outside the function. We verify this by calling
// checks() with two different datasets in the same test and confirming that
// each call returns results matching only its own input.
//
// If the function were reading a module global, one of these calls would return
// results that belong to the other dataset, and the test would catch it.
console.log('\nTest 5 — parameter isolation: checks() reads only its parameters');
{
  // Dataset A: combat cbt_A with a gap at round 2
  const campaignA = makeCampaign([{
    id: 'cbt_A',
    name: 'Combat A',
    sessions: ['session_001'],
    totalRounds: 3,
    rounds: [{ n: 1 }, { n: 3 }],  // round 2 missing
  }]);

  // Dataset B: combat cbt_B — no gaps
  const campaignB = makeCampaign([{
    id: 'cbt_B',
    name: 'Combat B',
    sessions: ['session_002'],
    totalRounds: 2,
    rounds: [{ n: 1 }, { n: 2 }],  // complete
  }]);

  const resultA = CI.checks(campaignA, []);
  const resultB = CI.checks(campaignB, []);

  // resultA should contain a gap for cbt_A (not cbt_B)
  const gapA = resultA.find(g => g.id === 'g_cbt_A');
  // resultB should contain no hard gaps
  const hardGapsB = resultB.filter(g => g.id.startsWith('g_'));

  assert('resultA contains gap for cbt_A',           gapA != null);
  assert('resultA does not contain gap for cbt_B',   !resultA.some(g => g.cbtId === 'cbt_B'));
  assert('resultB has no hard round gaps',            hardGapsB.length === 0);
  assert('resultB does not contain gap for cbt_A',   !resultB.some(g => g.cbtId === 'cbt_A'));
}

// ── Summary ──────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log(`\n${passed}/${total} tests passed.`);
if (failed > 0) process.exit(1);
