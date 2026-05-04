# CLAUDE.md — Chronicle Codebase Instructions

---

## Role and scope

You assist the DM (David) with maintenance and development of the Chronicle web app: adding new campaign entities, fixing bugs, building or improving admin tools, and keeping documentation current.

Campaign data in `data/magers-campaign.json` may be edited directly when asked. All architecture and factual description of the codebase belongs in README.md, not here.

---

## Before making any changes

Read these files first, in this order:

1. `README.md` — current factual state of the codebase (structure, data flow, known issues)
2. The specific HTML file or JS file you are about to change — read it fully before touching it
3. `data/magers-campaign.json` — if the task involves adding or changing campaign data

Before writing any code:
- Verify the fetch path matches the file's location in the directory tree (`../data/magers-campaign.json` from `admin/`, `../../data/magers-campaign.json` from nowhere — only two levels of nesting exist)
- Verify any ID you assign does not already exist in `magers-campaign.json`

Ask for clarification rather than proceeding if:
- You are unsure whether to write to the JSON file directly or via the Delta Review workflow
- You are asked to add a new admin page — confirm the intended nav position and which shared scripts to include

---

## Code comments

Every code block you write or modify must include comments that serve two purposes simultaneously: helping a human understand what the code does, and communicating the intent behind the code so that a future Claude session can understand why it was written this way.

These are not the same thing. "What" describes mechanics. "Why" describes intent. Both must be present.

Requirements:

- Every function must have a header comment stating: what it does, why it exists, and what would break if it were removed or changed.
- Every non-obvious expression, condition, or transformation must have an inline comment explaining the reason for that specific approach — not just a restatement of the code in English.
- Any workaround, migration shim, or compatibility measure must be commented with: what it works around, what the ideal solution would be, and when it can be removed (e.g. "remove after integrity.html is updated to fetch dynamically").
- Comments must be written in plain language — no jargon that requires knowing the codebase to understand.

Good comment (explains intent):
```javascript
// Flatten v4 slot.action into top-level fields so the combat viewer —
// which was written for the v3 flat slot format — works without modification.
// Once the combat viewer is updated to read slot.action directly,
// this shim can be removed.
slot.act = slot.action?.name ?? '';
```

Bad comment (restates code):
```javascript
// Set slot.act to slot.action.name
slot.act = slot.action?.name ?? '';
```

Apply this rule to all new code you write and to any existing code you modify. You are not required to comment existing code you do not touch — only code within the scope of the current task.

---

## README integrity

README.md must always accurately describe what the code does. You are responsible for keeping it current as part of every task — not as a separate step, not as an optional follow-up.

When you complete any task that changes how Chronicle works, update README.md in the same response before you finish. Do not ask whether to update it. Do not flag it as a follow-up. Do it.

Specifically:

- If you add, remove, or rename a file: update the Repository Structure section.
- If you change how data flows (fetch path, write path, build process): update the Data Architecture section.
- If you change a field name, path, or mapping in `normaliseCampaignJson`: update the Schema field mapping table in README.md.
- If you fix a known issue from the Known Issues table: remove that row.
- If you introduce a new known issue or leave a known gap: add a row to the Known Issues table with the file, a description, and why it was not fixed now.
- If you add or materially change a view or admin tool: update its subsection under Views.

What counts as a material change requiring a README update:
- Any change that would cause README.md to describe something that no longer exists, or fail to describe something that now exists
- Any fix to a known issue listed in the Known Issues table
- Any change to a fetch path, field name, function name, or file path
- Any addition or removal of a feature, view, or admin tool

What does not require a README update:
- Pure bug fixes that do not change any behaviour described in README.md (fix a broken fetch path — update README; fix a typo in a comment — do not)
- Internal refactoring that does not change any described behaviour
- Changes to CLAUDE.md itself

If you are unsure whether a change warrants a README update, update it. Over-documenting is not a problem. Under-documenting is.

---

## File conventions

- Vanilla HTML/CSS/JS only — zero npm packages, zero build steps, no framework
- Do not introduce React, Vue, webpack, Vite, or any bundler
- External CDN links are acceptable: D3.js (cdnjs), Google Fonts, JetBrains Mono
- CSS variables defined at `:root` in each file individually — there is no shared stylesheet
- Nav links use `onclick="window.location='filename.html'"` with same-folder relative paths
- Script tags for shared modules appear at the bottom of `<body>`, before the page's own `<script>` block
- D3.js is locked to v7.9 from cdnjs. Do not upgrade the version without explicit instruction and thorough graph testing — the force simulation parameters in both viewers are tuned to v7 behaviour.
- `localStorage` is used only by `admin/versions.html` for its backup ledger. Do not introduce `localStorage` in any other page. Warn in comments wherever `localStorage` is read that the data is volatile — cleared if the user clears site data or opens the app in a different browser.

