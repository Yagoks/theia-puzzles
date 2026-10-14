# Theia Puzzles

3D mini-game puzzles for Foundry VTT v13 (dnd5e), built with three.js.

## L03 — Balança do tributo (`l03-balanca`)

- Click the pedestal tile (Monk's Active Tiles → Run Macro with `game.modules.get("theia-puzzles").api.open("l03-balanca")`).
- **Watch** from anywhere in the scene, or **Interact** with your token within 5 ft (one operator at a time).
- Drag items from your sheet onto a pan (only items with weight, max 5 kg per pan), or place pp/gp/sp/cp (110 coins per kg).
- Drag an object out of a pan with the left mouse button: drop it on the side panel to take it, on the other pan to move it, or anywhere else and it falls and returns. Right-drag to orbit, wheel to zoom.
- Soul Coins are copies of the world item "Soul Coin" and always render as coins, even when put back.
- The GM can release the lock or reset the puzzle from the window.

Mark the pedestal tile with the flag `flags.theia-puzzles.puzzle = "l03-balanca"`.

## Build

`vendor/three-bundle.js` is three.js r169 + OrbitControls + GLTFLoader bundled with esbuild (`build/three-entry.js`).

## Triggers

Each puzzle has a list of triggers (GM: **Triggers** button in the puzzle window, or *Configure Settings › Theia Puzzles › Edit triggers*).
A trigger fires when **all** its conditions hold after a change on the scale; "once" triggers fire a single time (until **Reset**).

- Conditions: Soul Coins in a pan / taken off the scale, weight (kg) in a pan, left − right difference, a named item on a pan.
- Actions: area **trap** around the pedestal (animation, sound, save, damage, half on success, condition with duration),
  chat message, give an item to the operator, run a macro, close the puzzle window.

Default for L03 — *T2 Poisoned payment*: when the left pan has no Soul Coins and weighs < 0.55 kg, close the window and
fire `jb2a.breath_weapons.poison.cone.dark_black` (one cone per zone) across two 2x2 zones on either side of the pedestal + `psfx.cantrips.poison-spray.v1`: every creature in those zones makes a
DC 14 Constitution save, taking 2d6 poison (half on success) and Poisoned for 1 hour on a failure.

### Who rolls the saves (trap `rollMode`)

- `auto` — the GM rolls every save.
- `players` — each connected owner gets a Theia window with a **Roll save** button; NPCs, and anyone who doesn't roll within `rollTimeout` seconds, are rolled by the GM.
- `epic` — a single Epic Rolls 5e request for everyone caught (requires the *Epic Rolls 5e* module); missing results are rolled by the GM.

Creatures caught in the trap can't move until it is resolved.


## Slot tables (`type: "slots"`)

A table with a row of sockets. Each socket has a plaque, a shape (cube, pyramid, circle, cylinder, dodecahedron,
plate) and the piece it accepts. A piece is any item with `flags.theia-puzzles.key`. Pieces dragged in from the
character's list take the shape of their socket. Edit everything in **Setup** (GM button in the puzzle window).

- **Verify:** automatic (solved when every socket holds its piece), a button in the window, or external through
  `game.modules.get("theia-puzzles").api.press(puzzleId, { tokenUuid, tileUuid })` (e.g. a Monk's Active Tiles lever).
- **Wrong combination** (pressed with every socket filled): sound, public and GM messages, sockets locked for N seconds.
  With a socket empty nothing happens.
- **Only original pieces:** when an *Unboxing the Mystery* tile hands out a piece, the GM marks that item with a unique
  id (world setting `instances`). Copies from the Items directory or renamed items don't fit. Setup has a button to
  record pieces handed out another way.
- **Triggers:** conditions `solved`, `released` (emptied after being solved), `filled`, `correct`; actions `door`
  (wall ids → open / closed / locked) and `sound` (file path or Sequencer key). Non-"once" triggers fire each time their
  conditions become true.

Several tiles can open the same puzzle (flag `theia-puzzles.puzzle` on each); reach is measured to the nearest one.


## Alert counters

A dungeon-wide alarm level (0–3 for Casa Angelo, defined in `scripts/alert.js`), shown to the GM only.

- `api.alert.raise(id, { source, reason, amount, bell })` raises it, rings the bell for everyone and whispers the
  GM the new level and what it means. A raise from a **disabled source** (e.g. the T1 cable was cut) is ignored.
- Slot tables raise it on a wrong combination (`alert` / `alertSource` in the puzzle); triggers have an
  "Raise an alert counter" action.
- After `decayMinutes` of **game time** without signals the GM gets a whispered card with a "Lower the alert" button.
  After an intrusion it never drops below `floorAfterIntrusion`.
- `api.alert.open(id)` opens the GM panel: current level, what each level does, +1 / −1 / reset, signal toggles and
  history.
