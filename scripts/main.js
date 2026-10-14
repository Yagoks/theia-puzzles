// Theia Puzzles — 3D mini-game puzzles for Foundry VTT (dnd5e).
//
// Architecture
// - Each puzzle is registered in PUZZLES and placed on a scene by a tile flagged
//   `flags.theia-puzzles.puzzle = "<puzzleId>"` (the pedestal players click, through Monk's Active Tiles).
// - The puzzle state lives on the scene: `flags.theia-puzzles.state.<puzzleId>`. Every client renders from it.
// - Only the active GM mutates state and actor sheets. Players send requests over the module socket; the GM
//   validates (lock owner, distance, weights) and applies them one at a time.
// - One operator at a time ("Interact", must stand within reach of the pedestal); anyone can "Watch"
//   from anywhere in the scene and follow it live.
// - Puzzle types: "scale" (weigh items and coins on two pans) and "slots" (a table of sockets that take specific
//   pieces; solved automatically, by a button, or from outside through api.press(), e.g. a Monk's Active Tiles lever)
//   and "dial" (a combination lock: numbered rings and a handle).

import { THREE, OrbitControls, GLTFLoader } from "../vendor/three-bundle.js";
import { CONDITION_TYPES, PAN_OPTIONS, OPS, ROLL_MODES, ACTION_TYPES, DOOR_STATES, conditionsMet, runAction, playSound, saveLinkFlags } from "./triggers.js";
import { doorGm, registerDoors } from "./doors.js";
import { ALERTS, AlertPanel, alertOp, getAlert, onAlertSocket, openAlert, readyAlert, registerAlert, testBell } from "./alert.js";

const MODULE_ID = "theia-puzzles";
const SOCKET = `module.${MODULE_ID}`;
const LOCK_TIMEOUT_MS = 120_000;
const HEARTBEAT_MS = 20_000;
const COINS_PER_KG = 110; // dnd5e metric currency weight (50 coins per lb)

/* -------------------------------------------- */
/*  Puzzle registry                             */
/* -------------------------------------------- */

const PUZZLES = {
  "l03-balanca": {
    type: "scale",
    title: "Tribute Scale",
    reachFt: 5,
    maxPanKg: 5,
    modelUrl: null, // GLB of the scale (later step); null uses the built-in placeholder
    // The coins in the pan are copies of this world item (Items > Abbandoned Mansion Itens > Soul Coin).
    soulItem: { uuid: "Item.3jaI1tQwMTsR1nA0", name: "Soul Coin" },
    // Face texture for the 3D coin (a copy on the Forge assets, which allow WebGL use).
    soulTexture: "https://assets.forge-vtt.com/63def5083cd17e6cc9b2ed99/Atlantis/Tiles/Puzzles/soul_coin.webp",
    soulCount: 3,
    // Default triggers; the GM edits them in the Triggers window (saved in the "triggers" world setting).
    triggers: [{
      id: "t2", name: "T2 — Poisoned payment", enabled: true, once: true,
      conditions: [
        { type: "souls", pan: "left", op: "eq", value: 0 },
        { type: "weight", pan: "left", op: "lt", value: 0.55 }
      ],
      actions: [
        { type: "closeWindow" },
        { type: "trap", zones: "7700,3300,200,200; 8000,3300,200,200", radius: 10, rollMode: "players", rollTimeout: 30, animation: "jb2a.breath_weapons.poison.cone.dark_black", sound: "psfx.cantrips.poison-spray.v1",
          ability: "con", dc: 14, damage: "2d6", damageType: "poison", half: true,
          status: "poisoned", statusSeconds: 3600,
          flavor: "Green gas bursts from the holes under the pedestal!" }
      ]
    }]
  },

  "l22-selos": {
    type: "slots",
    title: "Table of the Three Seals",
    noun: "table",
    icon: "fa-table-cells",
    reachFt: 5,
    // Each slot: the label on its plaque, the shape of its socket, and the piece it takes (flags.theia-puzzles.key).
    slots: [
      { id: "nome", label: "Nome", shape: "cube", accepts: "mask" },
      { id: "valor", label: "Valor", shape: "cube", accepts: "hands" },
      { id: "testemunha", label: "Testemunha", shape: "cube", accepts: "eye" }
    ],
    // auto: solved as soon as every slot holds its piece • button: "Press" in the window • external: api.press()
    verify: "external",
    // Only pieces actually looted in the dungeon fit (copies made from the Items directory or renamed items don't).
    requireOriginal: true,
    pressSound: "psfx.doors.clean.lock.unlock.wooden.01",
    wrongLockSeconds: 60,
    wrongSound: "", // the bell comes from the alert counter below
    wrongText: "The three slots lock in place with a dry clack. Somewhere in the vault, a bell rings.",
    wrongGmText: "T9 — wrong combination. The slots stay locked for a minute.",
    // A wrong combination raises this alert counter (see alert.js) through the given signal.
    alert: "casa-angelo",
    alertSource: "t9",
    triggers: [
      {
        id: "open", name: "Seals accepted — the vault door opens", enabled: true, once: false,
        conditions: [{ type: "solved", op: "eq", value: 1 }],
        actions: [
          { type: "door", walls: "VjGwtRf63MIDvmy9", state: "open" },
          { type: "door", walls: "2IOCQojUCCfwrq1z", state: "locked" },
          { type: "chat", text: "<p><em>The three seals sink into the table with a heavy clunk. Ahead, a bolt slides free; behind you, the doors slam shut.</em></p>", gmOnly: false }
        ]
      },
      {
        id: "close", name: "Seals removed — back to the start", enabled: true, once: false,
        conditions: [{ type: "released", op: "eq", value: 1 }],
        actions: [
          { type: "door", walls: "VjGwtRf63MIDvmy9", state: "locked" },
          { type: "door", walls: "2IOCQojUCCfwrq1z", state: "open" },
          { type: "chat", text: "<p><em>With the last seal lifted, the vault door grinds shut and the way back opens again.</em></p>", gmOnly: false }
        ]
      }
    ]
  }
};

PUZZLES["l23-cofre"] = {
  type: "rotary",
  title: "Bracelet Vault",
  noun: "vault",
  icon: "fa-vault",
  reachFt: 5,
  digits: 40,
  // One entry per number of the combination: the sigil engraved above the dial (the notes with the numbers are found in
  // the rooms these sigils point to). Turn right for the 1st number, left for the 2nd, right for the 3rd...
  rings: [
    { id: "a", sigil: "scale", label: "Scale" },
    { id: "b", sigil: "compass", label: "Compass" },
    { id: "c", sigil: "seal", label: "Seal" }
  ],
  code: "6-2-9",
  treasure: true, // a golden bracelet waits inside (3D view)
  openSound: "psfx.doors.clean.lock.unlock.wooden.01",
  wrongSound: "",
  wrongLockSeconds: 4,
  wrongText: "The handle won't budge. Somewhere inside the door, the tumblers fall back with a dull clunk.",
  wrongGmText: "L23 vault — the handle was tried without the full combination.",
  // Tile ids (scene of the puzzle): the closed vault the players click, and the open one with the loot (Unboxing).
  triggers: [{
    id: "open", name: "Combination accepted — the vault opens", enabled: true, once: true,
    conditions: [{ type: "solved", op: "eq", value: 1 }],
    actions: [
      { type: "tile", tiles: "uUgRo0YGcEzyLro5", hidden: true },
      { type: "tile", tiles: "WM8WzzUlhI2VbQW6", hidden: false },
      { type: "chat", text: "<p><em>The third click. The handle turns all the way and the heavy door swings open.</em></p>", gmOnly: false }
    ]
  }]
};

/** Sigils that can be engraved above the rings of a dial. */
const SIGILS = { scale: "Scale", compass: "Compass rose", seal: "Wax seal", eye: "Eye", key: "Key", none: "— none —" };

/** "6-2-9", "629" or [6, 2, 9] -> [6, 2, 9] (numbers above 9 need separators: "12-30-4"). */
function parseCode(code, rings) {
  const list = Array.isArray(code) ? code : String(code ?? "").includes("-") || String(code ?? "").includes(",")
    ? String(code).split(/[-,\s]+/) : String(code ?? "").split("");
  return Array.from({ length: rings }, (_, i) => Number(list[i]) || 0);
}

/** Rotary dials: the direction to turn for each number of the combination (1 = right / clockwise, -1 = left). */
const rotaryDir = step => (step % 2 === 0 ? 1 : -1);

/** Socket / piece shapes of slot tables. */
const SHAPES = { cube: "Cube", pyramid: "Pyramid", circle: "Circle (disc)", cylinder: "Cylinder", dodecahedron: "Dodecahedron", plate: "Plate" };
const VERIFY_MODES = {
  auto: "Automatic — solved when every slot holds its piece",
  button: "Button in the puzzle window",
  external: "External — api.press() (e.g. a Monk's Active Tiles lever)"
};

/** Registry entry merged with the GM's edits from the Setup window ("config" world setting). */
function getDef(puzzleId) {
  const base = PUZZLES[puzzleId];
  if (!base) return null;
  const cfg = game.settings.get(MODULE_ID, "config")?.[puzzleId];
  return cfg ? { ...base, ...foundry.utils.deepClone(cfg) } : base;
}

const pieceKey = item => foundry.utils.getProperty(item?.flags ?? {}, `${MODULE_ID}.key`) ?? null;
const pieceInstance = item => foundry.utils.getProperty(item?.flags ?? {}, `${MODULE_ID}.instance`) ?? null;

