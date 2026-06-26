/**
 * scripts/harvest-characters.js
 *
 * Why it exists: the D&D Beyond character service exposes full character data
 * (~278KB per character) but intake.html only needs a small subset — ability
 * names, spell names, race, and class — to enrich the OCR system prompt with
 * positive disambiguation aids (issue #80). This script fetches all six
 * character URLs, extracts that subset, and writes a compact
 * data/pc-abilities.json (~5–10KB) that intake.html fetches at page load.
 *
 * Run manually after a session where characters level up or learn new abilities:
 *   node scripts/harvest-characters.js
 *
 * Output: data/pc-abilities.json (commit the result to keep it current)
 *
 * No external packages — uses Node.js built-in https and fs modules only.
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── Character registry ──────────────────────────────────────────────────────
// Maps the DM's session-note nickname to the D&D Beyond character URL and the
// campaign pc_id that identifies this character in magers-campaign.json.
// pc_id is written to pc-abilities.json so chronicle-ai.js can reference the
// correct slot number when building action economy summaries for AI prompts.
// Update the URL list if a character is deleted and recreated on D&D Beyond.
const CHARACTERS = [
  { nickname: 'Ashton',    pc_id: 'pc_003', url: 'https://character-service.dndbeyond.com/character/v5/character/160800869' },
  { nickname: 'Asphodel',  pc_id: 'pc_004', url: 'https://character-service.dndbeyond.com/character/v5/character/160524293' },
  { nickname: 'Atticus',   pc_id: 'pc_006', url: 'https://character-service.dndbeyond.com/character/v5/character/160522741' },
  { nickname: 'Goli',      pc_id: 'pc_005', url: 'https://character-service.dndbeyond.com/character/v5/character/157623081' },
  { nickname: 'Malachite', pc_id: 'pc_002', url: 'https://character-service.dndbeyond.com/character/v5/character/160128354' },
  { nickname: 'Goldie',    pc_id: 'pc_001', url: 'https://character-service.dndbeyond.com/character/v5/character/157312142' },
];

// ── Action economy static lookup ─────────────────────────────────────────────
// Maps ability/feature names to their correct action_type for cases where the
// standard 5e default would be wrong or ambiguous. The harvest script matches
// each character's harvested actions against this table and emits entries into
// the character's action_economy array in pc-abilities.json.
//
// Only list cases that differ from ROUND_SYSTEM_STRICT rule 7's 5e defaults,
// or cases that are ambiguous enough that the AI would likely guess wrong.
// Standard attacks (action), Cure Wounds (action), and most spells are omitted
// because rule 7 already covers them correctly.
//
// Nick weapon mastery is detected separately via regex (see extractCharacterFacts)
// because the ability name includes the weapon type in parentheses, e.g. "Nick (Dagger)".
const KNOWN_ACTION_ECONOMY = {
  // ── Monk ──
  'Flurry of Blows':    { action_type: 'bonus_action', note: 'Monk: spend 1 Focus Point after the Attack action to make 2 bonus unarmed strikes' },
  'Patient Defense':    { action_type: 'bonus_action', note: 'Monk: spend 1 Focus Point as a bonus action to take the Dodge action' },
  'Step of the Wind':   { action_type: 'bonus_action', note: 'Monk: spend 1 Focus Point as a bonus action to Dash or Disengage' },
  'Deflect Attack':     { action_type: 'reaction',     note: 'Monk: reaction to reduce damage from an attack that hits' },

  // ── Rogue ──
  'Cunning Action':     { action_type: 'bonus_action', note: 'Rogue: use a bonus action each turn to Dash, Disengage, or Hide' },
  'Steady Aim':         { action_type: 'bonus_action', note: 'Rogue: spend a bonus action to gain Advantage on next attack; cannot move this turn' },

  // ── Barbarian ──
  'Rage (Enter)':       { action_type: 'bonus_action', note: 'Entering Rage costs a bonus action (2024 D&D rules)' },

  // ── Polearm Master feat ──
  'Pole Strike':        { action_type: 'bonus_action', note: 'Polearm Master feat: bonus action attack with the butt of the polearm after hitting with the main attack' },
  'Reactive Strike':    { action_type: 'reaction',     note: 'Polearm Master feat: opportunity attack reaction when a creature enters your reach' },

  // ── Druid / Circle of the Stars ──
  // 2024 D&D rules changed Wild Shape to a bonus action for all Druids at level 2+.
  // The AI defaults to the 2014 rule (action) without this entry.
  'Wild Shape':         { action_type: 'bonus_action', note: '2024 D&D rules: Wild Shape costs a bonus action for all Druids at level 2+' },
  'Assume Starry Form': { action_type: 'bonus_action', note: 'Circle of the Stars: expend a Wild Shape use as a bonus action to assume Starry Form instead of transforming' },

  // ── Cleric/Druid spells with non-obvious action cost ──
  // Healing Word is a bonus action; the AI often confuses it with Cure Wounds (action).
  'Healing Word':       { action_type: 'bonus_action', note: 'Healing Word costs a bonus action (unlike Cure Wounds which costs an action)' },

  // ── Wizard / Bladesinger ──
  'Bladesong (Invoke)': { action_type: 'bonus_action', note: 'Bladesinger Wizard: invoke Bladesong as a bonus action (not an action)' },

  // ── Warlock / Pact of the Blade ──
  // Both Conjure and Bond cost an action — clarified here because they appear in
  // the actions list and could be mistaken for bonus actions or free actions.
  'Pact of the Blade: Conjure': { action_type: 'action', note: 'Warlock: summoning the pact weapon to hand uses an action' },
  'Pact of the Blade: Bond':    { action_type: 'action', note: 'Warlock: bonding with a non-magical weapon uses an action' },
  'Magical Cunning':            { action_type: 'action', note: 'Warlock: recovering expended spell slots via Magical Cunning uses an action' },

  // ── Reaction spells (present in multiple characters' spell lists) ──
  // These are standard 5e reactions but appear frequently enough in notes that
  // the AI sometimes classifies them as actions. Listed once here; matched
  // against every character's spell list during harvest.
  'Absorb Elements': { action_type: 'reaction', note: 'Reaction to incoming elemental damage — reduces damage and stores energy for next melee attack' },
  'Shield':          { action_type: 'reaction', note: 'Reaction to an incoming hit — raises AC by 5 until the start of next turn' },
  'Silvery Barbs':   { action_type: 'reaction', note: 'Reaction to a successful d20 roll — forces a reroll and can redirect advantage' },
  'Reactive Spell':  { action_type: 'reaction', note: 'War Caster feat: cast a spell as your opportunity attack reaction when a creature leaves reach' },
};

// ── Fetch helper ─────────────────────────────────────────────────────────────
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Chronicle-Harvest/1.0' } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        try { resolve(JSON.parse(Buffer.concat(chunks))); }
        catch (e) { reject(new Error(`JSON parse failed for ${url}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

// ── Extraction ────────────────────────────────────────────────────────────────
// Extracts only the fields relevant for OCR prompt disambiguation.
// The full character object is ~278KB; this produces ~1KB per character.
// Also derives action_economy entries for any abilities in the character's
// action/spell lists that appear in KNOWN_ACTION_ECONOMY, plus Nick weapon
// mastery entries detected by name pattern (ability: "Nick (<weapon>)").
function extractCharacterFacts(nickname, pc_id, raw) {
  const data = raw.data;

  // Race — fullName includes subrace (e.g. "Aasimar", "Tiefling")
  const race = data.race?.fullName ?? 'Unknown';

  // Classes — each entry has class name, level, and optional subclass
  const classes = (data.classes || []).map(c => ({
    name:     c.definition?.name     ?? 'Unknown',
    level:    c.level                ?? 0,
    subclass: c.subclassDefinition?.name ?? null,
  }));

  // Feats — skip generic ASI entries that carry no ability name the AI could see.
  // "Ability Score Improvement" and "{class} Ability Score Improvements" variants
  // never appear in handwritten notes — they are character-sheet-only entries.
  const ASI_PATTERN = /ability score improve?ment|ability score increase/i;
  const feats = (data.feats || [])
    .map(f => f.definition?.name)
    .filter(name => name && !ASI_PATTERN.test(name));

  // Actions — class features, racial traits, and feat abilities the player uses.
  // These are the action names most likely to appear in handwritten combat notes.
  const actions = [
    ...(data.actions?.class      || []).map(a => a.name),
    ...(data.actions?.race       || []).map(a => a.name),
    ...(data.actions?.feat       || []).map(a => a.name),
    ...(data.actions?.background || []).map(a => a.name),
  ].filter(Boolean);

  // Spells — classSpells is the primary list for class spells.
  // data.spells.{race,class,background,feat} captures spells granted by
  // non-class sources (racial traits, feats like Magic Initiate, etc.).
  const spells = [
    ...(data.classSpells || []).flatMap(cs =>
      (cs.spells || []).map(s => s.definition?.name)
    ),
    ...['race', 'class', 'background', 'feat'].flatMap(key =>
      (data.spells?.[key] || []).map(s => s.definition?.name)
    ),
  ].filter(Boolean);

  // Deduplicate spells — the same spell can appear in multiple lists
  // (e.g. a racial spell also listed in classSpells when learned via class).
  const uniqueSpells = [...new Set(spells)].sort();

  // ── Action economy derivation ──────────────────────────────────────────────
  // Build action_economy entries by matching harvested abilities against the
  // KNOWN_ACTION_ECONOMY table, then scanning for Nick weapon mastery entries.
  //
  // Why scan both actions and uniqueSpells: some entries in KNOWN_ACTION_ECONOMY
  // (e.g. Absorb Elements, Shield, Silvery Barbs) appear in spells, while others
  // (Cunning Action, Rage) appear in actions. We check both to avoid missing entries
  // that were harvested under the "wrong" list from D&D Beyond's perspective.
  //
  // Nick mastery uses a regex instead of an exact key because the weapon name is
  // embedded in the ability string (e.g. "Nick (Dagger)", "Nick (Handaxe)") and
  // cannot be pre-enumerated in the static table.
  const seen = new Set(); // guard against duplicates if same name appears in actions + spells
  const action_economy = [];

  for (const abilityName of [...actions, ...uniqueSpells]) {
    if (seen.has(abilityName)) continue;
    seen.add(abilityName);

    // Nick weapon mastery: "Nick (<weapon>)" → off-hand attack costs an Action
    const nickMatch = abilityName.match(/^Nick\s*\((.+)\)$/);
    if (nickMatch) {
      action_economy.push({
        ability:     abilityName,
        action_type: 'action',
        note:        `Nick weapon mastery: the off-hand attack from Nick costs the main Action, not a Bonus Action`,
      });
      continue;
    }

    // Static lookup table match
    if (KNOWN_ACTION_ECONOMY[abilityName]) {
      action_economy.push({ ability: abilityName, ...KNOWN_ACTION_ECONOMY[abilityName] });
    }
  }

  return {
    nickname,
    pc_id,
    full_name: data.name,
    race,
    classes,
    feats,
    actions,
    spells: uniqueSpells,
    action_economy,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const results = [];
  const errors  = [];

  for (const { nickname, pc_id, url } of CHARACTERS) {
    process.stdout.write(`Fetching ${nickname}... `);
    try {
      const raw   = await fetchJson(url);
      const facts = extractCharacterFacts(nickname, pc_id, raw);
      results.push(facts);
      console.log(
        `OK — ${facts.classes.map(c => `${c.name} ${c.level}`).join('/')} ` +
        `| ${facts.actions.length} actions, ${facts.spells.length} spells, ` +
        `${facts.action_economy.length} action_economy entries`
      );
    } catch (err) {
      console.error(`FAILED: ${err.message}`);
      errors.push({ nickname, error: err.message });
    }
  }

  if (errors.length) {
    console.error('\nFailed characters:', errors.map(e => e.nickname).join(', '));
    console.error('Fix errors and re-run before committing.');
    process.exit(1);
  }

  const output = {
    // ISO-8601 timestamp so intake.html can log when the data was last harvested
    generated_at: new Date().toISOString(),
    source: 'D&D Beyond character service v5',
    characters: results,
  };

  const outPath = path.join(__dirname, '..', 'data', 'pc-abilities.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(1)}KB)`);
  console.log('Commit data/pc-abilities.json to keep OCR context current.');
}

main().catch(err => { console.error(err); process.exit(1); });
