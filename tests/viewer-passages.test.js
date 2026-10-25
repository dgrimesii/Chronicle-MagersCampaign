/**
 * tests/viewer-passages.test.js — passages and aliases in the viewers (issue #107)
 *
 *   V-1  normaliseCampaignJson (both viewers) carries passages on every object
 *        that can hold them — NPC, location, session, combat, round, activity,
 *        quest progress entry, item, lore, bestiary, PC, character moment —
 *        and aliases; an object with none gets [] (never undefined)
 *   V-2  the two normalisers give identical output (the player view omits
 *        cohorts on purpose, so that key is left out of the comparison)
 *   V-3  passageListHtml (cut from the admin log viewer): newest session
 *        first, NPC testimony set apart from DM exposition, text escaped,
 *        '' for none
 *   V-4  the admin log viewer: aliases searchable, passages on the session,
 *        the combat, each round and its activities, quest steps, and linked
 *        events for places and people
 *   V-5  combat slot actors (#118, cut from the admin log viewer): a PC by
 *        nickname, any other entity by name, a roster label as written, an
 *        unknown id as "Unknown actor", never a raw UUID; the legend too
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Captured conversations are only worth having if the DM can check them
 * after publishing. These tests pin that a passage reaches the view on the
 * object it was attached to, that what an NPC said never reads as fact, and
 * that "Bel" finds Belfar.
 *
 * No test opens the page in a browser.
 *
 * RUN
 * ---
 * node tests/viewer-passages.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ChronicleIds = require('../shared/chronicle-ids.js');

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
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

// cutFunction(src, name) — one top-level function's source, by name.
function cutFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  const end = src.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(name + ' not found');
  return src.slice(start, end + 2);
}
const loadNormaliser = file => new Function(cutFunction(read(file), 'normaliseCampaignJson') + '\nreturn normaliseCampaignJson;')();
const adminNorm  = loadNormaliser('admin/log-viewer.html');
const playerNorm = loadNormaliser('player/index.html');

// The real campaign, with passages and an alias added where the session page
// would put them. Nothing is written back.
const campaign = JSON.parse(read('data/magers-campaign.json'));
const C = ChronicleIds.buildLegacyIndex(campaign);
const RUFUS = C.get('npc_014'), BELFAR = C.get('loc_006'), S6 = C.get('session_006'), S5 = C.get('session_005');
const byId = id => { let hit = null; ChronicleIds.forEachEntity(campaign, e => { if (e.id === id) hit = e; }); return hit; };
const P = (text, speaker, session) => ({ text, session_id: session || S6, speaker: speaker || 'dm', page: 1 });
byId(RUFUS).passages = [P('Rufus says he has not slept in days.', RUFUS), P('An older line about Rufus.', 'dm', S5)];
byId(BELFAR).passages = [P('Belfar is a river town of stilted houses.')];
byId(BELFAR).aliases = ['Bel'];
campaign.session_logs.find(s => s.id === S6).passages = [P('The party set out at dawn.')];
const ambush = campaign.combat_encounters.find(c => c.legacy_id === 'cbt_005');
ambush.passages = [P('The ambush opened from the treeline.')];
ambush.rounds[0].passages = [P('The Ogre burst from the trees.')];
ambush.rounds[0].slots[0].activities[0].passages = [P('The blow landed square.')];
ambush.rounds[0].enemy_turns[0].activities[0].passages = [P('The goblins loosed a ragged volley.')];
const quest = campaign.quest_ledger.find(q => q.legacy_id === 'qst_003');
quest.mechanics.progress_log[0].passages = [P('The cart rolled on toward Lake Town.')];
campaign.inventory_and_loot[0].passages = [P('The map is stained with river water.')];

const A = adminNorm(JSON.parse(JSON.stringify(campaign)));
const B = playerNorm(JSON.parse(JSON.stringify(campaign)));

// ── V-1 ─────────────────────────────────────────────────────────────────────
console.log('\nTest V-1 — the normaliser carries passages and aliases');
for (const [label, D] of [['admin', A], ['player', B]]) {
  const rufus = D.npcs.find(n => n.id === RUFUS);
  const bel = D.locations.find(l => l.id === BELFAR);
  const s6 = D.sessions.find(s => s.id === S6);
  const amb = D.combats.find(c => c.id === ambush.id);
  const q = D.quests.find(x => x.id === quest.id);
  assert(`V-1 (${label}): an NPC's passages, speaker kept`, rufus.passages.length === 2 && rufus.passages[0].speaker === RUFUS);
  assert(`V-1 (${label}): a location's passages and aliases`, bel.passages.length === 1 && bel.aliases[0] === 'Bel');
  assert(`V-1 (${label}): the session's passages, places visited and NPCs met`, s6.passages.length === 1 && Array.isArray(s6.locations_visited) && Array.isArray(s6.npcs_met));
  assert(`V-1 (${label}): the combat's and the round's passages`, amb.passages.length === 1 && amb.rounds[0].passages.length === 1);
  assert(`V-1 (${label}): an activity's passage reaches its flattened slot, naming the activity`,
    amb.rounds[0].slots[0].passages.length === 1 && amb.rounds[0].slots[0].passages[0].activity && /square/.test(amb.rounds[0].slots[0].passages[0].text));
  assert(`V-1 (${label}): an enemy activity's passage reaches its enemy row`, amb.rounds[0].enemy[0].passages.length === 1 && /volley/.test(amb.rounds[0].enemy[0].passages[0].text));
  assert(`V-1 (${label}): a quest progress entry's passages`, q.progress[0].passages.length === 1);
  assert(`V-1 (${label}): an item's passages`, D.items[0].passages.length === 1);
  const lists = [...D.npcs, ...D.locations, ...D.sessions, ...D.combats, ...D.quests, ...D.items, ...D.lore, ...D.bestiary, ...D.party, ...D.moments]
    .map(e => e.passages).concat(D.combats.flatMap(c => c.rounds.flatMap(r => [r.passages, ...r.slots.map(s => s.passages), ...r.enemy.map(e => e.passages)])), D.quests.flatMap(x => x.progress.map(p => p.passages)));
  assert(`V-1 (${label}): every passages field is a list, [] when the object has none`, lists.every(Array.isArray));
  const aliasLists = [...D.npcs, ...D.locations, ...D.combats, ...D.quests, ...D.items, ...D.lore, ...D.bestiary, ...D.party].map(e => e.aliases);
  assert(`V-1 (${label}): every aliases field is a list`, aliasLists.every(Array.isArray));
}

// ── V-2 ─────────────────────────────────────────────────────────────────────
console.log('\nTest V-2 — both normalisers give the same output');
{
  const { cohorts, ...rest } = A;
  assert('V-2: identical output apart from cohorts (admin only, on purpose)', JSON.stringify(rest) === JSON.stringify(B) && !('cohorts' in B));
}

// ── V-3 ─────────────────────────────────────────────────────────────────────
console.log('\nTest V-3 — passageListHtml');
{
  const src = read('admin/log-viewer.html');
  const DATA = A;
  const names = { [RUFUS]: 'Rufus' };
  const legacy = { [S6]: 'session_006', [S5]: 'session_005' };
  const listHtml = new Function('DATA', 'getName', 'sessionLabel',
    cutFunction(src, 'escHtml') + cutFunction(src, 'sessionRank') + cutFunction(src, 'passageListHtml') + '\nreturn passageListHtml;')(
    DATA, id => names[id] || id, id => legacy[id] || id);
  const html = listHtml(DATA.npcs.find(n => n.id === RUFUS).passages);
  assert('V-3: newest session first', html.indexOf('has not slept') < html.indexOf('An older line'));
  assert('V-3: NPC testimony is marked "Rufus said" and styled apart', /class="passage testimony"><div class="passage-meta">Rufus said · session_006/.test(html));
  assert('V-3: DM exposition is marked DM, not testimony', /class="passage"><div class="passage-meta">DM · session_005/.test(html));
  assert('V-3: text is escaped', listHtml([P('<b>bold</b> & co')]).includes('&lt;b&gt;bold&lt;/b&gt; &amp; co'));
  assert('V-3: an activity passage names its activity', /Attack|·/.test(listHtml(A.combats.find(c => c.id === ambush.id).rounds[0].slots[0].passages)));
  assert('V-3: no passages gives nothing (no "undefined")', listHtml([]) === '' && listHtml(undefined) === '');
}

// ── V-4 ─────────────────────────────────────────────────────────────────────
console.log('\nTest V-4 — the admin log viewer');
{
  const src = read('admin/log-viewer.html');
  assert('V-4: aliases are added to the search text', /if \(e\.aliases\?\.length\) e\._search \+= ' ' \+ e\.aliases\.join\(' '\)/.test(src));
  assert('V-4: the session detail shows its passages', /passageListHtml\(sess\.passages\)/.test(src));
  assert('V-4: the combat detail shows its passages', /passageListHtml\(cbt\.passages\)/.test(src));
  assert('V-4: a round shows its own and its activities\' passages', /const roundPassages = \(round\.passages \|\| \[\]\)\.concat\(actPassages\)/.test(cutFunction(src, 'renderRoundBlock')));
  assert('V-4: a quest step shows its passages', /passageListHtml\(p\.passages\)/.test(src));
  assert('V-4: other entities show passages and linked events', /passagesSection\(ent\.passages\) \+ linkedEventsSection\(ent\)/.test(cutFunction(src, 'renderDetail')));
  assert('V-4: testimony has its own style', /\.passage\.testimony\{/.test(src));
  assert('V-4: the player view renders no passages yet (#110)', !/passageListHtml/.test(read('player/index.html')));
}

// ── V-5 ─────────────────────────────────────────────────────────────────────
// #118: a slot actor who is not a PC showed as its raw UUID in the combat
// round view (#17 Run A, the Vespon Swarm in slot 7). slotActor and slotHTML
// are cut from the admin log viewer and run against stand-in data.
console.log('\nTest V-5 — combat slot actors in the admin log viewer (#118)');
{
  const src = read('admin/log-viewer.html');
  const PC = '11111111-1111-4111-8111-111111111111', NPC = '22222222-2222-4222-8222-222222222222', GONE = '26710597-b79c-488e-a34f-7925ba433dab';
  const PARTY_LOOKUP = { [PC]: { nick: 'Del', cls: 'Monk' } };
  const ENTITIES = { [PC]: { _name: 'Asphodel' }, [NPC]: { _name: 'Rufus' } };
  const uuidRe = /const UUID_RE = (\/[^\n]+\/i);/.exec(src);
  assert('V-5: the viewer defines UUID_RE', !!uuidRe);
  const make = new Function('PARTY_LOOKUP', 'ENTITIES', 'getName', 'resultClass', 'resultLabel',
    'const UUID_RE = ' + uuidRe[1] + ';\n' + cutFunction(src, 'slotActor') + '\n' + cutFunction(src, 'slotHTML') + '\nreturn { slotActor, slotHTML };');
  const { slotActor, slotHTML } = make(PARTY_LOOKUP, ENTITIES, id => ENTITIES[id]?._name || id, () => '', () => '');
  assert('V-5: a PC keeps its nickname and class', slotActor(PC).nick === 'Del' && slotActor(PC).cls === 'Monk' && slotActor(PC).linkable);
  assert('V-5: an NPC in a slot shows by name and is a link', slotActor(NPC).nick === 'Rufus' && slotActor(NPC).linkable);
  assert('V-5: a roster label shows as written and is not a link', slotActor('Vespon Swarm').nick === 'Vespon Swarm' && !slotActor('Vespon Swarm').linkable);
  assert('V-5: an id the data cannot name shows "Unknown actor", not the UUID', slotActor(GONE).nick === 'Unknown actor' && !slotActor(GONE).linkable);
  const html = slotHTML({ s: 7, a: GONE, act: 'Attack', res: 'crit', val: null, notes: null });
  assert('V-5: the slot never prints a raw UUID as its actor', />Unknown actor</.test(html) && !/>\s*26710597/.test(html) && !/selectEntity/.test(html));
  assert('V-5: an NPC slot links to the NPC', /selectEntity\('22222222-2222-4222-8222-222222222222'\)">Rufus</.test(slotHTML({ s: 3, a: NPC, act: 'Attack', res: 'hit', val: 5, notes: null })));
  const detail = cutFunction(src, 'renderCombatDetail');
  assert('V-5: the initiative legend lists the PCs and any other slot actor, named by slotActor',
    /const legendActors = Object\.keys\(PARTY_LOOKUP\)\.concat\(/.test(detail) && /legendActors\.map\(pid=>\{const pc=slotActor\(pid\)/.test(detail));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
