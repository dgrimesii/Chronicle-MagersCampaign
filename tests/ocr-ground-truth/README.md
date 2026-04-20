# tests/ocr-ground-truth/

Ground-truth pairs for OCR accuracy testing. Each pair consists of:

- An **image file** (`.jpg` or `.png`) — a scanned or photographed session notes page
- An **expected JSON file** (`.json`) — the exact round-data output that a correct OCR pass should produce for that image

## Naming convention

Pairs share a base name and differ only in extension:

```
session_006_page_01.jpg       ← source image
session_006_page_01.json      ← expected OCR output
```

The base name format is: `<session_id>_page_<zero-padded-page-number>`

Examples:
- `session_006_page_01.jpg` / `session_006_page_01.json`
- `session_007_page_02.jpg` / `session_007_page_02.json`

## Expected JSON format

The expected JSON file must contain an array of round objects in the v4 schema:

```json
[
  {
    "combatId": "cbt_005",
    "roundNumber": 1,
    "slots": [
      { "s": 1, "a": "pc_001", "action": { "name": "Longsword", "res": "hit", "val": 8 }, "notes": null }
    ],
    "enemyTurns": [
      { "actor_id": "Goblin A", "action": { "name": "Scimitar", "res": "miss", "val": 0 }, "special_events": [] }
    ]
  }
]
```

## How ground-truth tests work

The OCR ground-truth tests (Group B — see `docs/chronicle-intake-test-plan.md`) call `ChronicleAI.fillRoundsFromImage()` with the image file and compare the output to the expected JSON. A test passes when the produced round data matches the expected JSON within an acceptable tolerance.

Ground-truth tests require a live Anthropic API key and are **not** included in `tests/run-all.js`. Run them separately when testing OCR quality.

## Adding a new pair

1. Place the image in this directory with the session/page naming convention
2. Manually create the expected JSON by reviewing the image directly — do not use the AI output as the ground truth
3. Store the pair under version control so OCR regressions are detectable over time