/** Piece keys known in the world: key -> name of the Items-directory item carrying it. */
function knownPieces() {
  const out = {};
  for (const i of game.items) { const k = pieceKey(i); if (k && !out[k]) out[k] = i.name; }
  return out;
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

const fmtKg = kg => (kg < 1 ? `${Math.round(kg * 1000)} g` : `${Math.round(kg * 100) / 100} kg`);
const panKg = pan => (pan ?? []).reduce((s, e) => s + (e.kg ?? 0), 0);

function itemKgEach(item) {
  const w = item.system?.weight;
  if (!w) return 0;
  const value = Number(w.value ?? w) || 0;
  const units = CONFIG.DND5E?.weightUnits ?? {};
  const from = units[w.units ?? "lb"]?.conversion ?? 1;
  const toKg = units.kg?.conversion ?? 2.5;
  return (value * from) / toKg;
}

function soulSource(def) {
  return (def.soulItem?.uuid && fromUuidSync(def.soulItem.uuid)) || game.items.find(i => i.name === def.soulItem?.name) || null;
}

function isSoul(def, itemOrData) {
  return !!def.soulItem && itemOrData?.name === def.soulItem.name;
}

function soulEntry(def, data = null) {
  const src = soulSource(def);
  return {
    id: foundry.utils.randomID(), kind: "soul", name: def.soulItem.name,
    img: data?.img ?? src?.img ?? "icons/commodities/currency/coin-embossed-skull-gold.webp",
    tex: def.soulTexture ?? null, kg: src ? itemKgEach(src) || 0.2 : 0.2, data
  };
}

function initialState(def) {
  if (def.type === "rotary") {
    return { epoch: foundry.utils.randomID(), lock: null, pos: 0, step: 0, solved: false, lockedUntil: 0, wrong: 0, last: null };
  }
  if (def.type === "dial") {
    return { epoch: foundry.utils.randomID(), lock: null, dials: (def.rings ?? []).map(() => 0), solved: false, lockedUntil: 0,
      wrong: 0, lastTry: null };
  }
  if (def.type === "slots") {
    return { epoch: foundry.utils.randomID(), lock: null, slots: Object.fromEntries((def.slots ?? []).map(s => [s.id, null])),
      solved: false, released: false, lockedUntil: 0 };
  }
  return { epoch: foundry.utils.randomID(), lock: null, pans: { left: Array.from({ length: def.soulCount ?? 0 }, () => soulEntry(def)), right: [] } };
}

function getState(scene, puzzleId) {
  const saved = scene?.getFlag(MODULE_ID, `state.${puzzleId}`);
  if (saved) return foundry.utils.deepClone(saved);
  return initialState(getDef(puzzleId));
}

/** Every tile that opens this puzzle (a slot table can have one per socket). */
function findPedestals(scene, puzzleId) {
  return scene?.tiles.filter(t => t.getFlag(MODULE_ID, "puzzle") === puzzleId) ?? [];
}

function findPedestal(scene, puzzleId) {
  return findPedestals(scene, puzzleId)[0] ?? null;
}

/** Distance in feet from a token to the nearest tile of the puzzle. */
function distanceToPuzzleFt(tokenDoc, scene, puzzleId) {
  const tiles = findPedestals(scene, puzzleId);
  return tiles.length ? Math.min(...tiles.map(t => distanceToPedestalFt(tokenDoc, t))) : Infinity;
}

function findPuzzleScene(puzzleId) {
  if (findPedestal(canvas.scene, puzzleId)) return canvas.scene;
  return game.scenes.find(s => findPedestal(s, puzzleId)) ?? null;
}

/** Distance in feet from a token's edge to the pedestal tile's footprint. */
function distanceToPedestalFt(tokenDoc, tile) {
  const scene = tile.parent, g = scene.grid.size, gd = scene.grid.distance;
  const cx = tokenDoc.x + (tokenDoc.width * g) / 2, cy = tokenDoc.y + (tokenDoc.height * g) / 2;
  const nx = Math.max(tile.x, Math.min(cx, tile.x + tile.width));
  const ny = Math.max(tile.y, Math.min(cy, tile.y + tile.height));
  const px = Math.max(0, Math.hypot(cx - nx, cy - ny) - (tokenDoc.width * g) / 2);
  return (px / g) * gd;
}

/** The puzzle (id) this token is currently operating, if any. */
function puzzleUsedBy(tokenDoc) {
  const scene = tokenDoc.parent;
  for (const puzzleId of Object.keys(PUZZLES)) {
    const lock = scene?.getFlag(MODULE_ID, `state.${puzzleId}`)?.lock;
    if (!lock || lock.tokenUuid !== tokenDoc.uuid) continue;
    const stale = Date.now() - lock.ts > LOCK_TIMEOUT_MS || !game.users.get(lock.userId)?.active;
    if (!stale) return puzzleId;
  }
  return null;
}

function nearTokenFor(user, scene, puzzleId) {
  if (!findPedestal(scene, puzzleId)) return null;
  const reach = getDef(puzzleId).reachFt;
  const candidates = user.isSelf
    ? canvas.tokens.controlled.map(t => t.document)
    : scene.tokens.filter(t => t.actor?.testUserPermission(user, "OWNER"));
  return candidates.find(t => t.parent === scene && t.actor && distanceToPuzzleFt(t, scene, puzzleId) <= reach + 0.01) ?? null;
}

/** Give an item (data) to an actor, stacking onto a matching item when there is one. */
async function giveItem(actor, data) {
  // Plutonium silently cancels the creation of items that still carry its import flag.
  if (data.flags?.plutonium) { data = foundry.utils.deepClone(data); delete data.flags.plutonium; }
  const qty = Number(data.system?.quantity ?? 1) || 1;
  const same = actor.items.find(i => i.name === data.name && i.type === data.type && i.system.quantity !== undefined);
  if (same) return same.update({ "system.quantity": (Number(same.system.quantity) || 0) + qty });
  return actor.createEmbeddedDocuments("Item", [data]);
}

/* -------------------------------------------- */
/*  GM authority                                */
/* -------------------------------------------- */

let gmQueue = Promise.resolve();
const pending = {};

function isActiveGM() {
  return game.user.isGM && game.users.activeGM?.isSelf;
}

async function request(type, payload = {}) {
  const msg = { type, payload, userId: game.user.id, rid: foundry.utils.randomID() };
  if (isActiveGM()) return gmHandle(msg);
  if (!game.users.activeGM) {
    ui.notifications.warn("Theia Puzzles: no GM is connected.");
    return { ok: false };
  }
  return new Promise(resolve => {
    const timer = setTimeout(() => { delete pending[msg.rid]; resolve({ ok: false, msg: "No answer from the GM." }); }, 8000);
    pending[msg.rid] = r => { clearTimeout(timer); delete pending[msg.rid]; resolve(r); };
    game.socket.emit(SOCKET, msg);
  });
}

function gmHandle(msg) {
  const run = () => gmApply(msg).catch(err => {
    console.error(`${MODULE_ID} |`, err);
    return { ok: false, msg: err.message };
  });
  gmQueue = gmQueue.then(run, run);
  return gmQueue;
}

async function gmApply({ type, payload, userId }) {
  // Locked doors (keys, breaking, lockpick) aren't puzzles.
  if (type.startsWith("door")) return doorGm(type, payload, userId, { alertOp });
  const { puzzleId } = payload;
  const def = getDef(puzzleId);
  if (!def) return { ok: false, msg: "Unknown puzzle." };
  const noun = def.noun ?? "scale";
  const scene = game.scenes.get(payload.sceneId) ?? findPuzzleScene(puzzleId);
  if (!scene) return { ok: false, msg: "Puzzle scene not found." };
  const user = game.users.get(userId);
  const state = getState(scene, puzzleId);
  const save = () => scene.setFlag(MODULE_ID, `state.${puzzleId}`, state);
  const now = Date.now();
  const lockStale = state.lock && (now - state.lock.ts > LOCK_TIMEOUT_MS || !game.users.get(state.lock.userId)?.active);
  const holdsLock = state.lock?.userId === userId;
  // Requests sent before a reset belong to the old puzzle: drop them.
  if (type !== "reset" && type !== "release" && payload.epoch && state.epoch && payload.epoch !== state.epoch)
    return { ok: false, msg: "The puzzle was reset." };
  const limitMsg = pan => `A pan holds at most ${def.maxPanKg} kg (it has ${fmtKg(panKg(pan))}).`;

  switch (type) {
    case "claim": {
      if (state.lock && !holdsLock && !lockStale && !user.isGM)
        return { ok: false, msg: `${state.lock.actorName ?? state.lock.userName} is already using the ${noun}.` };
      const tok = payload.tokenUuid ? fromUuidSync(payload.tokenUuid) : null;
      if (!tok?.actor || tok.parent !== scene) return { ok: false, msg: "Select your character's token." };
      if (!user.isGM && !tok.actor.testUserPermission(user, "OWNER")) return { ok: false, msg: "That token isn't yours." };
      if (!user.isGM && distanceToPuzzleFt(tok, scene, puzzleId) > def.reachFt + 0.01)
        return { ok: false, msg: `Move closer: you must be within ${def.reachFt} ft of the ${noun}.` };
      state.lock = { userId, userName: user.name, tokenUuid: tok.uuid, actorName: tok.name, ts: now };
      await save();
      return { ok: true };
    }
    case "heartbeat": {
      if (!holdsLock) return { ok: false };
      state.lock.ts = now;
      await save();
      return { ok: true };
    }
    case "release": {
      if (!holdsLock && !user.isGM) return { ok: false };
      state.lock = null;
      await save();
      return { ok: true };
    }
    case "reset": {
      if (!user.isGM) return { ok: false, msg: "Only the GM can reset the puzzle." };
      // unset first: setFlag merges, which would keep keys like "fired" from the old state
      await scene.unsetFlag(MODULE_ID, `state.${puzzleId}`);
      await scene.setFlag(MODULE_ID, `state.${puzzleId}`, initialState(def));
      // Close the scale for everyone: drags and dialogs in progress are abandoned.
      closeWindowsEverywhere(puzzleId);
      return { ok: true };
    }
  }

  // ----- press (slot tables): anyone, e.g. from a lever tile; no lock needed -----
  if (type === "press") {
    if (def.type !== "slots") return { ok: false, msg: "This puzzle has nothing to press." };
    const r = await slotsPress({ def, state, save, payload, now, origin: findPedestal(scene, puzzleId) });
    const pressTok = payload.tokenUuid ? fromUuidSync(payload.tokenUuid) : null;
    if (r?.ok) await runTriggers(scene, puzzleId, { actor: pressTok?.actor ?? null, tokenDoc: pressTok, userId });
    return r;
  }

  // ----- mutating actions: only the lock holder (or a GM) -----
  if (!holdsLock && !user.isGM) return { ok: false, msg: `You aren't using the ${noun}.` };
  const tokenDoc = state.lock?.tokenUuid ? fromUuidSync(state.lock.tokenUuid) : null;
  const actor = tokenDoc?.actor;
  if (!actor) return { ok: false, msg: "Character not found." };
  if (state.lock) state.lock.ts = now;
  const panName = payload.pan === "left" ? "left" : "right";
  const pan = state.pans?.[panName];

  const result = def.type === "rotary" ? await rotaryApply(type, payload, { def, state, save, actor, now })
    : def.type === "dial" ? await dialApply(type, payload, { def, state, save, actor, now })
    : def.type === "slots" ? await slotsApply(type, payload, { def, state, save, actor, now }) : await (async () => { switch (type) {
    case "placeItem": {
      const item = actor.items.get(payload.itemId);
      if (!item) return { ok: false, msg: "Item not found on the sheet." };
      const each = itemKgEach(item);
      if (each <= 0) return { ok: false, msg: "Weightless items can't be placed on the scale." };
      const have = Number(item.system.quantity ?? 1) || 1;
      const qty = Math.max(1, Math.min(have, Math.floor(Number(payload.qty) || 1)));
      const kg = each * qty;
      if (panKg(pan) + kg > def.maxPanKg + 1e-9) return { ok: false, msg: limitMsg(pan) };
      const data = item.toObject();
      delete data._id;
      if (qty >= have) await item.delete();
      else await item.update({ "system.quantity": have - qty });
      if (isSoul(def, item)) {
        // Soul Coins stay coins on the scale: one coin per unit, each taken on its own.
        for (let i = 0; i < qty; i++) {
          const one = foundry.utils.deepClone(data);
          foundry.utils.setProperty(one, "system.quantity", 1);
          pan.push(soulEntry(def, one));
        }
      } else {
        foundry.utils.setProperty(data, "system.quantity", qty);
        pan.push({ id: foundry.utils.randomID(), kind: "item", name: item.name, img: item.img, kg, qty, data, by: actor.name });
      }
      await save();
      return { ok: true };
    }
    case "placeCurrency": {
      const denom = payload.denom;
      if (!CONFIG.DND5E.currencies[denom]) return { ok: false, msg: "Invalid currency." };
      const have = Number(actor.system.currency?.[denom]) || 0;
      const amount = Math.floor(Number(payload.amount) || 0);
      if (amount <= 0) return { ok: false, msg: "Enter an amount." };
      if (amount > have) return { ok: false, msg: `You only have ${have} ${denom}.` };
      const kg = amount / COINS_PER_KG;
      if (panKg(pan) + kg > def.maxPanKg + 1e-9) return { ok: false, msg: limitMsg(pan) };
      await actor.update({ [`system.currency.${denom}`]: have - amount });
      const pile = pan.find(e => e.kind === "currency" && e.denom === denom);
      if (pile) { pile.amount += amount; pile.kg = pile.amount / COINS_PER_KG; }
      else pan.push({ id: foundry.utils.randomID(), kind: "currency", denom, amount, kg, name: CONFIG.DND5E.currencies[denom].label });
      await save();
      return { ok: true };
    }
    case "move": {
      let entry = null, from = null;
      for (const side of ["left", "right"]) {
        const i = state.pans[side].findIndex(e => e.id === payload.entryId);
        if (i >= 0) { from = side; entry = state.pans[side][i]; break; }
      }
      if (!entry) return { ok: false, msg: "That object is no longer on the scale." };
      if (from === panName) return { ok: true };
      if (panKg(pan) + entry.kg > def.maxPanKg + 1e-9) return { ok: false, msg: limitMsg(pan) };
      state.pans[from] = state.pans[from].filter(e => e.id !== entry.id);
      pan.push(entry);
      await save();
      Hooks.callAll(`${MODULE_ID}.moved`, { puzzleId, scene, entry, from, to: panName, actor, state });
      return { ok: true };
    }
    case "take": {
      let from = null, entry = null;
      for (const side of ["left", "right"]) {
        const i = state.pans[side].findIndex(e => e.id === payload.entryId);
        if (i >= 0) { from = side; entry = state.pans[side].splice(i, 1)[0]; break; }
      }
      if (!entry) return { ok: false, msg: "That object was already taken." };
      if (entry.kind === "item") {
        await giveItem(actor, entry.data);
      } else if (entry.kind === "currency") {
        const have = Number(actor.system.currency?.[entry.denom]) || 0;
        await actor.update({ [`system.currency.${entry.denom}`]: have + entry.amount });
      } else if (entry.kind === "soul") {
        let data = entry.data;
        if (!data) {
          const src = soulSource(def);
          data = src ? src.toObject() : { name: entry.name, type: "loot", img: entry.img, system: { weight: { value: entry.kg, units: "kg" } } };
          delete data._id;
          delete data.folder;
          delete data.ownership;
        }
        foundry.utils.setProperty(data, "system.quantity", 1);
        await giveItem(actor, data);
      }
      await save();
      Hooks.callAll(`${MODULE_ID}.taken`, { puzzleId, scene, entry, from, actor, state });
      return { ok: true };
    }
  }
  return { ok: false, msg: `Unknown action: ${type}` };
  })();
  if (result?.ok) await runTriggers(scene, puzzleId, { actor, tokenDoc, userId });
  return result;
}

/* -------------------------------------------- */
/*  Slot tables (GM side)                       */
/* -------------------------------------------- */

const STUCK_MSG = "The slots are stuck. Try again in a moment.";
const misfit = item => `${item.name} doesn't fit the slot.`;

/** Keep the solved / released flags in step with the slots after every change. */
function settleSlots(def, state) {
  const filled = def.slots.filter(s => state.slots[s.id]).length;
  if (filled > 0) state.released = false;
  if (filled === 0 && state.solved) { state.solved = false; state.released = true; }
  if (def.verify === "auto" && !state.solved && filled === def.slots.length
    && def.slots.every(s => state.slots[s.id].key === s.accepts)) {
    state.solved = true;
    state.released = false;
  }
}

async function slotsApply(type, payload, { def, state, save, actor, now }) {
  state.slots ??= {};
  const slotDef = id => def.slots.find(s => s.id === id);
  const slotOf = entryId => def.slots.find(s => state.slots[s.id]?.id === entryId)?.id ?? null;
  if ((state.lockedUntil ?? 0) > now) return { ok: false, msg: STUCK_MSG };
  switch (type) {
    case "placeSlot": {
      const slot = slotDef(payload.slot);
      if (!slot) return { ok: false, msg: "Unknown slot." };
      if (state.slots[slot.id]) return { ok: false, msg: "That slot already holds a piece." };
      const item = actor.items.get(payload.itemId);
      if (!item) return { ok: false, msg: "Item not found on the sheet." };
      const key = pieceKey(item);
      if (!key) return { ok: false, msg: misfit(item) };
      const instance = pieceInstance(item);
      if (def.requireOriginal) {
        const registry = game.settings.get(MODULE_ID, "instances") ?? {};
        if (!instance || !registry[instance]) return { ok: false, msg: misfit(item) };
        // a duplicated piece carries the same mark: only one of them fits at a time
        if (Object.values(state.slots).some(e => e?.instance === instance)) return { ok: false, msg: misfit(item) };
      }
      const data = item.toObject();
      delete data._id;
      const have = Number(item.system.quantity ?? 1) || 1;
      if (have > 1) await item.update({ "system.quantity": have - 1 });
      else await item.delete();
      foundry.utils.setProperty(data, "system.quantity", 1);
      state.slots[slot.id] = { id: foundry.utils.randomID(), name: item.name, img: item.img, key, instance, data, by: actor.name };
      settleSlots(def, state);
      await save();
      return { ok: true };
    }
    case "moveSlot": {
      const from = slotOf(payload.entryId);
      const to = slotDef(payload.slot);
      if (!from || !to) return { ok: false, msg: "That piece is no longer on the table." };
      if (from === to.id) return { ok: true };
      const other = state.slots[to.id] ?? null; // swap with what is there
      state.slots[to.id] = state.slots[from];
      state.slots[from] = other;
      settleSlots(def, state);
      await save();
      return { ok: true };
    }
    case "takeSlot": {
      const from = slotOf(payload.entryId);
      if (!from) return { ok: false, msg: "That piece was already taken." };
      const entry = state.slots[from];
      state.slots[from] = null;
      // create, don't stack: the piece must keep its own mark
      const data = foundry.utils.deepClone(entry.data);
      if (data.flags?.plutonium) delete data.flags.plutonium;
      await actor.createEmbeddedDocuments("Item", [data]);
      settleSlots(def, state);
      await save();
      return { ok: true };
    }
  }
  return { ok: false, msg: `Unknown action: ${type}` };
}

/* -------------------------------------------- */
/*  Combination dials (GM side)                 */
/* -------------------------------------------- */

const DIAL_STUCK_MSG = "The rings are stuck. Try again in a moment.";

async function dialApply(type, payload, { def, state, save, actor, now }) {
  const rings = def.rings ?? [];
  const n = Number(def.digits) || 10;
  state.dials = rings.map((_, i) => Number(state.dials?.[i]) || 0);
  if (state.solved) return { ok: false, msg: `The ${def.noun ?? "vault"} is already open.` };
  if ((state.lockedUntil ?? 0) > now) return { ok: false, msg: DIAL_STUCK_MSG };
  switch (type) {
    case "turnDial": {
      const i = Number(payload.ring);
      if (!(i >= 0 && i < rings.length)) return { ok: false, msg: "Unknown ring." };
      const delta = Math.sign(Number(payload.delta) || 1);
      state.dials[i] = (((state.dials[i] + delta) % n) + n) % n;
      await save();
      return { ok: true };
    }
    case "tryDial": {
      const code = parseCode(def.code, rings.length);
      const right = code.every((c, i) => state.dials[i] === c);
      state.lastTry = { ts: now, ok: right };
      if (right) {
        state.solved = true;
        await save();
        playSound(def.openSound);
        return { ok: true };
      }
      state.wrong = (state.wrong ?? 0) + 1;
      const secs = Number(def.wrongLockSeconds) || 0;
      state.lockedUntil = secs ? now + secs * 1000 : 0;
      await save();
      playSound(def.wrongSound);
      const speaker = { alias: def.title };
      if (def.wrongText) await ChatMessage.create({ speaker, content: `<p><em>${def.wrongText}</em></p>` });
      if (def.wrongGmText) await ChatMessage.create({ speaker, whisper: ChatMessage.getWhisperRecipients("GM"),
        content: `<p>${def.wrongGmText} ${foundry.utils.escapeHTML(actor.name)} tried <b>${state.dials.join("-")}</b> (attempt ${state.wrong}).</p>` });
      return { ok: true };
    }
  }
  return { ok: false, msg: `Unknown action: ${type}` };
}

/* -------------------------------------------- */
/*  Rotary dials (GM side)                      */
/* -------------------------------------------- */

// A safe dial: turn right and stop on the 1st number (a click), left to the 2nd (a click), right to the 3rd (a click),
// then turn the handle. Stopping anywhere else, or turning the wrong way, lets the tumblers fall back to the start.

async function rotaryApply(type, payload, { def, state, save, actor, now }) {
  const n = Number(def.digits) || 40;
  const code = parseCode(def.code, (def.rings ?? []).length).map(c => ((c % n) + n) % n);
  state.step = Number(state.step) || 0;
  if (state.solved) return { ok: false, msg: `The ${def.noun ?? "vault"} is already open.` };
  if ((state.lockedUntil ?? 0) > now) return { ok: false, msg: "The dial is stuck. Try again in a moment." };
  switch (type) {
    case "spinRotary": {
      const to = ((Math.round(Number(payload.to) || 0) % n) + n) % n;
      const dir = Number(payload.dir) < 0 ? -1 : 1;
      state.pos = to;
      const right = state.step < code.length && to === code[state.step] && dir === rotaryDir(state.step);
      if (right) {
        state.step += 1;
        state.last = { ts: now, kind: "tick", step: state.step };
      } else {
        // progress lost: the tumblers fall back (silent when there was nothing to lose)
        state.last = { ts: now, kind: state.step ? "reset" : "none" };
        state.step = 0;
      }
      await save();
      return { ok: true };
    }
    case "tryRotary": {
      if (state.step >= code.length) {
        state.solved = true;
        state.last = { ts: now, kind: "open" };
        await save();
        playSound(def.openSound);
        return { ok: true };
      }
      state.wrong = (state.wrong ?? 0) + 1;
      state.step = 0;
      state.last = { ts: now, kind: "stuck" };
      const secs = Number(def.wrongLockSeconds) || 0;
      state.lockedUntil = secs ? now + secs * 1000 : 0;
      await save();
      playSound(def.wrongSound);
      const speaker = { alias: def.title };
      if (def.wrongText) await ChatMessage.create({ speaker, content: `<p><em>${def.wrongText}</em></p>` });
      if (def.wrongGmText) await ChatMessage.create({ speaker, whisper: ChatMessage.getWhisperRecipients("GM"),
        content: `<p>${def.wrongGmText} ${foundry.utils.escapeHTML(actor.name)} (attempt ${state.wrong}).</p>` });
      return { ok: true };
    }
  }
  return { ok: false, msg: `Unknown action: ${type}` };
}

/** Flip a lever tile and spring it back. */
async function animateLever(tileUuid) {
  const tile = tileUuid ? fromUuidSync(tileUuid) : null;
  if (!tile) return;
  let base = tile.getFlag(MODULE_ID, "leverScaleX");
  if (base === undefined) { base = tile.texture.scaleX ?? 1; await tile.setFlag(MODULE_ID, "leverScaleX", base); }
  await tile.update({ "texture.scaleX": -base });
  setTimeout(() => tile.update({ "texture.scaleX": base }), 1500);
}

/** Check the combination: right → solved; wrong → the slots lock for a while (T9); a slot empty → nothing happens. */
async function slotsPress({ def, state, save, payload, now, origin }) {
  animateLever(payload.tileUuid);
  if ((state.lockedUntil ?? 0) > now) return { ok: false, msg: STUCK_MSG };
  playSound(def.pressSound);
  if (def.slots.some(s => !state.slots?.[s.id])) return { ok: true, msg: "Nothing happens." };
  if (def.slots.every(s => state.slots[s.id].key === s.accepts)) {
    if (!state.solved) {
      state.solved = true;
      state.released = false;
      await save();
    }
    return { ok: true };
  }
  const secs = Number(def.wrongLockSeconds) || 0;
  state.lockedUntil = secs ? now + secs * 1000 : 0;
  await save();
  setTimeout(() => playSound(def.wrongSound), 400);
  if (def.wrongText) await ChatMessage.create({ speaker: { alias: def.title }, content: `<p><em>${def.wrongText}</em></p>` });
  if (def.wrongGmText) await ChatMessage.create({ speaker: { alias: def.title }, content: `<p>${def.wrongGmText}</p>`,
    whisper: ChatMessage.getWhisperRecipients("GM") });
  if (def.alert) await alertOp(def.alert, "raise", { source: def.alertSource, reason: ALERTS[def.alert]?.sources?.[def.alertSource] ?? `${def.title}: wrong combination`, origin });
  return { ok: true };
}

/* -------------------------------------------- */
/*  Original pieces                             */
/* -------------------------------------------- */

// A piece only fits when it is the one taken in the dungeon. When the Unboxing the Mystery module hands out a tile's
// item, the GM marks the new item with a unique id and records it in the "instances" world setting. Copies made from
// the Items directory (or renamed items) never get a recorded mark.

const recentClaims = [];
const recentCreations = [];
const claimedCache = new Map(); // tile uuid -> indexes already claimed

async function registerOriginal(item, source = "manual") {
  const key = pieceKey(item);
  if (!key) return null;
  const id = pieceInstance(item) ?? foundry.utils.randomID(16);
  if (!pieceInstance(item)) await item.update({ [`flags.${MODULE_ID}.instance`]: id });
  const registry = foundry.utils.deepClone(game.settings.get(MODULE_ID, "instances") ?? {});
  registry[id] = { key, name: item.name, actor: item.parent?.name ?? "", source, ts: Date.now() };
  await game.settings.set(MODULE_ID, "instances", registry);
  return id;
}

async function matchClaims() {
  const now = Date.now();
  for (const list of [recentClaims, recentCreations]) {
    for (let i = list.length - 1; i >= 0; i--) if (now - list[i].t > 20_000) list.splice(i, 1);
  }
  for (const c of [...recentCreations]) {
    const claim = recentClaims.find(cl => cl.keys.includes(c.key));
    if (!claim) continue;
    claim.keys.splice(claim.keys.indexOf(c.key), 1);
    recentCreations.splice(recentCreations.indexOf(c), 1);
    await registerOriginal(c.item, claim.tile);
  }
}

function watchOriginals() {
  for (const scene of game.scenes) for (const tile of scene.tiles) {
    const claimed = tile.flags?.["unboxing-mystery"]?.tileItemsClaimed;
    if (Array.isArray(claimed)) claimedCache.set(tile.uuid, [...claimed]);
  }
  Hooks.on("updateTile", (tile, changes) => {
    const claimed = foundry.utils.getProperty(changes, "flags.unboxing-mystery.tileItemsClaimed");
    if (!Array.isArray(claimed)) return;
    const before = claimedCache.get(tile.uuid) ?? [];
    claimedCache.set(tile.uuid, [...claimed]);
    if (!isActiveGM()) return;
    const linked = tile.flags?.["unboxing-mystery"]?.tileLinkedItems ?? [];
    const keys = claimed.filter(i => !before.includes(i)).map(i => linked[i]?.uuid).filter(Boolean)
      .map(uuid => pieceKey(fromUuidSync(uuid))).filter(Boolean);
    if (!keys.length) return;
    recentClaims.push({ keys, t: Date.now(), tile: tile.uuid });
    matchClaims();
  });
  Hooks.on("createItem", item => {
    if (!isActiveGM() || !(item.parent instanceof Actor)) return;
    const key = pieceKey(item);
    if (!key || pieceInstance(item)) return;
    recentCreations.push({ item, key, t: Date.now() });
    matchClaims();
  });
  // Unboxing stacks a looted piece onto one with the same name already on the sheet.
  Hooks.on("updateItem", (item, changes) => {
    if (!isActiveGM() || !(item.parent instanceof Actor) || !foundry.utils.hasProperty(changes, "system.quantity")) return;
    const key = pieceKey(item);
    const registry = game.settings.get(MODULE_ID, "instances") ?? {};
    if (!key || registry[pieceInstance(item)]) return;
    recentCreations.push({ item, key, t: Date.now() });
    matchClaims();
  });
}

/* -------------------------------------------- */
/*  Triggers                                    */
/* -------------------------------------------- */

function getTriggers(puzzleId) {
  const saved = game.settings.get(MODULE_ID, "triggers")?.[puzzleId];
  return foundry.utils.deepClone(saved ?? PUZZLES[puzzleId].triggers ?? []);
}

async function setTriggers(puzzleId, list) {
  const all = foundry.utils.deepClone(game.settings.get(MODULE_ID, "triggers") ?? {});
  all[puzzleId] = list;
  await game.settings.set(MODULE_ID, "triggers", all);
}

/** GM: ask a player to roll a save from their own client. Resolves with the total, or null on timeout. */
const saveWaits = {};
function askPlayerSave(user, tokenDoc, { ability, dc, flavor, timeoutMs, link = null }) {
  const rid = foundry.utils.randomID();
  return new Promise(resolve => {
    const timer = setTimeout(() => { delete saveWaits[rid]; resolve(null); }, timeoutMs);
    saveWaits[rid] = total => { clearTimeout(timer); delete saveWaits[rid]; resolve(total); };
    game.socket.emit(SOCKET, { type: "saveRequest", to: user.id, rid, actorUuid: tokenDoc.actor.uuid, tokenName: tokenDoc.name,
      ability, dc, flavor, timeoutMs, link });
  });
}

/** Player: show the save window, roll it on click, send the total back to the GM. */
async function onSaveRequest(msg) {
  const actor = fromUuidSync(msg.actorUuid);
  if (!actor) return;
  const label = CONFIG.DND5E.abilities[msg.ability]?.label ?? msg.ability;
  let answered = false;
  const send = total => {
    if (answered) return;
    answered = true;
    game.socket.emit(SOCKET, { type: "saveResult", rid: msg.rid, total });
  };
  const dlg = new DialogV2({
    window: { title: "Saving throw!", icon: "fa-solid fa-skull-crossbones" },
    classes: ["theia-puzzle-save"],
    content: `<p><b>${foundry.utils.escapeHTML(msg.tokenName)}</b> must make a <b>${label} saving throw (DC ${msg.dc})</b>.</p>
      <p class="tp-save-flavor"><em>${foundry.utils.escapeHTML(msg.flavor ?? "")}</em></p>
      <p class="tp-save-timer">If you don't roll in ${Math.round(msg.timeoutMs / 1000)} s, the GM rolls for you.</p>`,
    buttons: [{
      action: "roll", label: `Roll ${label} save`, icon: "fa-solid fa-dice-d20", default: true,
      callback: async () => {
        const rolls = await actor.rollSavingThrow({ ability: msg.ability, target: msg.dc }, {}, { data: { flavor: msg.flavor, flags: saveLinkFlags(msg.link) } });
        const roll = Array.isArray(rolls) ? rolls[0] : rolls;
        if (roll) send(roll.total);
      }
    }],
    rejectClose: false
  });
  dlg.render(true);
  setTimeout(() => { if (!answered) { answered = true; dlg.close(); } }, msg.timeoutMs - 500);
}

function closeWindowsEverywhere(puzzleId) {
  game.socket.emit(SOCKET, { type: "close", puzzleId });
  PuzzleWindow.instances.get(puzzleId)?.close();
}

/** GM: after each change, fire every enabled trigger whose conditions now hold (once-only triggers fire once). */
async function runTriggers(scene, puzzleId, { actor, tokenDoc, userId }) {
  const def = getDef(puzzleId);
  const state = getState(scene, puzzleId);
  const fired = new Set(state.fired ?? []);
  // "once" triggers fire a single time; the others fire each time their conditions become true
  const active = { ...(state.active ?? {}) };
  const due = [];
  for (const t of getTriggers(puzzleId)) {
    if (t.enabled === false) continue;
    const met = conditionsMet(t, state, def);
    if (t.once) { if (met && !fired.has(t.id)) due.push(t); continue; }
    if (met && !active[t.id]) due.push(t);
    active[t.id] = met;
  }
  const changed = JSON.stringify(active) !== JSON.stringify(state.active ?? {});
  state.active = active;
  for (const t of due) if (t.once) fired.add(t.id);
  state.fired = [...fired];
  if (!due.length && !changed) return;
  await scene.setFlag(MODULE_ID, `state.${puzzleId}`, state);
  if (!due.length) return;
  const ctx = {
    puzzleId, def, scene, state, actor, tokenDoc, userId, tile: findPedestal(scene, puzzleId),
    distanceToPedestalFt, giveItem, closeWindows: () => closeWindowsEverywhere(puzzleId), askPlayerSave, alertOp
  };
  for (const t of due) {
    Hooks.callAll(`${MODULE_ID}.trigger`, { trigger: t, ...ctx });
    for (const action of t.actions ?? []) {
      try { await runAction(action, ctx); } catch (err) { console.error(`${MODULE_ID} | trigger ${t.name}`, err); }
    }
  }
}

/* -------------------------------------------- */
/*  3D scale view                               */
/* -------------------------------------------- */

const DENOM_COLOR = { pp: 0xe8ecf2, gp: 0xf0c040, sp: 0xc8ccd2, cp: 0xc0703a };
const GRAVITY = 9.8;

class ScaleView {
  /**
   * @param {HTMLElement} container
   * @param {object} hooks
   * @param {() => boolean} hooks.canInteract
   * @param {(entryId: string) => Promise<boolean>} hooks.onTake      dropped on the inventory panel
   * @param {(entryId: string, pan: string) => Promise<boolean>} hooks.onMove  dropped on the other pan
   * @param {(data: object, pan: string) => void} hooks.onDrop         HTML item dragged in from the panel
   * @param {(x: number, y: number) => boolean} hooks.isOverInventory
   * @param {(over: boolean|null) => void} hooks.onDragState           null = drag ended
   */
  constructor(container, hooks) {
    this.container = container;
    this.hooks = hooks;
    this.entryMeshes = new Map(); // entryId -> mesh
    this.textures = new Map();
    this.anims = [];
    this.tilt = 0;
    this.tiltVel = 0;
    this.targetTilt = 0;

    const w = container.clientWidth || 600, h = container.clientHeight || 400;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x15110d);
    this.scene.fog = new THREE.Fog(0x15110d, 3, 7);
    this.camera = new THREE.PerspectiveCamera(42, w / h, 0.01, 50);
    this.camera.position.set(0, 1.05, 1.35);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.62, 0);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 0.55;
    this.controls.maxDistance = 2.6;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.update();

    this.scene.add(new THREE.HemisphereLight(0xffe2b8, 0x20160e, 0.55));
    const key = new THREE.DirectionalLight(0xffd59a, 2.2);
    key.position.set(1.2, 2.4, 1.0);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.5; key.shadow.camera.far = 6;
    Object.assign(key.shadow.camera, { left: -1.2, right: 1.2, top: 1.2, bottom: -1.2 });
    this.scene.add(key);
    const rim = new THREE.PointLight(0x7fa6ff, 0.6, 5);
    rim.position.set(-1.4, 1.2, -1.2);
    this.scene.add(rim);

    this._buildPlaceholder();

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.hovered = null;
    this.drag = null;
    this._bindEvents();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.clock = new THREE.Clock();
    this._loop = this._loop.bind(this);
    this.raf = requestAnimationFrame(this._loop);
  }

  _buildPlaceholder() {
    const stone = new THREE.MeshStandardMaterial({ color: 0x6d655b, roughness: 0.9 });
    const bronze = new THREE.MeshStandardMaterial({ color: 0x8a6232, metalness: 0.85, roughness: 0.35 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a2520, metalness: 0.6, roughness: 0.5 });

    const floor = new THREE.Mesh(new THREE.CircleGeometry(3, 48), new THREE.MeshStandardMaterial({ color: 0x3a342d, roughness: 1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    this.pedestalTop = 0.32;
    this.pedestalHalf = { x: 0.45, z: 0.25 };
    const pedestal = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.32, 0.5), stone);
    pedestal.position.y = 0.16;
    pedestal.castShadow = pedestal.receiveShadow = true;
    this.pedestal = pedestal;
    this.scene.add(pedestal);

    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.04, 0.42, 20), bronze);
    post.position.y = 0.32 + 0.21;
    post.castShadow = true;
    this.scene.add(post);

    this.pivot = new THREE.Group();
    this.pivot.position.set(0, 0.32 + 0.42 + 0.01, 0);
    this.scene.add(this.pivot);
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.84, 0.022, 0.03), bronze);
    beam.castShadow = true;
    this.pivot.add(beam);
    this.pivot.add(new THREE.Mesh(new THREE.SphereGeometry(0.032, 20, 14), dark));

    this.beamEnds = { left: new THREE.Object3D(), right: new THREE.Object3D() };
    this.beamEnds.left.position.set(-0.4, 0, 0);
    this.beamEnds.right.position.set(0.4, 0, 0);
    this.pivot.add(this.beamEnds.left, this.beamEnds.right);

    this.pans = {};
    for (const side of ["left", "right"]) {
      const g = new THREE.Group();
      const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.12, 0.025, 36), bronze);
      dish.position.y = -0.3;
      dish.castShadow = dish.receiveShadow = true;
      dish.userData.pan = side;
      g.add(dish);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        const pts = [new THREE.Vector3(Math.cos(a) * 0.14, -0.29, Math.sin(a) * 0.14), new THREE.Vector3(0, 0, 0)];
        g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x9a7a4a })));
      }
      const content = new THREE.Group();
      content.position.y = -0.3 + 0.0125;
      content.userData.pan = side;
      g.add(content);
      this.scene.add(g);
      this.pans[side] = { group: g, dish, content };
    }
  }

  /** Texture from an image URL; images from hosts that block WebGL use (CORS) fall back to a name label. */
  _texture(url, label = "") {
    if (!url) return this._labelTexture(label);
    const key = `${url}|${label}`;
    if (this.textures.has(key)) return this.textures.get(key);
    const tex = new THREE.Texture();
    tex.colorSpace = THREE.SRGBColorSpace;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { tex.image = img; tex.needsUpdate = true; };
    img.onerror = () => {
      const fb = this._labelTexture(label);
      tex.image = fb.image;
      tex.needsUpdate = true;
    };
    img.src = url;
    this.textures.set(key, tex);
    return tex;
  }

  _labelTexture(label) {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const g = c.getContext("2d");
    g.fillStyle = "#3b2f22"; g.fillRect(0, 0, 256, 256);
    g.strokeStyle = "#c9a35a"; g.lineWidth = 10; g.strokeRect(8, 8, 240, 240);
    g.fillStyle = "#f2e2c0"; g.textAlign = "center"; g.textBaseline = "middle";
    const words = String(label || "?").split(/\s+/).slice(0, 4);
    g.font = "bold 44px sans-serif";
    words.forEach((w, i) => g.fillText(w.slice(0, 10), 128, 128 + (i - (words.length - 1) / 2) * 50));
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /** Rebuild the pan contents from the puzzle state (deferred while something is being dragged/animated). */
  update(state) {
    if (this.drag || this.anims.length) { this.pendingState = state; return; }
    this.pendingState = null;
    for (const mesh of this.entryMeshes.values()) {
      mesh.parent?.remove(mesh);
      mesh.geometry?.dispose();
    }
    this.entryMeshes.clear();
    this._setHover(null);

    for (const side of ["left", "right"]) {
      const content = this.pans[side].content;
      const entries = state.pans[side] ?? [];
      let souls = 0;
      entries.forEach((e, i) => {
        const mesh = this._entryMesh(e);
        let slot;
        if (e.kind === "soul") slot = { x: -0.05, z: 0.02, y: souls++ * (mesh.userData.height + 0.001) };
        else slot = this._slot(i, entries.length);
        mesh.position.set(slot.x, slot.y + mesh.userData.height / 2, slot.z);
        mesh.userData.entryId = e.id;
        mesh.userData.pan = side;
        mesh.castShadow = true;
        content.add(mesh);
        this.entryMeshes.set(e.id, mesh);
      });
    }
    const diff = panKg(state.pans.right) - panKg(state.pans.left);
    this.targetTilt = THREE.MathUtils.clamp(-diff * 0.45, -0.32, 0.32);
  }

  _slot(i, n) {
    if (n === 1 || i === 0) return { x: 0.03, z: -0.02, y: 0 };
    const ring = (i - 1) % 6, layer = Math.floor((i - 1) / 6);
    const a = (ring / 6) * Math.PI * 2;
    return { x: Math.cos(a) * 0.075, z: Math.sin(a) * 0.075, y: layer * 0.05 };
  }

  _entryMesh(e) {
    let mesh;
    if (e.kind === "soul") {
      const h = 0.009;
      const face = new THREE.MeshStandardMaterial({ color: 0xffffff, map: this._texture(e.tex ?? e.img, e.name), metalness: 0.4, roughness: 0.5 });
      const edge = new THREE.MeshStandardMaterial({ color: 0x4a3a20, metalness: 0.9, roughness: 0.4 });
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, h, 28), [edge, face, face]);
      mesh.userData.height = h;
    } else if (e.kind === "currency") {
      const h = THREE.MathUtils.clamp(e.amount * 0.0012, 0.004, 0.09);
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.028, h, 24),
        new THREE.MeshStandardMaterial({ color: DENOM_COLOR[e.denom] ?? 0xf0c040, metalness: 0.9, roughness: 0.3 }));
      mesh.userData.height = h;
    } else {
      const side = THREE.MathUtils.clamp(0.05 * Math.cbrt(e.kg / 0.2), 0.03, 0.17);
      const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: this._texture(e.img, e.name), roughness: 0.7 });
      mesh = new THREE.Mesh(new THREE.BoxGeometry(side, side, side), mat);
      mesh.userData.height = side;
    }
    return mesh;
  }

  _materials(mesh) {
    return [].concat(mesh.material);
  }

  /* ---------------- input ---------------- */

  _bindEvents() {
    const el = this.renderer.domElement;
    el.addEventListener("contextmenu", ev => ev.preventDefault());
    el.addEventListener("pointermove", ev => this._onMove(ev));
    el.addEventListener("pointerdown", ev => this._onDown(ev));
    el.addEventListener("pointerup", ev => this._onUp(ev));
    el.addEventListener("pointercancel", ev => this._onUp(ev, true));
    el.addEventListener("pointerleave", () => { if (!this.drag) this._setHover(null); });
    el.addEventListener("dragover", ev => { if (this.hooks.canInteract()) ev.preventDefault(); });
    el.addEventListener("drop", ev => {
      ev.preventDefault();
      if (!this.hooks.canInteract()) return;
      let data;
      try { data = JSON.parse(ev.dataTransfer.getData("text/plain")); } catch { return; }
      this.hooks.onDrop(data, this._panAt(ev) ?? this._nearestPan(ev));
    });
  }

  _setPointer(ev) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  _entryAt(ev) {
    this._setPointer(ev);
    return this.raycaster.intersectObjects([...this.entryMeshes.values()], false)[0]?.object ?? null;
  }

  /** Pan under the pointer (dish or its contents), ignoring the dragged mesh. */
  _panAt(ev) {
    this._setPointer(ev);
    const targets = [...Object.values(this.pans).map(p => p.dish), ...[...this.entryMeshes.values()].filter(m => m !== this.drag?.mesh)];
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    return hit?.object.userData.pan ?? null;
  }

  _nearestPan(ev) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const dist = side => {
      const p = new THREE.Vector3(); this.pans[side].dish.getWorldPosition(p); p.project(this.camera);
      return Math.hypot((p.x + 1) / 2 * r.width + r.left - ev.clientX, (1 - p.y) / 2 * r.height + r.top - ev.clientY);
    };
    return Object.keys(this.pans).reduce((best, side) => (best === null || dist(side) < dist(best) ? side : best), null);
  }

  _setHover(mesh) {
    if (this.hovered === mesh) return;
    if (this.hovered) for (const m of this._materials(this.hovered)) m.emissive?.setHex(0x000000);
    this.hovered = mesh;
    if (mesh) for (const m of this._materials(mesh)) m.emissive?.setHex(0x8a5a10);
    this.renderer.domElement.style.cursor = this.drag ? "grabbing" : mesh ? "grab" : "";
  }

  _onMove(ev) {
    if (this.drag) return this._dragTo(ev);
    if (!this.hooks.canInteract()) return this._setHover(null);
    this._setHover(this._entryAt(ev));
  }

  _onDown(ev) {
    if (ev.button !== 0 || !this.hooks.canInteract() || this.anims.length) return;
    const mesh = this._entryAt(ev);
    if (!mesh) return;
    ev.preventDefault();
    this.renderer.domElement.setPointerCapture(ev.pointerId);
    const home = { parent: mesh.parent, pos: mesh.position.clone(), quat: mesh.quaternion.clone() };
    this.scene.attach(mesh);
    const p = mesh.getWorldPosition(new THREE.Vector3());
    const normal = this.camera.getWorldDirection(new THREE.Vector3()).negate();
    this.drag = { mesh, home, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, p), last: p.clone(), vel: new THREE.Vector3(), t: performance.now() };
    this._setHover(mesh);
    this.renderer.domElement.style.cursor = "grabbing";
    this.hooks.onDragState(false);
  }

  _dragTo(ev) {
    this._setPointer(ev);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.drag.plane, hit)) return;
    hit.y = Math.max(hit.y, this.drag.mesh.userData.height / 2 + 0.002);
    const now = performance.now(), dt = Math.max((now - this.drag.t) / 1000, 1e-3);
    this.drag.vel.copy(hit).sub(this.drag.last).divideScalar(dt).clampLength(0, 3);
    this.drag.last.copy(hit);
    this.drag.t = now;
    this.drag.mesh.position.copy(hit);
    this.drag.mesh.rotation.x = THREE.MathUtils.clamp(this.drag.vel.z * 0.3, -0.5, 0.5);
    this.drag.mesh.rotation.z = THREE.MathUtils.clamp(-this.drag.vel.x * 0.3, -0.5, 0.5);
    this.hooks.onDragState(this.hooks.isOverInventory(ev.clientX, ev.clientY));
  }

  async _onUp(ev, cancelled = false) {
    if (!this.drag) return;
    const drag = this.drag;
    const el = this.renderer.domElement;
    if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
    this.hooks.onDragState(null);
    const entryId = drag.mesh.userData.entryId;
    const fromPan = drag.mesh.userData.pan;

    if (!cancelled && this.hooks.isOverInventory(ev.clientX, ev.clientY)) {
      drag.mesh.visible = false;
      this.drag = null;
      const ok = await this.hooks.onTake(entryId);
      if (!ok) { drag.mesh.visible = true; return this._returnHome(drag, false); }
      return this._flush();
    }
    const pan = cancelled ? null : this._panAt(ev);
    this.drag = null;
    if (pan && pan !== fromPan) {
      const ok = await this.hooks.onMove(entryId, pan);
      if (ok) return this._flush();
      return this._returnHome(drag, false);
    }
    // dropped on the same pan: settle back in place; dropped in the air: fall to the floor, then return
    return this._returnHome(drag, !pan);
  }

  _flush() {
    if (this.pendingState && !this.drag && !this.anims.length) this.update(this.pendingState);
  }

  /** Optionally drop the mesh to the floor under gravity, then glide it back to its slot in the pan. */
  _returnHome(drag, fall) {
    const mesh = drag.mesh;
    const half = mesh.userData.height / 2;
    const anim = { mesh, phase: fall ? "fall" : "return", vel: drag.vel.clone().multiplyScalar(0.4), bounces: 0, wait: 0 };
    anim.vel.y = Math.min(anim.vel.y, 0.5);
    anim.home = drag.home;
    anim.start = null;
    anim.half = half;
    this.anims.push(anim);
  }

  _stepAnims(dt) {
    for (const a of [...this.anims]) {
      const m = a.mesh;
      if (a.phase === "fall") {
        a.vel.y -= GRAVITY * dt;
        m.position.addScaledVector(a.vel, dt);
        m.rotation.x += a.vel.z * dt * 4;
        m.rotation.z -= a.vel.x * dt * 4;
        // floor, or the pedestal top when it lands on it
        const onPedestal = Math.abs(m.position.x) < this.pedestalHalf.x && Math.abs(m.position.z) < this.pedestalHalf.z;
        const ground = (onPedestal ? this.pedestalTop : 0) + a.half;
        if (m.position.y <= ground) {
          m.position.y = ground;
          if (Math.abs(a.vel.y) > 0.6 && a.bounces < 2) { a.vel.y = -a.vel.y * 0.35; a.vel.x *= 0.6; a.vel.z *= 0.6; a.bounces++; }
          else { a.phase = "rest"; a.wait = 0; m.rotation.set(0, m.rotation.y, 0); }
        }
      } else if (a.phase === "rest") {
        a.wait += dt;
        if (a.wait > 0.45) a.phase = "return";
      } else if (a.phase === "return") {
        if (!a.start) {
          a.start = { pos: m.position.clone(), quat: m.quaternion.clone(), t: 0 };
          a.target = a.home.parent.localToWorld(a.home.pos.clone());
          a.targetQuat = a.home.parent.getWorldQuaternion(new THREE.Quaternion()).multiply(a.home.quat);
        }
        a.start.t = Math.min(a.start.t + dt / 0.45, 1);
        const k = 1 - Math.pow(1 - a.start.t, 3);
        const arc = Math.sin(Math.PI * a.start.t) * 0.12;
        m.position.lerpVectors(a.start.pos, a.target, k);
        m.position.y += arc;
        m.quaternion.slerpQuaternions(a.start.quat, a.targetQuat, k);
        if (a.start.t >= 1) {
          a.home.parent.attach(m);
          m.position.copy(a.home.pos);
          m.quaternion.copy(a.home.quat);
          this.anims.splice(this.anims.indexOf(a), 1);
          this._flush();
        }
      }
    }
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _loop() {
    this.raf = requestAnimationFrame(this._loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const k = 28, damp = 6.5;
    this.tiltVel += ((this.targetTilt - this.tilt) * k - this.tiltVel * damp) * dt;
    this.tilt += this.tiltVel * dt;
    this.pivot.rotation.z = this.tilt;
    const p = new THREE.Vector3();
    for (const side of ["left", "right"]) {
      this.beamEnds[side].getWorldPosition(p);
      this.pans[side].group.position.copy(p);
    }
    this._stepAnims(dt);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    for (const t of this.textures.values()) t.dispose();
    this.scene.traverse(o => { o.geometry?.dispose(); if (o.material) [].concat(o.material).forEach(m => m.dispose()); });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

/* -------------------------------------------- */
/*  3D slot table view                          */
/* -------------------------------------------- */

/** Geometry for a piece (or, scaled up and flattened, its socket). Returns its height too. */
function shapeGeometry(shape, k = 1) {
  switch (shape) {
    case "pyramid": return { geo: new THREE.ConeGeometry(0.07 * k, 0.1 * k, 4), h: 0.1 * k };
    case "circle": return { geo: new THREE.CylinderGeometry(0.06 * k, 0.06 * k, 0.025 * k, 40), h: 0.025 * k };
    case "cylinder": return { geo: new THREE.CylinderGeometry(0.045 * k, 0.045 * k, 0.1 * k, 32), h: 0.1 * k };
    case "dodecahedron": return { geo: new THREE.DodecahedronGeometry(0.06 * k), h: 0.11 * k };
    case "plate": return { geo: new THREE.BoxGeometry(0.13 * k, 0.018 * k, 0.09 * k), h: 0.018 * k };
    default: return { geo: new THREE.BoxGeometry(0.09 * k, 0.09 * k, 0.09 * k), h: 0.09 * k };
  }
}

/** A table with a row of sockets; pieces dragged in take the shape of their socket. Reuses the scale's drag code. */
class SlotsView extends ScaleView {
  _buildPlaceholder() {
    const def = this.hooks.def;
    const slots = def.slots ?? [];
    const wood = new THREE.MeshStandardMaterial({ color: 0x5b3e26, roughness: 0.8 });
    const darkWood = new THREE.MeshStandardMaterial({ color: 0x3a281a, roughness: 0.85 });
    const socketMat = new THREE.MeshStandardMaterial({ color: 0x0d0b09, roughness: 0.95, metalness: 0.1 });

    const floor = new THREE.Mesh(new THREE.CircleGeometry(3, 48), new THREE.MeshStandardMaterial({ color: 0x3a342d, roughness: 1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const spacing = 0.3;
    const width = Math.max(0.8, slots.length * spacing + 0.2), depth = 0.5;
    this.tableTop = 0.72;
    this.pedestalTop = this.tableTop;
    this.pedestalHalf = { x: width / 2, z: depth / 2 };
    const top = new THREE.Mesh(new THREE.BoxGeometry(width, 0.06, depth), wood);
    top.position.y = this.tableTop - 0.03;
    top.castShadow = top.receiveShadow = true;
    this.scene.add(top);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, this.tableTop - 0.06, 0.06), darkWood);
      leg.position.set(sx * (width / 2 - 0.06), (this.tableTop - 0.06) / 2, sz * (depth / 2 - 0.06));
      leg.castShadow = true;
      this.scene.add(leg);
    }

    this.pans = {};
    slots.forEach((slot, i) => {
      const x = (i - (slots.length - 1) / 2) * spacing;
      const { geo } = shapeGeometry(slot.shape, 1.15);
      const socket = new THREE.Mesh(geo, socketMat.clone());
      socket.scale.y = 0.08;
      if (slot.shape === "pyramid") socket.rotation.y = Math.PI / 4;
      socket.position.set(x, this.tableTop + 0.002, -0.02);
      socket.receiveShadow = true;
      socket.userData.pan = slot.id;
      this.scene.add(socket);

      const content = new THREE.Group();
      content.position.set(x, this.tableTop, -0.02);
      content.userData.pan = slot.id;
      this.scene.add(content);

      const plaque = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.07),
        new THREE.MeshStandardMaterial({ map: this._plaqueTexture(slot.label), roughness: 0.5, metalness: 0.6 }));
      plaque.rotation.x = -Math.PI / 2;
      plaque.position.set(x, this.tableTop + 0.001, 0.15);
      plaque.receiveShadow = true;
      this.scene.add(plaque);

      this.pans[slot.id] = { group: content, dish: socket, content };
    });

    this.camera.position.set(0, 1.32, 0.95);
    this.controls.target.set(0, this.tableTop, 0);
    this.controls.minDistance = 0.4;
    this.controls.update();
  }

  _plaqueTexture(label) {
    const c = document.createElement("canvas");
    c.width = 512; c.height = 150;
    const g = c.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 0, 150);
    grad.addColorStop(0, "#9c7a3c"); grad.addColorStop(1, "#5e4520");
    g.fillStyle = grad; g.fillRect(0, 0, 512, 150);
    g.strokeStyle = "#2b1d0c"; g.lineWidth = 8; g.strokeRect(6, 6, 500, 138);
    g.fillStyle = "#1f150a"; g.textAlign = "center"; g.textBaseline = "middle";
    g.font = "bold 64px serif";
    g.fillText(String(label ?? "").slice(0, 16), 256, 80);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  update(state) {
    if (this.drag || this.anims.length) { this.pendingState = state; return; }
    this.pendingState = null;
    for (const mesh of this.entryMeshes.values()) {
      mesh.parent?.remove(mesh);
      mesh.geometry?.dispose();
    }
    this.entryMeshes.clear();
    this._setHover(null);
    const stuck = (state.lockedUntil ?? 0) > Date.now();
    for (const slot of this.hooks.def.slots ?? []) {
      const pan = this.pans[slot.id];
      if (!pan) continue;
      pan.dish.material.emissive?.setHex(stuck ? 0x5a0a00 : state.solved ? 0x1e3a12 : 0x000000);
      const e = state.slots?.[slot.id];
      if (!e) continue;
      const { geo, h } = shapeGeometry(slot.shape);
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff, map: this._texture(e.img, e.name), roughness: 0.75 }));
      if (slot.shape === "pyramid") mesh.rotation.y = Math.PI / 4;
      mesh.userData.height = h;
      mesh.userData.entryId = e.id;
      mesh.userData.pan = slot.id;
      mesh.position.set(0, h / 2 + 0.004, 0);
      mesh.castShadow = true;
      pan.content.add(mesh);
      this.entryMeshes.set(e.id, mesh);
    }
  }

  _loop() {
    this.raf = requestAnimationFrame(this._loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this._stepAnims(dt);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

/* -------------------------------------------- */
/*  3D combination dial view                    */
/* -------------------------------------------- */

/** Draw a sigil, centered in a size×size box, with the current fill / stroke style. */
function drawSigil(g, sigil, size) {
  const c = size / 2, r = size * 0.36;
  g.lineWidth = size * 0.05;
  g.lineCap = g.lineJoin = "round";
  g.beginPath();
  switch (sigil) {
    case "scale": {
      g.moveTo(c, c - r); g.lineTo(c, c + r * 0.85);
      g.moveTo(c - r * 0.55, c + r * 0.85); g.lineTo(c + r * 0.55, c + r * 0.85);
      g.moveTo(c - r, c - r * 0.6); g.lineTo(c + r, c - r * 0.6);
      for (const sx of [-1, 1]) {
        const x = c + sx * r;
        g.moveTo(x, c - r * 0.6); g.lineTo(x - r * 0.32, c + r * 0.1);
        g.moveTo(x, c - r * 0.6); g.lineTo(x + r * 0.32, c + r * 0.1);
        g.moveTo(x - r * 0.4, c + r * 0.1); g.quadraticCurveTo(x, c + r * 0.5, x + r * 0.4, c + r * 0.1); g.closePath();
      }
      g.stroke();
      return;
    }
    case "compass": {
      g.arc(c, c, r, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      const p = (rad, ang) => [c + Math.cos(ang) * rad, c + Math.sin(ang) * rad];
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
        const len = i % 2 ? r * 0.55 : r * 1.12;
        g.moveTo(...p(r * 0.14, a - 0.63)); g.lineTo(...p(len, a)); g.lineTo(...p(r * 0.14, a + 0.63));
      }
      g.fill();
      return;
    }
    case "seal": {
      const n = 14;
      for (let i = 0; i <= n * 2; i++) {
        const a = (i / (n * 2)) * Math.PI * 2;
        const rad = i % 2 ? r : r * 0.88;
        g.lineTo(c + Math.cos(a) * rad, c + Math.sin(a) * rad);
      }
      g.fill();
      g.save();
      g.globalCompositeOperation = "destination-out";
      g.beginPath(); g.arc(c, c, r * 0.62, 0, Math.PI * 2); g.lineWidth = size * 0.035; g.stroke();
      g.beginPath();
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 - Math.PI / 2, b = a + Math.PI / 5;
        g.lineTo(c + Math.cos(a) * r * 0.42, c + Math.sin(a) * r * 0.42);
        g.lineTo(c + Math.cos(b) * r * 0.17, c + Math.sin(b) * r * 0.17);
      }
      g.fill();
      g.restore();
      return;
    }
    case "eye": {
      g.moveTo(c - r, c); g.quadraticCurveTo(c, c - r * 1.1, c + r, c); g.quadraticCurveTo(c, c + r * 1.1, c - r, c);
      g.stroke();
      g.beginPath(); g.arc(c, c, r * 0.32, 0, Math.PI * 2); g.fill();
      return;
    }
    case "key": {
      g.arc(c - r * 0.5, c, r * 0.38, 0, Math.PI * 2);
      g.moveTo(c - r * 0.12, c); g.lineTo(c + r, c);
      g.moveTo(c + r * 0.75, c); g.lineTo(c + r * 0.75, c + r * 0.35);
      g.moveTo(c + r * 0.45, c); g.lineTo(c + r * 0.45, c + r * 0.28);
      g.stroke();
      return;
    }
  }
}

/** A vault door with numbered rings (a cryptex lock) and a handle. Reuses the scale's renderer, lights and loop. */
class DialView extends ScaleView {
  /** The safe: floor, iron body open at the front, a red door on a hinge (this.hinge). Returns what the front needs. */
  _buildBody(W) {
    const iron = new THREE.MeshStandardMaterial({ color: 0x3b3633, metalness: 0.8, roughness: 0.45 });
    const red = new THREE.MeshStandardMaterial({ color: 0x5a1d18, metalness: 0.55, roughness: 0.55 });
    const brass = new THREE.MeshStandardMaterial({ color: 0xa57c3c, metalness: 0.9, roughness: 0.3 });

    const floor = new THREE.Mesh(new THREE.CircleGeometry(3, 48), new THREE.MeshStandardMaterial({ color: 0x2c2522, roughness: 1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // body, open at the front (the door covers it)
    const H = 0.78, D = 0.6, wallT = 0.04;
    this.pedestalTop = H;
    this.pedestalHalf = { x: W / 2, z: D / 2 };
    const parts = [
      [W, wallT, D, 0, H - wallT / 2, 0], [W, wallT, D, 0, wallT / 2, 0],
      [wallT, H, D, -W / 2 + wallT / 2, H / 2, 0], [wallT, H, D, W / 2 - wallT / 2, H / 2, 0],
      [W, H, wallT, 0, H / 2, -D / 2 + wallT / 2]
    ];
    for (const [w, h, d, x, y, z] of parts) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), iron);
      m.position.set(x, y, z);
      m.castShadow = m.receiveShadow = true;
      this.scene.add(m);
    }
    const inside = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.1, H - 0.1), new THREE.MeshStandardMaterial({ color: 0x0b0908, roughness: 1 }));
    inside.position.set(0, H / 2, -D / 2 + wallT + 0.001);
    this.scene.add(inside);
    if (this.hooks.def.treasure) {
      // what waits inside (seen once the door opens), lit by a faint glow
      const gold = new THREE.MeshStandardMaterial({ color: 0xe0b04a, metalness: 1, roughness: 0.2, emissive: 0x3a2400 });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.014, 16, 48), gold);
      ring.rotation.x = 0.35; // propped up, facing the door
      ring.position.set(0, wallT + 0.085, -0.05);
      ring.castShadow = true;
      this.scene.add(ring);
      const glow = new THREE.PointLight(0xffc870, 0.6, 0.8);
      glow.position.set(0, 0.25, 0.05);
      this.scene.add(glow);
    }

    // door on a hinge at the left edge
    this.hinge = new THREE.Group();
    this.hinge.position.set(-W / 2, 0, D / 2);
    this.scene.add(this.hinge);
    const door = new THREE.Mesh(new THREE.BoxGeometry(W - 0.02, H - 0.02, 0.045), red);
    door.position.set(W / 2, H / 2, 0.0225);
    door.castShadow = door.receiveShadow = true;
    this.hinge.add(door);
    for (const y of [0.12, H - 0.12]) {
      const band = new THREE.Mesh(new THREE.BoxGeometry(W - 0.02, 0.035, 0.012), iron);
      band.position.set(W / 2, y, 0.05);
      this.hinge.add(band);
    }
    for (const sx of [0.05, W - 0.05]) for (const y of [0.05, H - 0.05]) {
      const rivet = new THREE.Mesh(new THREE.SphereGeometry(0.012, 10, 8), brass);
      rivet.position.set(sx, y, 0.047);
      this.hinge.add(rivet);
    }
    this.camera.position.set(0.12, H * 0.75, 1.75);
    this.controls.target.set(0, H * 0.5, 0.3);
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 2.4;
    this.controls.update();
    return { iron, brass, H, front: 0.047 };
  }

  /** A lever handle on the door (this.handle, this.handleParts). */
  _buildHandle(x, y, front, brass) {
    this.handle = new THREE.Group();
    this.handle.position.set(x, y, front + 0.03);
    this.hinge.add(this.handle);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.05, 24), brass);
    hub.rotation.x = Math.PI / 2;
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.17, 0.03), brass);
    bar.position.set(0, 0.085, 0.025);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.025, 16, 12), brass);
    knob.position.set(0, 0.17, 0.025);
    for (const m of [hub, bar, knob]) { m.userData.handle = true; m.castShadow = true; this.handle.add(m); }
    this.handleParts = [hub, bar, knob];
    this.handleAngle = this.handleTarget = 0;
    this.doorAngle = this.doorTarget = 0;
  }

  _buildPlaceholder() {
    const def = this.hooks.def;
    const rings = def.rings ?? [];
    this.digits = Number(def.digits) || 10;
    const W = Math.max(0.8, rings.length * 0.17 + 0.42);
    const { iron, brass, H, front } = this._buildBody(W);

    // rings on an axle, in the middle of the door
    const ringR = 0.062, ringL = 0.1, gap = 0.17;
    const cy = H * 0.5, x0 = W / 2 - 0.06;
    const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, rings.length * gap + 0.04, 16), iron);
    axle.rotation.z = Math.PI / 2;
    axle.position.set(x0, cy, front + ringR + 0.012);
    this.hinge.add(axle);
    const housing = new THREE.Mesh(new THREE.BoxGeometry(rings.length * gap + 0.08, ringR * 2 + 0.06, 0.03), iron);
    housing.position.set(x0, cy, front + 0.015);
    this.hinge.add(housing);

    this.rings = [];
    rings.forEach((ring, i) => {
      const x = x0 + (i - (rings.length - 1) / 2) * gap;
      const geo = new THREE.CylinderGeometry(ringR, ringR, ringL, 40, 1, false);
      geo.rotateZ(Math.PI / 2);
      const side = new THREE.MeshStandardMaterial({ map: this._digitsTexture(), metalness: 0.6, roughness: 0.4 });
      const mesh = new THREE.Mesh(geo, [side, brass, brass]);
      mesh.position.set(x, cy, front + ringR + 0.012);
      mesh.castShadow = true;
      mesh.userData.ring = i;
      mesh.rotation.x = this._angleFor(0);
      this.hinge.add(mesh);
      this.rings.push({ mesh, side, angle: this._angleFor(0), target: this._angleFor(0) });

      // sigil plaque above, a pointer notch between plaque and ring
      const plaque = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.12),
        new THREE.MeshStandardMaterial({ map: this._sigilTexture(ring.sigil), metalness: 0.7, roughness: 0.35 }));
      plaque.position.set(x, cy + ringR + 0.13, front + 0.001);
      this.hinge.add(plaque);
      const notch = new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.03, 3), brass);
      notch.rotation.z = Math.PI;
      notch.position.set(x, cy + ringR + 0.045, front + 0.02);
      this.hinge.add(notch);
    });

    // the handle, on the right
    this._buildHandle(W - 0.12, cy - 0.2, front, brass);
  }

  /** Rotation (about the ring's axis) that brings digit d to the front. */
  _angleFor(d) {
    return ((d + 0.5) / this.digits) * Math.PI * 2;
  }

  _digitsTexture() {
    const n = this.digits, cell = 128;
    const c = document.createElement("canvas");
    c.width = cell * n; c.height = 128;
    const g = c.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 0, 128);
    grad.addColorStop(0, "#6e5426"); grad.addColorStop(0.5, "#b58d48"); grad.addColorStop(1, "#6e5426");
    g.fillStyle = grad; g.fillRect(0, 0, c.width, 128);
    g.strokeStyle = "rgba(30,20,8,0.7)"; g.lineWidth = 4;
    for (let d = 0; d <= n; d++) { g.beginPath(); g.moveTo(d * cell, 0); g.lineTo(d * cell, 128); g.stroke(); }
    g.fillStyle = "#1c1206"; g.textAlign = "center"; g.textBaseline = "middle"; g.font = "bold 92px serif";
    for (let d = 0; d < n; d++) {
      g.save();
      g.translate(d * cell + cell / 2, 64);
      g.rotate(Math.PI / 2); // the strip wraps the ring sideways: turn each digit so it reads upright
      g.fillText(String(d), 0, 4);
      g.restore();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  _sigilTexture(sigil) {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(128, 110, 20, 128, 128, 150);
    grad.addColorStop(0, "#b8924e"); grad.addColorStop(1, "#5b431e");
    g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
    g.strokeStyle = "#2a1c0b"; g.lineWidth = 10; g.strokeRect(6, 6, 244, 244);
    g.fillStyle = g.strokeStyle = "#24180a";
    drawSigil(g, sigil, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  _bindEvents() {
    const el = this.renderer.domElement;
    el.addEventListener("contextmenu", ev => ev.preventDefault());
    el.addEventListener("pointermove", ev => {
      el.style.cursor = this.hooks.canInteract() && this._pick(ev) ? "pointer" : "";
    });
    el.addEventListener("pointerdown", ev => {
      if (ev.button !== 0 || !this.hooks.canInteract()) return;
      const hit = this._pick(ev);
      if (!hit) return;
      ev.preventDefault();
      if (hit.handle) return this.hooks.onTry();
      // the upper half of a ring turns it up, the lower half down
      const local = hit.mesh.parent.worldToLocal(hit.point.clone());
      this.hooks.onTurn(hit.ring, local.y >= hit.mesh.position.y ? 1 : -1);
    });
    // over a ring, the mouse wheel turns it instead of zooming
    this.container.addEventListener("wheel", ev => {
      if (!this.hooks.canInteract()) return;
      const hit = this._pick(ev);
      if (!hit || hit.handle) return;
      ev.preventDefault();
      ev.stopPropagation();
      const now = performance.now();
      if (now - (this._lastWheel ?? 0) < 120) return;
      this._lastWheel = now;
      this.hooks.onTurn(hit.ring, ev.deltaY < 0 ? 1 : -1);
    }, { capture: true, passive: false });
  }

  _pick(ev) {
    this._setPointer(ev);
    const hit = this.raycaster.intersectObjects([...this.rings.map(r => r.mesh), ...this.handleParts], false)[0];
    if (!hit) return null;
    if (hit.object.userData.handle) return { handle: true };
    return { ring: hit.object.userData.ring, mesh: hit.object, point: hit.point };
  }

  update(state) {
    const full = Math.PI * 2;
    this.rings.forEach((r, i) => {
      // turn the short way round to the new digit
      let target = this._angleFor(Number(state.dials?.[i]) || 0);
      target += Math.round((r.target - target) / full) * full;
      r.target = target;
    });
    const stuck = (state.lockedUntil ?? 0) > Date.now();
    for (const r of this.rings) r.side.emissive.setHex(stuck ? 0x3a0800 : state.solved ? 0x14300c : 0x000000);
    clearTimeout(this._stuckTimer);
    if (stuck) this._stuckTimer = setTimeout(() => this.update(state), state.lockedUntil - Date.now() + 50);
    const t = state.lastTry?.ts ?? 0;
    if (this._lastTry !== undefined && t && t !== this._lastTry && !state.lastTry.ok) this._jerk();
    this._lastTry = t;
    this.doorTarget = state.solved ? -1.25 : 0;
    this.handleTarget = state.solved ? -Math.PI / 2 : this.handleTarget;
    if (!state.solved && !this._jerking) this.handleTarget = 0;
  }

  /** A wrong combination: the handle jerks halfway and falls back. */
  _jerk() {
    this._jerking = true;
    this.handleTarget = -Math.PI / 4;
    setTimeout(() => { this.handleTarget = 0; this._jerking = false; }, 300);
  }

  _loop() {
    this.raf = requestAnimationFrame(this._loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const ease = (cur, target, speed) => cur + (target - cur) * Math.min(1, dt * speed);
    for (const r of this.rings) {
      r.angle = ease(r.angle, r.target, 12);
      r.mesh.rotation.x = r.angle;
    }
    this.handleAngle = ease(this.handleAngle, this.handleTarget, 10);
    this.handle.rotation.z = this.handleAngle;
    // the door waits for the handle to turn before it swings open
    const turned = Math.abs(this.handleAngle - this.handleTarget) < 0.05;
    this.doorAngle = ease(this.doorAngle, this.doorTarget && !turned ? this.doorAngle : this.doorTarget, this.doorTarget ? 2.5 : 4);
    this.hinge.rotation.y = this.doorAngle;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  destroy() {
    clearTimeout(this._stuckTimer);
    super.destroy();
  }
}

/* -------------------------------------------- */
/*  3D rotary dial view                         */
/* -------------------------------------------- */

/** Small synthesized lock sounds (no files): the soft ratchet while turning, a tumbler's click, the clunk of a reset. */
function lockSound(kind) {
  const spec = { soft: [2600, 0.012, 0.04], tick: [1700, 0.035, 0.6], reset: [150, 0.2, 0.8], stuck: [90, 0.28, 0.9] }[kind];
  if (!spec) return;
  try {
    const ctx = (lockSound.ctx ??= new AudioContext());
    if (ctx.state === "suspended") ctx.resume();
    let vol = 0.5;
    try { vol = game.settings.get("core", "globalInterfaceVolume") ?? 0.5; } catch (err) { /* setting missing */ }
    const [freq, len, level] = spec;
    const t = ctx.currentTime;
    // a short noise burst through a band-pass filter
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * len), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 3);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = freq;
    filter.Q.value = kind === "soft" ? 1 : 4;
    const gain = ctx.createGain();
    gain.gain.value = level * vol * 2;
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start(t);
    if (kind === "tick") {
      // the metallic ring after the click
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 2400;
      g.gain.setValueAtTime(0.18 * vol, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      o.connect(g).connect(ctx.destination);
      o.start(t + 0.03);
      o.stop(t + 0.13);
    }
  } catch (err) { /* no audio */ }
}

/**
 * A safe door with a round combination dial and a handle. Drag the dial around and let go to stop on a number; the
 * numbers grow turning right (clockwise). Reuses the vault body and handle of DialView.
 */
class RotaryView extends DialView {
  _buildPlaceholder() {
    const def = this.hooks.def;
    const steps = def.rings ?? [];
    this.digits = Number(def.digits) || 40;
    this.stepAngle = (Math.PI * 2) / this.digits;
    this.rings = [];
    const W = 0.9;
    const { brass, H, front } = this._buildBody(W);
    this.hingeX = this.hinge.position.x;
    const cx = W / 2 - 0.05, cy = H * 0.44;

    const bezel = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.012, 12, 64), brass);
    bezel.position.set(cx, cy, front + 0.004);
    this.hinge.add(bezel);

    this.dial = new THREE.Group();
    this.dial.position.set(cx, cy, front + 0.016);
    this.hinge.add(this.dial);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.135, 0.14, 0.03, 64),
      new THREE.MeshStandardMaterial({ color: 0x2b2522, metalness: 0.85, roughness: 0.35 }));
    body.rotation.x = Math.PI / 2;
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.133, 64),
      new THREE.MeshStandardMaterial({ map: this._dialTexture(), metalness: 0.45, roughness: 0.5 }));
    face.position.z = 0.0155;
    const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.05, 32), brass);
    knob.rotation.x = Math.PI / 2;
    knob.position.z = 0.035;
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.085, 0.02), brass);
    grip.position.z = 0.065;
    for (const m of [body, face, knob, grip]) { m.castShadow = true; this.dial.add(m); }
    this.dialParts = [body, face, knob, grip];

    // index mark above the dial
    const mark = new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.03, 3), brass);
    mark.rotation.z = Math.PI;
    mark.position.set(cx, cy + 0.172, front + 0.02);
    this.hinge.add(mark);

    // one plaque per number: the sigil, and the way to turn under it
    steps.forEach((st, i) => {
      const x = cx + (i - (steps.length - 1) / 2) * 0.14;
      const plaque = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.12),
        new THREE.MeshStandardMaterial({ map: this._stepTexture(st.sigil, rotaryDir(i)), metalness: 0.7, roughness: 0.35 }));
      plaque.position.set(x, H - 0.19, front + 0.013);
      this.hinge.add(plaque);
    });

    this._buildHandle(W - 0.1, cy - 0.12, front, brass);
    this.angle = this.target = 0;
    this.jiggle = this.shake = 0;
  }

  _dialTexture() {
    const n = this.digits, S = 512, c0 = S / 2;
    const c = document.createElement("canvas");
    c.width = c.height = S;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(c0, c0 * 0.8, 20, c0, c0, c0);
    grad.addColorStop(0, "#3d3631"); grad.addColorStop(1, "#1a1614");
    g.fillStyle = grad; g.fillRect(0, 0, S, S);
    g.strokeStyle = "#d9c7a0"; g.fillStyle = "#efe2c2"; g.textAlign = "center"; g.textBaseline = "middle";
    for (let i = 0; i < n; i++) {
      // numbers grow counterclockwise on the face, so turning right brings higher numbers to the mark
      const a = -(i / n) * Math.PI * 2;
      const sx = Math.sin(a), sy = -Math.cos(a);
      const long = i % 5 === 0;
      g.lineWidth = long ? 6 : 3;
      g.beginPath();
      g.moveTo(c0 + sx * 252, c0 + sy * 252);
      g.lineTo(c0 + sx * (long ? 212 : 230), c0 + sy * (long ? 212 : 230));
      g.stroke();
      if (long) {
        g.save();
        g.translate(c0 + sx * 178, c0 + sy * 178);
        g.rotate(a);
        g.font = "bold 44px serif";
        g.fillText(String(i), 0, 2);
        g.restore();
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  /** A plaque: the sigil, and an arrow for the way to turn (clockwise = right). */
  _stepTexture(sigil, dir) {
    const c = document.createElement("canvas");
    c.width = 256; c.height = 308;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(128, 110, 20, 128, 150, 190);
    grad.addColorStop(0, "#b8924e"); grad.addColorStop(1, "#5b431e");
    g.fillStyle = grad; g.fillRect(0, 0, 256, 308);
    g.strokeStyle = "#2a1c0b"; g.lineWidth = 10; g.strokeRect(6, 6, 244, 296);
    g.fillStyle = g.strokeStyle = "#24180a";
    g.save(); g.translate(38, 4); drawSigil(g, sigil, 180); g.restore();
    const cx = 128, cy = 272, r = 44, a0 = -Math.PI * 0.95, a1 = -Math.PI * 0.05;
    g.lineWidth = 14;
    g.beginPath();
    if (dir > 0) g.arc(cx, cy, r, a0, a1); else g.arc(cx, cy, r, a1, a0, true);
    g.stroke();
    const end = dir > 0 ? a1 : a0;
    const ex = cx + Math.cos(end) * r, ey = cy + Math.sin(end) * r;
    const tang = end + (dir > 0 ? Math.PI / 2 : -Math.PI / 2);
    g.beginPath();
    g.moveTo(ex + Math.cos(tang) * 30, ey + Math.sin(tang) * 30);
    g.lineTo(ex + Math.cos(tang + 2.2) * 24, ey + Math.sin(tang + 2.2) * 24);
    g.lineTo(ex + Math.cos(tang - 2.2) * 24, ey + Math.sin(tang - 2.2) * 24);
    g.closePath();
    g.fill();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /** Number under the mark for a dial rotation. */
  _posFor(angle) {
    const n = this.digits;
    return ((Math.round(-angle / this.stepAngle) % n) + n) % n;
  }

  _bindEvents() {
    const el = this.renderer.domElement;
    el.addEventListener("contextmenu", ev => ev.preventDefault());
    el.addEventListener("pointermove", ev => {
      if (this.spin) return this._spinMove(ev);
      const hit = this.hooks.canInteract() ? this._pick(ev) : null;
      el.style.cursor = !hit ? "" : hit.handle ? "pointer" : "grab";
    });
    el.addEventListener("pointerdown", ev => {
      if (ev.button !== 0 || !this.hooks.canInteract()) return;
      const hit = this._pick(ev);
      if (!hit) return;
      ev.preventDefault();
      if (hit.handle) return this.hooks.onTry();
      el.setPointerCapture(ev.pointerId);
      this.angle = this.target; // pick it up where it is heading
      this.spin = { start: this.angle, last: this._pointerAngle(ev), lastPos: this._posFor(this.angle) };
      el.style.cursor = "grabbing";
    });
    const end = ev => {
      if (!this.spin) return;
      if (el.hasPointerCapture?.(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
      const spin = this.spin;
      this.spin = null;
      el.style.cursor = "";
      const snapped = Math.round(this.angle / this.stepAngle) * this.stepAngle;
      this.target = snapped;
      const net = snapped - spin.start;
      if (Math.abs(net) < this.stepAngle / 2) return;
      // clockwise (the angle goes down) is "right"
      this._send(this._posFor(snapped), net < 0 ? 1 : -1);
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  _pick(ev) {
    this._setPointer(ev);
    const hit = this.raycaster.intersectObjects([...this.dialParts, ...this.handleParts], false)[0];
    if (!hit) return null;
    return hit.object.userData.handle ? { handle: true } : { dial: true };
  }

  /** Angle of the pointer around the dial's center on screen, counterclockwise like the dial's rotation. */
  _pointerAngle(ev) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const p = this.dial.getWorldPosition(new THREE.Vector3()).project(this.camera);
    const cx = r.left + ((p.x + 1) / 2) * r.width, cy = r.top + ((1 - p.y) / 2) * r.height;
    return Math.atan2(-(ev.clientY - cy), ev.clientX - cx);
  }

  _spinMove(ev) {
    const a = this._pointerAngle(ev);
    let d = a - this.spin.last;
    if (d > Math.PI) d -= Math.PI * 2;
    else if (d < -Math.PI) d += Math.PI * 2;
    this.spin.last = a;
    this.angle += d;
    this.target = this.angle;
    const pos = this._posFor(this.angle);
    if (pos !== this.spin.lastPos) { this.spin.lastPos = pos; lockSound("soft"); }
  }

  /** Turn to a number the given way (1 = right) without dragging, e.g. from the side panel. */
  spinTo(to, dir) {
    if (!this.hooks.canInteract() || this.spin) return;
    const n = this.digits, cur = this._posFor(this.target);
    let delta = dir > 0 ? (((to - cur) % n) + n) % n : (((cur - to) % n) + n) % n;
    if (!delta) delta = n;
    this.target -= dir * delta * this.stepAngle;
    this._send(to, dir);
  }

  async _send(to, dir) {
    const r = await this.hooks.onSpin(to, dir);
    // refused (stuck, solved...): go back to where the lock really is
    if (!r?.ok && this._state) this.update(this._state);
  }

  update(state) {
    this._state = state;
    if (!this.spin) {
      const full = Math.PI * 2;
      let t = -(Number(state.pos) || 0) * this.stepAngle;
      t += Math.round((this.target - t) / full) * full;
      this.target = t;
    }
    const last = state.last;
    if (this._lastTs !== undefined && last?.ts && last.ts !== this._lastTs) this._feedback(last.kind);
    this._lastTs = last?.ts ?? 0;
    this.doorTarget = state.solved ? -1.25 : 0;
    if (state.solved) this.handleTarget = -Math.PI / 2;
    else if (!this._jerking) this.handleTarget = 0;
  }

  _feedback(kind) {
    if (kind === "tick") { lockSound("tick"); this.jiggle = 0.25; }
    else if (kind === "reset") { lockSound("reset"); this.shake = 0.3; }
    else if (kind === "stuck") { lockSound("stuck"); this.shake = 0.3; this._jerk(); }
  }

  _loop() {
    this.raf = requestAnimationFrame(this._loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const ease = (cur, target, speed) => cur + (target - cur) * Math.min(1, dt * speed);
    if (!this.spin) {
      const before = this._posFor(this.angle);
      this.angle = ease(this.angle, this.target, 8);
      if (this._posFor(this.angle) !== before) lockSound("soft");
    }
    let wobble = 0;
    if (this.jiggle > 0) { this.jiggle -= dt; wobble = Math.sin(this.jiggle * 90) * 0.04 * this.jiggle; }
    this.dial.rotation.z = this.angle + wobble;
    if (this.shake > 0) { this.shake -= dt; this.hinge.position.x = this.hingeX + Math.sin(this.shake * 100) * 0.012 * this.shake; }
    else this.hinge.position.x = this.hingeX;
    this.handleAngle = ease(this.handleAngle, this.handleTarget, 10);
    this.handle.rotation.z = this.handleAngle;
    const turned = Math.abs(this.handleAngle - this.handleTarget) < 0.05;
    this.doorAngle = ease(this.doorAngle, this.doorTarget && !turned ? this.doorAngle : this.doorTarget, this.doorTarget ? 2.5 : 4);
    this.hinge.rotation.y = this.doorAngle;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

/* -------------------------------------------- */
/*  Window                                      */
/* -------------------------------------------- */

const { ApplicationV2, DialogV2 } = foundry.applications.api;

class PuzzleWindow extends ApplicationV2 {
  static instances = new Map();

  static DEFAULT_OPTIONS = {
    classes: ["theia-puzzle"],
    window: { resizable: true, icon: "fa-solid fa-scale-balanced" },
    position: { width: 980, height: 640 }
  };

  constructor(puzzleId, scene, mode) {
    const def = getDef(puzzleId);
    super({ id: `theia-puzzle-${puzzleId}`, window: { title: def.title, icon: `fa-solid ${def.icon ?? "fa-scale-balanced"}` } });
    this.puzzleId = puzzleId;
    this.sceneDoc = scene;
    this.mode = mode; // "watch" | "interact"
  }

  get def() { return getDef(this.puzzleId); }
  get isSlots() { return this.def.type === "slots"; }
  get isDial() { return this.def.type === "dial"; }
  get isRotary() { return this.def.type === "rotary"; }
  get state() { return getState(this.sceneDoc, this.puzzleId); }
  get isOperator() { return this.state.lock?.userId === game.user.id; }

  async _renderHTML() {
    const root = document.createElement("div");
    root.className = "tp-root";
    root.innerHTML = `
      <div class="tp-stage"><div class="tp-hint"></div></div>
      <aside class="tp-side">
        <div class="tp-status"></div>
        <div class="tp-weights"></div>
        <div class="tp-controls"></div>
        <div class="tp-dropzone"><i class="fa-solid fa-hand-holding"></i> Drop here to take it</div>
        <div class="tp-inventory"></div>
      </aside>`;
    return root;
  }

  _replaceHTML(result, content) {
    if (content.firstChild) return; // built once; later updates go through refresh()
    content.replaceChildren(result);
  }

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    const stage = this.element.querySelector(".tp-stage");
    const side = this.element.querySelector(".tp-side");
    const slots = this.isSlots;
    this.element.classList.toggle("tp-dial", this.isDial || this.isRotary);
    this.view = new (this.isRotary ? RotaryView : this.isDial ? DialView : slots ? SlotsView : ScaleView)(stage, {
      def: this.def,
      canInteract: () => this.mode === "interact" && this.isOperator,
      onTurn: (ring, delta) => this._act("turnDial", { ring, delta }),
      onTry: () => this._act(this.isRotary ? "tryRotary" : "tryDial"),
      onSpin: (to, dir) => this._act("spinRotary", { to, dir }),
      onTake: async entryId => !!(await this._act(slots ? "takeSlot" : "take", { entryId }))?.ok,
      onMove: async (entryId, pan) => !!(await this._act(slots ? "moveSlot" : "move", slots ? { entryId, slot: pan } : { entryId, pan }))?.ok,
      onDrop: (data, pan) => (slots ? this._dropSlot(data, pan) : this._drop(data, pan)),
      isOverInventory: (x, y) => {
        const r = side.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      },
      onDragState: over => {
        this.element.classList.toggle("tp-dragging", over !== null);
        this.element.classList.toggle("tp-drop-hover", !!over);
      }
    });
    if (this.mode === "interact") this._startHeartbeat();
    this.refresh();
  }

  _startHeartbeat() {
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => request("heartbeat", this._payload()), HEARTBEAT_MS);
  }

  _payload(extra = {}) {
    const epoch = getState(this.sceneDoc, this.puzzleId).epoch;
    return { puzzleId: this.puzzleId, sceneId: this.sceneDoc.id, epoch, ...extra };
  }

  async _act(type, extra) {
    const r = await request(type, this._payload(extra));
    if (!r?.ok && r?.msg) ui.notifications.warn(r.msg);
    return r;
  }

  async _drop(data, pan) {
    if (data?.kind !== "item") return;
    const item = this._actor()?.items.get(data.itemId);
    if (!item) return;
    const epoch = getState(this.sceneDoc, this.puzzleId).epoch;
    let qty = 1;
    const have = Number(item.system.quantity ?? 1) || 1;
    if (have > 1) {
      qty = await DialogV2.prompt({
        window: { title: item.name },
        content: `<p>How many to place on the pan? (you have ${have})</p><input type="number" name="qty" min="1" max="${have}" value="1" autofocus>`,
        ok: { label: "Place", callback: (ev, btn) => Number(btn.form.elements.qty.value) },
        rejectClose: false
      });
      if (!qty || !this.rendered) return;
    }
    await this._act("placeItem", { itemId: item.id, qty, pan, epoch });
  }

  async _dropSlot(data, slot) {
    if (data?.kind !== "item" || !slot) return;
    await this._act("placeSlot", { itemId: data.itemId, slot });
  }

  _actor() {
    const uuid = this.state.lock?.tokenUuid;
    return uuid ? fromUuidSync(uuid)?.actor : null;
  }

  /** Re-sync everything from the scene flag (called on every state change). */
  refresh() {
    if (!this.element || !this.view) return;
    const state = this.state;
    if (this.mode === "interact" && !this.isOperator) this.mode = "watch";
    this.view.update(state);

    const el = this.element;
    const operating = this.mode === "interact" && this.isOperator;
    el.classList.toggle("tp-watching", !operating);
    const def = this.def;
    const noun = def.noun ?? "scale";
    el.querySelector(".tp-hint").textContent = !operating ? "Watching • Right-drag: orbit • Wheel: zoom"
      : this.isDial ? "Click the top or bottom of a ring (or scroll over it) to turn it • Click the handle to try • Right-drag: orbit"
      : this.isRotary ? "Drag the dial around to turn it; let go to stop on a number • Click the handle to try • Right-drag: orbit"
      : this.isSlots ? "Drag a piece from the list onto a slot • Drag pieces between slots or back onto the list • Right-drag: orbit • Wheel: zoom"
      : "Drag objects with the left mouse button • Right-drag: orbit • Wheel: zoom • Drag items from the list onto a pan";

    const lock = state.lock;
    const who = lock ? foundry.utils.escapeHTML(lock.actorName ?? lock.userName) : "";
    el.querySelector(".tp-status").innerHTML = lock
      ? `<i class="fa-solid fa-hand"></i> <b>${who}</b> is using the ${noun}${lock.userId === game.user.id ? " (you)" : ""}.`
      : `<i class="fa-solid fa-eye"></i> Nobody is using the ${noun}.`;

    if (this.isRotary) {
      const stuckFor = Math.ceil(((state.lockedUntil ?? 0) - Date.now()) / 1000);
      const steps = (def.rings ?? []).length;
      const gm = game.user.isGM
        ? `<div><span>Code (GM)</span><b>${parseCode(def.code, steps).join("-")}</b></div>
           <div><span>Clicks so far (GM)</span><b>${state.step ?? 0} / ${steps}</b></div>
           <div><span>Wrong tries</span><b>${state.wrong ?? 0}</b></div>` : "";
      const said = { tick: "Click.", reset: "Clunk. The tumblers fell back.", stuck: "The handle won't budge.", open: "" }[state.last?.kind] ?? "";
      el.querySelector(".tp-weights").innerHTML = `<div><span>Dial</span><b>${Number(state.pos) || 0}</b></div>${gm}`
        + (said ? `<p class="tp-rotary-said">${said}</p>` : "")
        + (stuckFor > 0 ? `<p class="tp-stuck"><i class="fa-solid fa-lock"></i> The dial is stuck (${stuckFor} s).</p>` : "")
        + (state.solved ? `<p class="tp-solved"><i class="fa-solid fa-check"></i> Open.</p>` : "");
      clearTimeout(this._stuckTimer);
      if (stuckFor > 0) this._stuckTimer = setTimeout(() => this.refresh(), 1000);
    } else if (this.isDial) {
      const esc = foundry.utils.escapeHTML;
      const stuckFor = Math.ceil(((state.lockedUntil ?? 0) - Date.now()) / 1000);
      const gm = game.user.isGM
        ? `<div><span>Code (GM)</span><b>${parseCode(def.code, def.rings.length).join("-")}</b></div>
           <div><span>Wrong attempts</span><b>${state.wrong ?? 0}</b></div>` : "";
      el.querySelector(".tp-weights").innerHTML = `<div><span>Rings</span><b>${esc((state.dials ?? []).join(" · "))}</b></div>${gm}`
        + (stuckFor > 0 ? `<p class="tp-stuck"><i class="fa-solid fa-lock"></i> The rings are stuck (${stuckFor} s).</p>` : "")
        + (state.solved ? `<p class="tp-solved"><i class="fa-solid fa-check"></i> Open.</p>` : "");
      clearTimeout(this._stuckTimer);
      if (stuckFor > 0) this._stuckTimer = setTimeout(() => this.refresh(), 1000);
    } else if (this.isSlots) {
      const esc = foundry.utils.escapeHTML;
      const pieces = knownPieces();
      const stuckFor = Math.ceil(((state.lockedUntil ?? 0) - Date.now()) / 1000);
      el.querySelector(".tp-weights").innerHTML = def.slots.map(s => {
        const e = state.slots?.[s.id];
        const gm = game.user.isGM ? `<em class="tp-expects">${esc(pieces[s.accepts] ?? s.accepts ?? "?")}${e ? (e.key === s.accepts ? " ✓" : " ✗") : ""}</em>` : "";
        return `<div><span>${esc(s.label)}</span><b>${e ? esc(e.name) : "—"}</b>${gm}</div>`;
      }).join("")
        + (stuckFor > 0 ? `<p class="tp-stuck"><i class="fa-solid fa-lock"></i> The slots are stuck (${stuckFor} s).</p>` : "")
        + (state.solved ? `<p class="tp-solved"><i class="fa-solid fa-check"></i> Solved.</p>` : "");
      clearTimeout(this._stuckTimer);
      if (stuckFor > 0) this._stuckTimer = setTimeout(() => this.refresh(), 1000);
    } else {
      el.querySelector(".tp-weights").innerHTML =
        `<div><span>Left pan</span><b>${fmtKg(panKg(state.pans.left))}</b></div>` +
        `<div><span>Right pan</span><b>${fmtKg(panKg(state.pans.right))}</b></div>`;
    }

    const controls = el.querySelector(".tp-controls");
    controls.innerHTML = "";
    const btn = (label, icon, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.innerHTML = `<i class="fa-solid ${icon}"></i> ${label}`;
      b.addEventListener("click", fn);
      controls.appendChild(b);
    };
    if (operating && this.isSlots && def.verify === "button") btn("Press the slots", "fa-hand-pointer", () => this._act("press"));
    if (operating) btn("Stop interacting", "fa-hand-back-fist", () => this._stopInteracting());
    else if (!lock || game.user.isGM) btn("Interact", "fa-hand", () => this._startInteracting());
    if (game.user.isGM) {
      if (lock && !operating) btn("Release", "fa-unlock", () => this._act("release"));
      if (this.isSlots) btn("Setup", "fa-gear", () => new SlotsEditor(this.puzzleId).render(true));
      if (this.isDial || this.isRotary) btn("Setup", "fa-gear", () => editDial(this.puzzleId));
      btn("Triggers", "fa-bolt", () => new TriggerEditor(this.puzzleId).render(true));
      btn("Reset", "fa-rotate-left", async () => {
        const ok = await DialogV2.confirm({ window: { title: `Reset ${noun}` },
          content: this.isDial || this.isRotary ? "<p>Lock the vault again and set the dial back to 0?</p>" : this.isSlots ? "<p>Return the table to its starting state? Pieces left in the slots will be lost.</p>"
            : "<p>Return the scale to its starting state? Items and coins left on the pans will be lost.</p>" });
        if (ok) this._act("reset");
      });
    }

    this._renderInventory(operating);
  }

  _renderInventory(operating) {
    const box = this.element.querySelector(".tp-inventory");
    if (!operating) { box.innerHTML = ""; return; }
    const actor = this._actor();
    if (!actor) { box.innerHTML = "<p>Character not found.</p>"; return; }
    if (this.isRotary) return this._renderRotary(box, actor);
    if (this.isDial) return this._renderDial(box, actor);
    if (this.isSlots) return this._renderPieces(box, actor);
    const items = actor.items.filter(i => itemKgEach(i) > 0 && i.system.quantity !== 0)
      .sort((a, b) => a.name.localeCompare(b.name));
    const cur = actor.system.currency ?? {};
    const denoms = Object.keys(CONFIG.DND5E.currencies);
    box.innerHTML = `
      <h3>${foundry.utils.escapeHTML(actor.name)}</h3>
      <div class="tp-coins">
        ${denoms.map(d => `<label class="tp-coin tp-${d}"><span>${CONFIG.DND5E.currencies[d].abbreviation ?? d}</span>
          <input type="number" min="0" max="${cur[d] ?? 0}" value="0" data-denom="${d}"><em>/ ${cur[d] ?? 0}</em></label>`).join("")}
        <div class="tp-coin-actions">
          <button type="button" data-pan="left"><i class="fa-solid fa-coins"></i> Left pan</button>
          <button type="button" data-pan="right"><i class="fa-solid fa-coins"></i> Right pan</button>
        </div>
      </div>
      <p class="tp-note">Drag an item onto a pan (max ${this.def.maxPanKg} kg per pan). Drag objects from the pans onto this panel to take them.</p>
      <ul class="tp-items">${items.map(i => `
        <li draggable="true" data-item-id="${i.id}">
          <img src="${i.img}"><span class="tp-name">${foundry.utils.escapeHTML(i.name)}</span>
          <span class="tp-w">${fmtKg(itemKgEach(i))}${(i.system.quantity ?? 1) > 1 ? ` ×${i.system.quantity}` : ""}</span>
        </li>`).join("")}</ul>`;
    box.querySelectorAll("li[draggable]").forEach(li => li.addEventListener("dragstart", ev => {
      ev.dataTransfer.setData("text/plain", JSON.stringify({ kind: "item", itemId: li.dataset.itemId }));
    }));
    box.querySelectorAll(".tp-coin-actions button").forEach(b => b.addEventListener("click", async () => {
      for (const input of box.querySelectorAll(".tp-coins input")) {
        const amount = Math.floor(Number(input.value) || 0);
        if (amount > 0) await this._act("placeCurrency", { denom: input.dataset.denom, amount, pan: b.dataset.pan });
      }
    }));
  }

  /** Dials: a row of buttons per ring and the handle (the same as clicking them in 3D). */
  _renderDial(box, actor) {
    const esc = foundry.utils.escapeHTML;
    const state = this.state;
    const rings = this.def.rings ?? [];
    const off = state.solved ? "disabled" : "";
    box.innerHTML = `
      <h3>${esc(actor.name)}</h3>
      <div class="tp-dial-rings">${rings.map((r, i) => `
        <div class="tp-dial-ring">
          <button type="button" data-ring="${i}" data-delta="1" ${off}><i class="fa-solid fa-chevron-up"></i></button>
          <b>${Number(state.dials?.[i]) || 0}</b>
          <button type="button" data-ring="${i}" data-delta="-1" ${off}><i class="fa-solid fa-chevron-down"></i></button>
        </div>`).join("")}</div>
      <button type="button" class="tp-dial-try" ${off}><i class="fa-solid fa-hand-back-fist"></i> Turn the handle</button>`;
    box.querySelectorAll("[data-ring]").forEach(b => b.addEventListener("click", () =>
      this._act("turnDial", { ring: Number(b.dataset.ring), delta: Number(b.dataset.delta) })));
    box.querySelector(".tp-dial-try").addEventListener("click", () => this._act("tryDial"));
  }

  /** Rotary dials: turn to a number (right or left) without dragging, and the handle. */
  _renderRotary(box, actor) {
    const esc = foundry.utils.escapeHTML;
    const state = this.state;
    const n = Number(this.def.digits) || 40;
    const off = state.solved ? "disabled" : "";
    box.innerHTML = `
      <h3>${esc(actor.name)}</h3>
      <p class="tp-note">Each stop counts: stop on the right number turning the right way and the lock clicks.</p>
      <div class="tp-rotary-turn">
        <button type="button" data-dir="-1" ${off} data-tooltip="Turn left (counterclockwise)"><i class="fa-solid fa-rotate-left"></i></button>
        <input type="number" min="0" max="${n - 1}" value="${Number(state.pos) || 0}" ${off}>
        <button type="button" data-dir="1" ${off} data-tooltip="Turn right (clockwise)"><i class="fa-solid fa-rotate-right"></i></button>
      </div>
      <button type="button" class="tp-dial-try" ${off}><i class="fa-solid fa-hand-back-fist"></i> Turn the handle</button>`;
    const input = box.querySelector("input");
    box.querySelectorAll("[data-dir]").forEach(b => b.addEventListener("click", () => {
      const to = ((Math.round(Number(input.value) || 0) % n) + n) % n;
      this.view?.spinTo?.(to, Number(b.dataset.dir));
    }));
    box.querySelector(".tp-dial-try").addEventListener("click", () => this._act("tryRotary"));
  }

  /** Slot tables: list the pieces (items with a puzzle key) the character carries. */
  _renderPieces(box, actor) {
    const esc = foundry.utils.escapeHTML;
    const items = actor.items.filter(i => pieceKey(i)).sort((a, b) => a.name.localeCompare(b.name));
    box.innerHTML = `
      <h3>${esc(actor.name)}</h3>
      <p class="tp-note">Drag a piece onto a slot. Drag pieces from the table onto this panel to take them back.</p>
      ${items.length ? `<ul class="tp-items">${items.map(i => `
        <li draggable="true" data-item-id="${i.id}">
          <img src="${i.img}"><span class="tp-name">${esc(i.name)}</span>
        </li>`).join("")}</ul>` : "<p class=\"tp-note\"><em>You carry nothing that fits these slots.</em></p>"}`;
    box.querySelectorAll("li[draggable]").forEach(li => li.addEventListener("dragstart", ev => {
      ev.dataTransfer.setData("text/plain", JSON.stringify({ kind: "item", itemId: li.dataset.itemId }));
    }));
  }

  async _startInteracting() {
    const tok = nearTokenFor(game.user, this.sceneDoc, this.puzzleId) ?? (game.user.isGM ? canvas.tokens.controlled[0]?.document : null);
    if (!tok) return ui.notifications.warn(`Select one of your tokens within ${this.def.reachFt} ft of the ${this.def.noun ?? "scale"}.`);
    const r = await this._act("claim", { tokenUuid: tok.uuid });
    if (!r?.ok) return;
    this.mode = "interact";
    this._startHeartbeat();
    this.refresh();
  }

  async _stopInteracting() {
    clearInterval(this.heartbeat);
    this.mode = "watch";
    await this._act("release");
    this.refresh();
  }

  async _onClose(options) {
    clearInterval(this.heartbeat);
    clearTimeout(this._stuckTimer);
    if (this.isOperator) request("release", this._payload());
    this.view?.destroy();
    PuzzleWindow.instances.delete(this.puzzleId);
    return super._onClose?.(options);
  }
}

/* -------------------------------------------- */
/*  Trigger editor (GM)                         */
/* -------------------------------------------- */

class TriggerEditor extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    classes: ["theia-puzzle-triggers"],
    window: { title: "Puzzle triggers", resizable: true, icon: "fa-solid fa-bolt" },
    position: { width: 760, height: 700 }
  };

  constructor(puzzleId, options = {}) {
    super({ id: `theia-puzzle-triggers`, ...options });
    this.puzzleId = puzzleId;
    this.list = getTriggers(puzzleId);
  }

  async _renderHTML() {
    const esc = v => foundry.utils.escapeHTML(String(v ?? ""));
    const opts = (map, cur) => Object.entries(map).map(([k, v]) =>
      `<option value="${k}" ${k === cur ? "selected" : ""}>${esc(typeof v === "string" ? v : v.label)}</option>`).join("");
    const wide = ["flavor", "text", "animation", "sound", "uuid", "name", "args", "walls", "tiles", "src"];
    const field = (key, val) => key === "rollMode"
      ? `<label class="tpt-f tpt-wide"><span>${key}</span><select data-k="${key}">${opts(ROLL_MODES, val)}</select></label>`
      : key === "state"
      ? `<label class="tpt-f"><span>${key}</span><select data-k="${key}">${opts(DOOR_STATES, val)}</select></label>`
      : typeof val === "boolean"
      ? `<label class="tpt-f"><span>${key}</span><input type="checkbox" data-k="${key}" ${val ? "checked" : ""}></label>`
      : `<label class="tpt-f ${wide.includes(key) ? "tpt-wide" : ""}"><span>${key}</span><input type="${typeof val === "number" ? "number" : "text"}" step="any" data-k="${key}" value="${esc(val)}"></label>`;
    const puzzles = opts(Object.fromEntries(Object.entries(PUZZLES).map(([k, d]) => [k, d.title])), this.puzzleId);
    const has = (c, f) => CONDITION_TYPES[c.type]?.fields.includes(f);
    const body = this.list.map((t, ti) => `
      <section class="tpt-trigger" data-ti="${ti}">
        <header>
          <input class="tpt-name" type="text" value="${esc(t.name)}" placeholder="Trigger name">
          <label><input type="checkbox" class="tpt-enabled" ${t.enabled !== false ? "checked" : ""}> enabled</label>
          <label><input type="checkbox" class="tpt-once" ${t.once ? "checked" : ""}> once</label>
          <button type="button" data-do="delTrigger" title="Delete trigger"><i class="fa-solid fa-trash"></i></button>
        </header>
        <h4>When all of these are true</h4>
        ${(t.conditions ?? []).map((c, ci) => `
          <div class="tpt-row tpt-cond" data-ci="${ci}">
            <select data-k="type">${opts(CONDITION_TYPES, c.type)}</select>
            ${has(c, "pan") ? `<select data-k="pan">${opts(PAN_OPTIONS, c.pan)}</select>` : ""}
            ${has(c, "op") ? `<select data-k="op">${opts(OPS, c.op)}</select>` : ""}
            ${has(c, "value") ? `<input type="number" step="any" data-k="value" value="${esc(c.value)}">` : ""}
            ${has(c, "name") ? `<input type="text" data-k="name" placeholder="Item name" value="${esc(c.name)}">` : ""}
            <button type="button" data-do="delCond" data-ci="${ci}"><i class="fa-solid fa-xmark"></i></button>
          </div>`).join("")}
        <button type="button" class="tpt-add" data-do="addCond"><i class="fa-solid fa-plus"></i> Condition</button>
        <h4>Then do</h4>
        ${(t.actions ?? []).map((a, ai) => `
          <div class="tpt-row tpt-action" data-ai="${ai}">
            <select data-k="type">${opts(ACTION_TYPES, a.type)}</select>
            <button type="button" data-do="delAction" data-ai="${ai}"><i class="fa-solid fa-xmark"></i></button>
            <div class="tpt-fields">${Object.keys(ACTION_TYPES[a.type]?.fields ?? {}).map(k => field(k, a[k] ?? ACTION_TYPES[a.type].fields[k])).join("")}</div>
          </div>`).join("")}
        <button type="button" class="tpt-add" data-do="addAction"><i class="fa-solid fa-plus"></i> Action</button>
      </section>`).join("");
    const root = document.createElement("div");
    root.className = "tpt-root";
    root.innerHTML = `
      <div class="tpt-top"><label>Puzzle <select class="tpt-puzzle">${puzzles}</select></label>
        <p class="tpt-help">Conditions are checked after every change on the puzzle. "Once" triggers fire a single time; the others fire every time their conditions become true. Weights are in kg; "Taken off the scale" counts Soul Coins removed from both pans. Door walls are wall ids separated by commas.</p></div>
      ${body || "<p>No triggers yet.</p>"}
      <footer>
        <button type="button" data-do="addTrigger"><i class="fa-solid fa-plus"></i> New trigger</button>
        <button type="button" data-do="defaults"><i class="fa-solid fa-rotate-left"></i> Restore defaults</button>
        <button type="button" data-do="save" class="tpt-save"><i class="fa-solid fa-floppy-disk"></i> Save</button>
      </footer>`;
    return root;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
    content.querySelector(".tpt-puzzle").addEventListener("change", ev => {
      this.puzzleId = ev.target.value;
      this.list = getTriggers(this.puzzleId);
      this.render();
    });
    content.querySelectorAll("select[data-k=type]").forEach(sel => sel.addEventListener("change", () => { this._read(); this.render(); }));
    content.querySelectorAll("[data-do]").forEach(b => b.addEventListener("click", () => this._do(b)));
  }

  /** Pull the form values back into this.list. */
  _read() {
    const el = this.element;
    if (!el) return;
    el.querySelectorAll(".tpt-trigger").forEach(sec => {
      const t = this.list[Number(sec.dataset.ti)];
      t.name = sec.querySelector(".tpt-name").value;
      t.enabled = sec.querySelector(".tpt-enabled").checked;
      t.once = sec.querySelector(".tpt-once").checked;
      sec.querySelectorAll(".tpt-cond").forEach(row => {
        const c = t.conditions[Number(row.dataset.ci)];
        row.querySelectorAll("[data-k]").forEach(inp => { c[inp.dataset.k] = inp.type === "number" ? Number(inp.value) : inp.value; });
      });
      sec.querySelectorAll(".tpt-action").forEach(row => {
        const a = t.actions[Number(row.dataset.ai)];
        const type = row.querySelector("select[data-k=type]").value;
        if (type !== a.type) {
          Object.keys(a).forEach(k => delete a[k]);
          Object.assign(a, foundry.utils.deepClone(ACTION_TYPES[type].fields));
          a.type = type;
          return;
        }
        row.querySelectorAll(".tpt-fields [data-k]").forEach(inp => {
          a[inp.dataset.k] = inp.type === "checkbox" ? inp.checked : inp.type === "number" ? Number(inp.value) : inp.value;
        });
      });
    });
  }

  async _do(btn) {
    this._read();
    const sec = btn.closest(".tpt-trigger");
    const t = sec ? this.list[Number(sec.dataset.ti)] : null;
    switch (btn.dataset.do) {
      case "addTrigger":
        this.list.push({ id: foundry.utils.randomID(), name: "New trigger", enabled: true, once: true,
          conditions: [{ type: "weight", pan: "left", op: "gte", value: 0 }], actions: [{ type: "chat", text: "", gmOnly: false }] });
        break;
      case "delTrigger": this.list.splice(Number(sec.dataset.ti), 1); break;
      case "addCond": t.conditions.push({ type: "weight", pan: "left", op: "gte", value: 0 }); break;
      case "delCond": t.conditions.splice(Number(btn.dataset.ci), 1); break;
      case "addAction": t.actions.push({ type: "chat", ...foundry.utils.deepClone(ACTION_TYPES.chat.fields) }); break;
      case "delAction": t.actions.splice(Number(btn.dataset.ai), 1); break;
      case "defaults": this.list = foundry.utils.deepClone(PUZZLES[this.puzzleId].triggers ?? []); break;
      case "save":
        await setTriggers(this.puzzleId, this.list);
        ui.notifications.info("Theia Puzzles: triggers saved.");
        return;
    }
    this.render();
  }
}

/* -------------------------------------------- */
/*  Slot table setup (GM)                       */
/* -------------------------------------------- */

const CONFIG_FIELDS = ["slots", "verify", "requireOriginal", "pressSound", "wrongLockSeconds", "wrongSound", "wrongText", "wrongGmText"];

class SlotsEditor extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    classes: ["theia-puzzle-triggers", "theia-puzzle-slots"],
    window: { title: "Slot table setup", resizable: true, icon: "fa-solid fa-gear" },
    position: { width: 720, height: 680 }
  };

  constructor(puzzleId) {
    super({ id: "theia-puzzle-slots-setup" });
    this.puzzleId = puzzleId;
    const def = getDef(puzzleId);
    this.cfg = foundry.utils.deepClone(Object.fromEntries(CONFIG_FIELDS.map(k => [k, def[k]])));
  }

  async _renderHTML() {
    const esc = v => foundry.utils.escapeHTML(String(v ?? ""));
    const opts = (map, cur) => Object.entries(map).map(([k, v]) => `<option value="${k}" ${k === cur ? "selected" : ""}>${esc(v)}</option>`).join("");
    const pieces = knownPieces();
    const c = this.cfg;
    const registry = game.settings.get(MODULE_ID, "instances") ?? {};
    const rows = (c.slots ?? []).map((s, i) => {
      const accepts = { ...pieces };
      if (s.accepts && !accepts[s.accepts]) accepts[s.accepts] = `${s.accepts} (no item)`;
      return `<div class="tpt-row tps-slot" data-i="${i}">
        <input type="text" data-k="label" value="${esc(s.label)}" placeholder="Plaque text">
        <select data-k="shape">${opts(SHAPES, s.shape)}</select>
        <select data-k="accepts"><option value="">— nothing —</option>${opts(accepts, s.accepts)}</select>
        <button type="button" data-do="delSlot" data-i="${i}" title="Remove slot"><i class="fa-solid fa-xmark"></i></button>
      </div>`;
    }).join("");
    const regRows = Object.entries(registry).map(([id, r]) =>
      `<li><b>${esc(r.name)}</b> — ${esc(r.actor || "?")} <em>(${esc(r.source)})</em> <code>${esc(id)}</code></li>`).join("");
    const root = document.createElement("div");
    root.className = "tpt-root";
    root.innerHTML = `
      <div class="tpt-top"><p class="tpt-help">Slots, from left to right. A piece is any item with <code>flags.theia-puzzles.key</code>;
        the slot accepts the piece whose key you choose.</p></div>
      <section class="tpt-trigger">
        <h4>Slots</h4>${rows || "<p>No slots.</p>"}
        <button type="button" class="tpt-add" data-do="addSlot"><i class="fa-solid fa-plus"></i> Slot</button>
        <h4>Solving</h4>
        <label class="tpt-f tpt-wide"><span>verify</span><select data-c="verify">${opts(VERIFY_MODES, c.verify)}</select></label>
        <label class="tpt-f"><span>only original pieces</span><input type="checkbox" data-c="requireOriginal" ${c.requireOriginal ? "checked" : ""}></label>
        <label class="tpt-f tpt-wide"><span>press sound</span><input type="text" data-c="pressSound" value="${esc(c.pressSound)}"></label>
        <h4>Wrong combination (pressed with every slot filled)</h4>
        <label class="tpt-f"><span>lock (s)</span><input type="number" data-c="wrongLockSeconds" value="${esc(c.wrongLockSeconds)}"></label>
        <label class="tpt-f tpt-wide"><span>sound</span><input type="text" data-c="wrongSound" value="${esc(c.wrongSound)}"></label>
        <label class="tpt-f tpt-wide"><span>public text</span><input type="text" data-c="wrongText" value="${esc(c.wrongText)}"></label>
        <label class="tpt-f tpt-wide"><span>GM text</span><input type="text" data-c="wrongGmText" value="${esc(c.wrongGmText)}"></label>
      </section>
      <section class="tpt-trigger">
        <h4>Original pieces</h4>
        <p class="tpt-help">Pieces handed out by Unboxing the Mystery tiles are recorded automatically. Use the button for pieces given another way.</p>
        <ul class="tps-registry">${regRows || "<li><em>None yet.</em></li>"}</ul>
        <button type="button" class="tpt-add" data-do="register"><i class="fa-solid fa-stamp"></i> Record the pieces carried by the selected token</button>
      </section>
      <footer>
        <button type="button" data-do="defaults"><i class="fa-solid fa-rotate-left"></i> Restore defaults</button>
        <button type="button" data-do="save" class="tpt-save"><i class="fa-solid fa-floppy-disk"></i> Save</button>
      </footer>`;
    return root;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
    content.querySelectorAll("[data-do]").forEach(b => b.addEventListener("click", () => this._do(b)));
  }

  _read() {
    const el = this.element;
    if (!el) return;
    el.querySelectorAll(".tps-slot").forEach(row => {
      const s = this.cfg.slots[Number(row.dataset.i)];
      row.querySelectorAll("[data-k]").forEach(inp => { s[inp.dataset.k] = inp.value; });
    });
    el.querySelectorAll("[data-c]").forEach(inp => {
      this.cfg[inp.dataset.c] = inp.type === "checkbox" ? inp.checked : inp.type === "number" ? Number(inp.value) : inp.value;
    });
  }

  async _do(btn) {
    this._read();
    switch (btn.dataset.do) {
      case "addSlot": this.cfg.slots.push({ id: foundry.utils.randomID(8), label: "New slot", shape: "cube", accepts: "" }); break;
      case "delSlot": this.cfg.slots.splice(Number(btn.dataset.i), 1); break;
      case "defaults": {
        const base = PUZZLES[this.puzzleId];
        this.cfg = foundry.utils.deepClone(Object.fromEntries(CONFIG_FIELDS.map(k => [k, base[k]])));
        break;
      }
      case "register": {
        const actor = canvas.tokens.controlled[0]?.actor;
        if (!actor) return ui.notifications.warn("Select a token first.");
        const items = actor.items.filter(i => pieceKey(i));
        for (const i of items) await registerOriginal(i, "manual");
        ui.notifications.info(`Theia Puzzles: ${items.length} piece(s) recorded for ${actor.name}.`);
        break;
      }
      case "save": {
        const all = foundry.utils.deepClone(game.settings.get(MODULE_ID, "config") ?? {});
        all[this.puzzleId] = this.cfg;
        await game.settings.set(MODULE_ID, "config", all);
        ui.notifications.info("Theia Puzzles: table saved. Reopen the puzzle window to see changes to the slots.");
        return;
      }
    }
    this.render();
  }
}

/* -------------------------------------------- */
/*  Dial setup (GM)                             */
/* -------------------------------------------- */

const DIAL_FIELDS = ["code", "rings", "openSound", "wrongSound", "wrongLockSeconds", "wrongText", "wrongGmText"];

/** Edit a dial: the combination, the sigil on each ring, and what a wrong try does. */
async function editDial(puzzleId) {
  const def = getDef(puzzleId);
  const esc = v => foundry.utils.escapeHTML(String(v ?? ""));
  const opts = cur => Object.entries(SIGILS).map(([k, v]) => `<option value="${k}" ${k === cur ? "selected" : ""}>${esc(v)}</option>`).join("");
  const rings = def.rings ?? [];
  const content = `<div class="tpt-root">
    <p class="tpt-help">${def.type === "rotary" ? `One number per step, 0–${(Number(def.digits) || 40) - 1}, separated by dashes (e.g. 6-2-9): right to the 1st, left to the 2nd, right to the 3rd. The sigils are engraved above the dial, in order.` : "One digit per ring, left to right (e.g. 6-2-9). The sigil is engraved above its ring."}</p>
    <label class="tpt-f tpt-wide"><span>combination</span><input type="text" name="code" value="${esc(parseCode(def.code, rings.length).join("-"))}"></label>
    ${rings.map((r, i) => `<label class="tpt-f tpt-wide"><span>${def.type === "rotary" ? "number" : "ring"} ${i + 1}</span><select name="sigil${i}">${opts(r.sigil)}</select></label>`).join("")}
    <label class="tpt-f"><span>lock after a wrong try (s)</span><input type="number" name="wrongLockSeconds" value="${esc(def.wrongLockSeconds)}"></label>
    <label class="tpt-f tpt-wide"><span>open sound</span><input type="text" name="openSound" value="${esc(def.openSound)}"></label>
    <label class="tpt-f tpt-wide"><span>wrong sound</span><input type="text" name="wrongSound" value="${esc(def.wrongSound)}"></label>
    <label class="tpt-f tpt-wide"><span>public text</span><input type="text" name="wrongText" value="${esc(def.wrongText)}"></label>
    <label class="tpt-f tpt-wide"><span>GM text</span><input type="text" name="wrongGmText" value="${esc(def.wrongGmText)}"></label>
  </div>`;
  const data = await DialogV2.prompt({
    window: { title: `${def.title} — setup`, icon: "fa-solid fa-gear" },
    classes: ["theia-puzzle-triggers"],
    content,
    ok: { label: "Save", icon: "fa-solid fa-floppy-disk", callback: (ev, btn) => new foundry.applications.ux.FormDataExtended(btn.form).object },
    rejectClose: false
  });
  if (!data) return;
  const cfg = {
    code: parseCode(String(data.code).replace(/[^0-9]+/g, "-").replace(/^-|-$/g, ""), rings.length).join("-"),
    rings: rings.map((r, i) => ({ ...r, sigil: data[`sigil${i}`] ?? r.sigil, label: SIGILS[data[`sigil${i}`]] ?? r.label })),
    openSound: data.openSound ?? "", wrongSound: data.wrongSound ?? "", wrongLockSeconds: Number(data.wrongLockSeconds) || 0,
    wrongText: data.wrongText ?? "", wrongGmText: data.wrongGmText ?? ""
  };
  const all = foundry.utils.deepClone(game.settings.get(MODULE_ID, "config") ?? {});
  all[puzzleId] = Object.fromEntries(DIAL_FIELDS.map(k => [k, cfg[k]]));
  await game.settings.set(MODULE_ID, "config", all);
  ui.notifications.info("Theia Puzzles: vault saved. Reopen the puzzle window to see new sigils.");
}

/** Check the combination of a slot table (e.g. from a Monk's Active Tiles lever macro). */
async function press(puzzleId, { tokenUuid, tileUuid } = {}) {
  const scene = findPuzzleScene(puzzleId) ?? canvas.scene;
  const r = await request("press", { puzzleId, sceneId: scene?.id, tokenUuid, tileUuid });
  if (r?.msg) ui.notifications[r.ok ? "info" : "warn"](r.msg);
  return r;
}

/* -------------------------------------------- */
/*  Entry point                                 */
/* -------------------------------------------- */

async function open(puzzleId) {
  const def = getDef(puzzleId);
  if (!def) return ui.notifications.error(`Theia Puzzles: puzzle "${puzzleId}" doesn't exist.`);
  const noun = def.noun ?? "scale";
  const scene = findPuzzleScene(puzzleId);
  if (!scene) return ui.notifications.error("Theia Puzzles: no pedestal tile is linked to this puzzle.");
  const existing = PuzzleWindow.instances.get(puzzleId);
  if (existing?.rendered) return existing.bringToFront();

  const state = getState(scene, puzzleId);
  const lock = state.lock;
  const stale = lock && (Date.now() - lock.ts > LOCK_TIMEOUT_MS || !game.users.get(lock.userId)?.active);
  const busy = lock && !stale && lock.userId !== game.user.id;
  const near = nearTokenFor(game.user, scene, puzzleId);

  const buttons = [{ action: "watch", label: "Watch", icon: "fa-solid fa-eye" }];
  if (!busy || game.user.isGM) buttons.unshift({ action: "interact", label: "Interact", icon: "fa-solid fa-hand", default: true });
  buttons.push({ action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark" });
  const why = busy ? `<p><b>${foundry.utils.escapeHTML(lock.actorName ?? lock.userName)}</b> is already using the ${noun}. You can watch.</p>`
    : (!near && !game.user.isGM ? `<p>To interact, select your token within ${def.reachFt} ft of the ${noun}. You can watch from anywhere.</p>` : "");
  const choice = await DialogV2.wait({
    window: { title: def.title, icon: `fa-solid ${def.icon ?? "fa-scale-balanced"}` },
    content: `<p>Interact with the ${noun}?</p>${why}`, buttons, rejectClose: false
  });
  if (!choice || choice === "cancel") return;

  let mode = "watch";
  if (choice === "interact") {
    const tok = near ?? (game.user.isGM ? canvas.tokens.controlled[0]?.document : null);
    if (!tok) return ui.notifications.warn(`Select one of your tokens within ${def.reachFt} ft of the ${noun}.`);
    const r = await request("claim", { puzzleId, sceneId: scene.id, tokenUuid: tok.uuid });
    if (!r?.ok) { if (r?.msg) ui.notifications.warn(r.msg); return; }
    mode = "interact";
  }
  const win = new PuzzleWindow(puzzleId, scene, mode);
  PuzzleWindow.instances.set(puzzleId, win);
  win.render(true);
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "triggers", { scope: "world", config: false, type: Object, default: {} });
  game.settings.register(MODULE_ID, "config", { scope: "world", config: false, type: Object, default: {} });
  game.settings.register(MODULE_ID, "instances", { scope: "world", config: false, type: Object, default: {} });
  registerAlert();
  registerDoors(request);
  game.settings.registerMenu(MODULE_ID, "triggerMenu", {
    name: "Puzzle triggers", label: "Edit triggers", icon: "fa-solid fa-bolt", restricted: true,
    hint: "Conditions and actions (traps, rewards, macros...) for each puzzle.",
    type: class extends TriggerEditor { constructor() { super(Object.keys(PUZZLES)[0]); } }
  });
  game.modules.get(MODULE_ID).api = {
    open, press, PUZZLES, getDef, getState, request, getTriggers, setTriggers, registerOriginal,
    editTriggers: id => new TriggerEditor(id ?? Object.keys(PUZZLES)[0]).render(true),
    editSlots: id => new SlotsEditor(id ?? "l22-selos").render(true),
    editDial: id => editDial(id ?? "l23-cofre"),
    alert: {
      ALERTS, get: getAlert,
      raise: (id, opts) => alertOp(id, "raise", opts),
      lower: (id, opts) => alertOp(id, "lower", opts),
      set: (id, level) => alertOp(id, "set", { level }),
      open: id => openAlert(id ?? "casa-angelo"),
      testBell: id => testBell(id ?? "casa-angelo") // this client only
    }
  };
});

Hooks.once("ready", () => {
  readyAlert();
  game.socket.on(SOCKET, async msg => {
    if (msg.type === "alert" || msg.type === "alertBell") return onAlertSocket(msg);
    if (msg.type === "result") {
      if (msg.to === game.user.id) pending[msg.rid]?.(msg.result);
      return;
    }
    if (msg.type === "close") return PuzzleWindow.instances.get(msg.puzzleId)?.close();
    if (msg.type === "closeFor") {
      if (msg.to !== game.user.id) return;
      ui.notifications.info("You moved away from the puzzle.");
      return PuzzleWindow.instances.get(msg.puzzleId)?.close();
    }
    if (msg.type === "saveRequest") { if (msg.to === game.user.id) onSaveRequest(msg); return; }
    if (msg.type === "saveResult") { if (isActiveGM()) saveWaits[msg.rid]?.(msg.total); return; }
    if (!isActiveGM()) return;
    const result = await gmHandle(msg);
    game.socket.emit(SOCKET, { type: "result", to: msg.userId, rid: msg.rid, result });
  });

  watchOriginals();

  // Creatures caught by a trap can't move until it has been resolved (the GM clears the list afterwards).
  Hooks.on("preUpdateToken", (tokenDoc, changes) => {
    if (!("x" in changes || "y" in changes || "elevation" in changes)) return;
    const frozen = tokenDoc.parent?.getFlag(MODULE_ID, "frozen") ?? [];
    if (frozen.includes(tokenDoc.id)) {
      ui.notifications.warn(`${tokenDoc.name} is caught in the trap and can't move yet.`);
      return false;
    }
    // A character stays put while it operates a puzzle (the GM can still move it, which ends the operation).
    const using = !game.user.isGM && puzzleUsedBy(tokenDoc);
    if (using) {
      ui.notifications.warn(`${tokenDoc.name} is using the ${getDef(using).noun ?? "scale"}. Stop interacting to move.`);
      return false;
    }
  });

  // GM: a lock holder moved out of reach (e.g. dragged by the GM) gives up the puzzle; its window closes.
  Hooks.on("updateToken", (tokenDoc, changes) => {
    if (!isActiveGM() || !("x" in changes || "y" in changes)) return;
    const puzzleId = puzzleUsedBy(tokenDoc);
    if (!puzzleId) return;
    const def = getDef(puzzleId);
    if (distanceToPuzzleFt(tokenDoc, tokenDoc.parent, puzzleId) <= def.reachFt + 0.01) return;
    const lock = getState(tokenDoc.parent, puzzleId).lock;
    gmHandle({ type: "release", payload: { puzzleId, sceneId: tokenDoc.parent.id }, userId: game.user.id });
    if (lock.userId === game.user.id) PuzzleWindow.instances.get(puzzleId)?.close();
    else game.socket.emit(SOCKET, { type: "closeFor", to: lock.userId, puzzleId });
  });

  // Live updates for every open window.
  Hooks.on("updateScene", (scene, changes) => {
    if (!foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`)) return;
    for (const win of PuzzleWindow.instances.values()) if (win.sceneDoc === scene) win.refresh();
  });
  Hooks.on("updateSetting", setting => {
    if (setting.key === `${MODULE_ID}.config`) for (const win of PuzzleWindow.instances.values()) win.refresh();
  });

  // GM: free the lock if its holder disconnects or goes silent.
  const sweep = (filter) => {
    for (const scene of game.scenes) for (const puzzleId of Object.keys(PUZZLES)) {
      const lock = scene.getFlag(MODULE_ID, `state.${puzzleId}`)?.lock;
      if (lock && filter(lock)) gmHandle({ type: "release", payload: { puzzleId, sceneId: scene.id }, userId: game.user.id });
    }
  };
  Hooks.on("userConnected", (user, connected) => {
    if (!connected && isActiveGM()) sweep(lock => lock.userId === user.id);
  });
  setInterval(() => { if (isActiveGM()) sweep(lock => Date.now() - lock.ts > LOCK_TIMEOUT_MS); }, 30_000);
});
