/**
 * tests/session-publish.test.js — the session page's publish step (issue #106)
 *
 * Tests ChroniclePublish.sessionQueue(), the computed relationships
 * (deriveRelationships) and what the review writes through the real
 * applySession:
 *   P-1  sessionQueue: order, roster groups, rounds without working fields,
 *        deferred passages on a round, an activity and a quest step,
 *        quest progress, loot, and what cannot be placed
 *   P-2  through applySession on the real campaign: rounds, passages each in
 *        one place, quest progress, holder, the new creature
 *   P-3  republishing the same review adds nothing twice
 *   P-4  relationships: combat participation per pairing, NPCs met with
 *        disposition, quests, recorded lists, no visit edges, approved
 *        significant events kept, identical on regeneration
 *   P-5  linking a misread name in step 3 changes its relationships
 *   P-6  a Safe Test Mode-style publish of the fixture passes
 *        scripts/migrate-opaque-ids.js --check
 *   P-7  the pages: Publish button, pending decisions, store order; no
 *        relationship detection left in intake, Delta Review or the viewer
 *   P-8  quest progress review and a quest's start (#120): dropped facts not
 *        written, an inciting event sets given_by only when empty, a second
 *        start is not written, the real qst_005 keeps its fields
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Publish writes the DM's whole review to the campaign file. These tests pin
 * that each reviewed fact lands once, in one place, that a repeat publish is
 * harmless, and that relationships follow confirmed data, so a correction in
 * step 3 reaches them with no other edit.
 *
 * No test loads a page in a browser or touches the real campaign file.
 *
 * RUN
 * ---
 * node tests/session-publish.test.js
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ChronicleIds     = require('../shared/chronicle-ids.js');
const ChroniclePublish = require('../shared/chronicle-publish.js');

let passed = 0;
let failed = 0;

/**
 * assert(label, condition)
 * Prints PASS or FAIL with the test label and increments counters.
 * All tests run regardless of earlier failures.
 */
function assert(label, condition) {
  if (condition) { console.log('  PASS  ' + label); passed++; }
  else           { console.log('  FAIL  ' + label); failed++; }
}

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// The real campaign, for session_006, cbt_005 and its NPCs; never written.
const campaign = JSON.parse(read('data/magers-campaign.json'));
const C = ChronicleIds.buildLegacyIndex(campaign);
const AMBUSH = C.get('cbt_005'), DEL = C.get('pc_004'), ASH = C.get('pc_003'), RUFUS = C.get('npc_014');
const QUEST = C.get('qst_003'), MAP = C.get('item_001');
const GOBLINS = campaign.bestiary.find(b => /^goblins?$/i.test(b.name)).id;
const DRAGON = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa'; // the new creature step 3 created

