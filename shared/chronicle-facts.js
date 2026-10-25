/**
 * shared/chronicle-facts.js
 *
 * Per-page fact extraction for the session page (issue #101), including the
 * narrative passages from the same call (issue #102).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The old intake read each page twice (image → OCR text, then text →
 * rounds) and the round call placed every action in an initiative slot
 * using a fixed roster (slot 1 = Goldie … slot 6 = Att). When the notes
 * listed turns in a different order, actions landed in the wrong slot, on
 * the wrong character, and a combat that crossed a page break became two.
 *
 * The redesign (docs/intake-redesign.md, "A mixed misalignment in one
 * round") separates the two decisions. This call only attributes: each fact
 * names its actor and targets by the occurrence ids step 3 settled, keeps
 * the line of the notes it came from, and places nothing by slot. The
 * confirmed initiative order (#103) places turns later. Open combats and the
 * previous page's last round are carried forward, so a page that continues
 * a fight adds rounds to it.
 *
 * The prompt, the reply check and the merging live here, without DOM or
 * network, so tests/fact-extraction.test.js runs the code the page runs.
 * chronicle-ai.js only sends the request (extractFacts).
 *
 * WHAT THIS MODULE DOES
 * ---------------------
 * Exports window.ChronicleFacts (and module.exports under Node):
 *   ENUMS                               — the turn schema's economy, result,
 *                                         val_type and special-event values
 *   pageReferences(page, rows, index)   — this page's occurrences, each with
 *                                         what step 3 settled it as
 *   combatChoices(campaign, rows, index)— the combats a page may add rounds to
 *   factsPrompt({...})                  — the system prompt for one page
 *   parseFacts(text)                    — the JSON object out of the reply
 *   validateFacts(facts, refs, combats) — errors that make a reply unusable
 *                                         (an entity named instead of an
 *                                         occurrence, an unknown value)
 *   checkFacts(facts, refs)             — the self-checks: imbalance and
 *                                         action economy (from #104)
 *   mergePages(pages, refs)             — one session: rounds across page
 *                                         breaks merged, round resets flagged,
 *                                         passages and page summaries gathered
 *   applyPassageEdits(passages, edits) — the DM's passage edits and drops (#116)
 *   passageItems(merged, refs, session) — the passages as publish items
 *                                         (#102), plus those that wait for
 *                                         their round or entry to be written
 *   testimonyUpdates(items, passages)   — marks new lore an NPC told the
 *                                         party as rumoured npc_testimony
 *
 * Depends on shared/chronicle-entities.js (resolveOccurrences, newEntities).
 *
 * WHAT WOULD BREAK IF REMOVED
 * ----------------------------
 * The session page could not read facts from the pages, and step 4's
 * review (#103) would have nothing to show.
 */

