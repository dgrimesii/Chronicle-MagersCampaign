/**
 * tests/entity-identification.test.js — session page step 3 (issue #100)
 *
 * Tests shared/chronicle-entities.js, which turns the AI's per-page mention
 * lists into the review rows the DM settles, and the publish support it
 * relies on in shared/chronicle-publish.js (_alias_append, _note_append,
 * _roster_group_append).
 *   I-1   the entity index: names, PC nicknames, aliases, open combats, roster groups
 *   I-2   rows: occurrences grouped by words, exact / inexact / new, order
 *   I-3   the DM's actions and Bulk acknowledge
 *   I-4   a Link updates every occurrence (the phase 3 gate) and saves the alias
 *   I-5   flags: acting twice in a round, two places at once, ally and enemy
 *   I-6   publish items through the real applySession
 *   I-7   the AI prompt and the reply check
 *   I-8   linking rows to an entity another row creates
 *   I-9   correcting a row's kind (#114): matched again, merged, refused
 *         when settled; a corrected creature is created in the bestiary
 *   I-10  "Not an entity" (#113): no publish item, no flag; downstream a
 *         target keeps its words, an actor is held, a passage about it goes
 *         on the session; Change undoes it
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Step 3 is where every name in the notes is settled once, so that a
 * misreading cannot spread. These tests pin down the rules the design sets:
 * only an exact name or alias may be bulk-acknowledged, the AI's guess never
 * decides that, every action covers all of a row's occurrences, and a Link
 * saves the words as an alias so the next session matches them exactly.
 *
 * The AI reply used here is written by hand, modelled on two real pages of
 * session 6 notes (Goblin Ambush rounds 4–7 and the Larkspur dragons). No
 * test calls the AI or loads the page in a browser.
 *
 * RUN
 * ---
 * node tests/entity-identification.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ChronicleIds      = require('../shared/chronicle-ids.js');
const ChroniclePublish  = require('../shared/chronicle-publish.js');
const E                 = require('../shared/chronicle-entities.js');

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
const throws = fn => { try { fn(); return false; } catch (e) { return true; } };

// The real campaign: it has the party, the paused Goblin Ambush and its
// roster groups, which the fixture does not. Nothing is written back.
const campaign = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'magers-campaign.json'), 'utf8'));
const C = ChronicleIds.buildLegacyIndex(campaign);
const ID = {
  del: C.get('pc_004'), mal: C.get('pc_002'), gold: C.get('pc_001'), ash: C.get('pc_003'),
  ambush: C.get('cbt_005'), goblins: C.get('mon_004'), belfar: C.get('loc_006'),
};
const ROSTER = name => 'roster:' + ID.ambush + ':' + name;

// A hand-written reply in the shape mentionPrompt asks for, two pages.
// Fresh copies each time, because rows hold the occurrences by reference.
function samplePages() {
  const m = (kind, as_written, extra) => Object.assign({ kind, as_written, context: '', round: null, turn_round: null,
    combat_ref: ID.ambush, scene: 1, location: null, allegiance: null, candidate_id: null, candidate_reason: '' }, extra);
  return [
    { page: 1, mentions: [
      m('pc', 'Asp',  { round: 4, turn_round: 4, context: 'Asp - Healing Hands', candidate_id: ID.del, candidate_reason: 'short for Asphodel' }),
      m('pc', 'Mal',  { round: 4, turn_round: 4, context: 'Mal - Hit (Dead)' }),
      m('pc', 'Gold', { round: 4, turn_round: 4, context: 'Gold - TS Crit (9)', candidate_id: ID.gold }),
      m('creature', 'Goblins', { round: 4, turn_round: 4, context: 'Goblins - Hit Mal (opportunity)', allegiance: 'enemy' }),
      m('pc', 'Mal',  { round: 4, context: 'Goblins - Hit Mal (opportunity)' }),
      m('creature', 'Slinger', { round: 4, turn_round: 4, context: 'Slinger - Attack dragon 1 hit', candidate_id: ROSTER('Goblin Slingers'), candidate_reason: 'slinger group in the ambush' }),
      m('creature', 'Larkspur dragons', { context: 'Larkspur dragons descend on cart from ridges.' }),
      m('pc', 'Asp',  { round: 5, turn_round: 5, context: 'Asp - Hit (7) Dead, Hit (5)', candidate_id: ID.del }),
    ] },
    { page: 2, mentions: [
      m('pc', 'Asp',  { round: 6, turn_round: 6, context: 'Asp - Death ✓', candidate_id: ID.del }),
      m('pc', 'Mail', { round: 6, turn_round: 6, context: 'Mail - Sword Hit (13) dragon', candidate_id: ID.mal, candidate_reason: 'likely Mal misspelt' }),
      m('pc', 'Ashton', { round: 6, context: '#1 Beak hit Ashton (5) Con. Save ✓' }),
      m('creature', 'Larkspur dragons', { round: 6, context: 'Dragons' }),
    ] },
  ];
}
const index = E.buildIndex(campaign);
const rowsFor = () => E.buildRows(samplePages(), index);
const row = (rows, words) => rows.find(r => r.asWritten === words);

// ── I-1 ─────────────────────────────────────────────────────────────────────
console.log('\nTest I-1 — the entity index');
{
  assert('I-1: a PC is found by full name and by nickname', index.byName.get('asphodel')?.[0]?.id === ID.del && index.byName.get('del')?.[0]?.id === ID.del);
  assert('I-1: the paused Goblin Ambush is marked open', index.entities.get(ID.ambush)?.open === true);
  assert('I-1: a finished combat is not open', index.entities.get(C.get('cbt_002'))?.open === false);
  const slingers = index.entities.get(ROSTER('Goblin Slingers'));
  assert('I-1: the ambush\'s roster groups are listed, with combat, creature and role',
    slingers && slingers.array === 'enemies_roster' && slingers.combatId === ID.ambush && slingers.monRef === ID.goblins && slingers.role === 'slinger');
  const list = E.entityListForPrompt(index);
  assert('I-1: the prompt list marks the open combat and names each roster group\'s combat',
    list.includes('Goblin Ambush [OPEN COMBAT]') && /Goblin Slingers \(enemy group in Goblin Ambush, role slinger\)/.test(list));
  // Aliases count as exact names once recorded.
  const withAlias = JSON.parse(JSON.stringify(campaign));
  withAlias.locations.find(l => l.id === ID.belfar).aliases = ['Bel'];
  assert('I-1: a recorded alias is an exact name', E.buildIndex(withAlias).byName.get('bel')?.[0]?.id === ID.belfar);
}

// ── I-2 ─────────────────────────────────────────────────────────────────────
console.log('\nTest I-2 — occurrences grouped into rows, matched and ordered');
{
  const rows = rowsFor();
  assert('I-2: one row per kind and words (Asp ×3 is one row)', row(rows, 'Asp').occurrences.length === 3 && rows.filter(r => r.asWritten === 'Asp').length === 1);
  assert('I-2: each occurrence keeps its page, words, context and its own id',
    row(rows, 'Asp').occurrences.map(o => o.id).join() === 'occ_1_1,occ_1_8,occ_2_1' && row(rows, 'Asp').occurrences[2].context === 'Asp - Death ✓');
  assert('I-2: "Mal" (a recorded nickname) is an exact match', row(rows, 'Mal').matchType === 'exact' && row(rows, 'Mal').matchId === ID.mal);
  assert('I-2: "Ashton" (the full name) is an exact match', row(rows, 'Ashton').matchType === 'exact');
  assert('I-2: "Asp" is inexact, using the AI\'s candidate', row(rows, 'Asp').matchType === 'inexact' && row(rows, 'Asp').matchId === ID.del);
  assert('I-2: "Mail" is inexact → Malachite, not exact', row(rows, 'Mail').matchType === 'inexact' && row(rows, 'Mail').matchId === ID.mal);
  assert('I-2: "Goblins" is an exact match to the ambush\'s roster group, not the bestiary entry',
    row(rows, 'Goblins').matchType === 'exact' && row(rows, 'Goblins').matchId === ROSTER('Goblins'));
  assert('I-2: "Slinger" is inexact → the Goblin Slingers group', row(rows, 'Slinger').matchType === 'inexact' && row(rows, 'Slinger').matchId === ROSTER('Goblin Slingers'));
  assert('I-2: "Larkspur dragons" is new', row(rows, 'Larkspur dragons').matchType === 'new');
  const order = rows.map(r => r.matchType);
  assert('I-2: new rows first, then inexact, exact last', order.join() === [...order].sort((a, b) => ['new', 'inexact', 'exact'].indexOf(a) - ['new', 'inexact', 'exact'].indexOf(b)).join() && order[0] === 'new' && order[order.length - 1] === 'exact');
  // A candidate the AI made up, or one of the wrong kind, is ignored.
  const fake = E.buildRows([{ page: 1, mentions: [{ kind: 'place', as_written: 'Zzz', candidate_id: 'not-an-id' }, { kind: 'place', as_written: 'Yyy', candidate_id: ID.del }] }], index);
  assert('I-2: an invented or wrong-kind candidate makes the row new', fake.every(r => r.matchType === 'new'));
  // Exactness is decided by the words, never by the AI's candidate.
  const lying = E.buildRows([{ page: 1, mentions: [{ kind: 'pc', as_written: 'Mal', candidate_id: ID.del }] }], index);
  assert('I-2: an exact name stays exact even if the AI proposes someone else', lying[0].matchType === 'exact' && lying[0].matchId === ID.mal);
}

// ── I-3 ─────────────────────────────────────────────────────────────────────
console.log('\nTest I-3 — actions and Bulk acknowledge');
{
  const rows = rowsFor();
  const n = E.bulkAcknowledgeExact(rows);
  assert('I-3: Bulk acknowledge settles only the exact rows', n === rows.filter(r => r.matchType === 'exact').length &&
    rows.every(r => (r.matchType === 'exact') === (r.status === 'settled')));
  assert('I-3: not all settled yet', !E.allSettled(rows));
  E.acknowledge(row(rows, 'Asp'));
  assert('I-3: acknowledging an inexact match saves the words as an alias', row(rows, 'Asp').resolution.alias === 'Asp');
  E.acknowledge(row(rows, 'Larkspur dragons'), 'Larkspur Dragon');
  const lark = row(rows, 'Larkspur dragons').resolution;
  assert('I-3: acknowledging a new row makes a bestiary entity with a UUID and the given name',
    lark.action === 'new' && lark.array === 'bestiary' && ChronicleIds.isOpaqueId(lark.entityId) && lark.name === 'Larkspur Dragon');
  const pcNew = E.buildRows([{ page: 1, mentions: [{ kind: 'pc', as_written: 'Zed' }] }], index)[0];
  assert('I-3: a PC with no match cannot be acknowledged as new', throws(() => E.acknowledge(pcNew)) && pcNew.status === 'pending');
  E.linkToExisting(row(rows, 'Mail'), ID.mal, index);
  E.acknowledge(row(rows, 'Slinger'));
  E.acknowledge(row(rows, 'Gold'));
  assert('I-3: every row settled', E.allSettled(rows));
  E.reopen(row(rows, 'Mail'));
  assert('I-3: reopen puts a row back to pending', row(rows, 'Mail').status === 'pending' && !E.allSettled(rows));

  // Separate, split and sub-type.
  const r2 = rowsFor();
  assert('I-3: Separate needs a matched row', throws(() => E.separateAsNew(row(r2, 'Larkspur dragons'), 'X')));
  const gob = E.buildRows([{ page: 1, mentions: [{ kind: 'creature', as_written: 'Gob boss', candidate_id: ID.goblins }] }], index)[0];
  E.separateAsNew(gob, 'Goblin Boss');
  assert('I-3: Separate creates a new entity noted against the look-alike', gob.resolution.action === 'separate' && gob.resolution.notConfusedWith === ID.goblins);
  assert('I-3: a split needs two parts', throws(() => E.split(row(r2, 'Larkspur dragons'), [{ name: 'A' }], index)));
  E.split(row(r2, 'Larkspur dragons'), [{ name: 'Larkspur Dragon #1' }, { name: 'Larkspur Dragon #2' }], index);
  assert('I-3: a split names the new entities', row(r2, 'Larkspur dragons').resolution.parts.map(p => p.name).join() === 'Larkspur Dragon #1,Larkspur Dragon #2');
  assert('I-3: a sub-type needs a real combat and a bestiary creature',
    throws(() => E.markSubType(row(r2, 'Goblins'), { combatId: ID.goblins, creatureId: ID.goblins, label: 'x', role: 'y' }, index)));
  E.markSubType(row(r2, 'Goblins'), { combatId: ID.ambush, creatureId: ID.goblins, label: 'Goblin Archers', role: 'archer' }, index);
  assert('I-3: a sub-type records the combat, creature, label and role', row(r2, 'Goblins').resolution.label === 'Goblin Archers');
}

// ── I-4 ─────────────────────────────────────────────────────────────────────
console.log('\nTest I-4 — a Link updates every occurrence and saves the alias (gate)');
{
  const rows = rowsFor();
  const asp = row(rows, 'Asp');
  E.linkToExisting(asp, ID.del, index);
  const resolved = E.resolveOccurrences(rows, index);
  assert('I-4: all three "Asp" occurrences now point at Asphodel', asp.occurrences.every(o => resolved.get(o.id).entityId === ID.del));
  assert('I-4: the Link saves "Asp" as an alias', asp.resolution.alias === 'Asp');
  // Relinking moves them all at once.
  E.linkToExisting(asp, ID.ash, index);
  const again = E.resolveOccurrences(rows, index);
  assert('I-4: relinking moves every occurrence together', asp.occurrences.every(o => again.get(o.id).entityId === ID.ash));
  E.linkToExisting(row(rows, 'Mal'), ID.mal, index);
  assert('I-4: linking words that are already a name saves no alias', row(rows, 'Mal').resolution.alias === null);
  assert('I-4: an unsettled row\'s occurrences are pending', again.get(row(rows, 'Mail').occurrences[0].id).pending === true);
  E.acknowledge(row(rows, 'Goblins'));
  const g = E.resolveOccurrences(rows, index).get(row(rows, 'Goblins').occurrences[0].id);
  assert('I-4: a roster-group match resolves to the combat and group, and the creature',
    g.roster?.combatId === ID.ambush && g.roster?.label === 'Goblins' && g.entityId === ID.goblins);
  E.split(row(rows, 'Larkspur dragons'), [{ name: 'A' }, { name: 'B' }], index);
  const s = E.resolveOccurrences(rows, index).get(row(rows, 'Larkspur dragons').occurrences[0].id);
  assert('I-4: a split leaves each occurrence needing assignment between the parts', Array.isArray(s.needsAssignment) && s.needsAssignment.length === 2);
}

// ── I-5 ─────────────────────────────────────────────────────────────────────
console.log('\nTest I-5 — flags for one entity that is really two');
{
  const m = (as_written, extra) => Object.assign({ kind: 'npc', as_written, scene: 1 }, extra);
  const pages = [{ page: 1, mentions: [
    m('Hank', { turn_round: 2, combat_ref: 'brawl', location: 'the inn', allegiance: 'ally' }),
    m('Hank', { turn_round: 2, combat_ref: 'brawl', location: 'the docks', allegiance: 'enemy' }),
    m('Hank', { turn_round: 3, combat_ref: 'brawl', scene: 2, location: 'the docks' }),
  ] }];
  const rows = E.buildRows(pages, index);
  E.acknowledge(rows[0]);
  const f = E.flags(rows, index);
  assert('I-5: acting twice in round 2 is flagged', f.some(x => x.type === 'acts-twice' && /round 2/.test(x.detail)));
  assert('I-5: two places in one scene is flagged', f.some(x => x.type === 'two-places'));
  assert('I-5: ally and enemy in one scene is flagged', f.some(x => x.type === 'allegiance'));
  assert('I-5: round 3 in another scene is not flagged', !f.some(x => /round 3/.test(x.detail)));
  E.split(rows[0], [{ name: 'Hank the innkeeper' }, { name: 'Hank the smuggler' }], index);
  assert('I-5: splitting the row clears its flags', E.flags(rows, index).length === 0);
  // A group (roster or bestiary) acting several times in a round is normal.
  const grp = E.buildRows([{ page: 1, mentions: [
    { kind: 'creature', as_written: 'Goblins', turn_round: 4, combat_ref: 'x' },
    { kind: 'creature', as_written: 'Goblins', turn_round: 4, combat_ref: 'x' }] }], index);
  assert('I-5: a group taking several turns in a round is not flagged', !E.flags(grp, index).some(x => x.type === 'acts-twice'));
}

// ── I-6 ─────────────────────────────────────────────────────────────────────
console.log('\nTest I-6 — the answers as publish items, through applySession');
{
  const rows = rowsFor();
  E.bulkAcknowledgeExact(rows);
  E.linkToExisting(row(rows, 'Asp'), ID.del, index);
  E.linkToExisting(row(rows, 'Mail'), ID.mal, index);
  E.acknowledge(row(rows, 'Gold'));
  E.acknowledge(row(rows, 'Slinger'));
  E.acknowledge(row(rows, 'Larkspur dragons'), 'Larkspur Dragon');
  const extra = E.buildRows([{ page: 2, mentions: [
    { kind: 'creature', as_written: 'Gob boss', candidate_id: ID.goblins },
    { kind: 'creature', as_written: 'Archers', candidate_id: ID.goblins }] }], index);
  E.separateAsNew(extra.find(r => r.asWritten === 'Gob boss'), 'Goblin Boss');
  E.markSubType(extra.find(r => r.asWritten === 'Archers'), { combatId: ID.ambush, creatureId: ID.goblins, label: 'Goblin Archers', role: 'archer' }, index);
  const items = E.toQueueItems(rows.concat(extra), index, 'session_006');

  assert('I-6: no item for an exact acknowledgement (Mal, Ashton)', !items.some(i => i.rawData?._alias_append?.some(a => a === 'Mal' || a === 'Ashton')));
  assert('I-6: no alias item for a roster group (Slinger)', !items.some(i => String(i.targetId).startsWith('roster:')));
  const { campaign: out, notes } = ChroniclePublish.applySession(campaign, items);
  const get = id => out.party.concat(out.bestiary, out.combat_encounters).find(e => e.id === id);
  assert('I-6: Asphodel gains the alias "Asp"', JSON.stringify(get(ID.del).aliases) === '["Asp"]');
  assert('I-6: Malachite gains "Mail"; Zragar gains "Gold"', get(ID.mal).aliases.includes('Mail') && get(ID.gold).aliases.includes('Gold'));
  const lark = out.bestiary.find(b => b.name === 'Larkspur Dragon');
  assert('I-6: the Larkspur Dragon is added to the bestiary with a UUID, its words kept as an alias',
    lark && ChronicleIds.isOpaqueId(lark.id) && lark._object_type === 'monster' && JSON.stringify(lark.aliases) === '["Larkspur dragons"]');
  assert('I-6: Goblin Boss is added and Goblins gets a "not to be confused with" note',
    out.bestiary.some(b => b.name === 'Goblin Boss') && /Not to be confused with Goblin Boss, first noted in session_006\./.test(get(ID.goblins).notes || ''));
  const roster = get(ID.ambush).mechanics.enemies_roster;
  assert('I-6: the ambush gains a Goblin Archers group (role archer, pointing at Goblins)',
    roster.some(g => g.actor_id === 'Goblin Archers' && g.role === 'archer' && g.mon_ref === ID.goblins));
  assert('I-6: the campaign passed in is not modified', !campaign.party.find(p => p.id === ID.del).aliases);

  // Publishing the same items again adds nothing twice.
  const twice = ChroniclePublish.applySession(out, items.filter(i => i.type === 'MOD'));
  const t = id => twice.campaign.party.concat(twice.campaign.bestiary, twice.campaign.combat_encounters).find(e => e.id === id);
  assert('I-6: a repeat publish adds no duplicate alias, note or group',
    t(ID.del).aliases.length === 1 && (t(ID.goblins).notes.match(/Goblin Boss/g) || []).length === 1 &&
    t(ID.ambush).mechanics.enemies_roster.filter(g => g.actor_id === 'Goblin Archers').length === 1 &&
    twice.notes.some(n => /already has a roster group "Goblin Archers"/.test(n)));
  // An alias equal to the name or a nickname is not added.
  const same = ChroniclePublish.applySession(campaign, [{ type: 'MOD', array: 'party', targetId: ID.del, status: 'approved', rawData: { id: ID.del, _alias_append: ['del', 'ASPHODEL', 'Asp'] } }]);
  assert('I-6: aliases equal to the name or nickname are skipped', JSON.stringify(same.campaign.party.find(p => p.id === ID.del).aliases) === '["Asp"]');
  // notes is text or null today; if an entity ever holds structured notes,
  // a note must not be forced in over them. Made up on a copy.
  const structured = JSON.parse(JSON.stringify(campaign));
  const npcObj = structured.npc_directory[0];
  npcObj.notes = { kept: true };
  const obj = ChroniclePublish.applySession(structured, [{ type: 'MOD', array: 'npc_directory', targetId: npcObj.id, status: 'approved', rawData: { id: npcObj.id, _note_append: 'x' } }]);
  assert('I-6: a note is not written over structured notes, and publish says so',
    JSON.stringify(obj.campaign.npc_directory.find(n => n.id === npcObj.id).notes) === JSON.stringify(npcObj.notes) && obj.notes.some(n => /notes is not text/.test(n)));
  assert('I-6: no publish note about missing entities', !notes.some(n => /no such entity/.test(n)));
}

// ── I-7 ─────────────────────────────────────────────────────────────────────
console.log('\nTest I-7 — the AI prompt and the reply check');
{
  const p = E.mentionPrompt({ entityList: E.entityListForPrompt(index), pageLabel: 'page 2 of 2' });
  assert('I-7: the prompt names the page and lists the entities by id', p.includes('PAGE: page 2 of 2') && p.includes(ID.del + ' | party | Asphodel (also: Del)'));
  assert('I-7: the prompt asks for the words exactly as written and forbids invented ids', /exactly as they appear/.test(p) && /Never invent an id/.test(p));
  const ok = E.parseMentions('Here you go:\n```json\n{"mentions":[{"kind":"pc","as_written":"Asp"}]}\n```');
  assert('I-7: a fenced reply with words around it parses', ok.mentions.length === 1);
  assert('I-7: a bare JSON reply parses', E.parseMentions('{"mentions":[]}').mentions.length === 0);
  assert('I-7: no JSON throws', throws(() => E.parseMentions('Sorry, I cannot read this page.')));
  assert('I-7: a cut-off reply throws', throws(() => E.parseMentions('{"mentions":[{"kind":"pc","as_written":"As')));
  assert('I-7: no mentions list throws', throws(() => E.parseMentions('{"rounds":[]}')));
  assert('I-7: a mention without words throws', throws(() => E.parseMentions('{"mentions":[{"kind":"pc","as_written":""}]}')));
}

// ── I-8 ─────────────────────────────────────────────────────────────────────
// The real session 6 run gave seven spellings for one creature ("dragon" ×11,
// "Dragons", "Larkspur Drag", "#2 Dragon"…). One row creates the entity; the
// others link to it, and their words become its aliases at publish.
console.log('\nTest I-8 — linking rows to an entity another row creates');
{
  const rows = E.buildRows([{ page: 1, mentions: [
    { kind: 'creature', as_written: 'Larkspur dragons' },
    { kind: 'creature', as_written: 'dragon' },
    { kind: 'creature', as_written: 'Larkspur Drag' }] }], index);
  const [lark, drag, abbr] = ['Larkspur dragons', 'dragon', 'Larkspur Drag'].map(w => row(rows, w));
  assert('I-8: linking to an entity nobody has created yet is refused', throws(() => E.linkToExisting(drag, 'no-such-id', index, rows)));
  E.acknowledge(lark, 'Larkspur Dragon');
  const id = lark.resolution.entityId;
  assert('I-8: newEntities lists it', E.newEntities(rows).get(id)?.name === 'Larkspur Dragon');
  assert('I-8: a row cannot link to the entity it creates itself', throws(() => E.linkToExisting(lark, id, index, rows)));
  E.linkToExisting(drag, id, index, rows);
  E.linkToExisting(abbr, id, index, rows);
  assert('I-8: the other rows link to it', drag.resolution.toNew && drag.resolution.entityId === id && E.allSettled(rows));
  const resolved = E.resolveOccurrences(rows, index);
  assert('I-8: every occurrence of all three spellings points at the one new entity', rows.every(r => r.occurrences.every(o => resolved.get(o.id).entityId === id)));
  const items = E.toQueueItems(rows, index, 'session_006');
  const newItem = items.find(i => i.type === 'NEW');
  assert('I-8: one NEW item, carrying every spelling as an alias, and no MOD for it',
    items.filter(i => i.type === 'NEW').length === 1 && items.length === 1 &&
    JSON.stringify(newItem.rawData.aliases) === JSON.stringify(['Larkspur dragons', 'dragon', 'Larkspur Drag']));
  const out = ChroniclePublish.applySession(campaign, items).campaign;
  assert('I-8: published as one bestiary entry with the three aliases',
    out.bestiary.filter(b => b.name === 'Larkspur Dragon').length === 1 && out.bestiary.find(b => b.name === 'Larkspur Dragon').aliases.length === 3);
  // Words that are right here but wrong as a lasting name ("#1") can be
  // linked without saving them as an alias.
  const num = E.buildRows([{ page: 2, mentions: [{ kind: 'creature', as_written: '#1' }] }], index)[0];
  E.linkToExisting(num, id, index, rows.concat(num), { saveAlias: false });
  assert('I-8: a link with saveAlias false saves no alias', num.resolution.alias === null && num.resolution.entityId === id);
  const back = E.reopen(lark, rows);
  assert('I-8: reopening the creating row reopens the rows linked to it', back.length === 3 && rows.every(r => r.status === 'pending'));
}

console.log('\nTest I-9 — correcting a row\'s kind (#114)');
{
  // The #17 gate: "Vespon" was read as an NPC, so the only way to settle it
  // was to create an NPC, which then took a party slot.
  const index = E.buildIndex(campaign);
  const vesponSwarm = campaign.bestiary.find(b => b.legacy_id === 'mon_003').id;
  const pages = () => [{ page: 1, mentions: [
    { kind: 'npc', as_written: 'Vespon Swarm', context: 'Vespon Swarm - Nat 20, Attisus' },
    { kind: 'npc', as_written: 'Vespon', context: 'Vespon - Nat 20' },
    { kind: 'npc', as_written: 'Ogre', context: 'Ogre bursts from the trees' },
    { kind: 'creature', as_written: 'Ogre', context: 'Ogre - Hit Mal' },
    { kind: 'npc', as_written: 'Helen', context: 'Helen' },
  ] }];
  let rows = E.buildRows(pages(), index);
  const row = (w, k) => rows.find(r => r.asWritten === w && r.kind === k);
  assert('I-9: as read, "Vespon Swarm" is an NPC with no match', row('Vespon Swarm', 'npc').matchType === 'new');
  rows = E.setKind(rows, row('Vespon Swarm', 'npc'), 'creature', index);
  const vs = row('Vespon Swarm', 'creature');
  assert('I-9: corrected to a creature, it is matched again: exact, to the Vespon Swarm', vs && vs.matchType === 'exact' && vs.matchId === vesponSwarm && vs.key === 'creature|vespon swarm');
  assert('I-9: no NPC row is left for it', !row('Vespon Swarm', 'npc'));
  rows = E.setKind(rows, row('Vespon', 'npc'), 'creature', index);
  const v = row('Vespon', 'creature');
  E.acknowledge(v, 'Vespon Swarm (second)');
  assert('I-9: a corrected new creature is created in the bestiary, not the NPC directory', v.resolution.array === 'bestiary');
  const items = E.toQueueItems(rows.filter(r => r.status === 'settled'), index, 'session_008');
  assert('I-9: its publish item is a NEW bestiary entry', items.some(i => i.type === 'NEW' && i.array === 'bestiary' && i.rawData.name === 'Vespon Swarm (second)'));
  const before = rows.length;
  const ogreOccs = row('Ogre', 'npc').occurrences.length + row('Ogre', 'creature').occurrences.length;
  rows = E.setKind(rows, row('Ogre', 'npc'), 'creature', index);
  assert('I-9: the same words already held as the new kind are merged into one row', rows.length === before - 1 && !row('Ogre', 'npc') && row('Ogre', 'creature').occurrences.length === ogreOccs);
  assert('I-9: the merged occurrences keep reading order', row('Ogre', 'creature').occurrences.map(o => o.id).join() === 'occ_1_3,occ_1_4');
  E.acknowledge(row('Helen', 'npc'));
  assert('I-9: a settled row is refused until reopened', throws(() => E.setKind(rows, row('Helen', 'npc'), 'place', index)) && row('Helen', 'npc').kind === 'npc');
  E.reopen(row('Helen', 'npc'), rows);
  rows = E.setKind(rows, row('Helen', 'npc'), 'place', index);
  assert('I-9: reopened, it can be corrected', !!row('Helen', 'place') && row('Helen', 'place').status === 'pending');
  const same = rows.slice();
  assert('I-9: the same kind changes nothing', E.setKind(same, row('Helen', 'place'), 'place', index) === same);
  assert('I-9: an unknown kind is refused', throws(() => E.setKind(rows, row('Helen', 'place'), 'dragon', index)));
  // Downstream: the facts read treats the corrected creature as a group,
  // so the grid gives it an enemy row, not a party slot (the #17 failure).
  const F = require('../shared/chronicle-facts.js');
  const ref = F.pageReferences(1, rows, index).find(r => r.asWritten === 'Vespon');
  assert('I-9: the facts read sees the corrected creature as a group (an enemy row, not a party slot)', ref && ref.group === true && ref.array === 'bestiary');
  assert('I-9: every kind has a label for the list', Object.values(E.KINDS).every(k => typeof k.label === 'string' && k.label.length));
  const page = fs.readFileSync(path.join(__dirname, '..', 'admin', 'session.html'), 'utf8');
  assert('I-9: an unsettled row shows a kind dropdown that calls changeKind; a settled row shows its label',
    /onchange="changeKind\('\$\{k\}', this\.value\)">\$\{kindOptions\(r\.kind\)\}<\/select>/.test(page) && /<span class="ident-kind">\$\{escapeHtml\(kind\.label\)\}<\/span>/.test(page));
  assert('I-9: changeKind replaces the rows with setKind\'s result', /session\.rows = ChronicleEntities\.setKind\(session\.rows, rowOf\(key\), kind, session\.index\)/.test(page));
}

console.log('\nTest I-10 — "Not an entity" (#113)');
{
  // The #17 gate: Tavern, Shop, Main St., Dwarves, Gnomes and Humans could
  // only be created as entities, so publish wrote junk bestiary entries.
  const F = require('../shared/chronicle-facts.js');
  const G = require('../shared/chronicle-grid.js');
  const index = E.buildIndex(campaign);
  const page = { page: 1, mentions: [
    { kind: 'place', as_written: 'Tavern', context: 'Tavern, Shop, Main St.' },
    { kind: 'creature', as_written: 'Dwarves', context: 'Mines run by Dwarves, Gnomes, Humans' },
    { kind: 'creature', as_written: 'Dwarves', context: 'Dwarves - hit Mal' },
    { kind: 'pc', as_written: 'Mal', context: 'Mal - Hit Dwarves' },
    { kind: 'npc', as_written: 'Helen', context: 'Helen' },
  ] };
  const rows = E.buildRows([page], index);
  const row = w => rows.find(r => r.asWritten === w);
  E.dismiss(row('Tavern')); E.dismiss(row('Dwarves'));
  E.bulkAcknowledgeExact(rows);
  assert('I-10: a dismissed row is settled, with no entity', row('Tavern').status === 'settled' && row('Tavern').resolution.action === 'dismiss' && !row('Tavern').resolution.entityId);
  assert('I-10: every row settled lets step 3 continue', E.allSettled(rows));
  const items = E.toQueueItems(rows, index, 'session_008');
  assert('I-10: no publish item for a dismissed row', !items.some(i => /Tavern|Dwarves/.test(JSON.stringify(i))));
  assert('I-10: it creates no entity', ![...E.newEntities(rows).values()].some(e => /Tavern|Dwarves/.test(e.name)));
  assert('I-10: it raises no flag', !E.flags(rows, index).some(x => /Tavern|Dwarves/.test(x.name)));
  const resolved = E.resolveOccurrences(rows, index);
  assert('I-10: its occurrences resolve as dismissed', row('Dwarves').occurrences.every(o => resolved.get(o.id).dismissed === true));
  const refs = F.pageReferences(1, rows, index);
  const dw = refs.filter(r => r.asWritten === 'Dwarves');
  assert('I-10: the facts read is told the words are not an entity, never an actor', dw.length === 2 && dw.every(r => r.dismissed && !r.entityId && /never an actor/.test(r.label)));
  // A fact that still uses the words: as a target they are kept as
  // target_text; as an actor the turn is held back, not guessed.
  const occ = w => refs.find(r => r.asWritten === w).occ;
  const malOcc = refs.find(r => r.asWritten === 'Mal').occ;
  const dwarvesActor = refs.filter(r => r.asWritten === 'Dwarves')[1].occ;
  const grid = G.buildGrid({ combat: ID.ambush, rounds: [{ n: 8, pages: [1], events: [], turns: [
    { actor: malOcc, source_line: 'Mal - Hit Dwarves', activities: [{ economy: 'action', name: 'Attack', outcomes: [{ res: 'hit', val: 6, target: occ('Dwarves') }] }] },
    { actor: dwarvesActor, source_line: 'Dwarves - hit Mal', activities: [{ economy: 'action', name: 'Attack', outcomes: [{ res: 'hit', val: 3, target: malOcc }] }] }],
    enemy_turns: [] }] }, { refs, name: 'Goblin Ambush', isParty: id => campaign.party.some(p => p.id === id), nameOf: id => id });
  const out = G.toTurnSchema(grid, 'session_008');
  const malHit = out.rounds[0].slots[0].activities[0].outcomes[0];
  assert('I-10: as a target, the words are kept as target_text', malHit.target_id === null && malHit.target_text === 'Dwarves');
  assert('I-10: as an actor, the turn is held back and says why', grid.held.length === 1 && /marked not an entity/.test(grid.held[0].reason));
  // Passages.
  const merged = { passages: [
    { text: 'The tavern is loud and smoky.', speaker: 'dm', attach: { to: 'entity', occ: occ('Tavern') }, page: 1 },
    { text: 'The dwarves say the mine is cursed.', speaker: occ('Dwarves'), attach: { to: 'session' }, page: 1 },
  ] };
  const pi = F.passageItems(merged, refs, 'session_008');
  assert('I-10: a passage about dismissed words goes on the session', pi.items.length === 1 && pi.items[0].array === 'session_logs' && pi.items[0].targetId === 'session_008');
  assert('I-10: a passage spoken by dismissed words waits, saying why', pi.deferred.length === 1 && /marked not an entity/.test(pi.deferred[0].reason));
  E.reopen(row('Dwarves'), rows);
  assert('I-10: Change undoes it', row('Dwarves').status === 'pending' && !row('Dwarves').resolution);
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'session.html'), 'utf8');
  assert('I-10: every unsettled row has a "Not an entity" button that calls dismiss',
    /onclick="rowAction\('\$\{k\}','dismiss'\)"[^>]*>Not an entity</.test(html) && /if \(action === 'dismiss'\) ChronicleEntities\.dismiss\(r\)/.test(html));
  assert('I-10: a dismissed row says what it means', /case 'dismiss':\s+return 'Not an entity — no entry is made/.test(html));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
