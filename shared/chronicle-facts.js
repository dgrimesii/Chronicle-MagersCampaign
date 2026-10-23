/**
 * shared/chronicle-facts.js
 *
 * Per-page fact extraction for the session page (issue #101).
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
 *                                         breaks merged, round resets flagged
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
   *   entityId, group, kind }]
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
        } else if (entityId) {
          const arr = arrayOf(entityId);
          label = `${nameOf(entityId)} (${arr === 'party' ? 'player character' : arr})`;
          group = ['bestiary', 'cohorts', 'factions', 'enemies_roster'].includes(arr);
        } else {
          label = 'unsettled';
        }
        out.push({ occ: o.id, asWritten: o.asWritten, context: o.context, label, entityId, group, kind: r.kind });
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
   * The rules are the design's: attribute by occurrence, never by slot;
   * one outcome per roll; down is an outcome effect; the 2024 rules and the
   * party's action economy are added by ChronicleAI.extractFacts.
   */
  function factsPrompt({ pageLabel, references, combats, carry, reread }) {
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
10. Before answering, check your own rounds. Imbalance: one character with two action-economy actions in a round while another listed character has none usually means a line was misread. Action economy: more than one action or more than one bonus action in a turn needs a feature that allows it (Action Surge). Re-read those lines and fix them. List anything you still cannot resolve in "self_check".
${reread && reread.length ? `\nA FIRST READ OF THIS PAGE HAD THESE PROBLEMS. Re-read the page and fix them:\n- ${reread.join('\n- ')}\n` : ''}
Respond with JSON only, no prose:
{"combats":[{"combat":"<combat id>","rounds":[{"n":4,"turns":[{"actor":"occ_1_1","source_line":"Asp - Healing Hands","activities":[{"economy":"action","name":"Magic","detail":"Healing Hands","val_type":null,"outcomes":[{"res":"unclear","val":null,"target":null,"target_text":null,"detail":null,"effect":null}],"notes":null}]}],"enemy_turns":[{"actor":"occ_1_4","source_line":"Goblins - Hit Mal (opportunity)","activities":[{"economy":"reaction","name":"Opportunity Attack","outcomes":[{"res":"hit","val":null,"target":"occ_1_5"}]}],"special_events":[]}],"events":[]}]}],"quest_progress":[],"loot":[],"self_check":[]}`;
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
    for (const k of ['quest_progress', 'loot', 'self_check']) if (!Array.isArray(parsed[k])) parsed[k] = [];
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
    for (const l of facts.loot) {
      if (l.item != null && !occ.has(l.item)) errors.push(`Loot names "${l.item}" instead of an occurrence id.`);
      if (l.holder != null && !occ.has(l.holder)) errors.push(`Loot holder "${l.holder}" is not an occurrence id.`);
    }
    return [...new Set(errors)];
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
    const quest_progress = [], loot = [];
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
      quest_progress.push(...f.quest_progress.map(q => Object.assign({ page: p.page }, q)));
      loot.push(...f.loot.map(l => Object.assign({ page: p.page }, l)));
    }
    return {
      combats: [...combats.values()].map(m => ({ combat: m.combat, rounds: [...m.rounds.values()].sort((a, b) => a.n - b.n) })),
      quest_progress, loot, issues,
    };
  }

  const api = { ENUMS, pageReferences, combatChoices, factsPrompt, parseFacts, validateFacts, checkFacts, mergePages };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChronicleFacts = api;
})(typeof window !== 'undefined' ? window : globalThis);
