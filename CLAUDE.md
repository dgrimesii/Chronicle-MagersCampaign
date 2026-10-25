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
- Campaign data paths live only in `shared/chronicle-store.js`, relative to the calling page; every page that loads it is one folder below the root (`admin/` or `player/`). A page at any other depth needs the store's paths changed first
- New entity ids are UUIDs from `ChronicleIds.newId()` (`shared/chronicle-ids.js`), never counted or typed by hand (issue #95). A reference you write must be an existing entity's `id` (its UUID), never its `legacy_id`

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
- `localStorage` is used only by `admin/log-viewer.html`, to remember the admin/player mode toggle (`chronicle_mode`). The Versions page's backup ledger went with the page (#98). Do not introduce `localStorage` in any other page. Warn in comments wherever `localStorage` is read that the data is volatile — cleared if the user clears site data or opens the app in a different browser.
- **IndexedDB exception (issue #97):** `shared/chronicle-store.js` keeps exactly one thing in IndexedDB: the repository folder handle publish writes through (database `chronicle-store`, store `handles`, key `repo-folder`). A directory handle cannot go in localStorage. Losing it only means the DM picks the folder again. Do not store anything else in IndexedDB, and never use it from a page.

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

`Session → Session Intake → OCR Glossary → Delta Review → Integrity → Campaign Log → Log Editor`

Session (`session.html`) is the rebuilt intake (#99–#106). When phase 5 retires Session Intake and Delta Review, remove their links from every page and from this list.

The Versions page was deleted with Google Drive (#98); git history is the backup.

The active page's nav link has `class="nav-link active"`. All others have `class="nav-link"`. Every admin page also has a "⇄ Player View" button in the header right that links to `../player/`.

`admin/index.html`, a redirect to `log-viewer.html`, is the only admin file with no nav bar.

The player view (`player/index.html`) has a "⇄ Admin" button linking to `../admin/log-viewer.html`. This is intentional.

---

## Data loading rules

- Every campaign read and write goes through `shared/chronicle-store.js` (`window.ChronicleStore`). Never `fetch()` the campaign JSON, touch the file system (`showDirectoryPicker`, file handles), or check `safeTestMode` in a page — add a method to the store module instead. The store is the seam for the move to Postgres (rebuild phase 7), as it was for local-file publishing (#97); a page that bypasses it breaks that move.
- `ChronicleStore.loadCampaign()` fetches `../data/magers-campaign.json` same-origin and returns the raw JSON; pages normalise it themselves. In Safe Test Mode it fetches `../tests/output/test-campaign.published.json` when a test publish has written it, else the test fixture
- There is no EMBEDDED_DATA block in any HTML file — do not add one
- There is no sync indicator bar — do not add one
- If a load fails, show a clear error state — do not silently fall back to stale or hardcoded data. `loadCampaign()` throws on HTTP errors so the page's catch can do this.

The standard pattern:
```javascript
async function loadCampaignData() {
  const json = await ChronicleStore.loadCampaign();
  return normaliseCampaignJson(json);
}
```

---

## Local-file publishing rules (issue #97)

- The DM runs Chronicle locally from VS Code with Live Server. Publish writes `data/magers-campaign.json` in the local clone through the File System Access API (Chrome or Edge). Committing and pushing are the DM's, in VS Code, on their own schedule: the tool never commits, pushes or talks to GitHub, and needs no token. Do not add a GitHub API call, a token setting or a git step to it
- All file access lives in `shared/chronicle-store.js` (`loadPublishBase()` / `publishSession()`). The DM picks the repository folder on the first publish; the handle is kept in IndexedDB (the one allowed use, see File conventions) and permission is re-granted with one click each browser session. `loadPublishBase()` must stay the first await in the Confirm Publish click handler, because the picker and the permission prompt need a fresh user gesture
- `loadPublishBase()` remembers the exact text it read; `publishSession()` re-reads the file and refuses, writing nothing, if the text differs at all. Never add a retry, a force or a fallback that writes over a file publish did not read
- Before overwriting, publish copies the current file to `data/magers-campaign.prev.json` (git-ignored). If that copy fails, the campaign file is not written
- Safe Test Mode builds on `tests/fixtures/test-campaign.json` and writes only `tests/output/test-campaign.published.json` (git-ignored). It must never write the fixture (the automated tests depend on it) or the real campaign file
- The file is written as `JSON.stringify(campaign, null, 2) + "\n"`, the format the repo stores, so the VS Code diff shows only what changed
- Every failure is an error ending "Nothing was written" (or saying the old file is unchanged), never a silent skip
- The session page's Publish (`publishFromPage()`, #106) follows the same rules as Delta Review's Confirm Publish: `loadPublishBase()` is its first await, and it builds on the file just read, not the copy the page loaded. Its button stays disabled until no decision is pending (the DM's rule), and the pending decisions are listed beside it
- Live Server must ignore `**/data/**`, `**/tests/**` and `**/OCR Test Files/**` so a publish, or a test photo or screenshot saved there, does not reload the page and lose the review. The list lives in `shared/CampaignLogApp.code-workspace` (the workspace the DM opens; Live Server reads its settings, not the folder's) and in `.vscode/settings.json`; keep the two the same. Write every pattern with a leading `**/`: a relative one (`tests/**`) never matches on Windows (#106). Keep those entries, and keep Live Server's defaults in the list, because the setting replaces them

## Google Drive is retired (issue #98)

- Chronicle no longer uses Google Drive. The proxy calls, the Versions page with its Drive backups, and `drive-test.html` were removed; git history is the backup. Turning off the Apps Script deployment is the DM's step
- Do not add a Drive call, a proxy URL or a Drive file ID back to any page or to the store
- A local `shared/config.js` may still hold `proxyUrl`, `campaignFileId` and `testCampaignFileId`. Nothing reads them; leave them to the DM to delete, and never copy them anywhere

---

## Shared module load order

When a page needs all eleven shared modules, load them in this order:

```html
<script src="../shared/config.js"></script>
<script src="../shared/chronicle-store.js"></script>
<script src="../shared/chronicle-ids.js"></script>
<script src="../shared/chronicle-publish.js"></script>
<script src="../shared/chronicle-entities.js"></script>
<script src="../shared/chronicle-facts.js"></script>
<script src="../shared/chronicle-grid.js"></script>
<script src="../shared/chronicle-pages.js"></script>
<script src="../shared/chronicle-integrity.js"></script>
<script src="../shared/chronicle-ai.js"></script>
<script src="../shared/chronicle-narrative.js"></script>
<!-- page script here -->
```

`chronicle-store.js` exports `window.ChronicleStore`. Load it on every page that reads or writes campaign data. It reads `config.js` at call time and works without it for reads (config.js is absent on GitHub Pages), so the player view loads it too.

`chronicle-ids.js` exports `window.ChronicleIds` (and `module.exports` under Node): UUID allocation and legacy-ID translation (issue #95). No dependencies. Load it on any page that accepts IDs from outside the data (intake output, AI output, links) and must turn a legacy ID into a UUID, or that creates entities. The two viewers do not load it, because `normaliseCampaignJson` must stay self-contained.

`chronicle-publish.js` exports `window.ChroniclePublish` (and `module.exports` under Node): `applySession()`, the one function that turns approved review items into campaign data (issue #92), plus `sessionChoices()` and `sessionHeader()`, which the session page uses to pick the session ID and date and hand them to `applySession()` (#99). Session choices and the header rule belong here, not in the page, so `tests/session-header.test.js` runs them through the real publish. It needs `chronicle-ids.js` loaded first and touches no DOM, sessionStorage or network; pages pass their state in as options. Any change to what publish writes goes in this module, not in a page, so `tests/delta-apply.test.js` keeps testing the real code. README "Shared modules" lists its round-conversion rules. Since #106 it also holds `sessionQueue()`, which turns the session page's review into the queue (so `tests/session-publish.test.js` tests the real order and placement), and `deriveRelationships()`, run by every `applySession()`.

`chronicle-entities.js` exports `window.ChronicleEntities` (and `module.exports` under Node): the session page's entity identification (#100), meaning the step 2 mention prompt and reply check, the step 3 rows and the DM's actions, and `toQueueItems()`, which turns the answers into publish items. It needs `chronicle-ids.js` loaded first and touches no DOM, storage or network. Matching rules belong here, not in the page, so `tests/entity-identification.test.js` tests the real code. Only an exact name, PC nickname or alias may be bulk-acknowledged; never let the AI's own confidence decide that. The DM can mark a row not an entity (`dismiss`, #113): it makes no publish item, and a dismissed occurrence is never guessed at downstream (a target keeps its words as `target_text`, an actor's facts are held back, a passage about it goes on the session). The DM can correct a row's kind before settling it (`setKind`, #114); a corrected row is matched by the same rules as a fresh one (`matchRow`), never kept on a match made for the old kind.

`chronicle-facts.js` exports `window.ChronicleFacts` (and `module.exports` under Node): the session page's per-page facts (#101), meaning the facts prompt, the reply check, the imbalance and action-economy checks, and the merge across page breaks. It needs `chronicle-entities.js` loaded first and touches no DOM, storage or network. A fact names actors and targets only by the occurrence ids step 3 settled, never by name, and never assigns an initiative slot: keep both rules in `validateFacts()` and the prompt.

Passages (#102) come from the same call. Each is `{ text, session_id, speaker, page }` and lives on exactly one object, the most specific thing it describes; never copy one to a second place. `speaker` is `"dm"` (exposition, fact) or the NPC's entity id (testimony), and an NPC's words keep the NPC as speaker whether quoted or reported. New lore an NPC told the party is `reliability: "rumoured"`, `source_type: "npc_testimony"`. A passage is cleaned into sentences but adds no fact the notes do not contain. In review the DM can move, edit or drop a passage (#116, `ChronicleFacts.applyPassageEdits`); the edited text is what publishes and what the draft reads, a dropped one is never written or counted as testimony, and neither `originalText` nor `dropped` may reach the published passage. Gemini reads confirmed entity text and passages, never raw notes.

`chronicle-grid.js` exports `window.ChronicleGrid` (and `module.exports` under Node): the session page's round grid (#103), meaning split assignment, the initiative order and every direct move, each a function on the grid model, plus `toTurnSchema()`, the rounds publish (#106) will write. No dependencies, DOM, storage or network. Every correction in the grid is a direct move; do not add an AI call to a move (only "Re-extract this round" calls the AI, through the page). Moves and their rules belong here, not in the page, so `tests/round-grid.test.js` tests the real code.

`chronicle-pages.js` exports `window.ChroniclePages` (and `module.exports` under Node): the session page's entity pages (#105), meaning the touched pages, the one AI draft of text changes, judgment events and the header, its checks, and the publish items approvals produce. No dependencies, DOM, storage or network. Every proposal waits for the DM's decision; never write one unapproved. A death needs the notes to say so: 0 HP or "downed" is never death. An NPC's words stay attributed. A text change is written with `_set` on its one field, never as a whole-object MOD. A placeholder session's recorded title and summary are replaced only when the DM ticks replace (`headerReplaceItem`), never by a draft on its own (#74).

In `admin/session.html` every step's functions share one script, so a new function must not reuse an existing name (a second `renderPages` once broke the upload step); `tests/session-header.test.js` checks this.

`chronicle-integrity.js` exports `window.ChronicleIntegrity`: gap detection (`checks()`) and, since #104, the nine round sanity checks (`roundChecks()` and one function per check). The sanity checks are advisory: never give a flag a blocking field, and never make publish depend on them. It has no dependencies — it can be loaded without `chronicle-ai.js` or `chronicle-narrative.js` when a page only needs gap detection and no AI calls.

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

`shared/chronicle-ai.js` is loaded by `intake.html`, `delta-review.html`, `integrity.html` and `session.html` only. If you add AI capability to a new page, load both `config.js` and `chronicle-ai.js` before the page script. The API key is read from `window.CHRONICLE_CONFIG.anthropicApiKey` — never pass it any other way.

The Anthropic API is called directly from the browser using the `anthropic-dangerous-direct-browser-access: true` header. This header must remain in all `chronicle-ai.js` fetch calls — remove it and the requests will be rejected. Never attempt to proxy AI requests through the Drive Apps Script endpoint.

`ChronicleAI.PARTY_ROSTER` is a string of party nicknames injected into AI prompts. If the party roster changes (new PC, renamed nickname), update `PARTY_ROSTER` in `shared/chronicle-ai.js` as part of the same task.

When to use which method:
- `.call()` — raw API access, use when building a new AI feature or when none of the specific methods fit
- `.fillRoundsFromImage()` — OCR from uploaded session photos (intake, integrity)
- `.fillRoundsFromText()` — round fill from typed description (integrity)
- `.sendCorrectionToAI()` — delta item correction chat (delta-review only)
- `.extractMentions()` — one page's entity mentions for the session page (#100). It streams, because a dense page takes minutes; keep long calls streamed
- `.draftPages()` — the session page's entity-page draft (#105); `.draftHeader()` — the session header's own title and summary draft (#74). A failed header draft leaves the fields as they were
- `.extractFacts()` — one page's facts for the session page (#101), against the occurrence ids from step 3. Never add a fixed slot-to-PC roster to its prompt
- Never show demo data (`demoRoundProposals`, `demoCorrectionResponse`) in place of a real reply. A failed call shows its error (#101)

---

## scripts/build.js

This file exists in the repository but is dead code. The EMBEDDED_DATA markers it looks for were removed from all HTML files during Phase 1. Do not run `node scripts/build.js` — it will do nothing (both targets will be skipped). Do not delete the file without explicit instruction.

---

## Schema conventions

### ID format

Since issue #95 every entity `id` is a lowercase **UUID v4**, e.g. `3f2b8c1e-9a4d-4c7e-b1f0-6d2a9e5c4b81`. The DM chose this format to match Storyteller's constraint C15: opaque, non-sequential, and type-free, so the type lives in the array, never in the id.

- Create ids with `ChronicleIds.newId()` (`shared/chronicle-ids.js`), or with `crypto.randomUUID()` in a one-off script. Never count, never type one by hand, never reuse one.
- Every reference (`a`, `target_id`, `mon_ref`, `character_ids`, `current_holder`, `sid`, `sessions[]`, `from_id`…) holds the target's UUID `id`.
- Never infer an entity's type from its id. Use the array it sits in.
- Every entity that existed before #95 keeps its old typed ID as `legacy_id` (`pc_001`, `npc_014`, `cbt_005`, `session_005`, `obj_003`). Legacy IDs are frozen: never assign a new one, except that a new session keeps the `session_NNN` the DM gave it at intake (Delta Review does this at publish).
- Legacy IDs still name entities outside the data: in the AI prompts, intake, notes and prose. Code that accepts an ID from outside must translate it with `ChronicleIds.buildLegacyIndex()` / `translateRefs()`. Prose is never rewritten.
- After editing `data/magers-campaign.json` by hand, run `node scripts/migrate-opaque-ids.js data/magers-campaign.json --check`. It must print CHECK PASSED.

Workflow records keep typed ids: `prompt_improvement_log[]` (`pil_NNN`) and `deferred_gaps[]` (`gap_NNN`). No entity refers to them.

Legacy IDs that were voided must never appear as a `legacy_id`: `npc_002`, `npc_005`, `npc_006` (gaps in the NPC registry) and `mon_006` (Goblin Slinger, folded into Goblins by issue #94).

A variant of a creature (a goblin with a sling) is the same bestiary entry in a different role. Give its combat roster group a `role` and point `mon_ref` at the base creature; tag abilities seen only in that role with the same `role`. Do not add a second bestiary entry for it.

### `deferred_gaps` — workflow state array

`deferred_gaps[]` is a root-level array written by `delta-review.html` when the DM chooses **Defer** on an integrity gap during a publish cycle. It persists in the campaign JSON alongside narrative data and is version-controlled.

Each entry shape:
```json
{
  "id":             "gap_001",
  "combat_id":      "<combat UUID>",
  "combat_name":    "Goblin Ambush",
  "session_id":     "<session UUID>",
  "missing_rounds": [9],
  "gap_type":       "incoming",
  "deferred_at":    "<session UUID>",
  "status":         "pending"
}
```

Rules:
- IDs follow `gap_001`, `gap_002`, etc. Assign the next by reading the current array length. The combat and session references are UUIDs like every other reference (#95); publish translates a legacy session ID before writing the record.
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

Relationships are computed, never written by hand or detected from raw text (#106). Every publish rebuilds the `participation` records from confirmed data in `ChroniclePublish.deriveRelationships()`; README "Shared modules" lists the sources. Rules the DM set:
- A record with significance `significant_event` is a judgment the DM approved in step 4 (#105). Rebuilds keep it untouched; never delete or recompute one.
- Location visits are not relationships: `sessions_visited` and a combat's location already hold them.
- A disposition is an attribute of a relationship, not one itself: it rides on the party → NPC record as `disposition`.
- Quests make their relationships when they are recorded; discovered facts (faction membership, an NPC's relationship list) make theirs once they are in the data.
- Party-level records use `from_id: "party"`, one per pairing, never one per PC.
To change what relationships exist, change the confirmed data or `deriveRelationships()`, never `entity_relationships[]` itself.

### Next available IDs

None since issue #95: entity ids are UUIDs and are not counted. The last legacy IDs assigned were `pc_006`, `npc_014`, `loc_013`, `qst_005`, `obj_005`, `item_011`, `cbt_006`, `session_007`, `mon_008`, `lore_003` and `moment_003`. Sessions 006 and 007 are placeholders.

The next session's legacy ID, typed by the DM at intake, is `session_008`. Workflow records still count: the next `pil_NNN` and `gap_NNN` come from their array lengths.

Voided/skipped legacy IDs (never reuse): `npc_002`, `npc_005`, `npc_006`, `mon_006`

### Field naming

- JSON field names use `snake_case`
- The `normaliseCampaignJson` function in `log-viewer.html` and `player/index.html` applies field renames at runtime. When adding new fields to the JSON, check whether the viewer needs a corresponding mapping. The README "Schema" section lists all current mappings.
- `class` in the JSON becomes `cls` in the normalised viewer object (reserved word workaround)
- `current_level` in the JSON becomes `level` in the viewer
- A player's absence ("Lance out work, played by David") is a session note, never a PC fact: a plain sentence in `session_logs[].narrative.absence_notes`, first names only, with no `pc_id` (#112). Omit the field when a session has no absence. Never add `mechanics.player_absences` or a `player_absence` mechanical note back

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

Schema 5.0.0 (issue #93) uses the turn schema. A slot is `{ s, a, activities[], notes }`. Each activity is `{ economy, name, detail?, val_type?, outcomes[], notes?, member?, ready_ref? }`, and each outcome is `{ res, val, target_id, target_text?, detail?, effect?, notes? }`. README "Turn schema (5.0.0)" and the data file's own `_field_type_reference.slot_fields` define every field and value. Rules that are easy to get wrong:

- `economy` is one of `action`, `bonus_action`, `reaction`, `movement`, `free`, `legendary_action`, `legendary_resistance`
- For the `action` economy, `name` is a standard action (Attack, Magic, Dash, Ready…), `Death Save`, or `No Action: <reason>`; the spell or weapon goes in `detail`. For other economies `name` is the feature or spell itself
- Down is an outcome `effect`, never an activity. Death saves record `success` or `failure`. A down or kill matched to its roll lives only in that outcome's `effect`, not also in `special_events`
- `target_id` is an ID or null: an entity's UUID `id`, or a roster `actor_id` (roster groups have no ids; #95 converted only objects that already had one). One target per outcome; never slash-joined. A target that is not an entity goes in `target_text` with `target_id` null. Never invent an ID
- One outcome per attack roll, even when the target repeats ("Melee (x2)" on one PC is two outcomes). An outcome's own `detail` (Bite, Claw) names the attack used for that roll and overrides the activity's `detail`
- Enemies have no slots: one `enemy_turns[]` entry per roster group per round, `{ actor_id, activities[], special_events[], notes }`
- Never add the 4.x fields (`action`, `bonus_action`, `reaction`, `movement`, `object_interaction`, `attacks`) back to a slot

The normaliser's `flattenSlot` helper translates a slot to the flat shape the combat viewer expects:

```javascript
// flattenSlot: act lists every activity (activityLabel); res/val come from the
// action activity's single outcome, else null (no badge for multi-attacks).
{ s, a, act: activities.map(activityLabel).join(' / '), res: one?.res ?? null, val: one?.val ?? null, notes: slot.notes || primary?.notes }
```

The `flattenEnemyTurn` helper builds `{desc, impact}` for the renderer:

```javascript
// flattenEnemyTurn: desc lists every activity of the group; impact from special_events[].description
desc   = actor_id + ': ' + activities.map(a => activityLabel(a) + (single outcome ? ' (res, val)' : '')).join('; ');
impact = special_events.map(ev => ev.description).join('; ') || null;
```

The 4.x compatibility branch (`slot.action`, `et.action`) was removed from both helpers by #92. Publish now writes `activities[]` (see `shared/chronicle-publish.js`), so do not add a 4.x reader back. A turn with no `activities` list renders as an empty turn.

`flattenSlot`, `flattenEnemyTurn`, `activityLabel` and `singleOutcome` are nested functions inside `normaliseCampaignJson`. They are not exported. `tests/turn-schema.test.js` cuts `normaliseCampaignJson` out of both pages and checks that the two produce identical combats.

To convert a file that still has 4.x rounds (for example after a pre-#92 publish), run `node scripts/migrate-turn-schema.js <file>` for a dry run, or add `--write` to rewrite the file. The script only reports inconsistencies; it never fixes them.

### What the JSON must never store

- Current HP, spell slots, conditions, or any transient game state — Chronicle is a log, not a live tracker
- Personally identifying player information beyond first names

### Null vs absent fields

- Use `null` explicitly for a field that exists in the schema but has no value yet
- Omit the field entirely if it is not applicable to this entity type

### Schema version

Do not change `_schema_version` without explicit instruction. It lives at the root of the JSON, not inside `meta`. Current version: `5.0.1`: 5.0.0 was approved by the DM on issue #93 for the turn schema, and 5.0.1 on issue #112 for player absence as a session note. The test fixture uses the same version.

---

## What you must never do

- Do not add EMBEDDED_DATA blocks to any HTML file
- Do not add a sync indicator bar to any page
- Do not add a Google Drive call, proxy URL or file ID back (#98)
- Do not introduce npm packages, a bundler, or a JS framework
- Do not reuse voided legacy IDs, and do not mint new typed or sequential ids: new ids are UUIDs from `ChronicleIds.newId()` (#95)
- Do not change `_schema_version` without explicit instruction
- Do not invent field names not present in the schema or the normaliser — check the README schema table first
- Do not store game state (HP, spell slots, conditions) in `magers-campaign.json`
- Do not remove data from existing campaign objects without explicit instruction
- Do not commit or reference `shared/config.js` — it is gitignored and must stay that way
- Do not run `node scripts/build.js` — it is dead code
- **Never commit `safeTestMode: true`** in `shared/config.js` — it redirects all campaign data reads to the test files and publishes to the test output file, which would affect any admin working locally from the same config
- Do not make publish commit, push or call GitHub, and never make it write the campaign file without the stale-file check and the `.prev` copy (#97)
- Do not commit `data/magers-campaign.prev.json` or `tests/output/` — both are git-ignored

---

## Known broken features — do not use as patterns

These features exist in the codebase but are broken. Do not treat them as reference implementations. Fix them properly when asked; do not work around them by copying the broken pattern elsewhere.

| File | Broken feature | Status |
|---|---|---|
| `admin/log-editor.html` | Edits are in-memory only — no write-back to JSON | Document clearly; do not add fake "save" affordances |

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
- [ ] All new ids are UUIDs, and `node scripts/migrate-opaque-ids.js data/magers-campaign.json --check` passes
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
2. Give any new entity a UUID id (`crypto.randomUUID()` or `ChronicleIds.newId()`) and no `legacy_id` (a new session may keep the DM's `session_NNN` as `legacy_id`); reference other entities by their UUID `id`
3. Follow all schema conventions for the entity type
4. Update `meta.last_updated` to today's date
5. Do not change `_schema_version`
6. After editing, run `node scripts/migrate-opaque-ids.js data/magers-campaign.json --check` and confirm CHECK PASSED

---

## Workflow: adding a new admin page

1. Copy the nav bar HTML from an existing admin page (e.g. `integrity.html`)
2. Set the new page's nav link to `active`, all others to inactive
3. Add a nav link for the new page to all other admin pages in the correct position
4. Load `../shared/config.js` at the bottom of `<body>` before the page script
5. Load `../shared/chronicle-ai.js` only if the page uses AI features
6. If the page needs campaign data, load `../shared/chronicle-store.js` and call `ChronicleStore.loadCampaign()` at init — never a direct fetch

---

## Workflow: delta-review publish cycle

Since #97, Delta Review publishes to the local campaign file, and the DM commits and pushes it in VS Code. There is no Drive copy to keep in sync.

The full post-session workflow, run from VS Code with Live Server in Chrome or Edge:
1. Session Intake (`intake.html`) — upload photos, AI extracts round data
2. Delta Review (`delta-review.html`) — approve/reject/correct AI proposals, then Publish. This writes the updated `data/magers-campaign.json` in the local clone and keeps the previous file as `data/magers-campaign.prev.json`. The first publish asks for the repository folder; each new browser session asks once to allow editing it
3. Commit and push in VS Code, using the message the status line suggests: `Publish session_NNN: <title>`. GitHub Pages redeploys on push

If the file changed on disk after Delta Review read it (a `git pull`, a hand edit, another tab), publish stops with nothing written. Reload Delta Review and publish again. To undo a publish before committing, discard the change in VS Code or copy `.prev.json` back.

After a direct edit to `data/magers-campaign.json` (bypassing the workflow): commit and push it as usual. The next publish reads the file from disk.

To test the workflow: set `safeTestMode: true` locally (never commit it). Publish then writes `tests/output/test-campaign.published.json`, which the admin log viewer shows, and leaves the real campaign file and the fixture untouched. Delete `tests/output/` to go back to the fixture.

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

## Workflow: working a GitHub issue

### Issue status

Move each issue you work through these states:

1. **Start: add the `in-progress` label.** Do this before you change any code. If the issue is already closed, ask the DM before reopening it. Setting labels replaces the issue's whole label list, so read the current labels first and send them back with `in-progress` added. Never drop the existing labels (`feature`, `wu-*`, and so on).
2. **Finished but not pushed: leave it open with `in-progress`.** Work that exists only locally or only in a local commit is not complete.
3. **Complete: close it.** Close the issue only after the commit is pushed to `main`, and use the reason "completed". In the same step, remove `in-progress` (keeping every other label) and post the follow-up comment naming the commit hash. A `Closes #N` line in the commit message closes the issue automatically on push. Then check the issue's state, and close it yourself only if it is still open. The label still has to be removed either way.
4. **Stopped or abandoned:** remove `in-progress` and leave the issue open. Post a comment saying what was done, what remains, and why the work stopped.

### Implementation log

Whenever you work a GitHub issue in this repo, post an implementation log as a comment on that issue. Do not wait to be asked. Post it when the work is finished, before reporting back to the DM. If the work is later committed, pushed or changed, post a short follow-up comment that says so and names the commit hash.

The issue thread is the lasting record of why the code changed. Chat history is not kept, and the commit message is too short to hold the reasoning.

Every comment must:

- **Say that Claude wrote it.** Start with a line such as `🤖 Comment written by Claude (Claude Code) on behalf of the DM.` The DM posts through their own GitHub account, so without this line the comment reads as if the DM wrote it.
- **Give the date and state.** Give today's date and say whether the work is uncommitted, committed (with hash) or pushed.

The implementation log must contain these sections:

1. **What was built.** New files, functions or methods, and what each does.
2. **What changed.** Each file touched, with one line on what changed in it.
3. **Deviations.** Anything that differs from the issue's scope or suggested design, and why. Also list any behaviour change a reader would not expect from the issue text. Write "None" if there are none.
4. **Docs.** Which README.md and CLAUDE.md sections were updated.
5. **Automated tests.** Document these explicitly, never as a one-word "tests pass":
   - the exact command(s) run (for example `node tests/run-all.js`)
   - the result for every test file, plus totals (for example `6/6 files passed`, `35 passed, 0 failed`)
   - which tests were added or changed, and what they check
   - what the automated tests do not cover. For example, no test loads the HTML pages themselves.
   - If tests were not run, or any failed, say so plainly and include the failure output.
6. **Manual verification.** Browser or other manual checks done, and what they showed.
7. **Not exercised.** Anything deliberately left untested, and why (for example, a real publish that would rewrite the live campaign file).
8. **Acceptance.** The issue's acceptance checklist, each item ticked or not, with a note on any exception.

Rules:

- Report results faithfully. Never mark an acceptance item done, or tests passing, unless you saw it happen in this session.
- Never paste secrets into a comment: API keys, the proxy URL, Drive file IDs, or anything from `shared/config.js`.
- Posting comments and changing an issue's state are outward-facing. This section is the DM's standing authorisation for exactly these actions on issues you work:
  - posting implementation logs and their follow-ups
  - adding and removing the `in-progress` label
  - closing the issue as completed once its commit is pushed

  It does not authorise any other change. Do not edit issue titles or bodies, add other labels, reopen closed issues, or close issues you did not work.

---

## Keeping documentation current

After any significant change to the codebase — new page, changed fetch path, new JSON section, schema version change, resolved known issue — propose updates to README.md and CLAUDE.md to reflect the new state. Do not let the documentation drift from the code.

To fully regenerate both documents from scratch, run the prompt in `docs/chronicle-docs-prompt.md` from the repository root in Claude Code. That prompt reads every file and rewrites both documents in one pass.
