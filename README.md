# Theia Puzzles

3D mini-game puzzles for Foundry VTT v13 (dnd5e), built with three.js.

## L03 — Balança do tributo (`l03-balanca`)

- Click the pedestal tile (Monk's Active Tiles → Run Macro with `game.modules.get("theia-puzzles").api.open("l03-balanca")`).
- **Assistir** from anywhere in the scene, or **Interagir** with your token within 5 ft (one operator at a time).
- Drag items from your sheet onto a pan (only items with weight, max 5 kg per pan), or place pp/gp/sp/cp (110 coins per kg).
- Hold left-click on an object in a pan to take it into your sheet. Right-drag to orbit, wheel to zoom.
- The GM can release the lock or reset the puzzle from the window.

Mark the pedestal tile with the flag `flags.theia-puzzles.puzzle = "l03-balanca"`.

## Build

`vendor/three-bundle.js` is three.js r169 + OrbitControls + GLTFLoader bundled with esbuild (`build/three-entry.js`).
