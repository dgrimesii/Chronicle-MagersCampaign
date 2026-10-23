/**
 * shared/chronicle-integrity.js
 *
 * Pure gap-detection logic for Chronicle integrity checking.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Gap detection originally lived inside admin/integrity.html as a single-page
 * function reading module globals. When delta-review.html needed the same
 * logic, the function was extracted here so both pages (and any future scanner
 * page) can share one canonical implementation.
 *
 * WHAT THIS MODULE DOES
 * ---------------------
 * Exports window.ChronicleIntegrity with:
 *   checks(campaignData, incomingData) — missing-round gap detection, used by
 *     delta-review.html and integrity.html (unchanged by #104)
 *   the nine sanity checks for combat rounds in the 5.0.0 turn schema
 *     (issue #104): imbalance, sourceLine, abilityOwnership, actionEconomy,
 *     outcomeCount, state, roundOrder, duplicates, gaps; roundChecks() runs
 *     all nine. Each returns flags { check, cell, message, suggestedMove? }.
 *     They are sanity checks, not controls: nothing here blocks publishing.
 *   abilityContext(campaign, pcAbilities) and partyNames(campaign) — the
 *     context the checks read
 * No DOM access, no API calls, no side effects.
 *
 * WHAT WOULD BREAK IF REMOVED
 * ----------------------------
 * delta-review.html and integrity.html both depend on this module.
 * Removing it without inlining checks() into both files will break gap
 * detection on both pages.
 *
 * LOAD ORDER
 * ----------
 * This module has no dependencies. When loaded alongside chronicle-ai.js,
 * the recommended order is:
 *   config.js → chronicle-integrity.js → chronicle-ai.js → page script
 */

