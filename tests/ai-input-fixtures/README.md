# tests/ai-input-fixtures/

Fixture files that stand in for live AI API responses in automated tests.
Using fixtures instead of live API calls keeps tests fast, deterministic,
and free of API cost.

## When to use these fixtures

Use AI input fixtures for any test that exercises code that would normally
call `ChronicleAI.call()`, `.fillRoundsFromImage()`, `.fillRoundsFromText()`,
or `.sendCorrectionToAI()`. The test loads the fixture file instead of making
a real API call.

## Naming convention

```
<feature>_<scenario>.json
```

- `feature` — the Chronicle feature under test (e.g. `intake`, `correction`, `fill-text`)
- `scenario` — what this fixture represents (e.g. `single-round`, `multi-combat`, `empty-response`)

Examples:
- `intake_single-round.json` — one round of OCR output from the intake pipeline
- `intake_multi-combat.json` — OCR output covering two combats in one session
- `correction_npc-name-fix.json` — AI correction response for a wrong NPC name
- `fill-text_round-description.json` — round data extracted from a text description

## Fixture format

Each fixture file must match the response shape that the corresponding
`ChronicleAI` method returns. The shape varies by method:

### fillRoundsFromImage / fillRoundsFromText

Returns an array of round proposal objects:

```json
[
  {
    "combatId": "cbt_001",
    "roundNumber": 1,
    "slots": [
      { "s": 1, "a": "pc_001", "action": { "name": "Longsword", "res": "hit", "val": 8 }, "notes": null }
    ],
    "enemyTurns": []
  }
]
```

### sendCorrectionToAI

Returns a correction response object. Shape is defined in `shared/chronicle-ai.js`.

## Adding a new fixture

1. Make a real API call once with the desired input
2. Capture the response
3. Save it here with the naming convention above
4. Use the fixture in tests by loading it with `JSON.parse(fs.readFileSync(...))`

Keep fixtures minimal — include only the fields needed to exercise the code
under test. Large fixtures with real campaign content should not be committed
here; use synthetic data only.
