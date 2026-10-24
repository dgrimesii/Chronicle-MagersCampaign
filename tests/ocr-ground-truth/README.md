# tests/ocr-ground-truth/

The ground-truth set (issue #15): three real session pages, each paired with the structured output the session page (`admin/session.html`) should produce from it. It is the test data for the end-to-end run (#17), and a regression set for entity identification (#100), facts (#101) and passages (#102).

The redesign removed the separate OCR-to-text step, so the expected output is structured data — entities, rounds, passages, session notes — not a transcription. (This folder used to describe a v4 round-only format; nothing used it.)

## The pages

The images stay in the DM's local `OCR Test Files/` folder at the repository root, which is git-ignored. This folder holds only the expected answers; its `.gitignore` keeps any image copied here out of git.

| File | Image | Session | What it tests |
|---|---|---|---|
| `ground-truth-1.json` | `Session 6 - page 1.jpg` | session_006 | Goblin Ambush (cbt_005) rounds 4–5: two-column notes, heavy abbreviations, the Larkspur dragons arriving, Gold's Shield reaction, Flurry of Blows, Asp downed |
| `ground-truth-2.json` | `Session 6 - page 2.jpg` | session_006 | Rounds 6–7 across the page break: the "Dragon, Dragon, Oregon" and "Not 1" misreads, the absence note, Mal's opportunity attacks under the enemies' headings, dragons #1 and #2, fleeing, the combat ending |
| `ground-truth-3.json` | `Session 4 - David - 3.jpg` | session_004 | Axe Beak & Vespon Ambush (cbt_003) rounds 10–11 against the recorded rounds; Menne's Ranch described; Helen's testimony about the Quarry; travel; Krustie Gnome |

## What each file holds

- `_about`: the page, image, session, what it tests, where the expected answer comes from, and its status. All three files were **confirmed by the DM against the physical pages on 2026-10-24**; `status` says so, and `answered` records the DM's answers to the questions the drafts raised.
- `entities`: each mention as written, the real campaign's entity (legacy id), and what the fixture should do (match one of its six PCs, or `new`). #17 runs on `tests/fixtures/test-campaign.json`, which since #111 has the six PCs and placeholder sessions 003–007 but nothing else from the campaign.
- `combats`: which combat each page's rounds belong to, the initiative order (legacy PC ids, slot 1 first) and any roster groups to add.
- `rounds`: each round's turns and enemy turns, with activities in the 5.0.0 shape (`economy`, `name`, `detail`, `outcomes` of `res`, `val`, `target`, `effect`). Targets are a PC's legacy id, a roster group's name, or null when the page names none.
- `passages`: the text in substance (not word for word), the speaker (`dm` or the NPC's legacy id) and what it attaches to.
- `session_notes`, `quest_progress`, `loot`: the other facts on the page. Page 3 also has `quests_initiated` (Helen's report starts the Quarry ROUS Problem; the DM: not a progress entry) and `ignored_lines` (a line the DM cannot read, which #17 should not score either way).
- `record_differences` (page 3): where the campaign's recorded rounds disagree with the confirmed page. The page is right; correcting the record is a separate task.
- A turn the combat ended before (no action taken) has an empty `activities` list: no slot is written for it.
- `known_misreads`: what the AI has got wrong on this page before, so #17 can check each was caught or fixed in review.
- `to_confirm`: open questions. Empty in all three files now; if a later look at a page raises a new one, add it here and change `status` back to a draft (`tests/ground-truth.test.js` expects confirmed files).

## How #17 uses them

Run each page through the session page in Safe Test Mode, review it, publish, and compare the published session with the expected answers: every entity settled as listed, every round's turns in the listed slots, every passage on the listed object with the listed speaker, the absence note recorded, and each known misread caught. `tests/ground-truth.test.js` checks that the files themselves are well formed and that every legacy id in them exists; it does not run the AI.
