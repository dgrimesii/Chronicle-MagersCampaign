# Chronicle Magers Campaign — Intake Pipeline Review & UX Streamlining

*Analysis generated: June 2026. Model: Claude Opus 4.6.*

---

# PHASE 1 — Current Pipeline Map

## Pipeline Diagram

```
[1] Image Upload (intake.html, Step 1)
     ↓
[2] OCR Processing (intake.html, Step 1→2 transition)
     ↓
[3] OCR Review & Correction (intake.html, Step 2)
     ↓
[4] Consolidation (intake.html, Step 3)
     ↓
[5] Relationship Detection & Envelope Build (intake.html, Step 4)
     ↓
[6] Hand-off via sessionStorage (intake.html → delta-review.html)
     ↓
[7] Delta Review Queue Load (delta-review.html, loadIntakeDelta)
     ↓
[8] Integrity Pre-flight (delta-review.html, initIntegrity)
     ↓
[9] RAW → ROUND Interpretation (delta-review.html, interpretRawItem)
     ↓
[10] Per-Item Review & AI Correction (delta-review.html, renderReview + sendCorrection)
      ↓
[11] Approve / Reject Each Item (delta-review.html, status toggling)
      ↓
[12] Publish (delta-review.html, publish → applyDeltasToCampaign → Drive write)
```

## Core Design Constraint

**OCR and interpretation errors are the norm, not the exception.** Two distinct failure modes must be treated separately throughout:

- **Failure Mode 1 (FM1) — Acknowledged Uncertainty:** The AI surfaces a choice because it detected ambiguity. The user picks from options. The system at least knows something is uncertain.
- **Failure Mode 2 (FM2) — Confident Misreading:** The AI produced a definite interpretation that is simply wrong. The AI does not flag this. The user must catch it during review without any prompt from the system. This is the dominant failure mode in practice.

## Step-by-Step Detail

### [1] Image Upload
- **Trigger:** DM opens `admin/intake.html`
- **Inputs:** JPEG/PNG photos of handwritten session notes; optional .txt/.md narrative notes
- **Processing:** Files added to `imageFiles[]` and `pageData[]`. Dedup by name+size.
- **Outputs:** `imageFiles[]` populated, "Run OCR Analysis" button enabled
- **Guardrails:** Button disabled until at least one image uploaded
- **Failure Mode 1/2:** None — no AI yet
- **Recovery:** Free add/remove until OCR starts

### [2] OCR Processing
- **Trigger:** DM clicks "Run OCR Analysis"
- **Processing:** `compressImageForOCR()` resizes to max 1800px JPEG, then `ChronicleAI.call()` sends to Anthropic vision API with `buildOCRSystemPrompt()`. Pages processed sequentially.
- **Guardrails:** Compression with retry at 1400px. Per-tab state dots.
- **Failure Mode 1:** AI returns `[?]` markers on uncertain words — visible in textarea
- **Failure Mode 2:** AI confidently misreads handwriting (wrong name, number, action). No flag raised. Text appears as-is.
- **Recovery:** Per-page re-run available at step 3. Images remain in memory.

### [3] OCR Review & Correction
- **Trigger:** OCR completes; DM reviews each page
- **Processing:** DM reads textarea, edits directly, or uses re-run controls (same prompt or with steering text)
- **Guardrails:** "All Pages Confirmed" gated on all pages confirmed
- **Failure Mode 1:** AI `[?]` markers visible; DM fixes manually
- **Failure Mode 2:** DM must catch confident misreadings by cross-referencing physical notes against textarea. Side-by-side image helps, but if the handwriting was hard for the AI, it may be hard for the DM too.
- **Recovery:** Re-run OCR per page. Navigate between pages freely. **Cannot return to upload without reloading the page.**

### [4] Consolidation
- **Trigger:** DM clicks "All Pages Confirmed — Consolidate"
- **Processing:** `buildSessionDoc()` concatenates all OCR text and narrative into a single HTML view
- **Guardrails:** None — display only
- **Failure Mode 1/2:** None new
- **Recovery:** "Back to OCR" button returns to step 3

