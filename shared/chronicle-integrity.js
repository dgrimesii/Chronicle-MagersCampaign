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
 * Exports window.ChronicleIntegrity with a single method: checks().
 * No DOM access, no API calls, no side effects. Load it anywhere you need
 * gap detection and call ChronicleIntegrity.checks(campaignData, incomingData).
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
   * to Drive — avoids committing incomplete records that are harder to find
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
