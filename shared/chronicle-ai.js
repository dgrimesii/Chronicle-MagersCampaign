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
  const MAX_TOKENS = 1200;

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
  // Strips ```json fences, parses, returns object or throws
  // ─────────────────────────────────────────────────────────
  function parseJSON(raw) {
    const clean = raw
      .replace(/^```json\s*/m, '')
      .replace(/^```\s*/m, '')
      .replace(/```\s*$/m, '')
      .trim();
    return JSON.parse(clean);
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

4. ENEMY ACTIONS ONLY FROM TEXT.
   Only include enemy_actions entries for enemies explicitly described by the user.
   Do not add enemy actions that seem likely or consistent with the combat context.

5. SLOT ORDER IS FIXED.
   Slots are numbered exactly as the user provided them. Do not reorder.

6. ONE JSON OBJECT ONLY.
   Output a single JSON object. No explanation, no preamble, no markdown fences.
   If you cannot parse a slot from the user's text, include it with
   action: "unclear", result: "unclear", value: null, notes: null.`;

  /**
   * fillRoundsFromImage({ images, combatName, combatId, sessionId, roundNumbers, onResult, onError, onLoading })
   * Calls the Vision API to extract round data from handwritten note images.
   * onResult receives an array of normalised proposal objects.
   */
  async function fillRoundsFromImage({ images, combatName, combatId, sessionId, roundNumbers, onResult, onError, onLoading }) {
    const imageBlocks = images.map(imageContent);
    const system = `${ROUND_SYSTEM_BASE}\nCombat: ${combatName} (${combatId}). Session: ${sessionId}. Extract only Rounds: ${roundNumbers.join(', ')}.`;

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
  async function fillRoundsFromText({ text, combatName, combatId, sessionId, roundNumbers, onResult, onError, onLoading }) {
    const rosterLines = [
      'slot 1: Zragar/Goldie (pc_001)',
      'slot 2: Malachite/Mal (pc_002)',
      'slot 3: Ashton/Ash (pc_003)',
      'slot 4: Asphodel/Del (pc_004)',
      'slot 5: Derwin/Goli (pc_005)',
      'slot 6: Atticus/Att (pc_006)',
    ].join('\n');

    const schemaExample = '{"rounds":[{\n' +
      '  "round_number": <number>,\n' +
      '  "session_id": "<string>",\n' +
      '  "initiative_grid": [\n' +
      '    {\n' +
      '      "slot": <number>,\n' +
      '      "actor_id": "<pc_id>",\n' +
      '      "action": "<exact action name from description>",\n' +
      '      "result": "hit|miss|crit|unclear",\n' +
      '      "value": <number or null>,\n' +
      '      "notes": "<string or null>"\n' +
      '    }\n' +
      '  ],\n' +
      '  "enemy_actions": [\n' +
      '    {\n' +
      '      "description": "<string>",\n' +
      '      "impact": "<string or null>"\n' +
      '    }\n' +
      '  ]\n' +
      '}]}';

    const roundLabel = roundNumbers.length === 1
      ? 'round ' + roundNumbers[0]
      : 'rounds ' + roundNumbers.join(', ');

    const userMessage =
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
        } catch (e) {
          onError(e);
        }
      },
      onError: e => { responded = true; onError(e); },
    });
  }

  /** Internal: convert raw API round objects to proposal shape */
  function _normaliseRoundProposals(rounds, targetNums, sessionId, source) {
    return rounds
      .filter(r => targetNums.includes(r.round_number))
      .map(r => ({
        n:       r.round_number,
        sid:     r.session_id || sessionId,
        source,
        status:  'pending',
        slots:   (r.initiative_grid || []).map(s => ({
          s:     s.slot,
          a:     s.actor_id,
          act:   s.action,
          res:   s.result || 'neutral',
          val:   s.value  || null,
          notes: s.notes  || null,
        })),
        enemy: (r.enemy_actions || []).map(e => ({
          desc:   e.description,
          impact: e.impact || null,
        })),
        summary: r.round_summary || null,
      }));
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

Respond ONLY with valid JSON:
{
  "content": "plain language explanation of what you changed and why",
  "diffs": [{"k": "field · subfield", "old": "previous value", "new": "corrected value"}],
  "cascades": [{"type": "NEW location|npc|item|etc", "desc": "description of new item to queue", "entityHint": {"name":"...","type":"..."}}],
  "globalScope": ["item title 1", "item title 2"]
}

Omit diffs, cascades, or globalScope if not applicable. Never omit content.`;

  /**
   * sendCorrectionToAI({ correctionText, itemContext, scope, pendingItems, onResult, onError, onLoading })
   *
   * correctionText  — what the DM typed
   * itemContext     — object describing the current delta item { title, type, array, rawData }
   * scope           — 'item' | 'global'
   * pendingItems    — array of { title } for global scope scan
   * onResult(response) — called with parsed correction response object
   * onError / onLoading as usual
   */
  async function sendCorrectionToAI({ correctionText, itemContext, scope, pendingItems = [], onResult, onError, onLoading }) {
    const contextStr = JSON.stringify(itemContext?.rawData || {}, null, 2).slice(0, 800);
    const scopeNote  = scope === 'global'
      ? `\nThis correction may apply broadly. Pending items: ${pendingItems.map(i => i.title).join('; ')}`
      : '';

    const messages = [{
      role: 'user',
      content: `Correction note: "${correctionText}"

Current item: ${itemContext?.title || 'unknown'} (${itemContext?.type || ''} · ${itemContext?.array || ''})
Current data:
${contextStr}${scopeNote}`,
    }];

    await call({
      system: CORRECTION_SYSTEM,
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
    demoRoundProposals,

    // Delta review
    sendCorrectionToAI,
    demoCorrectionResponse,
  };

})();