### [5] Relationship Detection & Envelope Build
- **Trigger:** DM clicks "Send to Delta Analysis"
- **Processing:** Builds delta items (session stub, one RAW item per OCR page, optional narrative item), runs `detectRelationships()` AI call, adds RELATIONSHIP items, writes `chronicle_intake_delta` to sessionStorage.
- **Failure Mode 2:** Relationship detection may hallucinate relationships; low risk since they appear for review in delta-review.
- **Recovery:** "Back" to consolidation. sessionStorage overwritten on re-send.

### [6] Hand-off via sessionStorage
- **Trigger:** DM clicks "Proceed to Delta Review"
- **Processing:** `window.location = 'delta-review.html'` — full page navigation
- **Failure Mode:** sessionStorage cleared if browser clears site data
- **Recovery:** **None. Must restart intake from scratch if sessionStorage is lost.**

### [7] Delta Review Queue Load
- **Trigger:** delta-review.html loads, `loadIntakeDelta()` runs
- **Processing:** Reads **and clears** the sessionStorage key. Builds `items[]` array.
- **Recovery:** **None — sessionStorage cleared on read. Cannot return to intake with data intact.**

### [8] Integrity Pre-flight
- **Trigger:** `initIntegrity()` on page load
- **Processing:** Fetches campaign JSON, runs `ChronicleIntegrity.checks()`, renders integrity panel if gaps found. Publish blocked until gaps resolved.
- **Failure Mode 1/2:** Deterministic gap detection, not AI-dependent
- **Recovery:** Each gap can be Accept'd, Deferred, or Edited individually

### [9] RAW → ROUND Interpretation
- **Trigger:** DM clicks "Interpret" button on each RAW item card; selects combat
- **Processing:** `interpretRawItem()` calls `ChronicleAI.fillRoundsFromText()`. Returns structured round proposals. Each becomes a ROUND cascade item. New entities added as additional cascade items.
- **Failure Mode 1:** AI may return "unclear" in round fields
- **Failure Mode 2:** **Major site.** AI interprets already-OCR'd text (which may contain step-2 errors). Confident misattribution of actions to wrong PCs, wrong damage numbers, hallucinated spell names — all common. No image available for reference at this point.
- **Recovery:** ROUND items can be corrected via AI sidebar (step 10). But the correction requires another AI round-trip, creating a nested error-correction loop.

