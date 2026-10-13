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
fire `jb2a.breath_weapons.poison.cone.green` (one cone per zone) across two 2x2 zones on either side of the pedestal + `psfx.cantrips.poison-spray.v1`: every creature in those zones makes a
DC 14 Constitution save, taking 2d6 poison (half on success) and Poisoned for 1 hour on a failure.
