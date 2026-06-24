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
// Maps the DM's session-note nickname to the D&D Beyond character URL.
// "nickname" is the short name used in handwritten notes (first name only).
// Update the URL list if a character is deleted and recreated on D&D Beyond.
const CHARACTERS = [
  { nickname: 'Ashton',    url: 'https://character-service.dndbeyond.com/character/v5/character/160800869' },
  { nickname: 'Asphodel',  url: 'https://character-service.dndbeyond.com/character/v5/character/160524293' },
  { nickname: 'Atticus',   url: 'https://character-service.dndbeyond.com/character/v5/character/160522741' },
  { nickname: 'Goli',      url: 'https://character-service.dndbeyond.com/character/v5/character/157623081' },
  { nickname: 'Malachite', url: 'https://character-service.dndbeyond.com/character/v5/character/160128354' },
  { nickname: 'Goldie',    url: 'https://character-service.dndbeyond.com/character/v5/character/157312142' },
];

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
function extractCharacterFacts(nickname, raw) {
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

  return {
    nickname,
    full_name: data.name,
    race,
    classes,
    feats,
    actions,
    spells: uniqueSpells,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const results = [];
  const errors  = [];

  for (const { nickname, url } of CHARACTERS) {
    process.stdout.write(`Fetching ${nickname}... `);
    try {
      const raw   = await fetchJson(url);
      const facts = extractCharacterFacts(nickname, raw);
      results.push(facts);
      console.log(
        `OK — ${facts.classes.map(c => `${c.name} ${c.level}`).join('/')} ` +
        `| ${facts.actions.length} actions, ${facts.spells.length} spells`
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