### [10] Per-Item Review & AI Correction
- **Trigger:** DM selects a queue item; types correction in sidebar textarea
- **Processing:** `sendCorrection()` → `ChronicleAI.sendCorrectionToAI()` → AI returns diffs → DM clicks Apply → `rawData` mutated, ground truth propagated (#57).
- **Failure Mode 2:** **Dominant failure point.** AI must understand the natural-language correction AND map it to the correct field path. Common failures: wrong slot index, wrong field key, wrong old value, cascade produced when a direct diff was needed (#69).
- **Recovery:** DM can "Discard" and retry, but each retry is another AI call. **No direct edit path exists.**

### [11] Approve / Reject Each Item
- **Trigger:** DM clicks approve/reject per item
- **Failure Mode 1/2:** None — DM assertion only
- **Recovery:** Can toggle status freely

### [12] Publish
- **Trigger:** DM clicks Publish
- **Processing:** Backs up Drive copy, fetches current JSON, runs `applyDeltasToCampaign()`, writes to Drive
- **Failure Mode 2:** Errors from steps 9-10 not caught by DM are committed permanently. No pre-publish confirmation (#37).
- **Recovery:** Drive backup allows manual rollback, but it is a file-level manual operation.

## Entity Handling

**NPCs:** Detected during interpretation (step 9) via `new_entities` with `type: "npc"`. Cascade items in the queue. Also created via AI correction cascades (step 10). Deduped against `campaignIntegrityData.npc_directory`.

**Factions:** Schema exists (`factions[]` array). **No detection or creation path anywhere in the pipeline. Not in any AI prompt. Not handled by `applyDeltasToCampaign()`. Completely inert.**

**Cohorts:** Schema exists (`cohorts[]` array). **No detection or creation path.** Issue #62 describes desired behavior but is not implemented. Issue #55 (schema introduction) is open, but the array already exists in the JSON.

---

# PHASE 2 — Issue and Debt Inventory

## By Pipeline Step

### Steps 2-3 — OCR

| Issue | Status | Failure Mode | Notes |
|---|---|---|---|
| #28 OCR re-run, steering, logging | Closed | FM1 | Completed — three correction paths available |
| #29 Prompt improvement log | Closed | FM2 | Completed |
| #32 OCR in-progress indicator | Closed | Neither | Completed |
| #33 Multi-page OCR hardening | Closed | Neither | Completed |

**Unfiled gap:** `buildOCRSystemPrompt()` has no mechanism to inject the campaign roster or known entity names. The OCR AI guesses at every proper noun from handwriting alone. **Highest-impact unaddressed FM2 source.**

### Step 1 — Upload

| Issue | Status | Failure Mode | Notes |
|---|---|---|---|
| #71 Drag-to-reorder never implemented | Open | Neither | Wrong page order garbles round data |

**Unfiled gap:** Cannot return to step 1 after OCR starts without reloading and re-uploading everything.

### Step 5 — Relationship Detection

| Issue | Status | Failure Mode | Notes |
|---|---|---|---|
| #43 Relationship detection in intake prompt | Open | FM2 | Code exists; not yet producing populated `entity_relationships[]` from real sessions |

### Steps 6-7 — Hand-off & Queue Load

| Issue | Status | Failure Mode | Notes |
|---|---|---|---|
| #30 sessionStorage hand-off | Closed | Neither | Completed |

**Unfiled gap:** sessionStorage cleared on read. If DM navigates away and back, queue is gone. No recovery.

### Step 8 — Integrity Pre-flight

| Issue | Status | Failure Mode | Notes |
|---|---|---|---|
| #8 Pre-publish integrity panel | Open/in-review | Neither | Panel exists; sub-issues open |
| #38 Partial resolution state missing | Open/in-review | Neither | No visual distinction between untouched and partially-filled gaps |
| #39 Integrity fill rounds corrupt on publish | Open/in-review | Neither | `type:'NEW'` should be `type:'ROUND'` — data corruption |
| #35 cbt_003 rounds 2-3 missing | Open | Neither | Existing campaign data gap |

### Step 9 — Interpretation

| Issue | Status | Failure Mode | Notes |
|---|---|---|---|
| #70 OCR pages silently skipped on publish | Open/in-review | FM2 | RAW items produce zero campaign writes; Interpret button not self-evident |
| #73 New combat option in Interpret form | Closed | Neither | Completed |

**Unfiled gap:** Interpretation is a second AI pass over already-OCR'd text. Errors from step 2 are inherited with no signal to the DM that interpretation is working from potentially-flawed input.

### Step 10 — AI Correction Sidebar

| Issue | Status | Failure Mode | Notes |
|---|---|---|---|
| #61 Sidebar layout & usability | Open | FM2 | Too narrow, textarea too small |
| #56 Pre-seed AI with campaign roster | Open | FM2 | AI cannot match existing entities without roster |
| #57 Ground truth registry & propagation | Closed | FM2 | Completed |
| #58 Redirect new→existing on correction | Closed | FM2 | Completed |
| #59 Stacking sidebar entries on retry | Closed | FM2 | Completed |
| #60 "Apply to All" not propagating | Open | FM2 | Bulk corrections don't update non-active cards |
| #69 ROUND corrections create cascades not patches | Open/in-review | FM2 | AI doesn't know ROUND schema; can't produce slot-level diffs |
| #72 RAW card stale render post-correction | Open/in-review | FM2 | Stale closure captures pre-correction text |
| #36 AI corrections don't update item card | Closed | FM2 | Fixed |
| #64 Session title/summary published empty | Open/in-review | FM2 | Inputs added; generation not built |
| #74 AI-generate session title and summary | Open | FM2 | Enhancement request |

### Step 12 — Publish

| Issue | Status | Failure Mode | Notes |
|---|---|---|---|
| #37 Pre-publish confirmation panel | Open | Neither | No preview before committing |

### Schema / Cross-cutting

| Issue | Status | Notes |
|---|---|---|
| #55 Introduce cohorts[] | Open | Array already exists in JSON |
| #54 Introduce factions[] | Closed | Done |
| #62 Cohort detection | Open | Not implemented; blocked on #55, #56 |

## Pipeline-wide Gaps (No Issue Filed)

1. **No undo after sessionStorage hand-off** — once "Proceed to Delta Review" is clicked, the intake data is gone. Any problem requires a full restart.
2. **Double AI pass amplifies errors** — OCR errors are silently inherited by interpretation with no signal to the DM.
3. **No direct edit for ROUND items** — every correction requires an AI round-trip. No click-to-edit on a cell.
4. **No batch review for ROUND items** — each round is a separate queue item. 14 rounds = 14+ sidebar items to individually review.
5. **OCR prompt has no campaign context** — knows party roster but not NPCs, locations, monsters, spells.
6. **Interpret step has no image access** — original image is in intake.html (no longer loaded). If OCR text was wrong, interpretation cannot self-correct.

---

# PHASE 3 — UX Streamlining Analysis

## Concern A — Redundant Input Type Separation

**Current state:** Two upload zones ("Combat Log — Images" and "Narrative Notes — Text") imply that combat data comes from images and narrative from text files. Real session notes contain both types on the same pages.

**Is the separation architecturally justified?** Partially — images require vision API processing, text files don't. But the DM's handwritten notes don't respect this boundary. Narrative context sits alongside combat rounds on the same page.

**Where it creates friction:** The DM must pre-classify their content at upload time. If narrative notes are handwritten on the same pages as combat, they cannot be uploaded separately as text — they must be transcribed manually.

**What a unified model would look like:** A single upload zone accepting images and text files. All images go through OCR. Text files passed through as-is. The AI interpretation step handles content-type classification — it decides which parts are combat rounds, which are narrative, which are entity references. Defers classification to where the knowledge lives.

**Recommendation:** Merge the upload zones. Remove the "combat vs narrative" labeling from the UI. Let auto-interpretation handle content classification.

## Concern B — No Step Recovery / Rollback

**Hard barriers in the current pipeline:**
- **After step 3:** Cannot return to upload without a full page reload and re-upload
- **After step 6:** sessionStorage hand-off is destructive — once delta-review reads the key, the intake data is gone. Any problem requires full restart: re-upload, re-OCR, re-confirm every page.
- **At step 10:** No direct edit. If an AI correction is itself wrong, the only option is another AI call.

**Steps most likely to require rollback (ordered by FM2 risk):**
1. Step 9 (Interpretation) — every field is a potential misreading of potentially-flawed OCR text
2. Step 10 (AI Correction) — AI-mediated corrections can themselves be wrong
3. Step 2 (OCR) — mitigated by re-run and direct edit

**Proposed recovery model:**
- Don't clear sessionStorage on read — keep the envelope until publish completes
- Add "Back to Intake" button in delta-review (accepts that re-upload is needed, but at least the user knows why)
- **Primarily:** replace AI-mediated correction with inline edit at step 10, which eliminates the need for rollback from the correction loop entirely

## Concern C — Too Many Steps

**Distinct transformations (genuinely necessary):**
Upload → OCR → Page Review → Auto-Interpret → Structured Review → Publish

**Steps that are pure plumbing (zero user value):**
- Step 4 (Consolidation) — display of already-confirmed text; adds nothing
- Steps 6-7 (sessionStorage hand-off) — technical seam between two HTML files
- Step 9 (Manual Interpret trigger) — DM should not need to trigger this per page

**The correction workflow creates extra steps that only exist because inline edit is missing.** Currently: select item → type correction in NL → wait for AI → review diffs → apply/discard → potentially repeat (3-6 sub-steps). With inline edit: click wrong value → type correct value → Enter (1 sub-step).

## Concern D — Pipeline Never Completes

**Blocking Point 1 — AI corrections fail to resolve errors (step 10)**
The DM types a correction. The AI produces a wrong diff (wrong slot index, wrong field path, wrong old value — #69). The DM discards and retries. After 2-3 failed corrections, the DM is stranded. **No escape hatch exists.**

**Blocking Point 2 — RAW items require manual Interpret triggering (step 9)**
The DM must know to click "Interpret" on each RAW item and select a combat. If they don't, RAW items sit inert and produce zero output on publish (#70).

**Blocking Point 3 — sessionStorage hand-off is one-way (steps 6-7)**
Once in delta-review, there is no way back to intake. Any problem requires full restart.

**Blocking Point 4 — OCR confidently misreads text (step 2)**
The error propagates silently through consolidation, interpretation, and into published JSON if not caught at step 3.

**Blocking Point 5 — ROUND corrections create cascades not patches (#69)**
Even when the AI responds to a correction, the response is wrong in kind — a new entity cascade when it should be a slot-level diff. The round data is never actually fixed.

**The cascade failure pattern (observed on every testing session):**
OCR error (step 2) → not caught at review (step 3) → propagated to interpretation (step 9) → DM notices in ROUND card (step 10) → AI correction produces wrong diff → retry fails → DM abandons.

## Concern E — The Correction Experience

**Where it occurs:** Step 10 — `sendCorrection()` in delta-review.html

**Round-trips per typical correction:**
- Best case: 1
- Typical case: 2-3
- ROUND items: effectively infinite due to #69 (AI cannot produce valid slot-level diffs)

**What happens when a correction prompt is misunderstood:**
The AI returns a diff with the wrong field key. DM clicks Discard. Retypes more specific correction. AI may now get the key right but quote the wrong old value. Discard, retry. Each retry is 5-15 seconds of API latency. After 3 failures, no remaining options.

**Two distinct correction types — only one is solved by inline editing:**

Real-world testing revealed that corrections fall into two categories that require fundamentally different solutions:

**Type 1 — Lexical errors** (wrong word, misread ability name, garbled proper noun): These are fixable by inline edit. Example: "stealing hands" misread from "healing hands" on a page where the Aasimar's cramped handwriting caused a character substitution. The DM clicks the wrong word, types the correct one, presses Enter. No AI call needed. This is where inline editing has genuine value.

**Type 2 — Structural errors** (wrong initiative order, wrong player-action associations, combat rounds misassigned to the wrong actor across multiple slots): These are **not** fixable by inline editing. When handwritten notes are cramped and the AI cannot determine which action belongs to which player in which round, the result is not a single wrong word — it is a wrong structure across multiple slots simultaneously. Correcting this requires reordering rows, reassigning actor IDs, and splitting or merging slots. In testing, this class of error required significant AI correction prompting and still frequently failed to resolve cleanly due to #69 (the AI's inability to produce valid slot-level diffs).

**Inline editing is a necessary improvement, not a complete solution.** It removes friction for Type 1 (lexical) errors. It does nothing for Type 2 (structural) errors, which are the harder and more consequential failure pattern. The AI correction sidebar must remain — and must be significantly improved — specifically for structural reordering. The fix for the sidebar is not to demote it, but to give it schema knowledge: the AI needs to understand the ROUND slot structure well enough to produce valid reordering diffs (#69).

**What inline correction would look like (for Type 1 errors):**
`renderRoundNL()` currently displays a table of slots (actor, action, result, value, notes). Each cell becomes a `contenteditable` span or click-to-edit input. DM clicks "stealing hands" → input appears → types "healing hands" → Enter → `rawData.slots[2].action` updated directly. No AI call. No latency.

**What structural correction still requires (for Type 2 errors):**
The AI sidebar is the right tool for structural reordering, but it must be fixed to understand the ROUND slot schema (#69). The prompt sent to `sendCorrectionToAI()` should include the full current slot structure serialized as JSON, and the AI's response spec should explicitly support slot reordering and actor reassignment as diff operations — not just field-value replacements.

**Classes of errors reducible upstream:**

| Error Class | Upstream Fix | Impact |
|---|---|---|
| Proper nouns (PC names, NPC names, location names) | Inject campaign roster + NPC/location names into OCR prompt | **High** — most common FM2 error class |
| PC racial/class features and ability names | Inject targeted SRD excerpt for each PC's race and class into OCR and interpretation prompts | **High** — "healing hands" is a known Aasimar feature; context injection would have caught the "stealing hands" misread before it reached review |
| Abbreviations | Connect `glossary.html` data to `buildOCRSystemPrompt()` | Medium — data exists but is not exported |
| Structural ordering (initiative, actor assignment) | Cannot be reduced upstream; cramped handwriting is the root cause. Must be fixed at review via improved AI sidebar schema knowledge (#69) | High risk, requires sidebar fix |
| Numbers (damage, rounds) | Flag implausible values during interpretation (>100 damage, negative, non-numeric) | Low-medium — handwriting quality is root cause |

**On SRD context injection:** A full SRD is too large to inject. The targeted approach is a per-PC feature list — for the Magers Campaign party, this means injecting the Aasimar feature list (Healing Hands, Radiant Soul, Necrotic Shroud, etc.), the Paladin spell list, the Ranger spell list, etc. This is a small, manageable payload that directly addresses the ability-name misread category. Each PC's relevant SRD section can be stored as a static string in `chronicle-ai.js` alongside `PARTY_ROSTER` and injected into both the OCR prompt and the interpretation prompt.

---

# PHASE 4 — Streamlined Pipeline Proposal

## Pipeline Diagram

```
[1] Upload Session Pages
     ↓
[2] OCR + Context Injection
     ↓
[3] Page Review (inline edit, confirm per page)
     ↓
[4] Auto-Interpret (AI structures all confirmed text in one pass)
     ↓
[5] Structured Review (inline-editable table, entity cards, session stub)
     ↓
[6] Publish (with pre-publish confirmation)
```

## Step-by-Step Detail

### [1] Upload Session Pages
- **What the user does:** Drops all session note images (and optionally a text file) into a single upload zone.
- **What the system does:** Accepts images and text files. Images queued for OCR. Text files tagged as narrative. Drag-to-reorder enabled (#71 fix). No "combat vs narrative" separation.
- **How confident misreadings are caught:** N/A — no AI yet
- **Guardrails:** File dedup, size validation, drag-to-reorder
- **Recovery:** Free add/remove/reorder until "Begin Processing"
- **Removed:** Two-zone "Combat / Narrative" separation

### [2] OCR + Context Injection
- **What the user does:** Clicks "Begin Processing" and waits.
- **What the system does:** Fetches `magers-campaign.json` at intake load (currently not done). For each image: compresses, then calls vision API with a system prompt containing (a) `PARTY_ROSTER`, (b) known NPC/location/monster names from campaign JSON, (c) glossary abbreviations, (d) a targeted SRD excerpt — per-PC racial features and class ability lists stored as a static payload in `chronicle-ai.js` alongside `PARTY_ROSTER`. Example: knowing the Aasimar PC has "Healing Hands" (not "Stealing Hands") is a known feature the AI should expect to see in handwriting. SRD injection is not the full rulebook — it is a curated list of abilities and terms that are likely to appear in this party's session notes.
- **How confident misreadings are caught:** Campaign context + SRD terms dramatically reduces FM2 for proper nouns and ability names. Structural ordering errors (who did what in which round) cannot be reduced at this stage — cramped handwriting is the root cause and must be handled at step 5.
- **Guardrails:** Compression, per-page progress, processing banner (existing)
- **Recovery:** Per-page re-run at step 3
- **Removed:** Nothing; added campaign roster + SRD feature injection into `buildOCRSystemPrompt()`

### [3] Page Review
- **What the user does:** Reviews each page's OCR output in a textarea, edits errors directly, confirms.
- **What the system does:** Side-by-side image + text (existing). Re-run with steering (existing). Textarea directly editable (existing).
- **How confident misreadings are caught:** DM compares textarea against physical notes. With proper noun injection from step 2, the most common FM2 errors are already reduced. Review effort focuses on numbers and actions rather than names.
- **Guardrails:** Per-page confirm required. Error banners on failed pages. Steering with prompt logging (existing).
- **Recovery:** Re-run per page. Navigate between pages freely. "Back to Upload" button (new).
- **Removed:** Nothing substantial. Added "Back to Upload" navigation.

### [4] Auto-Interpret
- **What the user does:** Clicks "Send for Interpretation" once all pages are confirmed.
- **What the system does:** In one automated pass: (a) concatenates all confirmed OCR text, (b) calls `fillRoundsFromText()` — AI infers combats from context rather than DM selecting them, (c) detects entities and relationships, (d) builds session stub with AI-generated title and summary (#74), (e) builds all delta items. DM waits; no manual triggering per page.
- **How confident misreadings are caught:** Interpretation errors surface at step 5 where inline editing is available.
- **Guardrails:** Implausible values flagged (damage >100, unknown actor IDs). Combat ambiguities surface as choices at step 5 rather than blocking interpretation.
- **Recovery:** If interpretation fails entirely, re-run. If partially wrong, fix at step 5 via inline edit — no AI round-trip needed for field-level fixes.
- **Removed/merged:** Consolidation (old step 4), relationship detection (old step 5), sessionStorage hand-off (old step 6), queue load (old step 7), integrity pre-flight (old step 8), and manual RAW interpretation (old step 9). Six steps collapsed into one automated step with one DM click.

### [5] Structured Review
- **What the user does:** Reviews each item; fixes lexical errors by clicking on the wrong value and typing the correct one; uses the AI sidebar for structural errors (wrong initiative order, misassigned actions); approves when correct.
- **What the system does:** Renders ROUND items as an inline-editable table. Each cell (actor, action, result, value, notes, target, target_effects) is click-to-edit — clicking converts it to an input; Enter commits directly to `rawData`. No AI call for cell-level edits. The AI correction sidebar handles structural corrections (slot reordering, actor reassignment across multiple rounds) — but must be fixed (#69) to send the full current slot structure as JSON and accept slot-level reordering as a valid diff operation. Entity cards (NPC, monster, location) similarly inline-editable. Session stub has editable title/summary.
- **How confident misreadings are caught:** Two-tier correction model. Lexical errors (wrong word, wrong ability name) caught by scanning the table and fixed via inline edit — fast, no AI, no latency. Structural errors (wrong actor in wrong slot, wrong round ordering) caught by comparing the table row-by-row against physical notes and fixed via the AI sidebar with full slot-structure context provided. The DM has physical originals on hand; screen real estate is for the interpreted data, not source images.
- **Guardrails:** Ground truth propagation (#57). Redirect detection (#58). Integrity checks against campaign data.
- **Recovery:** Inline edits: direct value replacement, previous value can be stored for undo. AI sidebar corrections: can be discarded and retried (existing). The sidebar's reliability for structural corrections depends on fixing #69.
- **Removed:** AI-mediated correction as the mechanism for *lexical* errors. Inline edit handles those. The AI sidebar remains the mechanism for structural errors and is elevated, not demoted — but must be given schema knowledge to do its job.

### [6] Publish
- **What the user does:** Clicks Publish; reviews the pre-publish confirmation panel (#37); clicks Confirm.
- **What the system does:** Shows full item list, change counts, safe-test-mode indicator. On confirm: backs up, fetches, applies, writes to Drive.
- **How confident misreadings are caught:** Final scan of all approved items before commit.
- **Guardrails:** Pre-publish confirmation (#37). Backup before write. Safe test mode.
- **Recovery:** Cancel returns to step 5. Drive backup allows post-publish rollback.
- **Removed:** Nothing; added pre-publish confirmation panel.

---

# Delta Summary (plain language)

The current pipeline has 12 steps. The proposed pipeline has 6. Here is what changed and why.

**The biggest problem was not the number of steps — it was that every correction required asking the AI to fix itself.** When the AI misread your handwriting (which happens on every session), you had to describe the error in words, send it to the AI, hope the AI understood, review its proposed fix, and apply it. If the AI misunderstood your correction, you tried again. This loop was the primary reason no intake run has ever completed successfully.

**There are two kinds of errors, and they need two different fixes.**

The first kind is a lexical error: the AI reads "healing hands" as "stealing hands" because two letters looked similar in cramped handwriting. For this, the fix is to let you edit the data directly — click on the wrong word, type the right one, press Enter. No AI call, no round-trips, no chance of misunderstanding.

The second kind is a structural error: the AI assigns the wrong action to the wrong player across multiple rounds because the initiative order was unclear from cramped notes. For this, inline editing is not enough — you can't fix a wrong table structure by clicking on one cell. This still requires the AI sidebar, but the sidebar currently cannot produce valid slot-level restructuring diffs (#69). That bug must be fixed, and the sidebar must be given the full current slot structure as context so it knows what it is being asked to rearrange.

**Preventing errors upstream matters as much as fixing them downstream.** The OCR AI currently reads your handwriting without knowing which ability names exist in the game or on your characters' sheets. "Healing Hands" is a real Aasimar racial feature — if the AI knew that, it would be far less likely to misread it as "Stealing Hands". The proposed fix is to inject a curated list of each PC's racial features and class abilities into the OCR prompt (stored in `chronicle-ai.js` alongside the party roster). This is a small addition that directly addresses the ability-name misread category.

**The second biggest problem was that OCR didn't know your campaign.** The AI was reading your handwriting without knowing which names to expect — it had to guess "Zragar" from your handwriting alone. In the new pipeline, the OCR step is told every character name, NPC name, location name, and monster name. It will still sometimes misread, but far less often on proper nouns — and those are the most important corrections to get right.

**Four "steps" were eliminated because they were plumbing, not work:**
1. Consolidation — you already confirmed each page; showing them concatenated added nothing
2. sessionStorage hand-off — technical plumbing between two HTML pages, invisible but a source of data loss if anything went wrong
3. Manual "Interpret" triggering — you had to click a button on each OCR page and select which combat it belonged to; the system does this automatically now
4. Relationship detection as a separate step — now happens automatically during interpretation

**Specific issues addressed by this proposal:**

| Issue | How addressed |
|---|---|
| #70 RAW items never written to JSON | Eliminated — auto-interpret converts all OCR text to structured items |
| #69 ROUND corrections create cascades | Partially mitigated — inline edit bypasses AI for lexical fixes; structural reordering still requires AI sidebar and depends on fixing #69 |
| #71 Drag to reorder not implemented | Included in step 1 |
| #37 No pre-publish confirmation | Included in step 6 |
| #64 / #74 Session title/summary empty | Handled automatically in auto-interpret |
| #72 RAW card stale render post-correction | Eliminated — RAW items are auto-interpreted, not displayed as raw text |
| Unfiled: OCR has no campaign context | Fixed in step 2 via roster injection into `buildOCRSystemPrompt()` |
| Unfiled: No direct edit for ROUND items | Fixed in step 5 via inline-editable table cells |