---

## Theme — Arcane Night

Every page uses the Arcane Night theme. The canonical values are:

```css
--parchment: #0f1020;   /* background */
--amber:     #d4af37;   /* gold accent */
--ink:       #f0e8d0;   /* body text */
```

Never revert to old Parchment theme values. Never introduce a new colour scheme.

---

## Navigation

All admin pages share a 7-item nav bar in this exact order:

`Session Intake → OCR Glossary → Delta Review → Integrity → Campaign Log → Log Editor → Versions`

The active page's nav link has `class="nav-link active"`. All others have `class="nav-link"`. Every admin page also has a "⇄ Player View" button in the header right that links to `../player/`.

`drive-test.html` is the only admin file with no nav bar.

The player view (`player/index.html`) has a "⇄ Admin" button linking to `../admin/log-viewer.html`. This is intentional.

---

## Data loading rules

- Admin files fetch campaign data from `../data/magers-campaign.json`
- Player file fetches from `../data/magers-campaign.json` (same path — both are one folder deep from root)
- Use standard `fetch()` — no proxy, no special headers needed for data reads (same origin on GitHub Pages)
- There is no EMBEDDED_DATA block in any HTML file — do not add one
- There is no sync indicator bar — do not add one
- If a fetch fails, show a clear error state — do not silently fall back to stale or hardcoded data

The standard pattern:
```javascript
async function loadCampaignData() {
  const res = await fetch('../data/magers-campaign.json');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  return normaliseCampaignJson(json);
}
```

---

## Drive integration rules

- Proxy URL and campaign file ID live ONLY in `shared/config.js` as `window.CHRONICLE_CONFIG`
- Never hardcode the proxy URL or file ID in an individual HTML file
- Admin files that need Drive access must load `../shared/config.js` before any page script
- GET for all Drive reads (avoids CORS preflight); POST with `Content-Type: text/plain` for writes
- Drive is used for: write-back after Delta Review publish, backup copies, listing backups
- Drive is NOT used for reading campaign data — all reads come from the repo fetch

---

## Shared module load order

When a page needs all four shared modules, load them in this order — each depends on the previous:

```html
<script src="../shared/config.js"></script>
<script src="../shared/chronicle-integrity.js"></script>
<script src="../shared/chronicle-ai.js"></script>
<script src="../shared/chronicle-narrative.js"></script>
<!-- page script here -->
```

`chronicle-integrity.js` exports `window.ChronicleIntegrity`. It has no dependencies — it can be loaded without `chronicle-ai.js` or `chronicle-narrative.js` when a page only needs gap detection and no AI calls.

`chronicle-narrative.js` exports `window.ChronicleNarrative`. It is completely independent of `chronicle-ai.js` — the two modules never import each other. Load `chronicle-narrative.js` only on pages that use Gemini narrative generation.

---

## Narrative field rules

Several entity types carry Gemini-generated prose fields alongside their factual data. These fields share a common shape and a strict set of rules.

### Session narrative generation fields

Inside each `session_logs[].narrative` block:

| Field | Type | Purpose |
|---|---|---|
| `chronicle_entry` | `string \| null` | Gemini-generated prose narrative for the session |
| `chronicle_entry_generated_at` | `string \| null` | ISO-8601 timestamp of the last successful generation |
| `chronicle_entry_model` | `string \| null` | Gemini model ID used for the last generation |
| `chronicle_entry_version` | `number` | Increments on each regeneration; starts at 0 |
| `narrative_beats` | `array` | DM-tagged key moments fed to Gemini as generation anchors |
| `human_guidance` | `string \| null` | Free-text DM steering for Gemini; null if not used |
| `generation_warnings` | `array` | Warnings from the last Gemini call (hallucination flags, etc.) |

### NPC and Location flavor text fields

Inside each `npc_directory[].narrative` and `locations[].narrative` block:

| Field | Type | Purpose |
|---|---|---|
| `flavor_text` | `string \| null` | Gemini-generated flavor text for display |
| `flavor_text_generated_at` | `string \| null` | ISO-8601 timestamp of the last generation |
| `flavor_text_model` | `string \| null` | Gemini model ID used |
| `flavor_text_version` | `number` | Generation counter; starts at 0 |
| `regeneration_flagged` | `boolean` | DM has flagged this entry for regeneration |
| `regeneration_flag_reason` | `string \| null` | Why the DM flagged it; null if not flagged |

### Quest progress narrative fields