// The review the session page would hand publish, in publishPlan()'s shape.
function makePlan(dragonRef) {
  const passage = (text, attach) => ({ passage: { text, session_id: 'session_006', speaker: 'dm', page: 1, attach } });
  return {
    header: ChroniclePublish.sessionHeader('session_006', '2026-04-02'),
    headerReplace: null,
    identityItems: dragonRef === DRAGON ? [{ id: 'ident_new', type: 'NEW', array: 'bestiary', status: 'approved', title: 'Larkspur Dragon',
      rawData: { _object_type: 'bestiary', id: DRAGON, name: 'Larkspur Dragon' } }] : [],
    passageItems: [{ id: 'passage_0', type: 'MOD', array: 'npc_directory', status: 'approved', targetId: RUFUS,
      rawData: { id: RUFUS, _passage_append: [{ text: 'Rufus has not slept in days.', session_id: 'session_006', speaker: RUFUS, page: 1 }] } }],
    deferredPassages: [
      passage('The dragons descended on the cart from the ridges.', { to: 'round', combat: AMBUSH, n: 4 }),
      passage('Del struck the goblin square in the jaw.', { to: 'activity', combat: AMBUSH, n: 4, actor: 'occ_del', index: 0 }),
      passage('The party agreed to see the cart through to Lake Town.', { to: 'quest_progress', index: 0 }),
      passage('A passage for a round that is not in the review.', { to: 'round', combat: AMBUSH, n: 9 }),
      { passage: { text: 'Waiting for a split.', session_id: 'session_006', speaker: 'dm', page: 2 }, reason: 'its speaker is waiting for a split assignment' },
    ],
    textItems: [],
    judgmentItems: [{ id: 'judg_0', type: 'NEW', array: 'character_moments', status: 'approved', title: 'Character moment',
      rawData: { _object_type: 'character_moment', id: 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb', type: 'clutch_save',
        mechanics: { character_ids: [ASH], parent_event_id: AMBUSH, origin_session: 'session_006', round_ref: 4, mechanical_action: 'Con save' },
        narrative: { description: 'Ash shrugged off the beak.', significance: null }, notes: null } },
      { id: 'judg_1', type: 'RELATIONSHIP', array: 'entity_relationships', status: 'approved', title: 'Relationship',
        rawData: { from_id: RUFUS, from_type: 'npc_directory', to_id: DEL, to_type: 'party', relationship_type: 'social_contact',
          significance: 'significant_event', established_session: 'session_006', ground_truth_notes: 'Rufus swore to guide Del.' } }],
    combats: [{
      combat: AMBUSH, name: 'Goblin Ambush',
      rounds: [{ n: 4, sid: 'session_006',
        slots: [{ s: 1, a: DEL, activities: [{ economy: 'action', name: 'Attack', outcomes: [{ res: 'hit', val: 7, target_id: 'Goblins' }] }],
          notes: null, source_line: 'Asp - Hit 7', note_order: 0 }],
        enemy_turns: [{ actor_id: 'Larkspur Dragon', activities: [{ economy: 'action', name: 'Attack', detail: 'Beak',
          outcomes: [{ res: 'hit', val: 5, target_id: ASH }] }], special_events: [], notes: null }] }],
      rosterAdds: [{ actor_id: 'Larkspur Dragon', type: 'group', mon_ref: dragonRef, count: null, count_remaining: null, notes: null }],
      held: [{ round: 4, asWritten: 'Dragon', source_line: 'Dragon - hit', reason: 'its actor is not yet assigned' }],
      events: [{ round: 4, text: 'Goblins scared of dragons', page: 1 }],
    }],
    questProgress: [{ quest: 'occ_quest', entry: 'The party agreed to finish the escort.', type: 'lead_acquired', page: 1 }],
    loot: [{ item: 'occ_map', change: 'given', holder: 'occ_del', page: 1 }, { item: null, item_text: 'a pouch of gold', change: 'found', page: 2 }],
  };
}
const OCC = { occ_del: { id: DEL, array: 'party' }, occ_quest: { id: QUEST, array: 'quest_ledger' }, occ_map: { id: MAP, array: 'inventory_and_loot' } };
let n = 0;
const ctx = { sessionRef: 'session_006', entityOf: occ => OCC[occ] || null, actorKey: occ => (OCC[occ] || {}).id || null,
  newId: () => 'cccccccc-3333-4ccc-8ccc-' + String(++n).padStart(12, '0') };
const stamps = c => JSON.stringify(Object.assign({}, c, { _last_published: null, _delta_count: null, meta: Object.assign({}, c.meta, { last_updated: null }) }));
const count = (obj, text) => JSON.stringify(obj).split(JSON.stringify(text).slice(1, -1)).length - 1;

// ── P-1 ─────────────────────────────────────────────────────────────────────
console.log('\nTest P-1 — sessionQueue');
const q = ChroniclePublish.sessionQueue(makePlan(DRAGON), ctx);
{
  const types = q.items.map(i => i.type + ':' + (i.array || ''));
  assert('P-1: the session header comes first', q.items[0].array === 'session_logs' && q.items[0].type === 'NEW');
  assert('P-1: identification items before the combat', types.indexOf('NEW:bestiary') < types.indexOf('MOD:combat_encounters'));
  const roster = q.items.find(i => i.rawData && i.rawData._roster_group_append);
  assert('P-1: the new roster group is a _roster_group_append on the combat', roster && roster.targetId === AMBUSH && roster.rawData._roster_group_append.mon_ref === DRAGON);
  const round = q.items.find(i => i.type === 'ROUND');
  assert('P-1: one ROUND item for the combat, round 4, sid session_006', round && round.combatId === AMBUSH && round.rawData.n === 4 && round.rawData.sid === 'session_006');
  assert('P-1: working fields source_line and note_order are stripped', !('source_line' in round.rawData.slots[0]) && !('note_order' in round.rawData.slots[0]));
  assert('P-1: the page plan is not changed', makePlan(DRAGON).combats[0].rounds[0].slots[0].source_line === 'Asp - Hit 7');
  assert('P-1: the round passage is on the round', (round.rawData.passages || []).some(p => /descended on the cart/.test(p.text)) && !('attach' in round.rawData.passages[0]));
  assert('P-1: the activity passage is on Del\'s attack', (round.rawData.slots[0].activities[0].passages || []).some(p => /square in the jaw/.test(p.text)));
  const prog = q.items.find(i => i.rawData && i.rawData._progress_append);
  assert('P-1: quest progress is a _progress_append on the quest, with its passage',
    prog && prog.targetId === QUEST && prog.rawData._progress_append.type === 'lead_acquired' && prog.rawData._progress_append.session_id === 'session_006' &&
    (prog.rawData._progress_append.passages || []).some(p => /see the cart through/.test(p.text)));
  const loot = q.items.find(i => i.id === 'loot_0');
  assert('P-1: an item given to Del sets its holder with _set', loot && loot.targetId === MAP && loot.rawData._set['mechanics.current_holder'] === DEL);
  assert('P-1: a found item that is not an entity is listed, not written', q.unplaced.some(u => /pouch of gold/.test(u.what) && /step 3/.test(u.reason)));
  assert('P-1: a passage for a round not in the review is listed', q.unplaced.some(u => /not in the review/.test(u.reason)));
  assert('P-1: a passage waiting for a split is listed with its reason', q.unplaced.some(u => /split assignment/.test(u.reason)));
  assert('P-1: text changes and judgments come last', q.items[q.items.length - 1].id === 'judg_1');
  const fresh = ChroniclePublish.sessionQueue(Object.assign(makePlan(DRAGON), { combats: [Object.assign(makePlan(DRAGON).combats[0], { combat: 'new: Bridge Fight' })] }), ctx);
  const nc = fresh.items.find(i => i.type === 'NEW' && i.array === 'combat_encounters');
  assert('P-1: a combat the notes started is a NEW combat with its roster, then its rounds',
    nc && nc.rawData.name === 'Bridge Fight' && nc.rawData.mechanics.enemies_roster.length === 1 &&
    fresh.items.some(i => i.type === 'ROUND' && i.combatId === nc.rawData.id));
}

