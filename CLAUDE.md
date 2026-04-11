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

## Shared AI module rules

`shared/chronicle-ai.js` is loaded by `intake.html`, `delta-review.html`, and `integrity.html` only. If you add AI capability to a new page, load both `config.js` and `chronicle-ai.js` before the page script. The API key is read from `window.CHRONICLE_CONFIG.anthropicApiKey` — never pass it any other way.

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

Never reuse a voided or skipped ID. The current gap IDs in the NPC registry (`npc_002`, `npc_005`, `npc_006`) are permanently voided.

### Next available IDs (as of v4.0.0 — sessions 006 and 007 are placeholders)

`pc_007`, `npc_015`, `loc_014`, `qst_006`, `item_012`, `cbt_007`, `session_008`, `mon_009`, `lore_004`, `moment_002`

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

In v4, each slot's action fields are nested inside a `slot.action` object. The combat viewer was written for the v3 flat format. The normaliser must flatten them:

```javascript
// v4 nests act/res/val inside slot.action. Flatten here so the combat
// viewer works unchanged. Remove this shim when the viewer is updated
// to read slot.action directly.
slot.act   = slot.action?.name ?? slot.act   ?? '';
slot.res   = slot.action?.res  ?? slot.res   ?? '';
slot.val   = slot.action?.val  ?? slot.val   ?? null;
slot.notes = slot.notes ?? slot.action?.notes ?? '';
```

`slot.val` is an integer in v4 and a numeric string in v3. Always normalise to a number: `val = val != null ? Number(val) : null`.

Enemy turns: v3 used `round.enemy[]` with `{desc, impact}`. v4 uses `round.enemy_turns[]` with `{actor_id, actor_label, action, special_events}`. Map them:

```javascript
// enemy_turns is the v4 key. Fall back to enemy[] if enemy_turns is
// absent so half-migrated data does not break the viewer.
round.enemy = (round.enemy_turns || round.enemy || []).map(et => ({
  desc:   et.desc   ?? et.action ?? '',
  impact: et.impact ?? (et.special_events || []).join('; '),
}));
```

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