Inside each `quest_ledger[].mechanics.progress_log[]` entry:

| Field | Type | Purpose |
|---|---|---|
| `progress_narrative` | `string \| null` | Gemini-generated prose for this progress entry; null until generated |

### Immutable ground truth rule

Gemini-generated fields are output only — they describe what happened, they do not define it. The canonical facts are always in the factual fields (`fact`, `description`, `key_moments`, etc.). Never treat a generated narrative as authoritative if it conflicts with the factual data.

`chronicle_entry` must never be hand-edited. If the DM wants to steer generation, use `human_guidance` or `narrative_beats`. Treat the generated text as replaceable at any time.

The `geminiApiKey` must never be committed to the repo. It lives in `shared/config.js` under `window.CHRONICLE_CONFIG.geminiApiKey` (gitignored, same file as `anthropicApiKey`).

---

## Shared AI module rules

`shared/chronicle-ai.js` is loaded by `intake.html`, `delta-review.html`, and `integrity.html` only. If you add AI capability to a new page, load both `config.js` and `chronicle-ai.js` before the page script. The API key is read from `window.CHRONICLE_CONFIG.anthropicApiKey` — never pass it any other way.

The Anthropic API is called directly from the browser using the `anthropic-dangerous-direct-browser-access: true` header. This header must remain in all `chronicle-ai.js` fetch calls — remove it and the requests will be rejected. Never attempt to proxy AI requests through the Drive Apps Script endpoint.

`ChronicleAI.PARTY_ROSTER` is a string of party nicknames injected into AI prompts. If the party roster changes (new PC, renamed nickname), update `PARTY_ROSTER` in `shared/chronicle-ai.js` as part of the same task.

When to use which method:
- `.call()` — raw API access, use when building a new AI feature or when none of the specific methods fit
- `.fillRoundsFromImage()` — OCR from uploaded session photos (intake, integrity)
- `.fillRoundsFromText()` — round fill from typed description (integrity)
- `.sendCorrectionToAI()` — delta item correction chat (delta-review only)

---

## scripts/build.js

This file exists in the repository but is dead code. The EMBEDDED_DATA markers it looks for were removed from all HTML files during Phase 1. Do not run `node scripts/build.js` — it will do nothing (both targets will be skipped). Do not delete the file without explicit instruction.

---

## Schema conventions

### ID format

All IDs follow `<type>_<zero-padded-number>`:

| Type | Prefix | Example |
|---|---|---|
| Party | `pc_` | `pc_001` |
| NPC | `npc_` | `npc_014` |
| Location | `loc_` | `loc_014` |
| Quest | `qst_` | `qst_006` |
| Item | `item_` | `item_011` |
| Combat | `cbt_` | `cbt_007` |
| Bestiary | `mon_` | `mon_009` |
| Lore | `lore_` | `lore_003` |
| Session | `session_` | `session_006` |
| Prompt Improvement Log | `pil_` | `pil_001` |
| Entity Relationship | `rel_` | `rel_001` |

Never reuse a voided or skipped ID. The current gap IDs in the NPC registry (`npc_002`, `npc_005`, `npc_006`) are permanently voided.

### `deferred_gaps` — workflow state array

`deferred_gaps[]` is a root-level array written by `delta-review.html` when the DM chooses **Defer** on an integrity gap during a publish cycle. It persists in the campaign JSON alongside narrative data and is version-controlled.

Each entry shape:
```json
{
  "id":             "gap_001",
  "combat_id":      "cbt_005",
  "combat_name":    "Goblin Ambush",
  "session_id":     "session_006",
  "missing_rounds": [9],
  "gap_type":       "incoming",
  "deferred_at":    "session_006",
  "status":         "pending"
}
```

Rules:
- IDs follow `gap_001`, `gap_002`, etc. Assign the next by reading the current array length.
- `gap_type` is `'incoming'` (gap in staged data) or `'continuity'` (jump between sessions).
- `deferred_at` is the `session_id` of the publish cycle that created the record.
- Only update `status` — from `'pending'` to `'resolved'` — when a gap is fixed. Do not rename or remove entries.
- The future campaign scanner (`integrity.html`) will surface `pending` entries as a correction queue.
- This array is workflow state, not campaign narrative. Do not add game data to it.

### `entity_relationships` — controlled vocabulary

The `relationship_type` field on each entry in `entity_relationships[]` must be one of:

| Value | Meaning |
|---|---|
| `combat_antagonist` | The target entity was an enemy in a combat the source entity participated in |
| `allied` | The entities fought on the same side or have a standing alliance |
| `quest_connection` | The target entity is tied to a quest the source is pursuing |
| `location_inhabitant` | The target location is where the source entity lives, works, or is based |
| `social_contact` | The entities know each other; no combat or quest connection |
| `witnessed` | The source entity witnessed the target event or entity in a significant way |
| `unknown` | A relationship exists but its nature has not been established |