window.ChronicleIntegrity = {

  /**
   * checks(campaignData, incomingData) → gap[]
   *
   * Detects missing rounds in both the existing campaign and a batch of
   * incoming (staged) session data. Returns a flat array of gap objects,
   * each describing a specific missing range within a specific combat.
   *
   * WHY THIS EXISTS
   * ---------------
   * The DM needs to know which combat rounds are missing before approving
   * or publishing session data. Catching gaps here — before the delta goes
   * to the campaign file — avoids committing incomplete records that are harder to find
   * and fix later.
   *
   * WHAT WOULD BREAK IF REMOVED
   * ----------------------------
   * The integrity panel in delta-review.html and the scan in integrity.html
   * would have no gap data to display. The Publish button gate (which blocks
   * publishing when unresolved gaps exist) would have nothing to check against.
   *
   * @param {object} campaignData
   *   Normalised campaign data fetched from the JSON. Must contain:
   *   campaignData.combat_encounters[]  — array of combat objects, each with:
   *     .id           {string}   combat ID (e.g. 'cbt_003')
   *     .name         {string}   human-readable combat name
   *     .sessions     {string[]} session IDs this combat spans
   *     .totalRounds  {number}   total rounds declared in mechanics
   *     .rounds       {Array}    round objects, each with .n (round number)
   *
   * @param {Array} incomingData
   *   Staged delta items representing the rounds about to be added. Each entry:
   *     .combatId    {string}  combat ID this round belongs to
   *     .roundNumber {number}  the round number being added
   *   Entries without combatId or roundNumber are ignored (they are non-round
   *   delta items such as NPC or session log additions).
   *   Pass [] if there is no incoming data — checks() returns only hard gaps.
   *
   * @returns {Array} gaps
   *   Flat array of gap objects. Empty array means no gaps found.
   *
   * Gap object shape:
   * {
   *   id:       string   — unique gap ID (e.g. 'g_cbt_003', 'gi_cbt_005', 'ct_cbt_005')
   *   group:    string   — display group: 'combat' | 'misc'
   *   sev:      string   — severity: 'critical' (blocks publish) | 'warning' (advisory)
   *   block:    boolean  — true if this gap blocks publishing
   *   isNew:    boolean  — true if the gap is in the incoming data; false if in existing records
   *   cbtId:    string   — combat ID
   *   cbtName:  string   — combat name (human-readable)
   *   sessHint: string   — session ID hint for where to look for corrections
   *   miss:     number[] — specific missing round numbers
   *   have:     number[] — round numbers that are present (context for the gap)
   *   rmin:     number   — lowest round number in the affected range
   *   rmax:     number   — highest round number in the affected range
   *   title:    string   — short human-readable gap label
   *   detail:   string   — HTML-safe longer description of the gap
   *   ctx:      string   — actionable guidance for the DM
   * }
   */
  checks(campaignData, incomingData) {
    const out = [];

    // --- Type 1: Existing-round gaps -------------------------------------------
    // For each committed combat, compare rounds[] against the expected contiguous
    // sequence [first..last]. Any missing number is a hard gap in the campaign record.
    // These are the most urgent: they represent data that was never captured.
    for (const cbt of campaignData.combat_encounters) {
      const ns = cbt.rounds.map(r => r.n).sort((a, b) => a - b);
      if (!ns.length) continue; // No rounds at all — skip; a separate count mismatch check will catch this.

      const miss = [];
      for (let i = ns[0]; i <= ns[ns.length - 1]; i++) {
        if (!ns.includes(i)) miss.push(i);
      }

      if (miss.length) {
        out.push({
          id: `g_${cbt.id}`,
          group: 'combat',
          sev: 'critical',
          block: true,
          isNew: false,
          cbtId: cbt.id,
          cbtName: cbt.name,
          sessHint: cbt.sessions?.join(', ') || '',
          miss,
          have: ns,
          rmin: ns[0],
          rmax: ns[ns.length - 1],
          title: `Round gap — ${cbt.name}`,
          detail: `Rounds ${miss.map(n => `<code>${n}</code>`).join(', ')} are missing. Sequence jumps from Round ${ns[ns.indexOf(miss[0]) - 1] || '?'} to Round ${miss[miss.length - 1] + 1}.`,
          ctx: `Check physical notes for ${cbt.name} Rounds ${miss[0]}–${miss[miss.length - 1]}. Use the correction workspace below to fill the gap.`,
        });
      }
    }

    // --- Type 2: Incoming-round gaps -------------------------------------------
    // Group the incoming delta items by combat ID. For each combat's incoming
    // rounds, check for holes in the sequence — same logic as Type 1 but applied
    // to staged data before it is committed.
    const byC = {};
    for (const d of incomingData) {
      if (d.combatId && d.roundNumber != null) {
        (byC[d.combatId] = byC[d.combatId] || []).push(d.roundNumber);
      }
    }

    for (const [cid, rns] of Object.entries(byC)) {
      const s = [...rns].sort((a, b) => a - b);
      const miss = [];
      for (let i = s[0]; i <= s[s.length - 1]; i++) {
        if (!s.includes(i)) miss.push(i);
      }

      if (miss.length) {
        const cbt = campaignData.combat_encounters.find(c => c.id === cid);
        out.push({
          id: `gi_${cid}`,
          group: 'combat',
          sev: 'critical',
          block: true,
          isNew: true,
          cbtId: cid,
          cbtName: cbt?.name || cid,
          sessHint: 'incoming session',
          miss,
          have: s,
          rmin: s[0],
          rmax: s[s.length - 1],
          title: `Incoming round gap — ${cbt?.name || cid}`,
          detail: `Intake produced Rounds ${s.join(', ')} for <code>${cid}</code>, but Round${miss.length > 1 ? 's' : ''} ${miss.map(n => `<code>${n}</code>`).join(', ')} ${miss.length > 1 ? 'are' : 'is'} missing.`,
          ctx: `The OCR may have missed a page. Check handwritten notes for Round${miss.length > 1 ? 's' : ''} ${miss[0]}${miss.length > 1 ? '–' + miss[miss.length - 1] : ''} and use the correction workspace.`,
        });
      }

      // --- Type 3: Continuity gaps -------------------------------------------
      // For combats that span multiple sessions, check that the incoming rounds
      // pick up exactly where the existing record left off. If there is a
      // numeric jump between existing max and incoming min, those round numbers
      // are a continuity gap — rounds that were never captured in either pass.
      const ex = campaignData.combat_encounters.find(c => c.id === cid);
      if (ex?.rounds?.length) {
        const exMax = Math.max(...ex.rounds.map(r => r.n));
        const incMin = Math.min(...s);
        if (incMin !== exMax + 1) {
          out.push({
            id: `ct_${cid}`,
            group: 'combat',
            sev: 'warning',
            block: false,
            isNew: true,
            cbtId: cid,
            cbtName: ex.name,
            sessHint: 'incoming session',
            miss: [],
            have: s,
            rmin: exMax + 1,
            rmax: incMin,
            title: `Continuity gap — ${ex.name}`,
            detail: `Existing log ends at Round <code>${exMax}</code>. Incoming rounds start at <code>${incMin}</code>.`,
            ctx: `Confirm Rounds 1–${exMax} are complete before appending new rounds.`,
          });
        }
      }
    }

    // --- Type 4: Round count mismatch ------------------------------------------
    // If a combat declares totalRounds but the actual rounds[] count doesn't
    // match, something is off. This is advisory — it may be that totalRounds
    // is stale after editing, or that rounds are genuinely missing.
    // Emitted as a warning (non-blocking) rather than a critical gap because
    // we cannot determine which specific round numbers are missing from count alone.
    for (const cbt of campaignData.combat_encounters) {
      if (cbt.totalRounds != null && cbt.totalRounds !== cbt.rounds.length) {
        out.push({
          id: `cnt_${cbt.id}`,
          group: 'misc',
          sev: 'warning',
          block: false,
          isNew: false,
          cbtId: cbt.id,
          cbtName: cbt.name,
          sessHint: cbt.sessions?.join(', ') || '',
          miss: [],
          have: [],
          rmin: null,
          rmax: null,
          title: `Round count mismatch — ${cbt.name}`,
          detail: `<code>totalRounds: ${cbt.totalRounds}</code> but ${cbt.rounds.length} round object${cbt.rounds.length !== 1 ? 's' : ''} exist.`,
          ctx: 'Update totalRounds or locate the missing data.',
        });
      }
    }

    return out;
  },

};

