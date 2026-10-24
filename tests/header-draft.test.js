/**
 * tests/header-draft.test.js — the session header's own draft (issue #74)
 *
 * Tests the "Draft title and summary" helpers in shared/chronicle-pages.js
 * and what they publish through the real applySession:
 *   D-1  headerPrompt: passages (testimony attributed), combats with rounds
 *        and outcome, session ID and date, party; the length and no-new-
 *        facts rules
 *   D-2  parseHeader: both fields read; no JSON or an empty field throws
 *        (so the page keeps the fields as they were); length warnings
 *   D-3  a new session publishes the edited title and summary
 *   D-4  a placeholder keeps its recorded header unless the DM ticks
 *        replace; headerReplaceItem then sets exactly that field
 *   D-5  the page: the button, the AI call, editing without a redraw
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The draft fills fields the DM then edits, and the edited text is what
 * publishes. A placeholder session already holds the DM's own header,
 * which a draft must never overwrite unless the DM asks.
 *
 * No test calls the AI or loads the page in a browser; D-5 reads its source.
 *
 * RUN
 * ---
 * node tests/header-draft.test.js
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

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// The real campaign, for the session_006 placeholder; nothing is written back.
const campaign = JSON.parse(read('data/magers-campaign.json'));
const throws = fn => { try { fn(); return false; } catch (e) { return true; } };

// ── D-1 ─────────────────────────────────────────────────────────────────────
console.log('\nTest D-1 — the header prompt');
{
  const prompt = P.headerPrompt({
    sessionLabel: 'session_008, played 2026-04-16',
    roster: 'pc_002 = Malachite / Mal (Barbarian)',
    passages: [{ text: 'The party reached Belfar at dusk.', speakerLabel: 'DM' },
               { text: 'The dragons keep a pact with the goblins.', speakerLabel: 'Rufus' }],
    combats: [{ name: 'Goblin Ambush', rounds: 4, outcome: 'victory' }, { name: 'Bridge Fight', rounds: 1, outcome: null }],
    facts: 'Goblin Ambush round 1: Malachite: Attack (hit 9 → Goblins (killed))',
  });
  assert('D-1: names the session ID and date', prompt.includes('session_008, played 2026-04-16'));
  assert('D-1: names the party', prompt.includes('Malachite / Mal'));
  assert('D-1: lists each combat with rounds and outcome', prompt.includes('- Goblin Ambush: 4 rounds, outcome victory') && prompt.includes('- Bridge Fight: 1 round\n'));
  assert('D-1: includes the round facts', prompt.includes('Goblins (killed)'));
  assert('D-1: passages carry their speaker', prompt.includes('[DM] The party reached Belfar') && prompt.includes('[Rufus] The dragons keep a pact'));
  assert('D-1: asks for a 5–10 word title and 2–4 sentences', /5 to 10 words/.test(prompt) && /2 to 4 sentences/.test(prompt));
  assert('D-1: forbids facts the passages and combats do not contain', /Add no event, name, motive or outcome they do not contain/.test(prompt));
  assert('D-1: keeps NPC words as claims, and 0 HP is not death', /NPC's words are their claim/.test(prompt) && /0 HP or "downed" is not dead/.test(prompt));
  const empty = P.headerPrompt({ sessionLabel: 'session_008, played 2026-04-16' });
  assert('D-1: an empty session still builds a prompt', empty.includes('(none)') && empty.includes('(no combat)'));
}

// ── D-2 ─────────────────────────────────────────────────────────────────────
console.log('\nTest D-2 — reading the reply');
{
  const good = P.parseHeader('```json\n{"title":"Fire and Feathers on the Belfar Road","summary":"The party reached Belfar. Goblins ambushed them on the road."}\n```');
  assert('D-2: reads title and summary from a fenced reply',
    good.title === 'Fire and Feathers on the Belfar Road' && good.summary.startsWith('The party reached Belfar.'));
  assert('D-2: no warnings for a 7-word title and 2 sentences', good.warnings.length === 0);
  assert('D-2: a reply without JSON throws', throws(() => P.parseHeader('Sorry, I cannot help.')));
  assert('D-2: an empty title throws', throws(() => P.parseHeader('{"title":"","summary":"A. B."}')));
  assert('D-2: an empty summary throws', throws(() => P.parseHeader('{"title":"Five words of title here","summary":"  "}')));
  const long = P.parseHeader('{"title":"Ambush","summary":"One sentence only"}');
  assert('D-2: a short title and one sentence are kept, with two warnings',
    long.title === 'Ambush' && long.warnings.length === 2 && /1 words/.test(long.warnings[0]) && /1 sentence;/.test(long.warnings[1]));
}

// ── D-3 ─────────────────────────────────────────────────────────────────────
console.log('\nTest D-3 — a new session publishes the edited header');
{
  // The page puts the field text on the header item (applyHeaderEdits);
  // this is what it hands publish after the DM edits the draft.
  const header = ChroniclePublish.sessionHeader('session_008', '2026-04-16');
  header.rawData.title = 'Fire and Feathers on the Belfar Road (edited)';
  header.rawData.summary = 'Edited summary. It has two sentences.';
  const out = ChroniclePublish.applySession(campaign, [header]).campaign;
  const s8 = out.session_logs.find(s => s.legacy_id === 'session_008');
  assert('D-3: the edited title is written', s8 && s8.title === 'Fire and Feathers on the Belfar Road (edited)');
  assert('D-3: the edited summary is written as narrative.summary', s8 && s8.narrative && s8.narrative.summary === 'Edited summary. It has two sentences.');
  assert('D-3: no replace item for a new session', P.headerReplaceItem(undefined, { title: 'x', summary: 'y', replaceTitle: true }) === null);
}

// ── D-4 ─────────────────────────────────────────────────────────────────────
console.log('\nTest D-4 — a placeholder keeps its header unless replace is ticked');
{
  const rec = campaign.session_logs.find(s => s.legacy_id === 'session_006');
  const draft = { title: 'A Drafted Title For Session Six Here', summary: 'A drafted summary. Two sentences.' };
  const header = ChroniclePublish.sessionHeader('session_006', rec.date);
  Object.assign(header.rawData, draft);

  // Not ticked: the recorded header stays and publish says so.
  assert('D-4: nothing ticked, no replace item', P.headerReplaceItem(rec, draft) === null);
  const kept = ChroniclePublish.applySession(campaign, [header]);
  const k6 = kept.campaign.session_logs.find(s => s.legacy_id === 'session_006');
  assert('D-4: unticked, the recorded title and summary stay',
    k6.title === rec.title && k6.narrative.summary === rec.narrative.summary);
  assert('D-4: unticked, publish notes the difference', kept.notes.some(n => /session_006: kept the recorded title/.test(n)));

  // Title ticked: only the title is replaced.
  const t = P.headerReplaceItem(rec, Object.assign({ replaceTitle: true }, draft));
  assert('D-4: title ticked, a MOD on session_logs setting only title',
    t && t.type === 'MOD' && t.array === 'session_logs' && t.rawData.id === rec.id && JSON.stringify(Object.keys(t.rawData._set)) === '["title"]');
  const t6 = ChroniclePublish.applySession(campaign, [header, t]).campaign.session_logs.find(s => s.legacy_id === 'session_006');
  assert('D-4: through applySession the title is replaced, the summary kept',
    t6.title === draft.title && t6.narrative.summary === rec.narrative.summary);
  assert('D-4: the rest of the session is untouched', t6.id === rec.id && t6.date === rec.date &&
    JSON.stringify(t6.mechanics) === JSON.stringify(Object.assign({}, rec.mechanics, t6.mechanics)));

  // Both ticked.
  const both = P.headerReplaceItem(rec, Object.assign({ replaceTitle: true, replaceSummary: true }, draft));
  const b6 = ChroniclePublish.applySession(campaign, [header, both]).campaign.session_logs.find(s => s.legacy_id === 'session_006');
  assert('D-4: both ticked, both replaced', b6.title === draft.title && b6.narrative.summary === draft.summary);
  assert('D-4: one session_006, nothing appended', ChroniclePublish.applySession(campaign, [header, both]).campaign.session_logs.length === campaign.session_logs.length);

  // The header sent with a replace item leaves out the replaced fields, so
  // publish does not say it kept what it then replaced (seen on session 6).
  const sent = P.headerForPublish(header, both);
  const run = ChroniclePublish.applySession(campaign, [sent, both]);
  const r6 = run.campaign.session_logs.find(s => s.legacy_id === 'session_006');
  assert('D-4: with headerForPublish both fields are still replaced', r6.title === draft.title && r6.narrative.summary === draft.summary);
  assert('D-4: and no "kept the recorded" note for a replaced field', !run.notes.some(n => /kept the recorded (title|narrative\.summary)/.test(n)));
  assert('D-4: the page header itself is not changed', header.rawData.title === draft.title && header.rawData.summary === draft.summary);
  assert('D-4: title only replaced, the summary stays on the header sent', (() => { const h = P.headerForPublish(header, t).rawData; return !('title' in h) && h.summary === draft.summary; })());
  assert('D-4: no replace item, the header is sent as is', P.headerForPublish(header, null) === header);

  // Ticked but the text equals the record: nothing to replace.
  assert('D-4: ticked with the recorded text, no item',
    P.headerReplaceItem(rec, { title: rec.title, summary: rec.narrative.summary, replaceTitle: true, replaceSummary: true }) === null);
}

// ── D-5 ─────────────────────────────────────────────────────────────────────
console.log('\nTest D-5 — the page');
{
  const page = read('admin/session.html');
  const ai = read('shared/chronicle-ai.js');
  assert('D-5: the header has a Draft title and summary button', /onclick="draftHeader\(\)"/.test(page) && /Draft title and summary/.test(page));
  assert('D-5: the page calls ChronicleAI.draftHeader with headerPrompt', /ChronicleAI\.draftHeader\(\{ system \}\)/.test(page) && /ChroniclePages\.headerPrompt\(/.test(page));
  assert('D-5: chronicle-ai.js exports a streamed draftHeader', /async function draftHeader\(\{ system \}\)[\s\S]{0,300}callStream/.test(ai) && /^\s+draftHeader,$/m.test(ai));
  // The failure path must not write the fields: only the catch sets the error.
  const fn = (/async function draftHeader\(\) \{([\s\S]*?)\n\}/.exec(page) || [, ''])[1];
  const catchPart = fn.slice(fn.indexOf('catch'));
  assert('D-5: a failed call leaves the fields alone', fn.includes('catch') && !/headerEdit/.test(catchPart));
  assert('D-5: typing does not redraw the header (oninput → editHeader)',
    /oninput="editHeader\('title', this\.value\)"/.test(page) && /oninput="editHeader\('summary', this\.value\)"/.test(page));
  // A redraw on blur replaced the Draft button under the mouse and the click
  // was lost (seen in Chrome on the first run): the fields must not have one.
  const fields = page.match(/<(?:input|textarea) id="hd-(?:title|summary)"[^>]*>/g) || [];
  assert('D-5: the title and summary fields do not redraw on change', fields.length === 2 && fields.every(f => !/onchange=/.test(f)));
  assert('D-5: the publish plan carries the replace item', /headerReplace = ChroniclePages\.headerReplaceItem\(/.test(page));
  assert('D-5: the plan sends the header through headerForPublish', /header: ChroniclePages\.headerForPublish\(session\.header, headerReplace\)/.test(page));
  assert('D-5: no demo text in the header draft', !/demo/i.test(fn));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