### Next available IDs (as of v4.1 — sessions 006 and 007 are placeholders)

`pc_007`, `npc_015`, `loc_014`, `qst_006`, `item_012`, `cbt_007`, `session_008`, `mon_009`, `lore_004`, `moment_002`, `pil_001`, `rel_001`

Voided/skipped NPC IDs (never reuse): `npc_002`, `npc_005`, `npc_006`

Update CLAUDE.md (this section) when new IDs are assigned.

### Field naming

- JSON field names use `snake_case`
- The `normaliseCampaignJson` function in `log-viewer.html` and `player/index.html` applies field renames at runtime. When adding new fields to the JSON, check whether the viewer needs a corresponding mapping. The README "Schema" section lists all current mappings.
- `class` in the JSON becomes `cls` in the normalised viewer object (reserved word workaround)
- `current_level` in the JSON becomes `level` in the viewer

### normaliseCampaignJson — the translation layer

`normaliseCampaignJson` exists in TWO files with identical implementations: `admin/log-viewer.html` and `player/index.html`. When you update field mappings in one, you must update the other in the same task. The README Schema section lists all current mappings — check it before adding or changing any mapping.

The function must handle missing fields gracefully. Always use optional chaining (`?.`) and nullish coalescing (`??`) when reading nested v4 paths so that a missing field produces an empty string or null rather than a runtime error.

When writing a mapping for a v4 field that was restructured from a flat v3 field, add a comment explaining the old path, the new path, and why the shim exists. Example:

```javascript
// v4 moved outcome into the mechanics block.
// v3: c.outcome | v4: c.mechanics.outcome
outcome: c.mechanics?.outcome ?? c.outcome ?? '',
```

### Combat slot format

In v4, each slot's action fields are nested inside a `slot.action` object. The normaliser's `flattenSlot` helper translates to the flat shape the combat viewer expects:

```javascript
// flattenSlot: v4 nests act/res/val inside slot.action — renderer uses flat fields.
{ s, a, act: slot.action?.name, res: slot.action?.res, val: slot.action?.val, notes: slot.notes || slot.action?.notes }
```

Enemy turns: v4 uses `round.enemy_turns[]` with `{actor_id, action:{name,res,val}, special_events:[{description}]}`. The normaliser's `flattenEnemyTurn` helper builds `{desc, impact}` for the renderer:

```javascript
// flattenEnemyTurn: builds desc from actor_id + action; impact from special_events[].description
desc   = actor_id + ': ' + action.name + ' (' + action.res + ', ' + action.val + ')';
impact = special_events.map(ev => ev.description).join('; ') || null;
```

The `flattenSlot` and `flattenEnemyTurn` helpers are nested functions inside `normaliseCampaignJson`. They are not exported.

### What the JSON must never store

- Current HP, spell slots, conditions, or any transient game state — Chronicle is a log, not a live tracker
- Personally identifying player information beyond first names

### Null vs absent fields

- Use `null` explicitly for a field that exists in the schema but has no value yet
- Omit the field entirely if it is not applicable to this entity type

### Schema version

Do not change `_schema_version` without explicit instruction. It lives at the root of the JSON, not inside `meta`.

---

## What you must never do

- Do not add EMBEDDED_DATA blocks to any HTML file
- Do not add a sync indicator bar to any page
- Do not hardcode the Drive proxy URL or campaign file ID outside of `shared/config.js`
- Do not introduce npm packages, a bundler, or a JS framework
- Do not reuse voided ID numbers
- Do not change `_schema_version` without explicit instruction
- Do not invent field names not present in the schema or the normaliser — check the README schema table first
- Do not store game state (HP, spell slots, conditions) in `magers-campaign.json`
- Do not remove data from existing campaign objects without explicit instruction
- Do not commit or reference `shared/config.js` — it is gitignored and must stay that way
- Do not run `node scripts/build.js` — it is dead code
- **Never commit `safeTestMode: true`** in `shared/config.js` — it redirects all campaign data reads to the test fixture and all Drive writes to the test file ID, which would affect any admin working locally from the same config

---

## Known broken features — do not use as patterns

These features exist in the codebase but are broken. Do not treat them as reference implementations. Fix them properly when asked; do not work around them by copying the broken pattern elsewhere.