// ══════════════════════════════════════════════════════════════════════════
// Sanity checks for combat rounds (issue #104)
// ══════════════════════════════════════════════════════════════════════════
//
// WHY THESE EXIST
// The hardest errors in a recorded round are misreads: an action in the wrong
// character's row, one character with two actions and another with none, a
// downed character still attacking. The design (docs/intake-redesign.md,
// "Checks that find misalignment") uses nine checks to find them. The AI is
// asked to run them on its own reply (#101), and the round grid (#103)
// highlights the cells they flag. They are sanity checks, not controls: a flag
// never blocks publishing, because unusual notes are sometimes right.
//
// WHAT THEY READ
// A combat in the 5.0.0 turn schema: rounds[] of { n, slots[], enemy_turns[] },
// a slot { s, a, activities[], notes } and an enemy turn { actor_id,
// activities[] }. Two optional working fields the round grid adds, never
// written to the data: slot.source_line (the line of the notes the turn came
// from, #101) and slot.note_order (where the notes listed it). ctx is
// { abilities: abilityContext(...), names: partyNames(...), order? } where
// order is the confirmed initiative order [{ s, a, from?, to? }] (#103).
//
// FLAG SHAPE
// { check, cell: { combat, round, s?, actor_id?, activity? }, message,
//   suggestedMove?: { to, label } } — suggestedMove names the party member a
// misplaced action probably belongs to, for a one-click fix in the grid.
(function(CI) {
  'use strict';

  const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

  // Standard action names (5.0.0) and other names that are never an
  // ability a character must own.
  const GENERIC = new Set(['attack', 'dash', 'disengage', 'dodge', 'help', 'hide', 'influence', 'magic', 'ready',
    'search', 'study', 'utilize', 'death save', 'opportunity attack', 'move', 'movement', 'object interaction']);

  // Economies some abilities always use, for the wrong-economy part of the
  // action-economy check. pc-abilities.json's action_economy entries add to
  // and override these per character.
  const STATIC_ECONOMY = {
    'flurry of blows': 'bonus_action', 'cunning action': 'bonus_action', 'healing word': 'bonus_action',
    'misty step': 'bonus_action', 'shield': 'reaction', 'opportunity attack': 'reaction', 'absorb elements': 'reaction',
  };

  /**
   * partyNames(campaign) → Map party id → [names]
   * Name, nickname and recorded aliases: what a source line may call a PC.
   */
  CI.partyNames = function partyNames(campaign) {
    const m = new Map();
    for (const p of (campaign && campaign.party) || []) {
      m.set(p.id, [p.name, p.nickname, ...(Array.isArray(p.aliases) ? p.aliases : [])].filter(Boolean));
    }
    return m;
  };

  /**
   * abilityContext(campaign, pcAbilities) → Map party id → { names: Set, econ: Map, display }
   *
   * Every ability a PC is known to have: the harvested sheet
   * (data/pc-abilities.json: actions, spells, feats, action_economy) plus
   * every spell or feature the campaign already records that PC using. The
   * recorded ones are added because the harvested lists are incomplete
   * (Atticus's sheet lacks Cure Wounds, which he cast in the Goblin Ambush);
   * publish's known-spell list does the same (#92). The sheets show current
   * abilities, so an early session may pass something learned later, which is
   * acceptable for a sanity check (#104).
   */
  CI.abilityContext = function abilityContext(campaign, pcAbilities) {
    const ctx = new Map();
    const byLegacy = new Map(((campaign && campaign.party) || []).map(p => [p.legacy_id, p]));
    for (const p of (campaign && campaign.party) || []) ctx.set(p.id, { names: new Set(), econ: new Map(), display: p.nickname || p.name });
    for (const ch of (pcAbilities && pcAbilities.characters) || []) {
      const pc = byLegacy.get(ch.pc_id);
      if (!pc) continue;
      const c = ctx.get(pc.id);
      for (const n of [].concat(ch.actions || [], ch.spells || [], ch.feats || [])) c.names.add(norm(typeof n === 'string' ? n : n && n.name));
      for (const e of ch.action_economy || []) { c.names.add(norm(e.ability)); c.econ.set(norm(e.ability), e.action_type); }
    }
    for (const cbt of (campaign && campaign.combat_encounters) || []) {
      for (const r of cbt.rounds || []) for (const sl of r.slots || []) {
        const c = ctx.get(sl.a);
        if (!c) continue;
        for (const a of sl.activities || []) {
          const ab = abilityOf(a);
          if (ab) c.names.add(norm(ab));
        }
      }
    }
    return ctx;
  };

  // abilityOf(activity) → the spell or feature an activity uses, or null for
  // a standard action with no spell (Attack · Longsword, Dash).
  function abilityOf(a) {
    if (!a) return null;
    if (a.name === 'Magic') return a.detail || null;
    if (a.economy === 'action' || a.economy === 'movement' || a.economy === 'free') return null;
    return GENERIC.has(norm(a.name)) || /^no action/i.test(a.name || '') ? null : a.name;
  }

  // owns(context, ability) — the ability is on the list, allowing for added
  // words either way ("Witch Bolt ongoing damage" uses Witch Bolt).
  function owns(c, ability) {
    const n = norm(ability);
    if (!n || c.names.has(n)) return true;
    for (const k of c.names) if (k && (n.startsWith(k + ' ') || k.startsWith(n + ' '))) return true;
    return false;
  }

  const roundsOf = combat => (combat.rounds || []).slice().sort((x, y) => (x.n ?? 0) - (y.n ?? 0));
  const cell = (combat, r, extra) => Object.assign({ combat: combat.id, round: r.n }, extra);
  const displayOf = (ctx, id) => ctx.abilities?.get(id)?.display || (ctx.names?.get(id) || [])[1] || (ctx.names?.get(id) || [])[0] || id;
  const isActing = a => a && a.name !== 'Death Save' && !/^no action/i.test(a.name || '');

  // byActor(round) → Map party id → { slots, action, bonus } (several slots
  // for one PC in a round happen when a reaction is recorded on its own).
  function byActor(r) {
    const m = new Map();
    for (const sl of r.slots || []) {
      const e = m.get(sl.a) || { slots: [], action: 0, bonus: 0 };
      e.slots.push(sl);
      for (const a of sl.activities || []) {
        if (a.economy === 'action') e.action++;
        if (a.economy === 'bonus_action') e.bonus++;
      }
      m.set(sl.a, e);
    }
    return m;
  }

  // activeIn(combat, ctx, n) → party ids expected to act in round n: the
  // confirmed order's entries whose from/to range covers n, or (no order
  // yet) everyone who has a slot anywhere in the combat.
  function activeIn(combat, ctx, n) {
    if (ctx.order && ctx.order.length) return ctx.order.filter(o => (o.from == null || o.from <= n) && (o.to == null || o.to >= n)).map(o => o.a);
    const all = new Set();
    for (const r of combat.rounds || []) for (const sl of r.slots || []) all.add(sl.a);
    return [...all];
  }

  /** 1. Imbalance: one character with two actions while another has none in that round. */
  CI.imbalance = function imbalance(combat, ctx) {
    const flags = [];
    for (const r of roundsOf(combat)) {
      const m = byActor(r);
      const missing = activeIn(combat, ctx, r.n).filter(id => !m.has(id) || m.get(id).action === 0);
      if (!missing.length) continue;
      for (const [id, e] of m) if (e.action > 1) {
        flags.push({ check: 'imbalance', cell: cell(combat, r, { s: e.slots[0].s }),
          message: `Round ${r.n}: ${displayOf(ctx, id)} has ${e.action} actions while ${missing.map(x => displayOf(ctx, x)).join(', ')} has none. One may be misread.`,
          suggestedMove: missing.length === 1 ? { to: missing[0], label: 'Move to ' + displayOf(ctx, missing[0]) } : undefined });
      }
    }
    return flags;
  };

  // leadName(line, names) → the party id the line starts with, and the words
  // as written. "Att - Cure Wounds" → Atticus. A short form counts when it is
  // the start of exactly one PC's name or nickname (Att, Asp, Gold, Mal).
  function leadName(line, names) {
    const m = /^\s*([A-Za-z][A-Za-z'’]{1,})/.exec(String(line || ''));
    if (!m) return null;
    const tok = norm(m[1]);
    const hits = [];
    for (const [id, list] of names || []) {
      if (list.some(n => norm(n) === tok || (tok.length >= 3 && norm(n).startsWith(tok)))) hits.push(id);
    }
    return hits.length === 1 ? { id: hits[0], words: m[1] } : null;
  }

  // namesPc(line, id, names) — the line mentions that PC anywhere, by name
  // or short form. The DM's notes are often in two columns ("ASP - Healing
  // Hands   Goli - 2 Att"), so one line can hold two turns; the second
  // column's turn must not be flagged for the first column's name (found on
  // the real session 6 page 1, #103).
  function namesPc(line, id, names) {
    const list = (names && names.get(id)) || [];
    const words = String(line || '').split(/[^A-Za-z'’]+/).map(norm).filter(w => w.length >= 3);
    return words.some(w => list.some(n => norm(n) === w || norm(n).startsWith(w)));
  }

  /** 2. Source line: the line a turn came from names a different character than its row, and not its own. */
  CI.sourceLine = function sourceLine(combat, ctx) {
    const flags = [];
    for (const r of roundsOf(combat)) for (const sl of r.slots || []) {
      if (!sl.source_line) continue;
      const lead = leadName(sl.source_line, ctx.names);
      if (lead && lead.id !== sl.a && !namesPc(sl.source_line, sl.a, ctx.names)) {
        flags.push({ check: 'source-line', cell: cell(combat, r, { s: sl.s }),
          message: `Round ${r.n}: this turn's line names ${lead.words}, but it sits in ${displayOf(ctx, sl.a)}'s row ("${sl.source_line}").`,
          suggestedMove: { to: lead.id, label: 'Move to ' + lead.words } });
      }
    }
    return flags;
  };

  /** 3. Ability ownership: a spell or feature not on that PC's list. */
  CI.abilityOwnership = function abilityOwnership(combat, ctx) {
    const flags = [];
    if (!ctx.abilities) return flags;
    for (const r of roundsOf(combat)) for (const sl of r.slots || []) {
      const c = ctx.abilities.get(sl.a);
      if (!c || !c.names.size) continue;
      (sl.activities || []).forEach((a, i) => {
        const ab = abilityOf(a);
        if (!ab || owns(c, ab)) return;
        const owners = [...ctx.abilities].filter(([id, o]) => id !== sl.a && owns(o, ab) && o.names.size).map(([id]) => id);
        flags.push({ check: 'ability-ownership', cell: cell(combat, r, { s: sl.s, activity: i }),
          message: `Round ${r.n}: ${ab} is not on ${displayOf(ctx, sl.a)}'s ability list${owners.length ? '; ' + owners.map(o => displayOf(ctx, o)).join(' or ') + ' has it' : ''}.`,
          suggestedMove: owners.length === 1 ? { to: owners[0], label: 'Move to ' + displayOf(ctx, owners[0]) } : undefined });
      });
    }
    return flags;
  };

  /**
   * 4. Action economy: more than one action or bonus action in a round
   * without Action Surge; an enemy group with more actions than its recorded
   * starting count; an ability under an economy it never uses.
   */
  CI.actionEconomy = function actionEconomy(combat, ctx) {
    const flags = [];
    const roster = new Map(((combat.mechanics && combat.mechanics.enemies_roster) || []).map(g => [g.actor_id, g]));
    for (const r of roundsOf(combat)) {
      for (const [id, e] of byActor(r)) {
        const c = ctx.abilities?.get(id);
        const surge = c && owns(c, 'Action Surge');
        if (e.action > 1 && !surge) flags.push({ check: 'action-economy', cell: cell(combat, r, { s: e.slots[0].s }), message: `Round ${r.n}: ${displayOf(ctx, id)} takes ${e.action} actions with no feature that allows it.` });
        if (e.bonus > 1) flags.push({ check: 'action-economy', cell: cell(combat, r, { s: e.slots[0].s }), message: `Round ${r.n}: ${displayOf(ctx, id)} takes ${e.bonus} bonus actions.` });
        for (const sl of e.slots) (sl.activities || []).forEach((a, i) => {
          const key = norm(a.name === 'Magic' ? a.detail : a.name);
          const want = (c && c.econ.get(key)) || STATIC_ECONOMY[key];
          if (want && a.economy !== want) flags.push({ check: 'action-economy', cell: cell(combat, r, { s: sl.s, activity: i }),
            message: `Round ${r.n}: ${a.name === 'Magic' ? a.detail : a.name} is recorded as ${a.economy} but uses the ${want}.` });
        });
      }
      for (const t of r.enemy_turns || []) {
        const g = roster.get(t.actor_id);
        const n = (t.activities || []).filter(a => a.economy === 'action').length;
        if (g && Number.isFinite(g.count) && g.count > 0 && n > g.count) flags.push({ check: 'action-economy', cell: cell(combat, r, { actor_id: t.actor_id }),
          message: `Round ${r.n}: ${t.actor_id} takes ${n} actions but started with ${g.count}.` });
      }
    }
    return flags;
  };

  // statedCount(activity) → the number of attacks the notes state ("3 Melee
  // Attacks", "Unarmed (x2)", "2 Att", "×3"), or null.
  function statedCount(a) {
    const text = [a.detail, a.notes].filter(Boolean).join(' ');
    const m = /\(\s*[x×]\s*(\d+)\s*\)|[x×]\s*(\d+)\b|\b(\d+)\s*(?:melee |ranged )?(?:attacks?|att|hits|strikes)\b/i.exec(text);
    return m ? Number(m[1] || m[2] || m[3]) : null;
  }

  /** 5. Outcome count: more or fewer outcomes than the notes or the feature imply. */
  CI.outcomeCount = function outcomeCount(combat, ctx) {
    const flags = [];
    const check = (r, extra, a, i, who) => {
      const n = a.outcomes ? a.outcomes.length : 0;
      const stated = statedCount(a);
      if (stated != null && n && n !== stated) flags.push({ check: 'outcome-count', cell: cell(combat, r, Object.assign({ activity: i }, extra)),
        message: `Round ${r.n}: ${who}'s ${a.name}${a.detail ? ' · ' + a.detail : ''} states ${stated} attacks but ${n} ${n === 1 ? 'is' : 'are'} recorded.` });
      else if (norm(a.name) === 'flurry of blows' && n && n !== 2) flags.push({ check: 'outcome-count', cell: cell(combat, r, Object.assign({ activity: i }, extra)),
        message: `Round ${r.n}: ${who}'s Flurry of Blows has ${n} strike${n === 1 ? '' : 's'}; it makes two.` });
    };
    for (const r of roundsOf(combat)) {
      for (const sl of r.slots || []) (sl.activities || []).forEach((a, i) => check(r, { s: sl.s }, a, i, displayOf(ctx, sl.a)));
      for (const t of r.enemy_turns || []) (t.activities || []).forEach((a, i) => check(r, { actor_id: t.actor_id }, a, i, t.actor_id));
    }
    return flags;
  };

  /**
   * 6. State: acting after being downed or killed, or before joining; a
   * downed creature doing anything but Death Save or No Action; a released
   * readied action with no Ready before it.
   *
   * Timing follows the design: a party member's blow takes effect at once,
   * so later slots in that round see it; an enemy's effects happen sometime
   * during its round, so they count from the next round. For the same reason
   * an enemy is judged by its state at the start of the round: the Ogre
   * swinging in round 3 and being killed by Att in round 3 is consistent.
   * A heal on the downed creature, in between, brings it back. Older rounds
   * often leave a heal's target_id empty and write "Target: Asphodel" in the
   * notes, so a heal with no target heals the PCs its notes name. Enemy
   * groups are left out (one goblin dying does not stop the group).
   */
  CI.state = function state(combat, ctx) {
    const flags = [];
    const status = new Map();   // target → 'downed' | 'killed'
    const individual = new Set(((combat.mechanics && combat.mechanics.enemies_roster) || []).filter(g => g.type === 'individual').map(g => g.actor_id));
    const tracked = id => (ctx.names && ctx.names.has(id)) || individual.has(id);
    // isHeal: recorded as healing, or a healing spell or feature by name.
    const isHeal = a => a.val_type === 'healing' || /\b(heal|healing|cure wounds|revivify|potion|goodberry)\b/i.test([a.name, a.detail].join(' '));
    // namedIn(text) → the PCs a note names ("Target: Asphodel", "Del").
    const namedIn = text => [...(ctx.names || [])].filter(([, list]) => list.some(n => n && new RegExp('\\b' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(text))).map(([id]) => id);
    const apply = (a, now, pending, slotNotes) => {
      for (const o of a.outcomes || []) {
        if (isHeal(a)) {
          const healed = o.target_id ? [o.target_id] : namedIn([a.notes, slotNotes, o.target_text, o.notes].filter(Boolean).join(' '));
          // A heal also cancels a downing still pending from an enemy this
          // round: Att healing Del after the slingers drop him is consistent.
          for (const id of healed) {
            if (status.get(id) === 'downed') status.delete(id);
            if (pending.get(id) === 'downed') pending.delete(id);
          }
        }
        if (!o.target_id || !tracked(o.target_id)) continue;
        if (o.effect === 'downed' || o.effect === 'killed') (now ? status : pending).set(o.target_id, o.effect);
      }
    };
    for (const r of roundsOf(combat)) {
      const pending = new Map();
      const atStart = new Map(status); // enemies are judged by this (see above)
      // Enemy effects are gathered first, as pending: they happen sometime in
      // the round, so a party heal later in the slot order can still cancel
      // them (the slingers drop Del, then Att heals him, in round 2).
      for (const t of r.enemy_turns || []) {
        if (individual.has(t.actor_id) && atStart.get(t.actor_id) === 'killed' && (t.activities || []).length) flags.push({ check: 'state', cell: cell(combat, r, { actor_id: t.actor_id }), message: `Round ${r.n}: ${t.actor_id} acts after being killed.` });
        for (const a of t.activities || []) apply(a, false, pending, t.notes);
      }
      const slots = (r.slots || []).slice().sort((x, y) => (x.s ?? 0) - (y.s ?? 0));
      for (const sl of slots) {
        // A downed PC whose own turn is a heal (eating a Goodberry someone
        // gave them) is back up for that turn.
        if (status.get(sl.a) === 'downed' && (sl.activities || []).some(isHeal)) status.delete(sl.a);
        const st = status.get(sl.a);
        const joined = !ctx.order || !ctx.order.length || ctx.order.some(o => o.a === sl.a && (o.from == null || o.from <= r.n));
        if (!joined) flags.push({ check: 'state', cell: cell(combat, r, { s: sl.s }), message: `Round ${r.n}: ${displayOf(ctx, sl.a)} acts before joining the combat.` });
        if (st === 'killed' && (sl.activities || []).length) flags.push({ check: 'state', cell: cell(combat, r, { s: sl.s }), message: `Round ${r.n}: ${displayOf(ctx, sl.a)} acts after being killed.` });
        else if (st === 'downed' && (sl.activities || []).some(isActing)) flags.push({ check: 'state', cell: cell(combat, r, { s: sl.s }),
          message: `Round ${r.n}: ${displayOf(ctx, sl.a)} was downed and has not been healed, but does more than a Death Save or No Action.` });
        (sl.activities || []).forEach((a, i) => {
          if (a.economy === 'reaction' && a.ready_ref) {
            const rr = roundsOf(combat).find(x => x.n === a.ready_ref.round);
            const src = rr && (rr.slots || []).find(x => x.s === a.ready_ref.s);
            if (!src || !(src.activities || []).some(x => x.name === 'Ready')) flags.push({ check: 'state', cell: cell(combat, r, { s: sl.s, activity: i }),
              message: `Round ${r.n}: ${displayOf(ctx, sl.a)} releases a readied action, but no Ready is recorded at round ${a.ready_ref.round}, slot ${a.ready_ref.s}.` });
          }
          apply(a, true, pending, sl.notes);
        });
      }
      for (const [k, v] of pending) status.set(k, v);
    }
    return flags;
  };

  /** 7. Round order: the notes list a round's turns in a different order from the initiative order. */
  CI.roundOrder = function roundOrder(combat, ctx) {
    const flags = [];
    for (const r of roundsOf(combat)) {
      const listed = (r.slots || []).filter(sl => Number.isFinite(sl.note_order)).sort((x, y) => x.note_order - y.note_order).map(sl => sl.s);
      const sorted = listed.slice().sort((x, y) => x - y);
      if (listed.length > 1 && listed.join() !== sorted.join()) flags.push({ check: 'round-order', cell: cell(combat, r, {}),
        message: `Round ${r.n}: the notes list the turns as slots ${listed.join(', ')}, not in initiative order. The round may be misread.` });
    }
    return flags;
  };

  /** 8. Duplicates: the same action, result and value in two cells of one round. */
  CI.duplicates = function duplicates(combat, ctx) {
    const flags = [];
    for (const r of roundsOf(combat)) {
      const seen = new Map();
      const cells = [].concat((r.slots || []).map(sl => ({ key: 's' + sl.s, extra: { s: sl.s }, acts: sl.activities || [], who: displayOf(ctx, sl.a) })),
        (r.enemy_turns || []).map(t => ({ key: 'e' + t.actor_id, extra: { actor_id: t.actor_id }, acts: t.activities || [], who: t.actor_id })));
      for (const c of cells) for (const a of c.acts) for (const o of a.outcomes || []) {
        if (o.val == null) continue; // without a value, two "hit"s are normal
        const k = [a.economy, a.name, a.detail || '', o.res, o.val].join('|');
        const first = seen.get(k);
        if (first && first.key !== c.key) flags.push({ check: 'duplicates', cell: cell(combat, r, c.extra),
          message: `Round ${r.n}: ${c.who} and ${first.who} both have ${a.name}${a.detail ? ' · ' + a.detail : ''}, ${o.res} ${o.val}. One may be copied.` });
        else if (!first) seen.set(k, c);
      }
    }
    return flags;
  };

  /** 9. Gaps: an active entity with no turn in a round (often legitimate: down or absent). */
  CI.gaps = function gaps(combat, ctx) {
    const flags = [];
    for (const r of roundsOf(combat)) {
      const has = new Set((r.slots || []).map(sl => sl.a));
      for (const id of activeIn(combat, ctx, r.n)) if (!has.has(id)) flags.push({ check: 'gaps', cell: cell(combat, r, {}),
        message: `Round ${r.n}: ${displayOf(ctx, id)} has no turn. Fine if they were down or absent.` });
    }
    return flags;
  };

  /**
   * roundChecks(combat, ctx) → every flag from the nine checks.
   * Run on every change in the round grid (#103). Advisory only: there is no
   * blocking field, and publish never reads these.
   */
  CI.roundChecks = function roundChecks(combat, ctx) {
    const c = ctx || {};
    return [].concat(CI.imbalance(combat, c), CI.sourceLine(combat, c), CI.abilityOwnership(combat, c), CI.actionEconomy(combat, c),
      CI.outcomeCount(combat, c), CI.state(combat, c), CI.roundOrder(combat, c), CI.duplicates(combat, c), CI.gaps(combat, c));
  };

  CI.SANITY_CHECKS = ['imbalance', 'source-line', 'ability-ownership', 'action-economy', 'outcome-count', 'state', 'round-order', 'duplicates', 'gaps'];
})(window.ChronicleIntegrity);
