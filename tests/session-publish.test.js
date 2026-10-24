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
  assert('P-6: the fixture file itself is unchanged', read('tests/fixtures/test-campaign.json') === fs.readFileSync(path.join(ROOT, 'tests/fixtures/test-campaign.json'), 'utf8') && !fixture.session_logs.some(s => s.legacy_id === 'session_003'));
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