// ── P-2 ─────────────────────────────────────────────────────────────────────
console.log('\nTest P-2 — through applySession on the real campaign');
const first = ChroniclePublish.applySession(campaign, q.items, { now: new Date('2026-10-24T12:00:00Z') });
{
  const out = first.campaign;
  const s6 = out.session_logs.find(s => s.legacy_id === 'session_006');
  const amb = out.combat_encounters.find(c => c.id === AMBUSH);
  const r4 = amb.rounds.find(r => r.n === 4);
  assert('P-2: round 4 is written to the Goblin Ambush with session_006\'s id', r4 && r4.sid === s6.id);
  assert('P-2: the combat now lists session_006 and counts 4 rounds', amb.mechanics.sessions.includes(s6.id) && amb.mechanics.total_rounds_logged === 4);
  assert('P-2: the new roster group points at the new creature', amb.mechanics.enemies_roster.some(g => g.actor_id === 'Larkspur Dragon' && g.mon_ref === DRAGON));
  assert('P-2: the new creature keeps the id step 3 gave it', out.bestiary.some(b => b.id === DRAGON && b.name === 'Larkspur Dragon'));
  assert('P-2: each passage is written exactly once',
    ['descended on the cart', 'square in the jaw', 'see the cart through', 'has not slept in days'].every(t => count(out, t) === 1));
  assert('P-2: the round passage carries the session\'s id', r4.passages[0].session_id === s6.id);
  const quest = out.quest_ledger.find(x => x.id === QUEST);
  assert('P-2: the quest gains the progress entry', quest.mechanics.progress_log.some(e => e.fact === 'The party agreed to finish the escort.' && e.session_id === s6.id));
  assert('P-2: Ched\'s Map is now held by Del', out.inventory_and_loot.find(i => i.id === MAP).mechanics.current_holder === DEL);
  assert('P-2: held-back facts are not written', count(out, 'Dragon - hit') === 0);
  assert('P-2: the moment is written once', out.character_moments.filter(m => m.id === 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb').length === 1);
  assert('P-2: the input campaign is untouched', !campaign.combat_encounters.find(c => c.id === AMBUSH).rounds.some(r => r.n === 4));
}

// ── P-3 ─────────────────────────────────────────────────────────────────────
console.log('\nTest P-3 — republishing the same review adds nothing twice');
{
  const again = ChroniclePublish.applySession(first.campaign, q.items, { now: new Date('2026-10-24T12:00:00Z') }).campaign;
  assert('P-3: the second publish leaves the campaign identical', stamps(again) === stamps(first.campaign));
  assert('P-3: one Larkspur Dragon, one roster group, one significant relationship',
    again.bestiary.filter(b => b.name === 'Larkspur Dragon').length === 1 &&
    again.combat_encounters.find(c => c.id === AMBUSH).mechanics.enemies_roster.filter(g => g.actor_id === 'Larkspur Dragon').length === 1 &&
    again.entity_relationships.filter(r => r.significance === 'significant_event').length === 1);
}

// ── P-4 ─────────────────────────────────────────────────────────────────────
console.log('\nTest P-4 — computed relationships');
{
  const out = first.campaign;
  const rels = out.entity_relationships;
  const s6 = out.session_logs.find(s => s.legacy_id === 'session_006').id;
  const s5 = C.get('session_005');
  const find = (f, t, ty) => rels.filter(r => r.from_id === f && r.to_id === t && r.relationship_type === ty);
  assert('P-4: every type is in the CLAUDE.md vocabulary',
    rels.every(r => ['combat_antagonist', 'allied', 'quest_connection', 'location_inhabitant', 'social_contact', 'witnessed', 'unknown'].includes(r.relationship_type)));
  assert('P-4: party → Goblins, one record for the pairing (Goblins and Goblin Slingers share it)',
    find('party', GOBLINS, 'combat_antagonist').length === 1 && !rels.some(r => r.from_type === 'pc' && r.relationship_type === 'combat_antagonist'));
  const dragon = find('party', DRAGON, 'combat_antagonist')[0];
  assert('P-4: the new creature is a combat antagonist from session_006', dragon && dragon.established_session === s6 && dragon.last_updated_session === s6);
  const gob = find('party', GOBLINS, 'combat_antagonist')[0];
  assert('P-4: first and last session span the combat (session_005 to session_006)', gob.established_session === s5 && gob.last_updated_session === s6);
  const rufus = find('party', RUFUS, 'social_contact')[0];
  const rufusRec = out.npc_directory.find(x => x.id === RUFUS);
  assert('P-4: party → NPC met carries the NPC\'s disposition as an attribute', rufus && rufus.disposition === rufusRec.mechanics.disposition);
  const blair = C.get('npc_004');
  assert('P-4: a quest giver is tied to its quest', find(blair, C.get('qst_001'), 'quest_connection').length === 1);
  const darnell = C.get('npc_011');
  assert('P-4: a recorded "resides_in" becomes location_inhabitant, with the word kept',
    find(darnell, C.get('loc_006'), 'location_inhabitant').some(r => /resides_in/.test(r.narrative.ground_truth_notes)));
  assert('P-4: a recorded entry pointing at a quest becomes quest_connection', !rels.some(r => r.to_type === 'quest' && r.relationship_type !== 'quest_connection' && r.significance === 'participation'));
  assert('P-4: no visit edges: the party has no relationship to a location', !rels.some(r => r.from_id === 'party' && r.to_type === 'location'));
  assert('P-4: the approved significant relationship is kept as approved',
    rels.some(r => r.significance === 'significant_event' && r.from_id === RUFUS && r.to_id === DEL && r.narrative.ground_truth_notes === 'Rufus swore to guide Del.'));
  const ids = rels.map(r => r.id);
  assert('P-4: every record has a UUID id, no duplicates', ids.every(ChronicleIds.isOpaqueId) && new Set(ids).size === ids.length);
  const copy = JSON.parse(JSON.stringify(out));
  ChroniclePublish.deriveRelationships(copy);
  assert('P-4: regenerating gives identical relationships, ids included', JSON.stringify(copy.entity_relationships) === JSON.stringify(rels));
  const participation = ChroniclePublish.applySession(campaign, [{ type: 'RELATIONSHIP', array: 'entity_relationships',
    rawData: { from_id: 'party', to_id: RUFUS, relationship_type: 'combat_antagonist', significance: 'participation' } }]).campaign;
  assert('P-4: a queued participation relationship is not written (participation is computed)',
    !participation.entity_relationships.some(r => r.from_id === 'party' && r.to_id === RUFUS && r.relationship_type === 'combat_antagonist'));
}

// ── P-5 ─────────────────────────────────────────────────────────────────────
console.log('\nTest P-5 — linking a misread name changes its relationships');
{
  // Step 3 first separated "Gobblins" as a new creature; the DM then linked
  // it to the existing Goblins. Only that answer differs between the runs.
  const plan = makePlan(DRAGON);
  const misread = 'dddddddd-4444-4ddd-8ddd-dddddddddddd';
  plan.identityItems.push({ id: 'ident_gob', type: 'NEW', array: 'bestiary', status: 'approved', title: 'Gobblins', rawData: { _object_type: 'bestiary', id: misread, name: 'Gobblins' } });
  plan.combats[0].rosterAdds.push({ actor_id: 'Gobblins', type: 'group', mon_ref: misread, count: null, count_remaining: null, notes: null });
  const before = ChroniclePublish.applySession(campaign, ChroniclePublish.sessionQueue(plan, ctx).items).campaign.entity_relationships;
  const linked = makePlan(DRAGON);
  linked.combats[0].rosterAdds.push({ actor_id: 'Gobblins', type: 'group', mon_ref: GOBLINS, count: null, count_remaining: null, notes: null });
  const after = ChroniclePublish.applySession(campaign, ChroniclePublish.sessionQueue(linked, ctx).items).campaign.entity_relationships;
  assert('P-5: separated, the misread creature has its own combat relationship', before.some(r => r.to_id === misread));
  assert('P-5: linked, it is gone and the Goblins relationship reaches session_006',
    !after.some(r => r.to_id === misread) && after.find(r => r.from_id === 'party' && r.to_id === GOBLINS).last_updated_session === C.get('session_006'));
}

// ── P-6 ─────────────────────────────────────────────────────────────────────
console.log('\nTest P-6 — a fixture publish passes the reference check');
{
  // What a Safe Test Mode publish writes: the fixture with a session applied.
  const fixture = JSON.parse(read('tests/fixtures/test-campaign.json'));
  const F = ChronicleIds.buildLegacyIndex(fixture);
  const cbt = F.get('cbt_001');
  const items = ChroniclePublish.sessionQueue({
    header: ChroniclePublish.sessionHeader('session_003', '2026-05-01'), identityItems: [], passageItems: [], deferredPassages: [],
    textItems: [], judgmentItems: [], questProgress: [], loot: [],
    combats: [{ combat: cbt, name: 'Goblin Skirmish', rounds: [{ n: 4, sid: 'session_003', slots: [{ s: 1, a: fixture.party[0].id,
      activities: [{ economy: 'action', name: 'Dodge', outcomes: [] }], notes: null }], enemy_turns: [] }], rosterAdds: [], held: [], events: [] }],
  }, ctx).items;
  const out = ChroniclePublish.applySession(fixture, items).campaign;
  const tmp = path.join(os.tmpdir(), 'chronicle-session-publish-' + process.pid + '.json');
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
  let ok = false, text = '';
  try { text = execFileSync(process.execPath, [path.join(ROOT, 'scripts/migrate-opaque-ids.js'), tmp, '--check'], { encoding: 'utf8' }); ok = /CHECK PASSED/.test(text); }
  catch (e) { text = String(e.stdout || e.message); }
  fs.unlinkSync(tmp);
  assert('P-6: migrate-opaque-ids.js --check prints CHECK PASSED' + (ok ? '' : ' — ' + text.slice(-300)), ok);
  assert('P-6: the fixture file itself is unchanged', read('tests/fixtures/test-campaign.json') === fs.readFileSync(path.join(ROOT, 'tests/fixtures/test-campaign.json'), 'utf8') && fixture.session_logs.find(s => s.legacy_id === 'session_003').notes.startsWith('PLACEHOLDER'));
}

// ── P-6b ────────────────────────────────────────────────────────────────────
console.log('\nTest P-6b — what the first Safe Test Mode publish showed');
{
  // The fixture has no entity_relationships array and a combat with no roster.
  const fixture = JSON.parse(read('tests/fixtures/test-campaign.json'));
  const F = ChronicleIds.buildLegacyIndex(fixture);
  const cbt = F.get('cbt_001');
  const npc = 'eeeeeeee-5555-4eee-8eee-eeeeeeeeeeee';
  const items = [ChroniclePublish.sessionHeader('session_003', '2026-05-01'),
    { type: 'NEW', array: 'npc_directory', rawData: { _object_type: 'npc', id: npc, name: 'Rufus', mechanics: { first_appeared: 'session_003' }, narrative: {}, notes: null } },
    { type: 'MOD', array: 'combat_encounters', targetId: cbt, rawData: { id: cbt, _roster_group_append: { actor_id: 'Dragons', type: 'group', mon_ref: null, count: null, count_remaining: null, notes: null } } },
    { type: 'RELATIONSHIP', array: 'entity_relationships', rawData: { from_id: npc, to_id: fixture.party[0].id, relationship_type: 'social_contact',
      significance: 'significant_event', established_session: 'session_003', ground_truth_notes: 'Swore to guide them.' } }];
  const res = ChroniclePublish.applySession(fixture, items);
  const out = res.campaign;
  assert('P-6b: an approved relationship is written when the campaign had no entity_relationships',
    out.entity_relationships.some(r => r.significance === 'significant_event' && r.from_id === npc));
  const roster = out.combat_encounters.find(c => c.id === cbt).mechanics.enemies_roster.map(g => g.actor_id);
  assert('P-6b: a first roster lists the groups the recorded rounds name, then the new one',
    roster.includes('Goblin A') && roster.includes('Goblin B') && roster[roster.length - 1] === 'Dragons' && res.notes.some(n => /had no roster/.test(n)));
  assert('P-6b: an NPC new this session is met by the party, dated from it',
    out.entity_relationships.some(r => r.from_id === 'party' && r.to_id === npc && r.relationship_type === 'social_contact' &&
      r.established_session === out.session_logs.find(s => s.legacy_id === 'session_003').id));
  const ChronicleEntities = require('../shared/chronicle-entities.js');
  const idx = ChronicleEntities.buildIndex(campaign);
  const rows = ChronicleEntities.buildRows([{ page: 1, mentions: [{ as_written: 'Gorbash', kind: 'npc', context: '' }] }], idx);
  ChronicleEntities.acknowledge(rows[0]);
  const made = ChronicleEntities.toQueueItems(rows, idx, 'session_008').find(i => i.type === 'NEW');
  assert('P-6b: step 3 gives a new NPC first_appeared = the session', made && made.rawData.mechanics.first_appeared === 'session_008');
}

// ── P-6c ────────────────────────────────────────────────────────────────────
console.log('\nTest P-6c — real intake output on the fixture resolves (#111)');
{
  // Intake output from a real session names all six PCs by legacy ID and the
  // session the DM typed. Before #111 the fixture had only pc_001, pc_002 and
  // two sessions, so pc_003–pc_006 and session_006 were written untranslated
  // and the test publish failed the reference check.
  const fixture = JSON.parse(read('tests/fixtures/test-campaign.json'));
  const F = ChronicleIds.buildLegacyIndex(fixture);
  assert('P-6c: the fixture has all six PCs, each with a UUID id and its legacy_id',
    ['pc_001', 'pc_002', 'pc_003', 'pc_004', 'pc_005', 'pc_006'].every(l => ChronicleIds.isOpaqueId(F.get(l))) && fixture.party.length === 6);
  assert('P-6c: session_006 is a placeholder the publish fills', fixture.session_logs.find(s => s.legacy_id === 'session_006').notes.startsWith('PLACEHOLDER'));
  const flat = (s, a, act, res, val) => ({ s, a, act, res, val, notes: null, action_type: 'action', target: null, target_effects: [], val_type: null });
  const items = [
    { type: 'NEW', array: 'session_logs', rawData: { session_id: 'session_006', date: '2026-04-02', title: 'Test of real output' } },
    { type: 'ROUND', array: 'combat_encounters', combatId: 'cbt_001', status: 'approved', rawData: { n: 4, session_id: 'session_006',
      slots: ['pc_001', 'pc_002', 'pc_003', 'pc_004', 'pc_005', 'pc_006'].map((pc, i) => flat(i + 1, pc, 'Dodge', 'neutral', null)), enemy_turns: [] } },
  ];
  const res = ChroniclePublish.applySession(fixture, items);
  const out = res.campaign;
  const r4 = out.combat_encounters.find(c => c.id === F.get('cbt_001')).rounds.find(r => r.n === 4);
  assert('P-6c: every slot names a PC by UUID', r4 && r4.slots.length === 6 && r4.slots.every(s => out.party.some(p => p.id === s.a)));
  assert('P-6c: the round and the combat name session_006 by its UUID', r4.sid === F.get('session_006') && out.combat_encounters[0].mechanics.sessions.includes(F.get('session_006')));
  assert('P-6c: no session was added (the placeholder was filled)', out.session_logs.length === fixture.session_logs.length);
  const tmp = path.join(os.tmpdir(), 'chronicle-fixture-111-' + process.pid + '.json');
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
  let ok = false, text = '';
  try { text = execFileSync(process.execPath, [path.join(ROOT, 'scripts/migrate-opaque-ids.js'), tmp, '--check'], { encoding: 'utf8' }); ok = /CHECK PASSED/.test(text) && /Still a legacy ID: 0/.test(text); }
  catch (e) { text = String(e.stdout || e.message); }
  fs.unlinkSync(tmp);
  assert('P-6c: the result passes migrate-opaque-ids.js --check with no legacy ID left' + (ok ? '' : ' — ' + text.slice(-300)), ok);
}

// ── P-7 ─────────────────────────────────────────────────────────────────────
console.log('\nTest P-7 — the pages');
{
  const page = read('admin/session.html');
  const fn = (/async function publishFromPage\(\) \{([\s\S]*?)\n\}/.exec(page) || [, ''])[1];
  const awaits = [...fn.matchAll(/await ([A-Za-z.]+)\(/g)].map(m => m[1]);
  assert('P-7: Publish calls publishFromPage()', /onclick="publishFromPage\(\)"/.test(page));
  assert('P-7: loadPublishBase() is the first await, publishSession() follows',
    awaits[0] === 'ChronicleStore.loadPublishBase' && awaits.includes('ChronicleStore.publishSession'));
  assert('P-7: the queue comes from sessionQueue and goes through applySession',
    /ChroniclePublish\.sessionQueue\(publishPlan\(\), queueContext\(\)\)/.test(fn) && /ChroniclePublish\.applySession\(base, queue\.items\)/.test(fn));
  assert('P-7: the button is disabled while any decision is pending', /pending\.length \|\| session\.publishing \? 'disabled' : ''/.test(page) && /function pendingDecisions\(\)/.test(page));
  assert('P-7: pending decisions list text changes, judgments, drafts and section approvals',
    /Text change: /.test(page) && /Judgment event: /.test(page) && /still running/.test(page) && /reviewed"`/.test(page));
  assert('P-7: no GitHub call, token or git step in the page', !/api\.github\.com|githubToken|git push|git commit/i.test(page));
  assert('P-7: the "not built yet" notice is gone', !/not built yet/.test(page));
  assert('P-7: an approved judgment gets its id once', /if \(decision === 'approved' && !j\.newId\) j\.newId = ChronicleIds\.newId\(\)/.test(page));
  const intake = read('admin/intake.html');
  assert('P-7: intake no longer detects or queues relationships',
    !/function detectRelationships|function buildRelationshipPrompt|type:\s*'RELATIONSHIP'|relationships_created:/.test(intake));
  assert('P-7: Delta Review has no relationship card', !/item\.type === 'RELATIONSHIP'/.test(read('admin/delta-review.html')));
  const viewer = read('admin/log-viewer.html');
  assert('P-7: the log viewer builds RELS from entity_relationships, with no hardcoded map',
    /function buildRels\(\)/.test(viewer) && /DATA\.entity_relationships/.test(viewer) && !/'pc_001':\[/.test(viewer));
}

// ── P-8 ─────────────────────────────────────────────────────────────────────
console.log('\nTest P-8 — reviewing quest progress, and a quest\'s start (#120)');
{
  const HELEN = C.get('npc_007'), QST5 = C.get('qst_005');
  const base = { header: ChroniclePublish.sessionHeader('session_008', '2026-04-16'), identityItems: [], passageItems: [], deferredPassages: [], textItems: [], judgmentItems: [], combats: [], loot: [] };
  const occs = { occ_q: { id: QST5, array: 'quest_ledger' }, occ_h: { id: HELEN, array: 'npc_directory' }, occ_m: { id: MAP, array: 'inventory_and_loot' }, occ_d: { id: DEL, array: 'party' } };
  const qctx = Object.assign({}, ctx, { sessionRef: 'session_008', entityOf: o => occs[o] || null });
  const start = (extra) => Object.assign({ quest: 'occ_q', entry: 'Helen told the party rats plague the quarry work camp.', type: 'inciting_event', giver: 'occ_h', page: 1 }, extra);
  // Dropped facts are not written.
  const dq = ChroniclePublish.sessionQueue(Object.assign({}, base, { questProgress: [start({ dropped: true })], loot: [{ item: 'occ_m', change: 'given', holder: 'occ_d', dropped: true }] }), qctx);
  assert('P-8: a dropped quest progress fact and a dropped loot fact are not written', !dq.items.some(i => i.rawData && (i.rawData._progress_append || i.rawData._set)) && !dq.unplaced.length);
  // The real qst_005 already has origin_session and given_by.
  const q = ChroniclePublish.sessionQueue(Object.assign({}, base, { questProgress: [start()] }), qctx);
  const item = q.items.find(i => i.rawData && i.rawData._progress_append);
  assert('P-8: a quest start carries its giver to publish', item && item.rawData._giver === HELEN && item.rawData._progress_append.type === 'inciting_event' && item.title === 'Quest start');
  const real = campaign.quest_ledger.find(x => x.id === QST5);
  const res = ChroniclePublish.applySession(campaign, q.items);
  const after = res.campaign.quest_ledger.find(x => x.id === QST5);
  assert('P-8: on the real qst_005 the start is added', after.mechanics.progress_log.some(e => e.type === 'inciting_event' && /rats plague/.test(e.fact)));
  assert('P-8: and its origin_session and given_by are unchanged', after.mechanics.origin_session === real.mechanics.origin_session && after.mechanics.given_by === real.mechanics.given_by);
  assert('P-8: the differing origin is reported', res.notes.some(n => /kept the recorded origin_session/.test(n)));
  // A second start is not written.
  const twice = ChroniclePublish.applySession(res.campaign, ChroniclePublish.sessionQueue(Object.assign({}, base, { questProgress: [start({ entry: 'Another telling of the start.' })] }), qctx).items);
  const t = twice.campaign.quest_ledger.find(x => x.id === QST5);
  assert('P-8: a second inciting event on one quest is reported and not written',
    t.mechanics.progress_log.filter(e => e.type === 'inciting_event').length === 1 && twice.notes.some(n => /already records an inciting event/.test(n)));
  const repeat = ChroniclePublish.applySession(res.campaign, q.items).campaign.quest_ledger.find(x => x.id === QST5);
  assert('P-8: publishing the same start again adds nothing', repeat.mechanics.progress_log.length === after.mechanics.progress_log.length);
  // On the fixture the quest is new this session: the start sets given_by.
  const fixture = JSON.parse(read('tests/fixtures/test-campaign.json'));
  const FX = ChronicleIds.buildLegacyIndex(fixture);
  const NEWQ = 'ffffffff-6666-4fff-8fff-ffffffffffff', NEWH = 'ffffffff-7777-4fff-8fff-ffffffffffff';
  const fxItems = [ChroniclePublish.sessionHeader('session_004', '2026-03-10'),
    { type: 'NEW', array: 'quest_ledger', rawData: { _object_type: 'quest', id: NEWQ, title: 'The Quarry ROUS Problem', mechanics: { origin_session: 'session_004' }, narrative: {}, notes: null } },
    { type: 'NEW', array: 'npc_directory', rawData: { _object_type: 'npc', id: NEWH, name: 'Helen', mechanics: { first_appeared: 'session_004' }, narrative: {}, notes: null } }];
  const fxOccs = { occ_q: { id: NEWQ, array: 'quest_ledger' }, occ_h: { id: NEWH, array: 'npc_directory' } };
  const fxQueue = ChroniclePublish.sessionQueue(Object.assign({}, base, { header: fxItems[0], identityItems: fxItems.slice(1), questProgress: [start()] }),
    Object.assign({}, ctx, { sessionRef: 'session_004', entityOf: o => fxOccs[o] || null }));
  const fxOut = ChroniclePublish.applySession(fixture, fxQueue.items).campaign;
  const fq = fxOut.quest_ledger.find(x => x.id === NEWQ);
  const s4 = FX.get('session_004');
  assert('P-8: on the fixture the new quest gets its start and given_by Helen', fq.mechanics.given_by === NEWH && fq.mechanics.progress_log.length === 1 && fq.mechanics.progress_log[0].type === 'inciting_event');
  assert('P-8: its origin_session is session_004 (set when created)', fq.mechanics.origin_session === s4 && fq.mechanics.progress_log[0].session_id === s4);
  const tmp = path.join(os.tmpdir(), 'chronicle-120-' + process.pid + '.json');
  fs.writeFileSync(tmp, JSON.stringify(fxOut, null, 2) + '\n');
  let ok = false, text = '';
  try { text = execFileSync(process.execPath, [path.join(ROOT, 'scripts/migrate-opaque-ids.js'), tmp, '--check'], { encoding: 'utf8' }); ok = /CHECK PASSED/.test(text); }
  catch (e) { text = String(e.stdout || e.message); }
  fs.unlinkSync(tmp);
  assert('P-8: the fixture output passes migrate-opaque-ids.js --check' + (ok ? '' : ' — ' + text.slice(-200)), ok);
  // The page.
  const page = read('admin/session.html');
  assert('P-8: step 4 applies quest progress and loot edits with the passage edits',
    /ChronicleFacts\.applyFactEdits\(merged\.quest_progress, session\.questEdits\)/.test(page) && /ChronicleFacts\.applyFactEdits\(merged\.loot, session\.lootEdits\)/.test(page));
  assert('P-8: each quest progress fact has quest, type and giver dropdowns, Edit and Drop',
    /setFact\('quest', \$\{i\}, 'quest'/.test(page) && /setFact\('quest', \$\{i\}, 'type'/.test(page) && /setFact\('quest', \$\{i\}, 'giver'/.test(page) && /dropFact\('quest', \$\{i\}, true\)">Drop</.test(page) && /saveFactText\(\$\{i\}\)">Save</.test(page));
  assert('P-8: each loot fact has change and holder dropdowns and Drop', /setFact\('loot', \$\{i\}, 'change'/.test(page) && /setFact\('loot', \$\{i\}, 'holder'/.test(page) && /dropFact\('loot', \$\{i\}, true\)">Drop</.test(page));
  assert('P-8: a second start is flagged in review, and dropped facts are listed as not written',
    /already records its start; publish will not add a second/.test(page) && /list\('Facts you dropped', droppedFacts\)/.test(page));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
