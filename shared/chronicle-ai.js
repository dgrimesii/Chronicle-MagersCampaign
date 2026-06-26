/**
 * chronicle-ai.js
 * Shared AI module for Chronicle — used by both the Integrity Checker
 * and the Delta Review screen.
 *
 * Responsibilities:
 *   - Raw fetch to Anthropic /v1/messages (one place, one error handler)
 *   - JSON response parsing + markdown fence stripping
 *   - Realistic fallback data when the API is unreachable
 *   - A loading/thinking state callback so callers can show UI feedback
 *   - Image content helpers (base64 encode from File or data-URL)
 *
 * Callers provide:
 *   - system prompt (they own the schema, Chronicle owns the plumbing)
 *   - message array
 *   - onResult(text) callback
 *   - onError(err) callback
 *   - onLoading(bool) callback (optional)
 *
 * Nothing in this file knows about rounds, diffs, or cascades.
 * That logic lives in the page that calls it.
 */

const ChronicleAI = (() => {

  // ─────────────────────────────────────────────────────────
  // Config
  // ─────────────────────────────────────────────────────────
  const API_URL  = 'https://api.anthropic.com/v1/messages';
  // Fix #23: was 'claude-sonnet-4-20250514' (pre-release/beta snapshot ID that
  // the production API rejects with HTTP 400). Use the canonical production alias.
  const MODEL    = 'claude-sonnet-4-6';
  // 4096 tokens: complex corrections with 15+ diffs across multiple rounds can
  // exceed 2500. 4096 is the safe upper bound for single-response JSON payloads.
  const MAX_TOKENS = 4096;

  // ─────────────────────────────────────────────────────────
  // Party roster — shared context injected into every prompt
  // ─────────────────────────────────────────────────────────
  const PARTY_CONTEXT = [
    'pc_001 = Zragar / Gold (Wizard)',
    'pc_002 = Malachite / Mal (Barbarian)',
    'pc_003 = Ashton / Ash (Warlock)',
    'pc_004 = Asphodel / Del (Monk)',
    'pc_005 = Derwin / Goli (Rogue)',
    'pc_006 = Atticus / Att (Druid)',
  ].join(', ');

  // Exposed so callers can embed it into system prompts
  const PARTY_ROSTER = PARTY_CONTEXT;

  // ─────────────────────────────────────────────────────────
  // Action economy reference — lazy-fetched at module init (issue #89)
  // ─────────────────────────────────────────────────────────
  // Start fetching pc-abilities.json immediately when this module loads so the
  // data is cached and ready by the time the DM clicks Interpret. The promise
  // is awaited lazily inside fillRoundsFromText() and fillRoundsFromImage().
  //
  // Why fetch at init rather than on demand: Interpret is usually clicked within
  // seconds of the page loading; fetching on demand would add a network round-trip
  // on the critical path. Fetching at init amortises that cost during page load.
  //
  // Silent failure: if the fetch fails or the file is malformed, _pcAbilitiesPromise
  // resolves to null. fillRoundsFromText/Image then skips the injection block and
  // the AI falls back to ROUND_SYSTEM_STRICT rule 7 alone (which covers standard
  // 5e defaults but not party-specific cases like Nick weapon mastery).
  const _pcAbilitiesPromise = fetch('../data/pc-abilities.json')
    .then(r => r.ok ? r.json() : null)
    .catch(() => null);

  /**
   * _buildActionEconomySummary(pcAbilities)
   *
   * Converts the action_economy arrays from pc-abilities.json into a compact
   * multi-line reference string suitable for prepending to AI prompts.
   *
   * Why: ROUND_SYSTEM_STRICT rule 7 covers standard 5e action types, but cannot
   * know party-specific exceptions — e.g. Goli's Nick weapon mastery making her
   * off-hand dagger attack cost an Action rather than a Bonus Action. This summary
   * gives the AI a per-character lookup so it uses the correct action_type instead
   * of falling back to the 5e default.
   *
   * Format: one line per character with non-empty action_economy, e.g.:
   *   Goli (pc_005): Nick (Dagger) = action (Nick mastery: ...) | Cunning Action = bonus_action (...)
   *
   * Returns null if pcAbilities is null/malformed or no characters have entries,
   * so callers can skip injection when there is nothing to add.
   */
  function _buildActionEconomySummary(pcAbilities) {
    if (!pcAbilities || !Array.isArray(pcAbilities.characters)) return null;

    const lines = [];
    for (const ch of pcAbilities.characters) {
      if (!Array.isArray(ch.action_economy) || !ch.action_economy.length) continue;
      // Each entry formatted as "ability = action_type (note)" joined by " | "
      const entries = ch.action_economy
        .map(e => `${e.ability} = ${e.action_type}${e.note ? ' (' + e.note + ')' : ''}`)
        .join(' | ');
      lines.push(`${ch.nickname} (${ch.pc_id}): ${entries}`);
    }

    return lines.length ? lines.join('\n') : null;
  }

  // ─────────────────────────────────────────────────────────
  // Core call
  // ─────────────────────────────────────────────────────────
  /**
   * call({ system, messages, onResult, onError, onLoading })
   *
   * system   — string system prompt
   * messages — array of { role: 'user'|'assistant', content: string|array }
   * onResult(rawText)  — called with the full text response
   * onError(err)       — called on network/API error
   * onLoading(bool)    — called with true before fetch, false after (optional)
   */
  async function call({ system, messages, onResult, onError, onLoading }) {
    const apiKey = window.CHRONICLE_CONFIG?.anthropicApiKey;
    if (!apiKey || apiKey === 'YOUR_KEY_HERE' || apiKey.trim() === '') {
      if (typeof onError === 'function') {
        onError('Anthropic API key not configured. Add your key to shared/config.js.');
      }
      return;
    }

    onLoading?.(true);
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system,
          messages,
        }),
      });

      if (!response.ok) {
        // Fix #25: read the response body before throwing so the Anthropic error
        // message (e.g. "model not found", "invalid api key") is included in the
        // thrown error and surfaced to the DM in the status bar.
        // Without this, all failures show as "HTTP 400: Bad Request" with no detail.
        let detail = response.statusText;
        try {
          const errBody = await response.json();
          detail = errBody?.error?.message || JSON.stringify(errBody);
        } catch (_) { /* body not JSON — keep statusText */ }
        throw new Error(`HTTP ${response.status}: ${detail}`);
      }

      const data = await response.json();

      // Handle error response from API
      if (data.type === 'error') {
        throw new Error(data.error?.message || 'Unknown API error');
      }

      const text = (data.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');

      window.tpShowResponse?.(text);
      onResult(text);
    } catch (err) {
      onError(err);
    } finally {
      onLoading?.(false);
    }
  }

  // ─────────────────────────────────────────────────────────
  // JSON extraction helper
  // Extracts and parses a JSON object from the AI response.
  //
  // Why multiple strategies exist: the AI is instructed to respond with JSON
  // only, but sometimes includes reasoning text before/after the code block, or
  // (on complex corrections with many diffs) runs out of tokens and truncates
  // the response before the JSON is properly closed.
  //
  // Strategy order: 1=fenced JSON, 2=bare fences, 3=balanced-brace walker,
  // 4=partial recovery (extract whatever diffs survived truncation).
  // Each strategy falls through to the next on parse failure.
  // ─────────────────────────────────────────────────────────
  function parseJSON(raw) {
    // Strategy 1: extract the content between ```json ... ``` fences anywhere in
    // the response. [\s\S]*? matches newlines too; non-greedy stops at first ```.
    // Wrapped in try/catch so a truncated response inside the fence falls through
    // to Strategy 4 rather than surfacing a parse error.
    const fenceMatch = raw.match(/```json\s*([\s\S]*?)```/);
    if (fenceMatch) {
      try { return JSON.parse(fenceMatch[1].trim()); } catch(e) { /* fall through */ }
    }

    // Strategy 2: no language tag — bare ``` fences — only attempt if the
    // captured content looks like a JSON object (starts with '{').
    const plainFence = raw.match(/```\s*([\s\S]*?)```/);
    if (plainFence && plainFence[1].trim().startsWith('{')) {
      try { return JSON.parse(plainFence[1].trim()); } catch(e) { /* fall through */ }
    }

    // Strategy 3: no fences at all — find the first '{' and walk forward to the
    // matching '}' using a brace counter. This handles responses where the AI
    // omits code fences AND appends trailing explanation text after the JSON
    // object, which would cause JSON.parse(raw.slice(objStart)) to throw.
    const objStart = raw.indexOf('{');
    if (objStart !== -1) {
      let depth = 0, inStr = false, escape = false, end = -1;
      for (let i = objStart; i < raw.length; i++) {
        const ch = raw[i];
        if (escape)          { escape = false; continue; }
        if (ch === '\\' && inStr) { escape = true; continue; }
        if (ch === '"')      { inStr = !inStr; continue; }
        if (inStr)           continue;
        if (ch === '{')      depth++;
        else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end !== -1) {
        try { return JSON.parse(raw.slice(objStart, end + 1)); } catch(e) { /* fall through */ }
      }
    }

    // Strategy 4: partial recovery for truncated responses.
    // When the AI hits the token limit mid-response the JSON is never closed, so
    // all three strategies above fail. Rather than returning diffs:[] (which
    // hides the Apply button entirely), we walk the diffs array and extract every
    // complete diff object that was emitted before the cutoff.
    // The DM sees a "(response truncated)" warning alongside any recoverable diffs.
    const diffsStart = raw.indexOf('"diffs"');
    if (diffsStart !== -1) {
      const arrOpen = raw.indexOf('[', diffsStart);
      if (arrOpen !== -1) {
        const recovered = [];
        let pos = arrOpen + 1;
        while (pos < raw.length) {
          // Skip whitespace and commas between objects
          while (pos < raw.length && /[\s,]/.test(raw[pos])) pos++;
          if (raw[pos] !== '{') break; // Hit ']' end or truncation
          // Walk to find the end of this complete diff object
          let d = 0, inS = false, esc = false, objEnd = -1;
          for (let i = pos; i < raw.length; i++) {
            const c = raw[i];
            if (esc)               { esc = false; continue; }
            if (c === '\\' && inS) { esc = true;  continue; }
            if (c === '"')         { inS = !inS;   continue; }
            if (inS)               continue;
            if (c === '{')         d++;
            else if (c === '}')    { d--; if (d === 0) { objEnd = i; break; } }
          }
          if (objEnd === -1) break; // Truncated mid-object — stop here
          try { recovered.push(JSON.parse(raw.slice(pos, objEnd + 1))); }
          catch(e) { break; }
          pos = objEnd + 1;
        }
        if (recovered.length > 0) {
          // Extract the content field if it was emitted before truncation
          const contentMatch = raw.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          const contentText  = contentMatch
            ? contentMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')
            : '';
          return {
            content:     contentText + '\n\n⚠ Response was truncated — showing ' + recovered.length + ' recoverable diff(s).',
            diffs:       recovered,
            cascades:    [],
            globalScope: [],
          };
        }
      }
    }

    // Final fallback: trim and parse. Will throw if none of the above worked,
    // and the caller's catch block will wrap it as a plain content response.
    return JSON.parse(raw.trim());
  }

  // ─────────────────────────────────────────────────────────
  // Image content builder
  // Accepts: File object, data-URL string, or { media_type, data } object
  // Returns an Anthropic image content block
  // ─────────────────────────────────────────────────────────
  function imageContent(source) {
    // Already a content block
    if (source && source.type === 'image') return source;

    // Data-URL string  e.g. "data:image/jpeg;base64,/9j/..."
    if (typeof source === 'string' && source.startsWith('data:')) {
      const [header, data] = source.split(',');
      const media_type = header.split(';')[0].split(':')[1];
      return { type: 'image', source: { type: 'base64', media_type, data } };
    }

    // Raw { media_type, data }
    if (source && source.data) {
      return { type: 'image', source: { type: 'base64', media_type: source.media_type || 'image/jpeg', data: source.data } };
    }

    throw new Error('imageContent: unrecognised source format');
  }

  /**
   * readFileAsDataURL(file) → Promise<string>
   * Converts a File/Blob to a data-URL suitable for imageContent()
   */
  function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = e => resolve(e.target.result);
      reader.onerror = () => reject(new Error('FileReader failed'));
      reader.readAsDataURL(file);
    });
  }

  // ─────────────────────────────────────────────────────────
  // Thinking indicator helper
  // Returns the HTML string for the three animated dots used
  // in chat threads while waiting for a response.
  // ─────────────────────────────────────────────────────────
  const THINKING_HTML =
    '<span class="thinking-dot">●</span> ' +
    '<span class="thinking-dot" style="animation-delay:0.2s">●</span> ' +
    '<span class="thinking-dot" style="animation-delay:0.4s">●</span>';

  // ─────────────────────────────────────────────────────────
  // ── INTEGRITY CHECKER specialisation ─────────────────────
  //
  // Provides the system prompt and response parser for the
  // round-gap filling workflow.  Returns round proposal objects
  // in the shape the integrity checker expects.
  // ─────────────────────────────────────────────────────────
  const ROUND_SYSTEM_BASE = `You are a D&D 5e combat log transcription assistant.
Your ONLY job is to convert the user's description into structured JSON.

STRICT RULES — not guidelines:
1. Every value in the JSON must be directly stated in the user's text.
   If no damage number was given, value must be omitted or null.
   If hit/miss was not stated, result must be "unclear".
2. Use the EXACT action name the user wrote. Never substitute a different
   spell or ability name even if you think it is equivalent.
3. Do not use your knowledge of D&D or these characters to fill gaps.
   Absent information stays absent.
4. Include only enemy actions explicitly described by the user.
5. Output ONE JSON object only. No explanation, no markdown fences.

Party actor IDs (use exactly as shown):
${PARTY_CONTEXT}

Output schema:
{"rounds":[{"round_number":<n>,"session_id":"<sid>","initiative_grid":[{"slot":<1-6>,"actor_id":"pc_XXX","action":"<exact text from description>","result":"hit|miss|crit|save|success|neutral|unclear","value":<number or null>,"notes":"<string or null>"}],"enemy_actions":[{"description":"<string>","impact":"<string or null>"}]}]}

If a slot was not described, include it with action:"not described", result:"unclear", value:null.`;

  // Strict transcription system prompt for text-based round generation
  const ROUND_SYSTEM_STRICT = `You are a D&D 5e combat log transcription assistant. Your only job is to
convert a human-written round description into structured JSON.

RULES — these are absolute, not guidelines:

1. TRANSCRIBE, DO NOT INVENT.
   Every value in the JSON must come directly from the text the user provided.
   If the user did not state a damage number, value must be null.
   If the user did not state whether an attack hit or missed, result must be "unclear".
   Do not use your knowledge of D&D, the characters, or prior rounds to fill gaps.

2. ACTION NAMES ARE LITERAL.
   Use the exact action name the user wrote. If the user wrote "Concussive Burst",
   the action field must say "Concussive Burst". Never substitute a different spell
   or ability name, even if you believe it is equivalent or more accurate.

3. NULL MEANS NULL.
   If a field has no value in the user's description, output null for that field.
   Do not estimate, interpolate, or use "likely" values.
   The "notes" field is for DM-written text only. Never put your own reasoning,
   actor identification, turn-sequence labels ("First attack"), or inference notes
   into it. If you have nothing from the user's text to put there, use null.

4. ENEMY ACTIONS ONLY FROM TEXT.
   Only include enemy_actions entries for enemies explicitly described by the user.
   Do not add enemy actions that seem likely or consistent with the combat context.

5. ONE ENTRY PER OUTCOME.
   A D&D turn may include a main action, a bonus action, and a reaction. Produce a
   separate initiative_grid entry for each. Bonus actions and reactions share the same
   slot number and actor_id as the main action — they are distinguished by action_type.
   If a character has no bonus action or reaction recorded, do not add entries for them.

   MULTIPLE ATTACK ROLLS: If an action involves more than one attack roll (Extra Attack,
   Flurry of Blows, Multiattack, "2 attacks", etc.), produce ONE entry per roll. Each
   entry shares the same slot, actor_id, action name, and action_type. Each gets its own
   result, value, target, and target_effects for that specific roll.
   NEVER collapse multiple attack rolls into a single entry with res:"mixed" — always split.

   FAMILIAR ACTIONS: If a character's familiar uses an action on the caster's turn (most
   commonly the Help action to grant advantage), record it as a SEPARATE initiative_grid
   entry on the same slot with the same actor_id. Use the familiar's action as the "action"
   field (e.g. "Help (Familiar)") and action_type:"free_action" — the familiar acts
   independently; the caster spends no action or bonus action to direct it.
   Never put familiar actions in the notes field of the caster's main action entry.

   MULTI-TARGET ABILITIES: If a single action affects more than one target (Acid Splash,
   Fireball, Burning Hands, Shatter, any AoE or save-or-X spell), produce ONE entry per
   target. Each entry shares the same slot, actor_id, action name, action_type, and value
   (the single damage roll applies to all targets). Each entry gets its own target name
   and result (that specific target's saving throw outcome — "fail" if they failed, "save"
   if they succeeded). NEVER set target to null and collapse all outcomes into one entry
   when specific targets are described — always split one entry per target.

6. ONE JSON OBJECT ONLY.
   Output a single JSON object. No explanation, no preamble, no markdown fences.
   If you cannot parse a slot from the user's text, include it with
   action: "unclear", result: "unclear", value: null, action_type: "action".

7. ACTION TYPE.
   Set action_type to one of these values, or null:
     "action"       — the character's main action
     "bonus_action" — a bonus action taken in the same turn
     "reaction"     — a reaction (opportunity attack, shield, etc.)
     "free_action"  — a free action (drop item, speak, etc.)
     null           — when you genuinely do not know and cannot determine it (see below)

   USE YOUR D&D 5e KNOWLEDGE: Note-takers write during a live game and do not annotate
   action economy. You must infer action_type from the ability name using standard 5e rules.
   This campaign uses the 2024 D&D Player's Handbook rules where they differ from 2014.
   If you recognise the ability as a standard D&D 5e ability with a known action cost, use it.
   Examples:
     - Flurry of Blows, Two-Weapon Fighting (off-hand), Cunning Action → "bonus_action"
     - Witch Bolt ongoing damage (activating on subsequent turns) → "bonus_action" [2024 rule]
     - Most spells, attacks, Help, Dash, Disengage, Hide → "action"
     - Opportunity Attack, Shield (spell), Counterspell, Absorb Elements → "reaction"
     - Drop item, speak a few words → "free_action"

   LEAVE NULL only when:
     - The ability name is campaign-specific, homebrew, or unrecognisable as a standard 5e ability
     - A class feature or weapon property may have substituted a different action slot
       (see ACTION ECONOMY SUBSTITUTIONS below) and you are not certain whether it applies
     - You cannot identify the ability with enough confidence to assign an action type

   REACTION RESET: A reaction resets at the START of a character's own turn (not end of
   round). A character whose turn falls mid-round may use a reaction before their turn
   (e.g. Shield against an attack) and again after their turn ends (reaction has reset).
   Two reaction entries for the same slot in one round is valid — do not deduplicate.

   ACTION ECONOMY SUBSTITUTIONS: Some class features change which action slot an ability
   uses. For example, the Nick weapon mastery property lets an off-hand attack consume the
   main Attack action instead of a bonus action — record that as action_type:"action".
   When a substitution might be in effect and you are not certain it applies, use null
   rather than guessing either the original or the modified cost.

8. TARGET.
   Set target to the descriptive name of what was targeted: "goblin", "dragon", "self",
   "goblin leader". Use null ONLY when no target is described at all. Never use a PC/NPC
   id — use the natural name as written in the log.
   For multi-target abilities: produce one entry per target per rule 5 — do NOT set
   target to null and merge all outcomes into one entry.

9. TARGET EFFECTS.
   Set target_effects to an array of outcomes that happened to the target as a direct
   result of this action. Use only values from this list:
     "killed", "downed", "unconscious", "stunned", "restrained", "prone",
     "frightened", "blinded", "concentration_broken", "escaped"
   Use an empty array [] when none apply. Never infer — only populate from explicit text.

10. VALUE TYPE.
    Set val_type to classify what the val number represents:
      "damage"  — hit points lost by target
      "healing" — hit points restored
      "temp_hp" — temporary hit points granted
    Use null when val is null or the type is unclear.

11. NEW ENTITIES.
    Before the rounds array, include a "new_entities" array listing every distinct entity
    that appears in enemy_actions. For each entry:
      "name" — use the most specific name the text provides. If a creature is named fully
               early in the text and then shortened later (e.g. "Lurkspur Dragon" → "dragon"),
               use the full name and emit only ONE entry. Never create a separate entry for
               a shorthand that refers to an already-listed entity.
      "type" — use exactly one of:
                 "monster" — a creature type that the bestiary tracks as a category.
                   Use this for any creature that is interchangeable with others of its
                   kind in this encounter: "goblins", "hobgoblins", "Lurkspur Dragon"
                   (a dragon species). One entry per species — not one per individual.
                 "npc"     — a specific individual who stands apart from the generic group
                   through narrative significance. A formal name is NOT required. Use "npc"
                   when the text singles out one creature as individually important —
                   because they took a unique action (stole something, taunted the party,
                   escaped), have a distinguishing description ("the shaman with blue hair",
                   "the hobgoblin carrying the banner"), or are clearly meant to recur.
                   An NPC can be hostile and appear in combat. Use the most specific
                   identifier the text gives — a description is fine when no name is known.
                   The test: could this individual return in a future session as a distinct
                   entity, separate from the rest of their group? If yes, npc. If they are
                   interchangeable with the others around them, monster.
      "desc" — one sentence describing the entity from the text context
    Do NOT list individual instances of a monster type ("Goblin #1", "Goblin #2").
    The caller deduplicates against the existing bestiary; always include the full list.`;

  // ─────────────────────────────────────────────────────────
  // Narrative extraction system prompt — used by extractNarrativeEntities().
  //
  // Why separate from ROUND_SYSTEM_STRICT: round extraction requires a known
  // combat context (name, ID, party roster in slot order). Narrative extraction
  // has no combat context — it needs different output fields and different rules.
  // Combining them would require the caller to lie about combat context for
  // pure-narrative pages, producing confusing empty round arrays alongside
  // the actual entity content.
  //
  // Also used by fillRoundsFromText() when the AI detects non-round content
  // on a mixed page — the caller passes onNarrative() which fires when
  // parsed.narrative is non-empty in the combined response.
  // ─────────────────────────────────────────────────────────
  const NARRATIVE_EXTRACT_SYSTEM = `You are a D&D 5e session notes transcription assistant for the Magers Campaign.
Your job is to extract structured entity data from prose session notes — handwritten or typed text
that describes what happened in the session WITHOUT combat round structure.

PARTY MEMBERS (do not list these as NPCs):
${PARTY_CONTEXT}

RULES — these are absolute, not guidelines:

1. TRANSCRIBE, DO NOT INVENT.
   Every value in the JSON must come directly from the text provided.
   If the text does not explicitly name a location, do not infer one.
   If a quest hint is ambiguous, record what the text says verbatim as quest_hint.

2. DO NOT LIST PARTY MEMBERS AS NPCS.
   The party members listed above are known PCs. Never add them to the npcs array.

3. NULL MEANS NULL.
   If a field has no stated value in the text, use null. Do not estimate or infer.

4. ONE JSON OBJECT ONLY.
   Output a single JSON object. No explanation, no preamble, no markdown fences.
   If nothing extractable is found in a category, use an empty array [].

5. QUEST HINTS.
   quest_hint should be the quest name or a brief identifying phrase from the text.
   Use the exact name as written if known (e.g. "Escort to Lake Town").
   progress_entry should be a single sentence describing what happened with the quest.

6. ITEMS AND LOOT.
   Include any items, coins, treasure, or rewards found or received by the party.
   Each item should be a separate entry. For coin stacks (cp, sp, gp), use one entry
   per denomination (e.g. name: "1400 cp", description: "Copper pieces from dragon's lair").
   For named items (Bag of Holding, Immovable Rod, etc.), include the full name and any
   description given in the text. Generic potions ("2x Potion of Healing") can be grouped
   as one entry with the quantity in the name (e.g. name: "Potion of Healing ×2").

Output schema:
{
  "npcs": [
    { "name": "<NPC name>", "role": "<brief role or description from text>", "disposition": "friendly|neutral|hostile|unknown" }
  ],
  "locations": [
    { "name": "<location name>", "description": "<one sentence from the text>" }
  ],
  "quest_updates": [
    { "quest_hint": "<quest name or identifying phrase>", "progress_entry": "<one sentence: what happened>" }
  ],
  "items": [
    { "name": "<item or coin name>", "description": "<source or context from text, or null>" }
  ],
  "session_notes": "<one or two sentence DM-reference summary of the page — not a cascade item>"
}`;

  /**
   * fillRoundsFromImage({ images, combatName, combatId, sessionId, roundNumbers, onResult, onError, onLoading })
   * Calls the Vision API to extract round data from handwritten note images.
   * onResult receives an array of normalised proposal objects.
   */
  async function fillRoundsFromImage({ images, combatName, combatId, sessionId, roundNumbers, onResult, onError, onLoading }) {
    const imageBlocks = images.map(imageContent);

    // Inject action economy reference into the image OCR prompt so the AI uses
    // character-specific action types (e.g. Nick = action) rather than 5e defaults.
    // Await the promise fetched at module init — it resolves immediately if already cached.
    // If the fetch failed, pcAbilities is null and economySummary is null → no injection.
    const pcAbilities = await _pcAbilitiesPromise;
    const economySummary = _buildActionEconomySummary(pcAbilities);

    const system = `${ROUND_SYSTEM_BASE}\nCombat: ${combatName} (${combatId}). Session: ${sessionId}. Extract only Rounds: ${roundNumbers.join(', ')}.` +
      (economySummary
        ? '\n\n[ACTION ECONOMY REFERENCE — use these instead of 5e defaults for these abilities]\n' +
          economySummary + '\n[END ACTION ECONOMY REFERENCE]'
        : '');

    const messages = [{
      role: 'user',
      content: [
        ...imageBlocks,
        { type: 'text', text: `Please extract the combat round data for Rounds ${roundNumbers.join(', ')} from these handwritten notes.` },
      ],
    }];

    let responded = false;
    await call({
      system, messages,
      onLoading: loading => { if (loading || !responded) onLoading?.(loading); },
      onResult: raw => {
        responded = true;
        try {
          const parsed = parseJSON(raw);
          onResult(_normaliseRoundProposals(parsed.rounds || [], roundNumbers, sessionId, 'image'));
        } catch (e) {
          onError(e);
        }
      },
      onError: e => { responded = true; onError(e); },
    });
  }

  /**
   * fillRoundsFromText({ text, combatName, combatId, sessionId, roundNumbers, onResult, onError, onLoading })
   * Sends a plain-language description to the API and converts it to round proposals.
   * onResult receives an array of normalised proposal objects.
   */
  async function fillRoundsFromText({ text, combatName, combatId, sessionId, roundNumbers, onResult, onError, onLoading, onEntities, onNarrative }) {
    // onEntities(entities) — optional callback receiving [{name, type, desc}] for any
    // new entity the AI flags in enemy_actions (rule 11 of ROUND_SYSTEM_STRICT).
    // Callers can use this to queue cascade items without a second AI call.
    //
    // onNarrative(narrative) — optional callback receiving the structured narrative
    // block when the AI detects non-round content on the page (issue #90 Branch B).
    // Fires only when parsed.narrative is non-empty. Shape mirrors extractNarrativeEntities()
    // output: { npcs, locations, quest_updates, session_notes }.
    // Pure combat pages with no narrative content will not trigger this callback.
    const rosterLines = [
      'slot 1: Zragar/Goldie (pc_001)',
      'slot 2: Malachite/Mal (pc_002)',
      'slot 3: Ashton/Ash (pc_003)',
      'slot 4: Asphodel/Del (pc_004)',
      'slot 5: Derwin/Goli (pc_005)',
      'slot 6: Atticus/Att (pc_006)',
    ].join('\n');

    // Schema shown to the AI. Uses full field names (action/result/value) because
    // that is what the AI naturally produces — _normaliseRoundProposals maps them
    // to the abbreviated internal names (act/res/val) used by renderRoundNL.
    //
    // new_entities is placed FIRST in the schema so the AI emits it before the
    // potentially-large rounds array. If the response is truncated (token limit),
    // the entity list survives because it was generated early. Placing it last
    // caused it to be cut off when processing two or more rounds of OCR text.
    //
    // Five example entries in initiative_grid teach the multi-entry patterns:
    //   1+2. Two attack rolls from one actor (slot 1, both action_type:"action") —
    //        prevents collapsing Extra Attack / Flurry of Blows into res:"mixed".
    //   3.   A bonus action on the same slot (slot 1, action_type:"bonus_action").
    //   4+5. AoE spell hitting two targets (slot 2, both action_type:"action") —
    //        One damage roll (value:4) shared by both entries. Each target gets its own
    //        result (their individual saving throw) and target name. This models Acid
    //        Splash, Fireball, etc. — one roll, per-target saves, each target an entry.
    const schemaExample = '{\n' +
      '"new_entities": [\n' +
      '  { "name": "<creature type or NPC name>", "type": "monster|npc", "desc": "<one sentence from text>" }\n' +
      '],\n' +
      '"rounds":[{\n' +
      '  "round_number": <number>,\n' +
      '  "session_id": "<string>",\n' +
      '  "initiative_grid": [\n' +
      '    {\n' +
      '      "slot": 1, "actor_id": "pc_001", "action_type": "action",\n' +
      '      "action": "attack", "result": "hit", "value": 7, "val_type": "damage",\n' +
      '      "target": "goblin", "target_effects": ["killed"], "notes": null\n' +
      '    },\n' +
      '    {\n' +
      '      "slot": 1, "actor_id": "pc_001", "action_type": "action",\n' +
      '      "action": "attack", "result": "miss", "value": null, "val_type": null,\n' +
      '      "target": "goblin", "target_effects": [], "notes": null\n' +
      '    },\n' +
      '    {\n' +
      '      "slot": 1, "actor_id": "pc_001", "action_type": "bonus_action",\n' +
      '      "action": "<bonus action name>", "result": "hit", "value": null, "val_type": null,\n' +
      '      "target": null, "target_effects": [], "notes": null\n' +
      '    },\n' +
      '    {\n' +
      '      "slot": 2, "actor_id": "pc_002", "action_type": "action",\n' +
      '      "action": "Acid Splash", "result": "fail", "value": 4, "val_type": "damage",\n' +
      '      "target": "goblin", "target_effects": [], "notes": null\n' +
      '    },\n' +
      '    {\n' +
      '      "slot": 2, "actor_id": "pc_002", "action_type": "action",\n' +
      '      "action": "Acid Splash", "result": "save", "value": 4, "val_type": "damage",\n' +
      '      "target": "goblin", "target_effects": [], "notes": null\n' +
      '    }\n' +
      '  ],\n' +
      '  "enemy_actions": [\n' +
      '    { "description": "<string>", "impact": "<string or null>" }\n' +
      '  ]\n' +
      '}],\n' +
      // Optional narrative block for mixed pages (issue #90 Branch B).
      // Include ONLY when non-round content appears on the same page (NPC introductions,
      // location references, quest updates, post-combat narrative). Omit entirely for
      // pure combat pages — the callback fires only when this block is present and non-empty.
      //
      // narrative.npcs is for individuals who stand apart from the generic group through
      // narrative significance. A formal name is NOT required — use the best identifier
      // the text provides ("the shaman with blue hair", "the hobgoblin who escaped with the
      // amulet"). An NPC can be hostile and can appear in combat.
      //
      // Do NOT use narrative.npcs for generic creature types (dragon, goblin, hobgoblin, wolf)
      // that are interchangeable with others of their kind. Those belong in new_entities as
      // type:"monster". The distinction: the hobgoblins in a fight = monster; the one hobgoblin
      // shaman who taunted the party and fled with the McGuffin = npc.
      '"narrative": {\n' +
      '  "npcs": [{ "name": "<individual identifier — name or description; not a generic creature type>", "role": "<brief description>", "disposition": "friendly|neutral|hostile|unknown" }],\n' +
      '  "locations": [{ "name": "<location name>", "description": "<one sentence>" }],\n' +
      '  "quest_updates": [{ "quest_hint": "<quest name>", "progress_entry": "<one sentence>" }],\n' +
      '  "items": [{ "name": "<item or coin name>", "description": "<source/context or null>" }],\n' +
      '  "session_notes": "<one sentence DM-reference summary>"\n' +
      '}\n' +
      '}';

    // Open-ended mode (roundNumbers null/falsy): the caller doesn't know which rounds
    // are in the text (OCR interpret path). Tell the AI to extract all rounds it finds.
    // Specific-rounds mode (roundNumbers is an array): caller knows the target set
    // (integrity checker filling known missing rounds). Enumerate them explicitly.
    // Without this guard, passing [1..30] caused the AI to produce 29 empty "unclear"
    // rounds for pages with only 1 real round (issue #90 bug report).
    const roundLabel = !roundNumbers || !roundNumbers.length
      ? 'all rounds found in the text'
      : roundNumbers.length === 1
        ? 'round ' + roundNumbers[0]
        : 'rounds ' + roundNumbers.join(', ');

    // Inject action economy reference so the AI uses character-specific action types
    // (e.g. Nick (Dagger) = action) rather than 5e defaults (which would be bonus_action).
    // Await the module-init fetch — resolves instantly if already cached.
    // economySummary is null when the fetch failed or file has no entries → block omitted.
    const pcAbilities = await _pcAbilitiesPromise;
    const economySummary = _buildActionEconomySummary(pcAbilities);

    const userMessage =
      // Prepend action economy reference block when available.
      // Placed before the combat description so the AI processes it as context
      // before encountering the ability names in the round text.
      (economySummary
        ? '[ACTION ECONOMY REFERENCE — use these instead of 5e defaults for these abilities]\n' +
          economySummary + '\n' +
          '[END ACTION ECONOMY REFERENCE]\n\n'
        : '') +
      'Convert the following combat description to JSON for ' + roundLabel + '.' +
      '\n\nCombat: ' + combatName +
      '\nSession: ' + sessionId +
      '\nParty roster for this combat (use these actor_ids exactly):\n' +
      rosterLines +
      '\n\nUser description (treat as authoritative ground truth):\n' +
      text +
      '\n\nRequired JSON schema:\n' + schemaExample +
      '\n\nRemember: output ONLY the JSON. null for any field not stated above.';

    const messages = [{ role: 'user', content: userMessage }];

    window.tpShowPrompt?.(ROUND_SYSTEM_STRICT, userMessage);

    // Track whether onResult has fired to prevent onLoading(false) from
    // triggering a duplicate render in the caller.
    let responded = false;
    await call({
      system: ROUND_SYSTEM_STRICT,
      messages,
      onLoading: loading => { if (loading || !responded) onLoading?.(loading); },
      onResult: raw => {
        responded = true;
        try {
          const parsed = parseJSON(raw);
          onResult(_normaliseRoundProposals(parsed.rounds || [], roundNumbers, sessionId, 'text'));
          // Fire onEntities with any new entity flags the AI included (rule 11).
          // Callers that don't pass onEntities simply ignore this field.
          if (onEntities && Array.isArray(parsed.new_entities) && parsed.new_entities.length) {
            onEntities(parsed.new_entities);
          }
          // Fire onNarrative when the AI included a narrative block alongside the rounds.
          // This handles mixed pages (combat + narrative content on the same page).
          // Guard: only fire when the block is present and at least one sub-array is non-empty,
          // so pure combat pages never trigger the narrative cascade item creation path.
          if (onNarrative && parsed.narrative) {
            const n = parsed.narrative;

            // Dedup: remove narrative.npcs entries whose name matches a new_entities entry
            // with type:"monster". The AI sometimes puts a generic creature type (e.g. a dragon
            // species) into both new_entities as a monster AND narrative.npcs, which would create
            // duplicate entries — one in the bestiary and one in npc_directory.
            //
            // The filter is restricted to type:"monster" entries. A named individual (type:"npc"
            // in new_entities) may legitimately also appear in narrative.npcs — e.g. a named
            // antagonist who fights the party is both a new combat entity and a narrative NPC.
            // Filtering those out would silently drop valid NPC cascade items.
            //
            // Name comparison is case-insensitive to catch capitalisation differences.
            if (Array.isArray(n.npcs) && Array.isArray(parsed.new_entities) && parsed.new_entities.length) {
              const monsterNames = new Set(
                parsed.new_entities
                  .filter(e => e.type === 'monster')
                  .map(e => e.name.toLowerCase())
              );
              n.npcs = n.npcs.filter(npc => !monsterNames.has(npc.name.toLowerCase()));
            }

            const hasContent = (Array.isArray(n.npcs) && n.npcs.length)
                            || (Array.isArray(n.locations) && n.locations.length)
                            || (Array.isArray(n.quest_updates) && n.quest_updates.length)
                            || (Array.isArray(n.items) && n.items.length)
                            || n.session_notes;
            if (hasContent) onNarrative(n);
          }
        } catch (e) {
          onError(e);
        }
      },
      onError: e => { responded = true; onError(e); },
    });
  }

  /** Internal: convert raw API round objects to proposal shape.
   *
   * targetNums: when provided, only rounds whose round_number is in the array are kept.
   * When null/falsy (open-ended mode for OCR interpret), all rounds the AI returned are kept.
   *
   * Why the open-ended guard: interpretRawItem() doesn't know which round numbers are on
   * the page before calling the AI. Passing [1..30] caused the AI to produce all 30 rounds
   * (29 empty "unclear" ones) because the user message said "convert for rounds 1, 2, ..., 30".
   * Passing null tells the AI to extract whatever rounds it finds, then accept them all here.
   */
  function _normaliseRoundProposals(rounds, targetNums, sessionId, source) {
    return rounds
      .filter(r => !targetNums || targetNums.includes(r.round_number))
      .map(r => ({
        n:       r.round_number,
        sid:     r.session_id || sessionId,
        source,
        status:  'pending',
        slots:   (r.initiative_grid || []).map(s => ({
          s:              s.slot,
          a:              s.actor_id,
          // act/res/val are the abbreviated names renderRoundNL and applyDiff SLOT_FIELD_MAP use.
          // The AI produces full names (action/result/value); we translate here so the rest
          // of the codebase only deals with one shape.
          act:            s.action,
          res:            s.result   || 'neutral',
          val:            s.value    || null,
          notes:          s.notes    || null,
          // New fields (issue #75) — passed through verbatim, no abbreviation.
          // action_type classifies action economy (action/bonus_action/reaction/free_action).
          // target is a descriptive name string; target_effects is a controlled-vocab array.
          // val_type distinguishes damage from healing when val is non-null.
          action_type:    s.action_type    || null,
          target:         s.target         || null,
          target_effects: Array.isArray(s.target_effects) ? s.target_effects : [],
          val_type:       s.val_type       || null,
        })),
        enemy: (r.enemy_actions || []).map(e => ({
          desc:   e.description,
          impact: e.impact || null,
        })),
        summary: r.round_summary || null,
      }));
  }

  /**
   * extractNarrativeEntities({ text, sessionId, onResult, onError, onLoading })
   *
   * Sends OCR text from a non-combat session page to the AI and extracts structured
   * entity data — NPCs, locations, quest updates, and a session summary note.
   *
   * Why a separate method from fillRoundsFromText: round extraction requires a combat
   * name and ID. Pure narrative pages have no combat context. Calling fillRoundsFromText
   * for a narrative page would require fabricating a combat ID, and the AI would return
   * an empty rounds array alongside the entity data — needlessly confusing the result shape.
   *
   * onResult receives the parsed JSON object directly:
   *   { npcs, locations, quest_updates, session_notes }
   * The caller (delta-review.html _processNarrativeResult) converts these into cascade items.
   *
   * What breaks if removed: the '-- Non-Combat --' path in interpretRawItem() has no AI call.
   */
  async function extractNarrativeEntities({ text, sessionId, onResult, onError, onLoading }) {
    const userMessage =
      'Extract structured entity data from the following session notes.\n\n' +
      'Session ID: ' + sessionId + '\n\n' +
      'Session notes (treat as authoritative ground truth — do not invent content ' +
      'not found in the text):\n' + text +
      '\n\nReturn ONLY the JSON object. No explanation, no markdown fences.';

    const messages = [{ role: 'user', content: userMessage }];

    await call({
      system: NARRATIVE_EXTRACT_SYSTEM,
      messages,
      onLoading,
      onResult: raw => {
        try {
          const parsed = parseJSON(raw);
          onResult(parsed);
        } catch (e) {
          onError(e);
        }
      },
      onError,
    });
  }

  // ─────────────────────────────────────────────────────────
  // ── DELTA REVIEW specialisation ──────────────────────────
  //
  // Provides the system prompt and response parser for the
  // correction-assistant workflow.  Returns a correction
  // response object with diffs, cascades, global-scope, etc.
  // ─────────────────────────────────────────────────────────
  const CORRECTION_SYSTEM = `You are a D&D 5e campaign log correction assistant for the Magers Campaign.

Party: ${PARTY_CONTEXT}

You help the DM correct errors in session intake deltas. When given a correction note you:
1. Propose specific field changes as a "diffs" array: [{"k":"field path","old":"old value","new":"new value"}]
2. If the correction implies a new entity that doesn't exist (e.g. a location name), include a "cascades" array describing what new items should be queued
3. If the correction could apply to multiple pending items, include a "globalScope" array of affected item titles
4. Always explain your reasoning in plain language in "content"

Respond ONLY with valid JSON. Do not include any reasoning, explanation, or text outside the JSON object — put your explanation inside the "content" field.
{
  "content": "plain language explanation of what you changed and why",
  "diffs": [{"k": "field · subfield", "old": "previous value", "new": "corrected value"}],
  "cascades": [{"type": "NEW location|npc|item|quest|monster", "desc": "description of new item to queue", "entityHint": {"name":"...","type":"..."}}],
  "globalScope": ["item title 1", "item title 2"]
}

Omit diffs, cascades, or globalScope if not applicable. Never omit content. Never write text before or after the JSON block.

STRUCTURAL CORRECTIONS — reorder operation (ROUND items only):
When the initiative order is wrong (wrong actor in the wrong slot, two actors swapped,
etc.), use the reorder operation instead of individual k/old/new diffs:
  {"op": "reorder", "slots": [<full replacement slots array>]}

Use reorder when two or more actors need to swap slot positions, or when an actor_id
needs to move from one slot position to another. Do NOT use reorder for single-field
fixes (wrong action name, wrong result, wrong value) — use the standard k/old/new diff
for those. Only use reorder when the slot assignments themselves are wrong.

When producing a reorder, copy the ENTIRE current slots array from "Current data" above
exactly as shown, then change only the actor_id (and slot number if applicable) on the
affected entries. Preserve all other field values verbatim — action, result, value, notes,
action_type, target, target_effects, val_type must all be copied unchanged. Use the
PARTY ROSTER in the user message to confirm the correct actor_ids for each slot.

Entity type rules for cascades:
- Use type "monster" for any D&D creature: dragons, drakes, beasts, undead, constructs, humanoid enemies (goblins, ogres, etc.), and any entity that would appear in a monster manual. These go to the bestiary array.
- Use type "npc" only for named persons with agency: merchants, guards, quest-givers, allies, villains who speak and make decisions, and similar characters.
- Never use type "npc" for a creature that would appear in a monster manual entry. A dragon is always type "monster", not type "npc".
- The entityHint.type field must be exactly one of: location, npc, monster, item, quest. Never invent a type not in this list. If the correction implies something that does not fit any of these types, omit the cascade entirely rather than inventing a new type name.

For items of type RAW (uninterpreted OCR text), the rawData contains only one
field: "ocr_text". These items are confirmed OCR output that the DM is now
correcting. You MUST return a diff for any correction to OCR text — do not
treat it as "not applicable". Use k:"ocr_text", old: the exact phrase as it
currently appears in the ocr_text value, new: the corrected phrase. Diff only
the changed portion — never return the entire text block as old/new.

For items of type ROUND (combat round data), the rawData contains:
  "slots": array of initiative slot objects. Multiple entries may share the same slot
    number and actor_id in two cases:
      (a) Different action types: one for the main action, one for a bonus action, one for a reaction.
      (b) Multiple attack rolls within one action (Extra Attack, Flurry of Blows, Multiattack,
          "2 attacks", etc.): one entry PER ROLL, all sharing the same slot, actor_id, action name,
          and action_type. Each roll has its own result, value, target, and target_effects.
          NEVER correct multiple attacks into a single entry with result:"mixed" — always split.
    Each slot entry has these fields:
      "action"       — what the actor did (exact name, string)
      "result"       — one of: hit / miss / crit / save_fail / save_success / mixed /
                       success / neutral / unclear / crit_miss
      "value"        — damage or healing number, or null
      "val_type"     — "damage" | "healing" | "temp_hp" | null
      "action_type"  — "action" | "bonus_action" | "reaction" | "free_action"
      "target"       — descriptive target name string, or null
      "target_effects" — array of condition strings, or empty array []. Allowed values:
                         "killed" / "downed" / "unconscious" / "stunned" / "restrained" /
                         "prone" / "frightened" / "blinded" / "concentration_broken" / "escaped"
      "notes"        — extra context or null
  "enemy_turns": array of enemy action objects, each with:
    "description" — what the enemy did (string)

Use bracket-path notation to target individual slot or enemy fields in diffs.
Slot indices are 0-based and count across ALL slot entries including bonus actions and reactions:
  k:"slots[2].action"             → corrects slot index 2's action text
  k:"slots[2].result"             → corrects slot index 2's result
  k:"slots[2].value"              → corrects slot index 2's damage value
  k:"slots[2].val_type"           → corrects slot index 2's value type
  k:"slots[2].action_type"        → corrects slot index 2's action category
  k:"slots[2].target"             → corrects slot index 2's target name
  k:"slots[2].target_effects"     → replaces the entire target_effects array; "new" must be
                                     the full replacement array, e.g. ["killed"] or []
  k:"slots[0].notes"              → corrects slot 0's notes
  k:"enemy_turns[0].description"  → corrects the first enemy action text

Always quote the current value in "old" so the DM can see the before/after.
For target_effects, "old" should be the current array and "new" the replacement array.
Never produce a cascade for a ROUND correction — round data is self-contained.`;

  /**
   * sendCorrectionToAI({ correctionText, itemContext, scope, pendingItems, campaignRoster, onResult, onError, onLoading })
   *
   * correctionText  — what the DM typed
   * itemContext     — object describing the current delta item { title, type, array, rawData }
   * scope           — 'item' | 'global'
   * pendingItems    — array of { title } for global scope scan
   * campaignRoster  — optional string built by buildCampaignRoster() in delta-review.html.
   *                   When provided it is prepended to CORRECTION_SYSTEM so the AI treats
   *                   all existing entities as known facts and avoids proposing duplicates.
   *                   When absent (empty string or undefined) the base system prompt is used
   *                   unchanged — this keeps the function safe to call without roster context.
   * onResult(response) — called with parsed correction response object
   * onError / onLoading as usual
   */
  async function sendCorrectionToAI({ correctionText, itemContext, scope, pendingItems = [], campaignRoster = '', entityContext = '', onResult, onError, onLoading }) {
    // Context serialization — ROUND vs non-ROUND items have different truncation needs.
    //
    // ROUND items: the slots array is the critical payload for structural corrections
    // (reorder op). A round with 6 slots, multiple attack rolls, bonus actions, and
    // reactions can produce ~3–5KB of JSON — well within 6000 chars — but truncation
    // risks cutting off the final slots and leaving the AI with an incomplete array to
    // copy from. For ROUND items we skip truncation entirely so the AI always receives
    // the full current state to work from.
    //
    // Non-ROUND items: the 6000-char limit is kept. RAW OCR items (the only other large
    // payload) were raised to 6000 from 800 in issue #76 — that covers any realistic
    // single-page OCR block without exceeding the prompt context window.
    const isRound = itemContext?.type === 'ROUND';
    const rawJson = JSON.stringify(itemContext?.rawData || {}, null, 2);
    const contextStr = isRound ? rawJson : rawJson.slice(0, 6000);

    // For ROUND items, inject the party roster directly into the user message so the
    // AI sees slot assignments alongside the slots array. This is the same roster that
    // ROUND_SYSTEM_STRICT embeds, repeated here so the AI can use it when deciding
    // which actor_id belongs in which slot during a reorder correction.
    // Non-ROUND corrections do not need this — they have no slot-assignment context.
    const rosterBlock = isRound
      ? '\nPARTY ROSTER (slot → actor_id):\n' +
        'slot 1: Zragar/Goldie (pc_001)\n' +
        'slot 2: Malachite/Mal (pc_002)\n' +
        'slot 3: Ashton/Ash (pc_003)\n' +
        'slot 4: Asphodel/Del (pc_004)\n' +
        'slot 5: Derwin/Goli (pc_005)\n' +
        'slot 6: Atticus/Att (pc_006)\n'
      : '';

    const scopeNote  = scope === 'global'
      ? `\nThis correction may apply broadly. Pending items: ${pendingItems.map(i => i.title).join('; ')}`
      : '';

    // Prepend the campaign roster to the base system prompt when available.
    // The roster gives the AI ground-truth entity lists so it matches existing
    // entries rather than proposing new ones that already exist in the campaign.
    // An empty roster string leaves the base prompt unchanged.
    const system = campaignRoster
      ? campaignRoster + '\n\n' + CORRECTION_SYSTEM
      : CORRECTION_SYSTEM;

    // entityContext carries the type-scoped existing-entity list for NPC, location, and
    // monster cascade items (issue #56). It is placed here — in the user message — rather
    // than the system prompt so it is sent exactly once per conversation, not repeated
    // with every turn. An empty string (the default for all other item types) leaves the
    // user message unchanged.
    const entityBlock = entityContext ? entityContext + '\n' : '';

    const messages = [{
      role: 'user',
      content: `Correction note: "${correctionText}"
${rosterBlock}${entityBlock}
Current item: ${itemContext?.title || 'unknown'} (${itemContext?.type || ''} · ${itemContext?.array || ''})
Current data:
${contextStr}${scopeNote}`,
    }];

    await call({
      system,
      messages,
      onLoading,
      onResult: raw => {
        try {
          const parsed = parseJSON(raw);
          onResult(parsed);
        } catch (e) {
          // If JSON parse fails, wrap the raw text as a plain content response
          onResult({ content: raw, diffs: [], cascades: [], globalScope: [] });
        }
      },
      onError,
    });
  }

  // ─────────────────────────────────────────────────────────
  // Fallback / demo data
  // Used when the API is unreachable (CORS, network, etc.)
  // Both callers can use these to keep the UI functional.
  // ─────────────────────────────────────────────────────────

  /** Demo round proposals for the integrity checker */
  function demoRoundProposals(roundNumbers, sessionId, source) {
    const db = {
      2: { n:2, sid:sessionId||'session_004', source, status:'pending',
        slots:[
          {s:1,a:'pc_004',act:'2 attacks',res:'hit',val:'8',notes:'1 Axe Beak wounded'},
          {s:2,a:'pc_001',act:'Firebolt',res:'miss'},
          {s:3,a:'pc_002',act:'Longsword',res:'hit',val:'11'},
          {s:4,a:'pc_003',act:'Eldritch Blast',res:'hit',val:'9'},
          {s:5,a:'pc_006',act:'Starry Wisp',res:'miss'},
          {s:6,a:'pc_005',act:'Short bow',res:'hit',val:'6'},
        ],
        enemy:[{desc:'Axe Beak charges Del',impact:'Del takes 8 dmg'}],
        summary:'Del takes a hit; party continues pressing the Axe Beak.',
      },
      3: { n:3, sid:sessionId||'session_004', source, status:'pending',
        slots:[
          {s:1,a:'pc_004',act:'2 unarmed attacks',res:'hit',val:'10'},
          {s:2,a:'pc_001',act:'Firebolt',res:'hit',val:'5'},
          {s:3,a:'pc_002',act:'Longsword',res:'miss'},
          {s:4,a:'pc_003',act:'Witch Bolt',res:'hit',val:'8'},
          {s:5,a:'pc_006',act:'Entangle',res:'success',notes:'Swarm restrained'},
          {s:6,a:'pc_005',act:'Short bow SA',res:'hit',val:'11',notes:'Axe Beak bloodied'},
        ],
        enemy:[{desc:'Vespon swarm attacks Gold',impact:'Gold 5 dmg'}],
        summary:null,
      },
      9: { n:9, sid:sessionId||'session_006', source, status:'pending',
        slots:[
          {s:1,a:'pc_004',act:'Unarmed (x2)',res:'hit',val:'8'},
          {s:2,a:'pc_002',act:'Melee',res:'miss'},
          {s:3,a:'pc_006',act:'Starry Wisp',res:'hit',val:'5'},
          {s:4,a:'pc_005',act:'Shortbow',res:'hit',val:'9'},
          {s:5,a:'pc_003',act:'Eldritch Blast',res:'miss'},
          {s:6,a:'pc_001',act:'Firebolt',res:'hit',val:'6'},
        ],
        enemy:[{desc:'Goblin slinger hits Ash',impact:'Ash 4 dmg'}],
        summary:null,
      },
    };

    return roundNumbers.map(n => db[n] || {
      n, sid: sessionId || 'session_004', source, status: 'pending',
      slots: Object.keys({ pc_001:1,pc_002:2,pc_003:3,pc_004:4,pc_005:5,pc_006:6 }).map((a,i) => ({
        s: i+1, a, act: 'Action', res: 'hit', val: String(Math.ceil(Math.random()*8)+2),
      })),
      enemy: [], summary: null,
    });
  }

  /**
   * Demo correction responses for the delta review screen.
   * Keyed by patterns found in the correction text.
   */
  function demoCorrectionResponse(correctionText, itemContext) {
    const t = correctionText.toLowerCase();

    if (t.includes('old bridge') || t.includes('bridge')) {
      return {
        content: "I'll update the combat location to the Old Bridge. Since this location doesn't exist yet, I've also queued a new location entry for your review.",
        diffs: [{ k: 'location_id', old: 'loc_002 (The Quarry)', new: 'loc_new_01 (Old Bridge)' }],
        cascades: [{ type: 'NEW location', desc: 'loc_new_01 — "The Old Bridge" added to review queue', entityHint: { name: 'The Old Bridge', type: 'location' } }],
        globalScope: [],
      };
    }
    if (t.includes('shillelagh')) {
      return {
        content: `Correcting the uncertain "Shillelagh [?]" reading. Confirmed as Shillelagh and removing the uncertainty flag.`,
        diffs: [{ k: 'action', old: 'Shillelagh [?]', new: 'Shillelagh' }],
        cascades: [], globalScope: [],
      };
    }
    if (t.includes('surround') || (t.includes('tactical') && itemContext?.roundNumber === 11)) {
      return {
        content: `Correcting Round 11, Slot 5 (Mal). Changing "Surrender" to "Surround" — a tactical encirclement consistent with Barbarian positioning.`,
        diffs: [{ k: 'Mal (slot 5) · action', old: 'Surrender [?]', new: 'Surround (tactical encirclement)' }],
        cascades: [], globalScope: [],
      };
    }
    if (t.includes('all rounds') || t.includes('throughout') || t.includes('every round')) {
      return {
        content: `Scanning all pending rounds for matches to: "${correctionText.slice(0,60)}". Found potential matches in 3 items.`,
        diffs: [],
        cascades: [],
        globalScope: ['Round 10', 'Round 11', 'Round 12'],
      };
    }

    // Generic fallback
    return {
      content: `Noted. Updating ${itemContext?.title || 'this item'} based on: "${correctionText.slice(0,80)}${correctionText.length > 80 ? '…' : ''}". Proposed change below.`,
      diffs: [{ k: 'notes', old: null, new: `Correction: ${correctionText.slice(0, 60)}` }],
      cascades: [], globalScope: [],
    };
  }

  // ─────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────
  return {
    // Core
    call,
    parseJSON,
    imageContent,
    readFileAsDataURL,
    THINKING_HTML,
    PARTY_ROSTER,

    // Integrity checker
    fillRoundsFromImage,
    fillRoundsFromText,
    extractNarrativeEntities,
    demoRoundProposals,

    // Delta review
    sendCorrectionToAI,
    demoCorrectionResponse,
  };

})();