(function(root) {
  'use strict';

  const NodeEntities = (typeof module !== 'undefined' && module.exports) ? require('./chronicle-entities.js') : null;
  function Ent() {
    const e = NodeEntities || root.ChronicleEntities;
    if (!e) throw new Error('ChronicleFacts needs shared/chronicle-entities.js loaded first');
    return e;
  }

  // The 5.0.0 enums, as data/magers-campaign.json's _field_type_reference
  // lists them. Kept here so the prompt and the check agree with the schema.
  const ENUMS = {
    economy: ['action', 'bonus_action', 'reaction', 'movement', 'free', 'legendary_action', 'legendary_resistance'],
    res: ['hit', 'miss', 'crit', 'save', 'success', 'failure', 'death', 'neutral', 'unclear'],
    val_type: ['damage', 'healing', 'temp_hp', 'resource_restored', 'shield_value', 'death_save_success', 'death_save_failure', 'other'],
    special: ['appeared', 'reinforcements', 'fled', 'downed', 'eliminated', 'phase_change', 'other'],
    loot: ['found', 'given', 'lost', 'used'],
  };

  /**
   * pageReferences(page, rows, index) → [{ occ, asWritten, context, label,
   *   entityId, group, kind, array }]
   *
   * Every occurrence step 3 found on this page, with the entity it was
   * settled as (or "needs assignment" for a split). The facts call may name
   * an actor or target only by one of these ids. label is what the AI is
   * shown; entityId and group are what the checks use: group is true for a
   * creature group (roster group, bestiary, cohort, faction), which may act
   * several times in a round.
   */
  function pageReferences(page, rows, index) {
    const E = Ent();
    const resolved = E.resolveOccurrences(rows, index);
    const made = E.newEntities(rows);
    const nameOf = id => index.entities.get(id)?.name || made.get(id)?.name || id;
    const arrayOf = id => index.entities.get(id)?.array || made.get(id)?.array || null;
    const out = [];
    for (const r of rows) {
      for (const o of r.occurrences) {
        if (String(o.page) !== String(page)) continue;
        const res = resolved.get(o.id) || {};
        let label, entityId = res.entityId || null, group = false;
        if (res.roster) {
          label = `enemy group "${res.roster.label}"`;
          entityId = 'roster:' + res.roster.combatId + ':' + res.roster.label;
          group = true;
        } else if (res.needsAssignment) {
          label = 'one of: ' + res.needsAssignment.map(nameOf).join(' / ') + ' (to be assigned later)';
        } else if (res.dismissed) {
          // The DM marked the words not an entity (#113). The AI is told so,
          // so it keeps them as target_text and never makes them an actor.
          label = 'not an entity: keep the words as target_text; never an actor or a speaker';
        } else if (entityId) {
          const arr = arrayOf(entityId);
          label = `${nameOf(entityId)} (${arr === 'party' ? 'player character' : arr})`;
          group = ['bestiary', 'cohorts', 'factions', 'enemies_roster'].includes(arr);
        } else {
          label = 'unsettled';
        }
        // array: where the entity lives (a new one's array comes from step 3),
        // so a passage attached to it can be published to the right list.
        // candidates: for an occurrence of a split row, the entities it must
        // be assigned between (the round grid's split assignment, #103).
        out.push({ occ: o.id, asWritten: o.asWritten, context: o.context, label, entityId, group, kind: r.kind, dismissed: !!res.dismissed,
          array: res.roster ? 'enemies_roster' : (entityId ? arrayOf(entityId) : null),
          candidates: res.needsAssignment ? res.needsAssignment.map(id => ({ id, name: nameOf(id) })) : null });
      }
    }
    return out;
  }

  /**
   * combatChoices(campaign, rows, index) → [{ ref, name, open, lastRound }]
   *
   * The combats a page may add rounds to: every open combat in the campaign,
   * any recorded combat a page's occurrence was settled as, and each combat
   * step 3 created this session. ref is what the AI writes in `combat`.
   * lastRound is the highest round already recorded, so "Round 4" on a page
   * reads as continuing a combat recorded to round 3.
   */
  function combatChoices(campaign, rows, index) {
    const E = Ent();
    const out = new Map();
    const resolved = E.resolveOccurrences(rows, index);
    const settled = new Set([...resolved.values()].map(v => v.entityId).filter(Boolean));
    for (const c of (campaign && campaign.combat_encounters) || []) {
      const entry = index.entities.get(c.id);
      if (!entry || !(entry.open || settled.has(c.id))) continue;
      const lastRound = Math.max(0, ...(c.rounds || []).map(r => Number(r.n) || 0));
      out.set(c.id, { ref: c.id, name: c.name, open: !!entry.open, lastRound });
    }
    for (const m of E.newEntities(rows).values()) {
      if (m.array === 'combat_encounters') out.set(m.id, { ref: m.id, name: m.name, open: true, lastRound: 0, isNew: true });
    }
    return [...out.values()];
  }

  /**
   * factsPrompt({ pageLabel, references, combats, carry, reread }) → system prompt.
   *
   * carry  — { combat, round } where the previous page stopped, or null
   * reread — problems found in the first reply, listed so the second read
   *          fixes them (the issue's "re-reads the round once")
   * recordedAbsences — the session's absence notes already recorded (a
   *          placeholder's, after #112's migration), so the AI reuses the same
   *          sentence for the same absence and publish keeps one copy
   * focus  — { combat, n, order } to read one round only, against the
   *          initiative order the DM confirmed: the round grid's
   *          "Re-extract this round" (#103). order is text ("1. Del, 2. Mal").
   * The rules are the design's: attribute by occurrence, never by slot;
   * one outcome per roll; down is an outcome effect; the 2024 rules and the
   * party's action economy are added by ChronicleAI.extractFacts.
   */
  function factsPrompt({ pageLabel, references, combats, carry, reread, focus, recordedAbsences }) {
    const refs = references.map(r => `${r.occ} | "${r.asWritten}" = ${r.label} | line: ${r.context}`).join('\n');
    const cmb = combats.length
      ? combats.map(c => `${c.ref} | ${c.name}${c.open ? ' (open' + (c.lastRound ? `, recorded to round ${c.lastRound}` : '') + ')' : ''}`).join('\n')
      : '(none)';
    return `You record what happened on one page of a Dungeon Master's handwritten D&D session notes as structured facts. The names on the page have already been identified; you refer to them only by occurrence id.

PAGE: ${pageLabel}
${carry ? `The previous page ended in combat ${carry.combat}, round ${carry.round}. A page that starts with a later round continues it.\n` : ''}
OCCURRENCES ON THIS PAGE (id | words as written = what they were confirmed as | the line they are on):
${refs || '(none)'}

COMBATS YOU MAY ADD ROUNDS TO (id | name):
${cmb}

RULES:
1. Refer to every actor and every target by an occurrence id from the list above, choosing the occurrence on the same line. Never write a character's name in "actor" or "target". A target that is not in the list (a horse, the cart) goes in "target_text" with "target" null.
2. Do not assign initiative slots or reorder turns. Record each turn in the order the notes list it, with the line it came from in "source_line", copied exactly.
3. "combat" is a combat id from the list. Only if the page clearly starts a different fight, write "new: <name as written>". If a round number goes back down (round 14, then round 1), that is a new combat.
4. Party turns go in "turns"; enemy group turns go in "enemy_turns", one per group per round, holding all that group's activities.
5. Each activity: economy is one of ${ENUMS.economy.join(', ')}. For the action economy, name is a standard action (Attack, Dash, Disengage, Dodge, Help, Hide, Influence, Magic, Ready, Search, Study, Utilize), "Death Save", or "No Action: <reason>"; the spell or weapon goes in "detail" ("Magic" with detail "True Strike"). For other economies, name is the feature or spell (Flurry of Blows, Shield). A reaction belongs to the character who reacted, as a turn for them in that round.
6. One outcome per attack roll or per spell target, even when the target repeats ("2 Att miss/Hit" is two outcomes). res is one of ${ENUMS.res.join(', ')}; val is the number written, or null. Never infer a number or a result that is not written; use "unclear" when the result is not stated.
7. "Dead", "killed" or "Down" on a roll is that outcome's effect: "killed" or "downed". It is never an activity. A death save is the action "Death Save" with res success or failure.
8. A sentence that is not a turn (the dragons descend, goblins flee) goes in the round's "events" as written, or in "special_events" of the enemy group it is about (type one of ${ENUMS.special.join(', ')}).
9. Quest progress and items found, given, lost or used go in "quest_progress" and "loot", each with its occurrence id and source line.
11. PASSAGES: every piece of narrative on the page that is not a turn — the DM's descriptions and exposition, and what NPCs say — becomes a passage in "passages". A line about a player being absent is not narrative: it goes only in "absence_notes" (rule 14), never also in passages. Clean each into complete sentences and expand abbreviations, but add no fact the notes do not contain: clean up and flesh out, do not invent.
    - "speaker": "dm" for the DM's own description or exposition (it is fact), or the occurrence id of the NPC who said it (it is testimony). What an NPC tells the party counts as said by that NPC whether the notes quote it or report it ("Rufus says he hasn't slept", "R: will guide for a share"): keep the NPC as speaker, and keep what the NPC said separate from the DM's own description of them.
    - What an NPC says about themselves, their past or what they want goes on that NPC; what they say about something else (a place, a creature, a piece of lore) goes on that thing.
    - "attach": the most specific thing the passage describes, one of:
      {"to":"entity","occ":"<occurrence id>"} — what a person, creature, group, place, thing or piece of knowledge is like, or what an NPC said about themselves;
      {"to":"combat","combat":"<combat id>"} — how a fight opened, turned or ended;
      {"to":"round","combat":"<combat id>","n":<round>} — a moment in one round;
      {"to":"activity","combat":"<combat id>","n":<round>,"actor":"<occurrence id>","index":<0-based activity index in that turn>} — how one action landed;
      {"to":"quest_progress","index":<0-based index in quest_progress>} — what happened at a quest step;
      {"to":"session"} — scene-setting and transitions that belong to nothing narrower.
      A description of a place goes on the place. The party arriving at a place is an event: attach it to the round or combat if it happens in one, otherwise the session.
    - "source_lines": the lines of the notes it came from, copied exactly.
12. "page_summary": one or two sentences saying what happens on this page, for the DM's reference.
13. "assignments": for each occurrence listed as "one of: …", propose which of those it is: {"occ":"<occurrence id>","choice":"<one of the names exactly as listed>","reason":"<a few words: spelling, place, who else is there, which combat>"}. The DM confirms these later.
14. "absence_notes": a line saying a player was absent and someone else ran their character ("Lance out work, played by David") is a note about the session, not a fact about a character and not a turn, event or passage. Write it as one plain sentence with first names only, saying who was out, why if stated, and who played the character ("Malachite piloted by David due to Lance's work schedule."). Leave the list empty when the page has none.${recordedAbsences && recordedAbsences.length ? `
    This session already records: ${recordedAbsences.map(t => '"' + t + '"').join('; ')}. If the page records the same absence, copy that sentence exactly instead of writing a new one.` : ''}
10. Before answering, check your own rounds against these sanity checks (issue #104) and re-read the lines behind any that fail:
    - Imbalance: one character with two actions in a round while another listed character has none usually means a line was misread.
    - Source line: every turn's actor is the character its source line names.
    - Ability ownership: a spell or feature should be one that character has (see the action economy reference and what they used earlier).
    - Action economy: more than one action or bonus action in a turn needs a feature that allows it (Action Surge); a feature recorded under the wrong economy (Healing Word as an action) is a misread.
    - Outcome count: "3 attacks" or "x2" means that many outcomes; Flurry of Blows is two strikes.
    - State: a character downed or killed earlier does nothing but Death Save or No Action until healed.
    - Duplicates: the same action with the same result and number in two turns of one round is usually a line read twice.
    List anything you still cannot resolve in "self_check". These are sanity checks: when the notes really say something unusual, record what they say.
${reread && reread.length ? `\nA FIRST READ OF THIS PAGE HAD THESE PROBLEMS. Re-read the page and fix them:\n- ${reread.join('\n- ')}\n` : ''}${focus ? `\nRE-READ ONE ROUND: record only round ${focus.n} of combat ${focus.combat}, as one combat with that one round. The DM has confirmed the initiative order: ${focus.order}. Use it to tell whose turn each line is; still record turns in the order the notes list them. Leave quest_progress, loot, passages and assignments empty.\n` : ''}
Respond with JSON only, no prose:
{"combats":[{"combat":"<combat id>","rounds":[{"n":4,"turns":[{"actor":"occ_1_1","source_line":"Asp - Healing Hands","activities":[{"economy":"action","name":"Magic","detail":"Healing Hands","val_type":null,"outcomes":[{"res":"unclear","val":null,"target":null,"target_text":null,"detail":null,"effect":null}],"notes":null}]}],"enemy_turns":[{"actor":"occ_1_4","source_line":"Goblins - Hit Mal (opportunity)","activities":[{"economy":"reaction","name":"Opportunity Attack","outcomes":[{"res":"hit","val":null,"target":"occ_1_5"}]}],"special_events":[]}],"events":[]}]}],"quest_progress":[],"loot":[],"passages":[{"text":"Two Larkspur dragons swooped down on the cart from the ridges and killed everyone at the cart.","speaker":"dm","attach":{"to":"round","combat":"<combat id>","n":4},"source_lines":["Larkspur dragons descend on cart from ridges. Kill all at the cart."]}],"absence_notes":[],"page_summary":"The Goblin Ambush continues through rounds 4 and 5 as Larkspur dragons join the fight.","self_check":[]}`;
  }

  /**
   * parseFacts(text) → the reply's JSON object, with every list present.
   * Throws with a plain message on a reply that is not that object, so the
   * page shows an error for that page and never continues with a guess.
   */
  function parseFacts(text) {
    const s = String(text || '');
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
    let body = fenced ? fenced[1] : s;
    const start = body.indexOf('{'), end = body.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('The AI reply had no JSON in it.');
    let parsed;
    try { parsed = JSON.parse(body.slice(start, end + 1)); } catch (e) { throw new Error('The AI reply was not valid JSON: ' + e.message); }
    if (!parsed || !Array.isArray(parsed.combats)) throw new Error('The AI reply has no "combats" list.');
    for (const k of ['quest_progress', 'loot', 'self_check', 'passages', 'assignments', 'absence_notes']) if (!Array.isArray(parsed[k])) parsed[k] = [];
    // Absence notes are plain sentences (#112); anything else is dropped.
    parsed.absence_notes = parsed.absence_notes.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim());
    if (typeof parsed.page_summary !== 'string') parsed.page_summary = null;
    for (const p of parsed.passages) {
      if (!Array.isArray(p.source_lines)) p.source_lines = p.source_lines ? [String(p.source_lines)] : [];
      if (!p.attach || typeof p.attach !== 'object') p.attach = { to: 'session' };
    }
    for (const c of parsed.combats) {
      c.rounds = Array.isArray(c.rounds) ? c.rounds : [];
      for (const r of c.rounds) {
        for (const k of ['turns', 'enemy_turns', 'events']) if (!Array.isArray(r[k])) r[k] = [];
        for (const t of r.turns.concat(r.enemy_turns)) {
          if (!Array.isArray(t.activities)) t.activities = [];
          for (const a of t.activities) if (!Array.isArray(a.outcomes)) a.outcomes = [];
          if (r.enemy_turns.includes(t) && !Array.isArray(t.special_events)) t.special_events = [];
        }
      }
    }
    return parsed;
  }

  // forEachTurn(facts, fn) — fn(turn, round, combat, isEnemy) for every turn.
  function forEachTurn(facts, fn) {
    for (const c of facts.combats || []) for (const r of c.rounds || []) {
      for (const t of r.turns || []) fn(t, r, c, false);
      for (const t of r.enemy_turns || []) fn(t, r, c, true);
    }
  }

  /**
   * validateFacts(facts, references, combats) → [error sentence]
   *
   * Anything here makes the reply unusable, and the page is re-read once:
   *   - an actor that is not one of this page's occurrence ids, or a target
   *     that is neither an occurrence id nor null (the phase 4 gate: "no
   *     fact refers to an entity by name instead of by occurrence")
   *   - a combat that is neither in the list nor "new: <name>"
   *   - an economy, result or val_type outside the schema's enums
   *   - a round without a number
   */
  function validateFacts(facts, references, combats) {
    const occ = new Set(references.map(r => r.occ));
    const refs = new Set(combats.map(c => c.ref));
    const errors = [];
    const where = (r, t) => `round ${r.n ?? '?'}, line "${t.source_line || ''}"`;
    for (const c of facts.combats) {
      if (!refs.has(c.combat) && !/^new:\s*\S/.test(String(c.combat || ''))) errors.push(`Combat "${c.combat}" is not in the list and not "new: <name>".`);
      for (const r of c.rounds) if (!Number.isFinite(Number(r.n)) || r.n === null) errors.push('A round has no number.');
    }
    forEachTurn(facts, (t, r) => {
      if (!occ.has(t.actor)) errors.push(`Actor "${t.actor}" (${where(r, t)}) is not an occurrence id from the list.`);
      for (const a of t.activities) {
        if (!ENUMS.economy.includes(a.economy)) errors.push(`Economy "${a.economy}" (${where(r, t)}) is not one of the allowed values.`);
        if (a.val_type != null && !ENUMS.val_type.includes(a.val_type)) errors.push(`val_type "${a.val_type}" (${where(r, t)}) is not allowed.`);
        for (const o of a.outcomes) {
          if (o.target != null && !occ.has(o.target)) errors.push(`Target "${o.target}" (${where(r, t)}) is not an occurrence id; use target_text for anything not in the list.`);
          if (o.res != null && !ENUMS.res.includes(o.res)) errors.push(`Result "${o.res}" (${where(r, t)}) is not allowed.`);
        }
      }
    });
    for (const q of facts.quest_progress) if (q.quest != null && !occ.has(q.quest)) errors.push(`Quest progress names "${q.quest}" instead of an occurrence id.`);
    // Passages (#102): the speaker must be "dm" or an occurrence; a speaker
    // named instead is an error (testimony must point at the NPC). An
    // attachment the reply cannot back up is not an error: it is moved to
    // the nearest place that exists (repairAttachments), because one
    // misplaced passage must not throw away a page of facts (seen on the
    // real session 6 page 1, #103). The DM can still see where it went.
    repairAttachments(facts, occ, refs);
    (facts.passages || []).forEach((p, i) => {
      const at = `Passage ${i + 1}`;
      if (!p.text || !String(p.text).trim()) errors.push(`${at} has no text.`);
      if (p.speaker !== 'dm' && !occ.has(p.speaker)) errors.push(`${at}: speaker "${p.speaker}" is neither "dm" nor an occurrence id.`);
    });
    for (const l of facts.loot) {
      if (l.item != null && !occ.has(l.item)) errors.push(`Loot names "${l.item}" instead of an occurrence id.`);
      if (l.holder != null && !occ.has(l.holder)) errors.push(`Loot holder "${l.holder}" is not an occurrence id.`);
    }
    return [...new Set(errors)];
  }

  /**
   * repairAttachments(facts, occ, combatRefs) — moves each passage whose
   * attachment names something the reply does not have to the nearest place
   * that does: an activity → its round → its combat → the session; an
   * unknown occurrence or quest step → the session. Each move is added to
   * the reply's self_check notes, so the DM sees it beside the review.
   */
  function repairAttachments(facts, occ, combatRefs) {
    const roundOf = (cmb, n) => facts.combats.find(c => c.combat === cmb)?.rounds.find(r => Number(r.n) === Number(n));
    const combatOk = cmb => combatRefs.has(cmb) || facts.combats.some(c => c.combat === cmb);
    (facts.passages || []).forEach((p, i) => {
      const a = p.attach || { to: 'session' };
      let to = a;
      if (a.to === 'activity') {
        const r = roundOf(a.combat, a.n);
        const t = r && r.turns.concat(r.enemy_turns).find(x => x.actor === a.actor);
        if (!t || !t.activities[Number(a.index)]) to = r ? { to: 'round', combat: a.combat, n: a.n } : (combatOk(a.combat) ? { to: 'combat', combat: a.combat } : { to: 'session' });
      } else if (a.to === 'round') {
        if (!roundOf(a.combat, a.n)) to = combatOk(a.combat) ? { to: 'combat', combat: a.combat } : { to: 'session' };
      } else if (a.to === 'combat') {
        if (!combatOk(a.combat)) to = { to: 'session' };
      } else if (a.to === 'entity') {
        if (!occ.has(a.occ)) to = { to: 'session' };
      } else if (a.to === 'quest_progress') {
        if (!facts.quest_progress[Number(a.index)]) to = { to: 'session' };
      } else if (a.to !== 'session') to = { to: 'session' };
      if (to !== a) {
        p.attach = to;
        if (!Array.isArray(facts.self_check)) facts.self_check = [];
        facts.self_check.push(`Passage ${i + 1} ("${String(p.text || '').slice(0, 50)}") was attached to ${a.to} ${a.n != null ? 'round ' + a.n : (a.occ || '')}, which this page does not record; it now sits on the ${to.to}${to.n != null ? ' (round ' + to.n + ')' : ''}.`);
      }
    });
  }

  /**
   * checkFacts(facts, references) → [{ type, combat, round, detail }]
   *
   * The two checks the issue asks the model to run on itself (from #104),
   * run again here on what came back, so a failure triggers the one re-read
   * and, if it survives, a flag:
   *   economy   — a turn (all of one character's turns in a round, since a
   *               reaction is recorded as a separate turn) with more than one
   *               action or more than one bonus action. Groups are exempt:
   *               five goblins take five actions.
   *   imbalance — in one round, a character with two or more actions while
   *               another character who acts elsewhere in that combat on this
   *               page has no turn at all.
   * Characters are compared by entity, so "Mal" and "Mail" count as one.
   */
  function checkFacts(facts, references) {
    const byOcc = new Map(references.map(r => [r.occ, r]));
    const issues = [];
    for (const c of facts.combats) {
      const everyone = new Map(); // entityId → label, party members acting anywhere in this combat
      for (const r of c.rounds) for (const t of r.turns) {
        const ref = byOcc.get(t.actor);
        if (ref && ref.entityId && !ref.group) everyone.set(ref.entityId, ref.asWritten);
      }
      for (const r of c.rounds) {
        const perActor = new Map(); // entityId → { label, action, bonus }
        for (const t of r.turns) {
          const ref = byOcc.get(t.actor);
          if (!ref || !ref.entityId || ref.group) continue;
          const p = perActor.get(ref.entityId) || { label: ref.asWritten, action: 0, bonus: 0 };
          for (const a of t.activities) {
            if (a.economy === 'action') p.action++;
            if (a.economy === 'bonus_action') p.bonus++;
          }
          perActor.set(ref.entityId, p);
        }
        for (const p of perActor.values()) {
          if (p.action > 1) issues.push({ type: 'economy', combat: c.combat, round: r.n, detail: `${p.label} has ${p.action} actions in round ${r.n}` });
          if (p.bonus > 1) issues.push({ type: 'economy', combat: c.combat, round: r.n, detail: `${p.label} has ${p.bonus} bonus actions in round ${r.n}` });
        }
        const doubled = [...perActor.values()].filter(p => p.action > 1);
        const missing = [...everyone.entries()].filter(([id]) => !perActor.has(id));
        if (doubled.length && missing.length) {
          issues.push({ type: 'imbalance', combat: c.combat, round: r.n,
            detail: `round ${r.n}: ${doubled.map(p => p.label).join(', ')} has two actions while ${missing.map(m => m[1]).join(', ')} has no turn` });
        }
      }
    }
    return issues;
  }

  /**
   * mergePages(pages, references) → { combats: [{ combat, rounds: [...] }], quest_progress, loot, issues }
   *
   * pages — [{ page, facts }] in reading order. Rounds of the same combat
   * with the same number are merged (a round split across a page break):
   * turns, enemy turns and events are appended in page order, so nothing is
   * dropped or reordered. Each turn keeps its page and source line.
   * issues adds round-reset flags: within a combat, a round number lower
   * than one already seen on an earlier page suggests a new combat (#91).
   */
  function mergePages(pages, references) {
    const combats = new Map();
    const issues = [];
    const quest_progress = [], loot = [], passages = [], summaries = [], assignments = [], absence_notes = [];
    for (const p of pages) {
      const f = p.facts;
      for (const c of f.combats) {
        if (!combats.has(c.combat)) combats.set(c.combat, { combat: c.combat, rounds: new Map(), maxSeen: 0 });
        const m = combats.get(c.combat);
        let lastOnPage = -Infinity;
        for (const r of c.rounds) {
          const n = Number(r.n);
          if (n < m.maxSeen || n < lastOnPage) {
            issues.push({ type: 'round-reset', combat: c.combat, round: n, detail: `round ${n} on ${p.page === 'notes' ? 'the notes file' : 'page ' + p.page} comes after round ${Math.max(m.maxSeen, lastOnPage)}: likely a new combat` });
          }
          lastOnPage = n;
          if (!m.rounds.has(n)) m.rounds.set(n, { n, turns: [], enemy_turns: [], events: [], pages: [] });
          const target = m.rounds.get(n);
          const tag = t => Object.assign({}, t, { page: p.page });
          target.turns.push(...r.turns.map(tag));
          target.enemy_turns.push(...r.enemy_turns.map(tag));
          target.events.push(...r.events);
          if (!target.pages.includes(p.page)) target.pages.push(p.page);
        }
        m.maxSeen = Math.max(m.maxSeen, ...c.rounds.map(r => Number(r.n) || 0));
      }
      // A passage's quest step is an index into its own page's list; it is
      // turned into the session-wide index here, as the lists are joined.
      const qOffset = quest_progress.length;
      for (const ps of f.passages || []) {
        const attach = Object.assign({}, ps.attach);
        if (attach.to === 'quest_progress') attach.index = qOffset + Number(attach.index);
        passages.push(Object.assign({}, ps, { attach, page: p.page }));
      }
      if (f.page_summary) summaries.push({ page: p.page, text: f.page_summary });
      assignments.push(...(f.assignments || []).map(a => Object.assign({ page: p.page }, a)));
      // One absence written on two pages is kept once (#112).
      for (const t of f.absence_notes || []) if (!absence_notes.includes(t)) absence_notes.push(t);
      quest_progress.push(...f.quest_progress.map(q => Object.assign({ page: p.page }, q)));
      loot.push(...f.loot.map(l => Object.assign({ page: p.page }, l)));
    }
    return {
      combats: [...combats.values()].map(m => ({ combat: m.combat, rounds: [...m.rounds.values()].sort((a, b) => a.n - b.n) })),
      quest_progress, loot, passages, summaries, assignments, absence_notes, issues,
    };
  }

  /**
   * passageItems(merged, references, sessionLegacyId) → { items, deferred }
   *
   * Turns the session's passages into publish items (#102). Each passage is
   * stored as { text, session_id, speaker, page } — the shape #93 gave the
   * optional passages[] list — on exactly one object, so nothing is copied:
   *   entity            → MOD _passage_append on that entity. An occurrence
   *                        of an enemy roster group attaches to its combat,
   *                        because a roster group is not an entity.
   *   combat            → MOD _passage_append on the combat
   *   session           → MOD _passage_append on the session (by its
   *                        session_NNN, which publish translates)
   *   round, activity,
   *   quest step        → deferred: those objects are written with the facts
   *                        at publish (#106), so their passages go with them
   * speaker is "dm" or the speaker's entity id (a new entity's working id,
   * which publish maps to the id it assigns). An occurrence still waiting for
   * a split assignment, as speaker or target, is deferred too.
   */
  function passageItems(merged, references, sessionLegacyId) {
    // A passage the DM dropped in review (#116) is neither written nor
    // deferred. Its index still counts, so item ids and the DM's moves, both
    // keyed by position, stay stable.
    const byOcc = new Map(references.map(r => [r.occ, r]));
    const items = [], deferred = [];
    const entityOf = occ => {
      const r = byOcc.get(occ);
      if (!r || !r.entityId) return null;
      const m = /^roster:([^:]+):/.exec(r.entityId);
      return m ? { array: 'combat_encounters', id: m[1] } : { array: r.array, id: r.entityId };
    };
    // isDismissed(occ) — the DM marked those words not an entity (#113).
    const isDismissed = occ => !!(byOcc.get(occ) && byOcc.get(occ).dismissed);
    merged.passages.forEach((p, i) => {
      if (p.dropped) return;
      let speaker = 'dm';
      if (p.speaker !== 'dm') {
        const sp = entityOf(p.speaker);
        if (!sp) {
          deferred.push({ passage: p, reason: isDismissed(p.speaker)
            ? 'its speaker was marked not an entity; reopen that row in step 3, or drop the passage'
            : 'its speaker is waiting for a split assignment' });
          return;
        }
        speaker = sp.id;
      }
      const passage = { text: String(p.text).trim(), session_id: sessionLegacyId, speaker, page: typeof p.page === 'number' ? p.page : null };
      const a = p.attach || { to: 'session' };
      let target = null;
      // A passage about words marked not an entity (#113) belongs to nothing
      // narrower than the session, so it goes there rather than waiting.
      if (a.to === 'entity') target = isDismissed(a.occ) ? { array: 'session_logs', id: sessionLegacyId } : entityOf(a.occ);
      else if (a.to === 'combat') target = { array: 'combat_encounters', id: a.combat };
      else if (a.to === 'session') target = { array: 'session_logs', id: sessionLegacyId };
      if (a.to === 'round' || a.to === 'activity' || a.to === 'quest_progress') {
        deferred.push({ passage: Object.assign({}, passage, { attach: a }), reason: `it belongs to a ${a.to.replace('_', ' ')}, written with the facts at publish (#106)` });
        return;
      }
      if (!target || !target.id) { deferred.push({ passage, reason: 'what it describes is waiting for a split assignment' }); return; }
      items.push({ id: 'passage_' + i, type: 'MOD', array: target.array || null, status: 'approved', targetId: target.id,
        title: 'Passage: ' + passage.text.slice(0, 40), rawData: { id: target.id, _passage_append: [passage] } });
    });
    return { items, deferred };
  }

  /**
   * testimonyUpdates(identityItems, passages, references) → identityItems
   *
   * A piece of lore created this session whose passage an NPC spoke is
   * testimony, not fact: it gets reliability "rumoured" and source_type
   * "npc_testimony", with the NPC as source, so a rumour never becomes a
   * confirmed description (#102; lore already uses npc_testimony). Lore that
   * already exists keeps its recorded reliability; its new passage carries
   * the NPC as speaker. Returns new item objects; the input is not changed.
   */
  function testimonyUpdates(identityItems, passages, references) {
    const byOcc = new Map(references.map(r => [r.occ, r]));
    return identityItems.map(item => {
      if (item.type !== 'NEW' || item.array !== 'world_lore') return item;
      // A dropped passage (#116) is not testimony: it will not be written.
      const told = passages.find(p => !p.dropped && p.speaker !== 'dm' && p.attach?.to === 'entity' && byOcc.get(p.attach.occ)?.entityId === item.rawData.id);
      if (!told) return item;
      const copy = JSON.parse(JSON.stringify(item));
      copy.rawData.mechanics = Object.assign({}, copy.rawData.mechanics, {
        reliability: 'rumoured', source_type: 'npc_testimony', source: byOcc.get(told.speaker)?.entityId || null });
      return copy;
    });
  }

  /**
   * applyPassageEdits(passages, edits) → passages, changed in place.
   *
   * The DM's corrections to passages in step 4 (#116). edits is
   * { index: { text?, dropped? } }, keyed by the passage's position in the
   * merged list, the same key the DM's moves use:
   *   text    — replaces the passage's text; the AI's reading is kept as
   *             originalText so the review can show what changed. A text
   *             equal to the AI's, or empty, changes nothing.
   *   dropped — the passage is not written (passageItems skips it) and is
   *             not testimony (testimonyUpdates skips it); it stays in the
   *             list, marked, so the DM can restore it.
   * Why: a passage that carries a misread ("ruins" for ROUS, "Not 1" for
   * Nat 1, an ignored line stated as an NPC's words) could only be moved,
   * so the misread was published and the entity-page draft built on it
   * (#17, F4). The grid corrections never reach passages.
   */
  function applyPassageEdits(passages, edits) {
    for (const [i, e] of Object.entries(edits || {})) {
      const p = passages[i];
      if (!p || !e) continue;
      const text = typeof e.text === 'string' ? e.text.trim() : '';
      if (text && text !== (p.originalText || p.text)) {
        if (p.originalText == null) p.originalText = p.text;
        p.text = text;
      }
      if (e.dropped) p.dropped = true;
    }
    return passages;
  }

  const api = { ENUMS, pageReferences, combatChoices, factsPrompt, parseFacts, validateFacts, checkFacts, mergePages, passageItems, testimonyUpdates, applyPassageEdits };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChronicleFacts = api;
})(typeof window !== 'undefined' ? window : globalThis);
