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

import { THREE, OrbitControls, GLTFLoader } from "../vendor/three-bundle.js";
import { CONDITION_TYPES, PAN_OPTIONS, OPS, ROLL_MODES, ACTION_TYPES, conditionsMet, runAction } from "./triggers.js";

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
  }
};

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
  return { lock: null, pans: { left: Array.from({ length: def.soulCount ?? 0 }, () => soulEntry(def)), right: [] } };
}

function getState(scene, puzzleId) {
  const saved = scene?.getFlag(MODULE_ID, `state.${puzzleId}`);
  if (saved) return foundry.utils.deepClone(saved);
  return initialState(PUZZLES[puzzleId]);
}

function findPedestal(scene, puzzleId) {
  return scene?.tiles.find(t => t.getFlag(MODULE_ID, "puzzle") === puzzleId) ?? null;
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

function nearTokenFor(user, scene, puzzleId) {
  const tile = findPedestal(scene, puzzleId);
  if (!tile) return null;
  const reach = PUZZLES[puzzleId].reachFt;
  const candidates = user.isSelf
    ? canvas.tokens.controlled.map(t => t.document)
    : scene.tokens.filter(t => t.actor?.testUserPermission(user, "OWNER"));
  return candidates.find(t => t.parent === scene && t.actor && distanceToPedestalFt(t, tile) <= reach + 0.01) ?? null;
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
  const { puzzleId } = payload;
  const def = PUZZLES[puzzleId];
  if (!def) return { ok: false, msg: "Unknown puzzle." };
  const scene = game.scenes.get(payload.sceneId) ?? findPuzzleScene(puzzleId);
  if (!scene) return { ok: false, msg: "Puzzle scene not found." };
  const user = game.users.get(userId);
  const state = getState(scene, puzzleId);
  const save = () => scene.setFlag(MODULE_ID, `state.${puzzleId}`, state);
  const now = Date.now();
  const lockStale = state.lock && (now - state.lock.ts > LOCK_TIMEOUT_MS || !game.users.get(state.lock.userId)?.active);
  const holdsLock = state.lock?.userId === userId;
  const limitMsg = pan => `A pan holds at most ${def.maxPanKg} kg (it has ${fmtKg(panKg(pan))}).`;

  switch (type) {
    case "claim": {
      if (state.lock && !holdsLock && !lockStale && !user.isGM)
        return { ok: false, msg: `${state.lock.actorName ?? state.lock.userName} is already using the scale.` };
      const tok = payload.tokenUuid ? fromUuidSync(payload.tokenUuid) : null;
      const tile = findPedestal(scene, puzzleId);
      if (!tok?.actor || tok.parent !== scene) return { ok: false, msg: "Select your character's token." };
      if (!user.isGM && !tok.actor.testUserPermission(user, "OWNER")) return { ok: false, msg: "That token isn't yours." };
      if (!user.isGM && distanceToPedestalFt(tok, tile) > def.reachFt + 0.01)
        return { ok: false, msg: `Move closer: you must be within ${def.reachFt} ft of the scale.` };
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
      return { ok: true };
    }
  }

  // ----- mutating actions: only the lock holder (or a GM) -----
  if (!holdsLock && !user.isGM) return { ok: false, msg: "You aren't using the scale." };
  const tokenDoc = state.lock?.tokenUuid ? fromUuidSync(state.lock.tokenUuid) : null;
  const actor = tokenDoc?.actor;
  if (!actor) return { ok: false, msg: "Character not found." };
  if (state.lock) state.lock.ts = now;
  const panName = payload.pan === "left" ? "left" : "right";
  const pan = state.pans[panName];

  const result = await (async () => { switch (type) {
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
function askPlayerSave(user, tokenDoc, { ability, dc, flavor, timeoutMs }) {
  const rid = foundry.utils.randomID();
  return new Promise(resolve => {
    const timer = setTimeout(() => { delete saveWaits[rid]; resolve(null); }, timeoutMs);
    saveWaits[rid] = total => { clearTimeout(timer); delete saveWaits[rid]; resolve(total); };
    game.socket.emit(SOCKET, { type: "saveRequest", to: user.id, rid, actorUuid: tokenDoc.actor.uuid, tokenName: tokenDoc.name,
      ability, dc, flavor, timeoutMs });
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
        const rolls = await actor.rollSavingThrow({ ability: msg.ability, target: msg.dc }, {}, { data: { flavor: msg.flavor } });
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
  const def = PUZZLES[puzzleId];
  const state = getState(scene, puzzleId);
  const fired = new Set(state.fired ?? []);
  const due = getTriggers(puzzleId).filter(t => t.enabled !== false && !(t.once && fired.has(t.id)) && conditionsMet(t, state, def));
  if (!due.length) return;
  for (const t of due) fired.add(t.id);
  state.fired = [...fired];
  await scene.setFlag(MODULE_ID, `state.${puzzleId}`, state);
  const ctx = {
    puzzleId, def, scene, state, actor, tokenDoc, userId, tile: findPedestal(scene, puzzleId),
    distanceToPedestalFt, giveItem, closeWindows: () => closeWindowsEverywhere(puzzleId), askPlayerSave
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
    const targets = [this.pans.left.dish, this.pans.right.dish, ...[...this.entryMeshes.values()].filter(m => m !== this.drag?.mesh)];
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    return hit?.object.userData.pan ?? null;
  }

  _nearestPan(ev) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const dist = side => {
      const p = new THREE.Vector3(); this.pans[side].dish.getWorldPosition(p); p.project(this.camera);
      return Math.hypot((p.x + 1) / 2 * r.width + r.left - ev.clientX, (1 - p.y) / 2 * r.height + r.top - ev.clientY);
    };
    return dist("left") < dist("right") ? "left" : "right";
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
        const onPedestal = Math.abs(m.position.x) < 0.45 && Math.abs(m.position.z) < 0.25;
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
    super({ id: `theia-puzzle-${puzzleId}`, window: { title: PUZZLES[puzzleId].title } });
    this.puzzleId = puzzleId;
    this.sceneDoc = scene;
    this.mode = mode; // "watch" | "interact"
  }

  get def() { return PUZZLES[this.puzzleId]; }
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
    this.view = new ScaleView(stage, {
      canInteract: () => this.mode === "interact" && this.isOperator,
      onTake: async entryId => !!(await this._act("take", { entryId }))?.ok,
      onMove: async (entryId, pan) => !!(await this._act("move", { entryId, pan }))?.ok,
      onDrop: (data, pan) => this._drop(data, pan),
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
    return { puzzleId: this.puzzleId, sceneId: this.sceneDoc.id, ...extra };
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
    let qty = 1;
    const have = Number(item.system.quantity ?? 1) || 1;
    if (have > 1) {
      qty = await DialogV2.prompt({
        window: { title: item.name },
        content: `<p>How many to place on the pan? (you have ${have})</p><input type="number" name="qty" min="1" max="${have}" value="1" autofocus>`,
        ok: { label: "Place", callback: (ev, btn) => Number(btn.form.elements.qty.value) },
        rejectClose: false
      });
      if (!qty) return;
    }
    await this._act("placeItem", { itemId: item.id, qty, pan });
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
    el.querySelector(".tp-hint").textContent = operating
      ? "Drag objects with the left mouse button • Right-drag: orbit • Wheel: zoom • Drag items from the list onto a pan"
      : "Watching • Right-drag: orbit • Wheel: zoom";

    const lock = state.lock;
    const who = lock ? foundry.utils.escapeHTML(lock.actorName ?? lock.userName) : "";
    el.querySelector(".tp-status").innerHTML = lock
      ? `<i class="fa-solid fa-hand"></i> <b>${who}</b> is using the scale${lock.userId === game.user.id ? " (you)" : ""}.`
      : `<i class="fa-solid fa-eye"></i> Nobody is using the scale.`;

    el.querySelector(".tp-weights").innerHTML =
      `<div><span>Left pan</span><b>${fmtKg(panKg(state.pans.left))}</b></div>` +
      `<div><span>Right pan</span><b>${fmtKg(panKg(state.pans.right))}</b></div>`;

    const controls = el.querySelector(".tp-controls");
    controls.innerHTML = "";
    const btn = (label, icon, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.innerHTML = `<i class="fa-solid ${icon}"></i> ${label}`;
      b.addEventListener("click", fn);
      controls.appendChild(b);
    };
    if (operating) btn("Stop interacting", "fa-hand-back-fist", () => this._stopInteracting());
    else if (!lock || game.user.isGM) btn("Interact", "fa-hand", () => this._startInteracting());
    if (game.user.isGM) {
      if (lock && !operating) btn("Release", "fa-unlock", () => this._act("release"));
      btn("Triggers", "fa-bolt", () => new TriggerEditor(this.puzzleId).render(true));
      btn("Reset", "fa-rotate-left", async () => {
        const ok = await DialogV2.confirm({ window: { title: "Reset scale" },
          content: "<p>Return the scale to its starting state? Items and coins left on the pans will be lost.</p>" });
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

  async _startInteracting() {
    const tok = nearTokenFor(game.user, this.sceneDoc, this.puzzleId) ?? (game.user.isGM ? canvas.tokens.controlled[0]?.document : null);
    if (!tok) return ui.notifications.warn(`Select one of your tokens within ${this.def.reachFt} ft of the scale.`);
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
    const wide = ["flavor", "text", "animation", "sound", "uuid", "name", "args"];
    const field = (key, val) => key === "rollMode"
      ? `<label class="tpt-f tpt-wide"><span>${key}</span><select data-k="${key}">${opts(ROLL_MODES, val)}</select></label>`
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
        <p class="tpt-help">Conditions are checked after every change on the scale. Weights are in kg. "Taken off the scale" counts Soul Coins removed from both pans.</p></div>
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
/*  Entry point                                 */
/* -------------------------------------------- */

async function open(puzzleId) {
  const def = PUZZLES[puzzleId];
  if (!def) return ui.notifications.error(`Theia Puzzles: puzzle "${puzzleId}" doesn't exist.`);
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
  const why = busy ? `<p><b>${foundry.utils.escapeHTML(lock.actorName ?? lock.userName)}</b> is already using the scale. You can watch.</p>`
    : (!near && !game.user.isGM ? `<p>To interact, select your token within ${def.reachFt} ft of the scale. You can watch from anywhere.</p>` : "");
  const choice = await DialogV2.wait({
    window: { title: def.title, icon: "fa-solid fa-scale-balanced" },
    content: `<p>Interact with the scale?</p>${why}`, buttons, rejectClose: false
  });
  if (!choice || choice === "cancel") return;

  let mode = "watch";
  if (choice === "interact") {
    const tok = near ?? (game.user.isGM ? canvas.tokens.controlled[0]?.document : null);
    if (!tok) return ui.notifications.warn(`Select one of your tokens within ${def.reachFt} ft of the scale.`);
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
  game.settings.registerMenu(MODULE_ID, "triggerMenu", {
    name: "Puzzle triggers", label: "Edit triggers", icon: "fa-solid fa-bolt", restricted: true,
    hint: "Conditions and actions (traps, rewards, macros...) for each puzzle.",
    type: class extends TriggerEditor { constructor() { super(Object.keys(PUZZLES)[0]); } }
  });
  game.modules.get(MODULE_ID).api = {
    open, PUZZLES, getState, request, getTriggers, setTriggers,
    editTriggers: id => new TriggerEditor(id ?? Object.keys(PUZZLES)[0]).render(true)
  };
});

Hooks.once("ready", () => {
  game.socket.on(SOCKET, async msg => {
    if (msg.type === "result") {
      if (msg.to === game.user.id) pending[msg.rid]?.(msg.result);
      return;
    }
    if (msg.type === "close") return PuzzleWindow.instances.get(msg.puzzleId)?.close();
    if (msg.type === "saveRequest") { if (msg.to === game.user.id) onSaveRequest(msg); return; }
    if (msg.type === "saveResult") { if (isActiveGM()) saveWaits[msg.rid]?.(msg.total); return; }
    if (!isActiveGM()) return;
    const result = await gmHandle(msg);
    game.socket.emit(SOCKET, { type: "result", to: msg.userId, rid: msg.rid, result });
  });

  // Creatures caught by a trap can't move until it has been resolved (the GM clears the list afterwards).
  Hooks.on("preUpdateToken", (tokenDoc, changes) => {
    if (!("x" in changes || "y" in changes || "elevation" in changes)) return;
    const frozen = tokenDoc.parent?.getFlag(MODULE_ID, "frozen") ?? [];
    if (!frozen.includes(tokenDoc.id)) return;
    ui.notifications.warn(`${tokenDoc.name} is caught in the trap and can't move yet.`);
    return false;
  });

  // Live updates for every open window.
  Hooks.on("updateScene", (scene, changes) => {
    if (!foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`)) return;
    for (const win of PuzzleWindow.instances.values()) if (win.sceneDoc === scene) win.refresh();
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