| File | Broken feature | Status |
|---|---|---|
| `admin/log-editor.html` | Edits are in-memory only — no write-back to JSON or Drive | Document clearly; do not add fake "save" affordances |
| `admin/drive-test.html` | `?action=read` test calls the proxy read endpoint — reads moved to same-origin fetch in Phase 1 | Do not use this as a pattern for data reads |

---

## After making changes — what to verify

After any code change, open the affected page in a browser and check:

**For any page that fetches campaign data:**
- [ ] Page loads without JS console errors
- [ ] No `undefined` values visible in the UI
- [ ] Party panel shows all 6 PCs with correct name, class, and level
- [ ] If you changed normaliseCampaignJson: check it in BOTH files

**For combat changes:**
- [ ] Open cbt_002 (Siege of Bagyers Farm) — confirm round viewer shows all 14+ rounds and Ched's death event is visible
- [ ] Slot data shows action names, not `undefined`
- [ ] `val` fields display as numbers where data exists, blank where null

**For schema/JSON changes:**
- [ ] `_schema_version` is unchanged unless you were explicitly told to update it
- [ ] All new IDs are in the correct format and not already used
- [ ] `meta.last_updated` reflects today's date
- [ ] No game state fields (HP, spell slots, conditions) were added

**For admin tool changes:**
- [ ] Nav bar order matches the 7-item canonical order
- [ ] Active page nav link has `class="nav-link active"`
- [ ] "⇄ Player View" button is present in the header right

---

## Workflow: updating campaign data after a session

The DM manages the post-session workflow through the admin tools, then manually replaces the JSON file. When asked to update `data/magers-campaign.json` directly:

1. Read the current file before editing
2. Assign the next available ID for any new entity — check the "Next available IDs" section above
3. Follow all schema conventions for the entity type
4. Update `meta.last_updated` to today's date
5. Do not change `_schema_version`
6. After editing, note which IDs were assigned and update this file's "Next available IDs" section if asked

---

## Workflow: adding a new admin page

1. Copy the nav bar HTML from an existing admin page (e.g. `integrity.html`)
2. Set the new page's nav link to `active`, all others to inactive
3. Add a nav link for the new page to all other admin pages in the correct position
4. Load `../shared/config.js` at the bottom of `<body>` before the page script
5. Load `../shared/chronicle-ai.js` only if the page uses AI features
6. If the page needs campaign data, fetch `../data/magers-campaign.json` at init — not from Drive

---

## Workflow: delta-review publish cycle

Delta Review reads the campaign JSON from Drive (not from `/data/`). After a v4 migration or any direct edit to `data/magers-campaign.json`, the Drive copy will be stale until manually synced.

The full post-session workflow:
1. Session Intake (`intake.html`) — upload photos, AI extracts round data
2. Delta Review (`delta-review.html`) — approve/reject/correct AI proposals, then Publish. This writes the updated JSON to Drive.
3. Download the updated JSON from Drive (via Versions page or direct Drive)
4. Replace `data/magers-campaign.json` in the repo with the downloaded file
5. Commit and push to `main` — GitHub Pages redeploys automatically

After a direct edit to `data/magers-campaign.json` (bypassing the workflow):
- The Drive copy is now stale. Before using Delta Review, manually upload the current JSON to Drive or use the Versions page to create a backup that will become the new Drive source.

---

## Workflow: v3 → v4 schema migration

When updating `normaliseCampaignJson` to consume the v4 JSON:

1. Update the function in `admin/log-viewer.html` first
2. Copy the identical changes to `player/index.html` — they must stay in sync
3. Use optional chaining for all v4 nested field reads (e.g. `c.mechanics?.outcome`)
4. Add shim comments on every remapped field (old path, new path, when to remove)
5. Test by opening both views and checking all sections render without `undefined`
6. Update the README Schema field mapping table
7. Update the "Next available IDs" section in this file if the JSON was replaced

The full field mapping is in `docs/chronicle-v3-to-v4-conversion-plan.md`.

---

## Workflow: fixing the log-editor fetch path

The current broken fetch in `admin/log-editor.html` uses:
```javascript
const res = await fetch('magers-campaign.json');
```
The correct path is:
```javascript
const res = await fetch('../data/magers-campaign.json');
```
When fixing this, also remove the silent catch that falls back to the hardcoded ENTITIES array — the fetch should show an error if it fails.

---

## Keeping documentation current

After any significant change to the codebase — new page, changed fetch path, new JSON section, schema version change, resolved known issue — propose updates to README.md and CLAUDE.md to reflect the new state. Do not let the documentation drift from the code.

To fully regenerate both documents from scratch, run the prompt in `docs/chronicle-docs-prompt.md` from the repository root in Claude Code. That prompt reads every file and rewrites both documents in one pass.
