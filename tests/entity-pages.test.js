/**
 * tests/entity-pages.test.js — entity pages, judgment events, header (issue #105)
 *
 * Tests shared/chronicle-pages.js and the publish support it relies on
 * (MOD _set in shared/chronicle-publish.js):
 *   E-1  touchedPages: one page per entity or event the session touched,
 *        with its passages and current text; PCs only with a passage
 *   E-2  the draft prompt: pages, testimony kept attributed, 0 HP is not death
 *   E-3  parseDraft / validateDraft: bad fields, ids and vocabularies are
 *        dropped with a reason, not failing the draft
 *   E-4  text changes as _set items, through the real applySession: one
 *        field changes, nothing else
 *   E-5  judgment events as items, through applySession: moment,
 *        relationship, death, allegiance (with its passage), holder
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The DM approves every text change and judgment event the AI proposes.
 * These tests pin the rules that keep a proposal honest (a death must be
 * stated, never read from 0 HP; an NPC's words stay testimony) and that an
 * approval writes exactly the field it names.
 *
 * No test calls the AI or loads the page.
 *
 * RUN
 * ---
 * node tests/entity-pages.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ChronicleIds     = require('../shared/chronicle-ids.js');
const ChroniclePublish = require('../shared/chronicle-publish.js');
const P                = require('../shared/chronicle-pages.js');

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

const campaign = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'magers-campaign.json'), 'utf8'));
const C = ChronicleIds.buildLegacyIndex(campaign);
const RUFUS = C.get('npc_014'), BELFAR = C.get('loc_006'), AMBUSH = C.get('cbt_005'), GOLI = C.get('pc_005'), DEL = C.get('pc_004');
const MAP = campaign.inventory_and_loot.find(i => /map/i.test(i.name)).id;
const NEW_LORE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const nameOf = id => (campaign.npc_directory.concat(campaign.locations, campaign.combat_encounters, campaign.party, campaign.inventory_and_loot).find(e => e.id === id) || {}).name || (id === NEW_LORE ? 'The Dragon Pact' : id);
const refs = [
  { occ: 'occ_1_1', entityId: RUFUS }, { occ: 'occ_1_2', entityId: BELFAR }, { occ: 'occ_1_3', entityId: GOLI },
  { occ: 'occ_1_4', entityId: 'roster:' + AMBUSH + ':Goblins' }, { occ: 'occ_1_5', entityId: NEW_LORE },
];
const passages = [
  { text: 'Rufus said he had not slept since the dragons came.', speaker: 'occ_1_1', targetId: RUFUS, speakerLabel: 'Rufus' },
  { text: 'Belfar is a walled market town on the river.', speaker: 'dm', targetId: BELFAR, speakerLabel: 'DM' },
  { text: 'The goblins fled when the dragons came.', speaker: 'dm', targetId: AMBUSH, speakerLabel: 'DM' },
  { text: 'Rufus claimed the dragons keep a pact with the ridge goblins.', speaker: 'occ_1_1', targetId: NEW_LORE, speakerLabel: 'Rufus' },
];
const made = new Map([[NEW_LORE, { id: NEW_LORE, name: 'The Dragon Pact', array: 'world_lore' }]]);
const pages = P.touchedPages({ campaign, refs, passages, combats: [AMBUSH], newEntities: made, nameOf });
const page = id => pages.find(p => p.id === id);

// ── E-1 ─────────────────────────────────────────────────────────────────────
console.log('\nTest E-1 — touched pages');
{
  assert('E-1: Rufus, Belfar, the ambush and the new lore each get a page', [RUFUS, BELFAR, AMBUSH, NEW_LORE].every(id => page(id)));
  assert('E-1: a roster group\'s occurrence counts as its combat (no page for the group)', !pages.some(p => /^roster:/.test(p.id)));
  assert('E-1: a PC with no passage gets no page', !page(GOLI));
  assert('E-1: each page holds its own passages', page(RUFUS).passages.length === 1 && page(AMBUSH).passages[0].text.startsWith('The goblins fled'));
  assert('E-1: current text is the recorded text of each text field', page(BELFAR).text.description === campaign.locations.find(l => l.id === BELFAR).narrative.description && 'significance' in page(BELFAR).text);
  assert('E-1: a new entity starts with empty text', page(NEW_LORE).isNew && page(NEW_LORE).text.content === '');
  assert('E-1: generated fields (flavor_text) are never offered', !('flavor_text' in page(RUFUS).text));
  const withPc = P.touchedPages({ campaign, refs, passages: passages.concat({ text: 'Goli laughed.', speaker: 'dm', targetId: GOLI }), combats: [], newEntities: made, nameOf });
  assert('E-1: a PC gets a page when a passage is about them, with no text fields', withPc.find(p => p.id === GOLI) && Object.keys(withPc.find(p => p.id === GOLI).text).length === 0);
}

// ── E-2 ─────────────────────────────────────────────────────────────────────
console.log('\nTest E-2 — the draft prompt');
{
  const p = P.draftPrompt({ sessionLabel: 'session_008', pages, facts: 'Goblin Ambush round 4: Del: A: Attack — hit 7', sessionPassages: [], header: { title: 'The Larkspur Dragons', summary: null }, names: '' });
  assert('E-2: lists each page with its current text and passages', p.includes(`${RUFUS} | npc_directory | Rufus`) && p.includes('[Rufus] Rufus said he had not slept'));
  assert('E-2: NPC words stay attributed as testimony', /Words an NPC said are testimony: keep them attributed/.test(p));
  assert('E-2: 0 HP or downed is never death', /"downed" is NOT dead/.test(p));
  assert('E-2: holders only when stated; allegiance when stated or implied by role', /only when the notes state it/.test(p) && /plainly implied by a change of role/.test(p));
  assert('E-2: the recorded header is shown so it is kept', p.includes('title "The Larkspur Dragons"'));
}

// ── E-3 ─────────────────────────────────────────────────────────────────────
console.log('\nTest E-3 — parse and validate the draft');
{
  const reply = '```json\n' + JSON.stringify({
    changes: [
      { id: BELFAR, field: 'description', text: 'A walled market town on the river; its gates shut at dusk.', reason: 'gates' },
      { id: BELFAR, field: 'flavor_text', text: 'x' },                       // not a text field
      { id: 'nobody', field: 'description', text: 'x' },                     // no page
      { id: RUFUS, field: 'personality', text: page(RUFUS).text.personality }, // unchanged → skipped silently
    ],
    judgments: [
      { kind: 'moment', type: 'comedy', character_ids: [GOLI], description: 'Goli asked about the pact.', source: 'Goli asks about the pact' },
      { kind: 'moment', type: 'heroics', character_ids: [GOLI], description: 'x' },
      { kind: 'death', id: DEL, cause: 'downed by goblins', source: 'Hit Asp (Down)' },
      { kind: 'death', id: RUFUS, cause: 'killed by the dragon', source: 'Rufus killed' },
      { kind: 'relationship', from_id: RUFUS, to_id: GOLI, relationship_type: 'social_contact', note: 'guide' },
      { kind: 'relationship', from_id: RUFUS, to_id: GOLI, relationship_type: 'uncle' },
      { kind: 'allegiance', id: RUFUS, disposition: 'friendly', note: 'Rufus agreed to guide the party.' },
      { kind: 'holder', id: MAP, holder_id: 'party' },
      { kind: 'holder', id: MAP, holder_id: 'stranger' },
      { kind: 'teleport' },
    ],
    header: { title: 'Gates of Belfar', summary: 'The party reaches Belfar.' },
  }) + '\n```';
  const d = P.parseDraft(reply);
  assert('E-3: a fenced reply parses, header included', d.changes.length === 4 && d.header.title === 'Gates of Belfar');
  const known = new Set([RUFUS, BELFAR, AMBUSH, NEW_LORE, GOLI, DEL, MAP]);
  const v = P.validateDraft(d, pages, { knownIds: known });
  assert('E-3: one usable text change, with the recorded text as "before"', v.changes.length === 1 && v.changes[0].before === page(BELFAR).text.description);
  assert('E-3: a change to a non-text field or a missing page is dropped with a reason', v.dropped.some(t => /flavor_text/.test(t)) && v.dropped.some(t => /no page/.test(t)));
  assert('E-3: a death resting only on "downed" is refused; a stated killing is kept',
    v.dropped.some(t => /never death/.test(t)) && v.judgments.some(j => j.kind === 'death' && j.id === RUFUS) && !v.judgments.some(j => j.kind === 'death' && j.id === DEL));
  assert('E-3: unknown moment type, relationship type, holder and kind are dropped',
    v.dropped.some(t => /heroics/.test(t)) && v.dropped.some(t => /"uncle"/.test(t)) && v.dropped.some(t => /holder the session/.test(t)) && v.dropped.some(t => /teleport/.test(t)));
  assert('E-3: valid moment, relationship, allegiance and party holder are kept', ['moment', 'relationship', 'allegiance', 'holder'].every(k => v.judgments.some(j => j.kind === k)));
  // The first real run sent moments with the type under another name and
  // all six were dropped: common variants are accepted, and a drop names
  // the fields that were sent.
  const variants = P.validateDraft({ changes: [], header: {}, judgments: [
    { kind: 'moment', moment_type: 'clutch_save', characters: GOLI, text: 'Goli dragged Del clear.' },
    { kind: 'relationship', from: RUFUS, to: GOLI, relationship_type: 'social_contact' },
    { kind: 'moment', flavour: 'x', character_ids: [GOLI], description: 'y' },
  ] }, pages, { knownIds: known });
  assert('E-3: moment_type / characters / text and from / to are accepted',
    variants.judgments.length === 2 && variants.judgments[0].type === 'clutch_save' && variants.judgments[0].character_ids[0] === GOLI && variants.judgments[1].from_id === RUFUS);
  assert('E-3: a dropped judgment names the fields it was sent with', variants.dropped.some(t => /sent: kind, flavour, character_ids, description/.test(t)));
  let threw = false; try { P.parseDraft('no json'); } catch (e) { threw = true; }
  assert('E-3: a reply with no JSON throws', threw);
}

// ── E-4 ─────────────────────────────────────────────────────────────────────
console.log('\nTest E-4 — accepted text changes through applySession');
{
  const items = P.textItems(pages, [{ id: BELFAR, field: 'description', text: 'A walled market town on the river; its gates shut at dusk.' }]);
  assert('E-4: one MOD item with _set narrative.description', items.length === 1 && items[0].rawData._set['narrative.description'].includes('gates shut'));
  const out = ChroniclePublish.applySession(campaign, items).campaign;
  const before = campaign.locations.find(l => l.id === BELFAR), after = out.locations.find(l => l.id === BELFAR);
  assert('E-4: the description changes', after.narrative.description.includes('gates shut at dusk'));
  assert('E-4: …and nothing else on the entity', JSON.stringify(Object.assign({}, after.narrative, { description: null })) === JSON.stringify(Object.assign({}, before.narrative, { description: null })) &&
    JSON.stringify(after.mechanics.visibility) === JSON.stringify(before.mechanics.visibility) && after.name === before.name);
}

// ── E-5 ─────────────────────────────────────────────────────────────────────
console.log('\nTest E-5 — approved judgment events through applySession');
{
  const arrayOf = id => ['npc_directory', 'locations', 'combat_encounters', 'party', 'inventory_and_loot'].find(a => campaign[a].some(e => e.id === id)) || null;
  let n = 0;
  const items = P.judgmentItems([
    { kind: 'moment', type: 'comedy', character_ids: [GOLI], description: 'Goli asked about the pact.', source: 'Goli asks about the pact', combat: null },
    { kind: 'relationship', from_id: RUFUS, to_id: GOLI, relationship_type: 'social_contact', note: 'agreed to guide' },
    { kind: 'death', id: RUFUS, cause: 'killed by the dragon', combat: AMBUSH },
    { kind: 'allegiance', id: C.get('npc_011'), disposition: 'friendly', note: 'Darnell agreed to help.' },
    { kind: 'holder', id: MAP, holder_id: 'party' },
  ], { sessionRef: 'session_006', arrayOf, newId: () => 'bbbbbbbb-bbbb-4bbb-8bbb-' + String(++n).padStart(12, '0') });
  const out = ChroniclePublish.applySession(campaign, items).campaign;
  const moment = out.character_moments.find(m => m.narrative.description === 'Goli asked about the pact.');
  assert('E-5: the moment is a new character_moments entry for the session', moment && moment.type === 'comedy' && moment.mechanics.origin_session === C.get('session_006') && moment.mechanics.character_ids[0] === GOLI);
  const rel = out.entity_relationships.find(r => r.from_id === RUFUS && r.to_id === GOLI);
  assert('E-5: the relationship is a significant event of an allowed type', rel && rel.relationship_type === 'social_contact' && rel.significance === 'significant_event');
  const rufus = out.npc_directory.find(x => x.id === RUFUS);
  assert('E-5: the death sets status_event and disposition deceased, and nothing else', rufus.mechanics.status_event.type === 'death' && rufus.mechanics.disposition === 'deceased' &&
    rufus.mechanics.species === campaign.npc_directory.find(x => x.id === RUFUS).mechanics.species);
  const darnell = out.npc_directory.find(x => x.id === C.get('npc_011'));
  assert('E-5: the allegiance sets disposition and adds its passage on the NPC', darnell.mechanics.disposition === 'friendly' && (darnell.passages || []).some(p => p.text === 'Darnell agreed to help.'));
  assert('E-5: the holder is set to the party', out.inventory_and_loot.find(i => i.id === MAP).mechanics.current_holder === 'party');
  assert('E-5: the campaign passed in is not modified', !campaign.character_moments.some(m => m.narrative.description === 'Goli asked about the pact.'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
