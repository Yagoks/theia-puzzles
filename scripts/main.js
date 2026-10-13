// Theia Puzzles — 3D mini-game puzzles for Foundry VTT (dnd5e).
//
// Architecture
// - Each puzzle is registered in PUZZLES and placed on a scene by a tile flagged
//   `flags.theia-puzzles.puzzle = "<puzzleId>"` (the pedestal players click, through Monk's Active Tiles).
// - The puzzle state lives on the scene: `flags.theia-puzzles.state.<puzzleId>`. Every client renders from it.
// - Only the active GM mutates state and actor sheets. Players send requests over the module socket; the GM
//   validates (lock owner, distance, weights) and applies them one at a time.
// - One operator at a time ("Interagir", must stand within reach of the pedestal); anyone can "Assistir"
//   from anywhere in the scene and watch live.

import { THREE, OrbitControls, GLTFLoader } from "../vendor/three-bundle.js";

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
    title: "Balança do tributo",
    reachFt: 5,
    maxPanKg: 5,
    modelUrl: null, // GLB of the scale (step 2); null uses the built-in placeholder
    initial: () => ({
      left: [0, 1, 2].map(i => ({
        id: `soul${i}`, kind: "soul", kg: 0.2, name: "Soul Coin",
        img: "icons/commodities/currency/coin-embossed-skull-gold.webp"
      })),
      right: []
    })
  }
};

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

const fmtKg = kg => (kg < 1 ? `${Math.round(kg * 1000)} g` : `${(Math.round(kg * 100) / 100).toLocaleString("pt-BR")} kg`);
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

function getState(scene, puzzleId) {
  const def = PUZZLES[puzzleId];
  const saved = scene?.getFlag(MODULE_ID, `state.${puzzleId}`);
  if (saved) return foundry.utils.deepClone(saved);
  return { lock: null, pans: def.initial() };
}

function findPedestal(scene, puzzleId) {
  return scene?.tiles.find(t => t.getFlag(MODULE_ID, "puzzle") === puzzleId) ?? null;
}

function findPuzzleScene(puzzleId) {
  if (findPedestal(canvas.scene, puzzleId)) return canvas.scene;
  return game.scenes.find(s => findPedestal(s, puzzleId)) ?? null;
}

/** Distance in feet from a token to the pedestal tile's footprint. */
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

/* -------------------------------------------- */
/*  GM authority                                */
/* -------------------------------------------- */

let gmQueue = Promise.resolve();

function isActiveGM() {
  return game.user.isGM && game.users.activeGM?.isSelf;
}

async function request(type, payload = {}) {
  const msg = { type, payload, userId: game.user.id, rid: foundry.utils.randomID() };
  if (isActiveGM()) return gmHandle(msg);
  if (!game.users.activeGM) {
    ui.notifications.warn("Theia Puzzles: nenhum GM conectado.");
    return { ok: false };
  }
  return new Promise(resolve => {
    const timer = setTimeout(() => { delete pending[msg.rid]; resolve({ ok: false, msg: "Sem resposta do GM." }); }, 8000);
    pending[msg.rid] = r => { clearTimeout(timer); resolve(r); };
    game.socket.emit(SOCKET, msg);
  });
}
const pending = {};

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
  if (!def) return { ok: false, msg: "Puzzle desconhecido." };
  const scene = game.scenes.get(payload.sceneId) ?? findPuzzleScene(puzzleId);
  if (!scene) return { ok: false, msg: "Cena do puzzle não encontrada." };
  const user = game.users.get(userId);
  const state = getState(scene, puzzleId);
  const save = () => scene.setFlag(MODULE_ID, `state.${puzzleId}`, state);
  const now = Date.now();
  const lockStale = state.lock && (now - state.lock.ts > LOCK_TIMEOUT_MS || !game.users.get(state.lock.userId)?.active);
  const holdsLock = state.lock?.userId === userId;

  switch (type) {
    case "claim": {
      if (state.lock && !holdsLock && !lockStale && !user.isGM)
        return { ok: false, msg: `${state.lock.userName} já está interagindo com a balança.` };
      const tok = payload.tokenUuid ? fromUuidSync(payload.tokenUuid) : null;
      const tile = findPedestal(scene, puzzleId);
      if (!tok?.actor || tok.parent !== scene) return { ok: false, msg: "Selecione o token do seu personagem." };
      if (!user.isGM && !tok.actor.testUserPermission(user, "OWNER")) return { ok: false, msg: "Esse token não é seu." };
      if (!user.isGM && distanceToPedestalFt(tok, tile) > def.reachFt + 0.01)
        return { ok: false, msg: `Aproxime-se: é preciso estar a até ${def.reachFt} ft da balança.` };
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
      if (!user.isGM) return { ok: false, msg: "Só o GM pode resetar." };
      await scene.unsetFlag(MODULE_ID, `state.${puzzleId}`);
      return { ok: true };
    }
  }

  // ----- mutating actions: only the lock holder (or a GM) -----
  if (!holdsLock && !user.isGM) return { ok: false, msg: "Você não está interagindo com a balança." };
  const tokenDoc = state.lock?.tokenUuid ? fromUuidSync(state.lock.tokenUuid) : null;
  const actor = tokenDoc?.actor;
  if (!actor) return { ok: false, msg: "Personagem não encontrado." };
  if (state.lock) state.lock.ts = now;
  const panName = payload.pan === "left" ? "left" : "right";
  const pan = state.pans[panName];

  switch (type) {
    case "placeItem": {
      const item = actor.items.get(payload.itemId);
      if (!item) return { ok: false, msg: "Item não encontrado na ficha." };
      const each = itemKgEach(item);
      if (each <= 0) return { ok: false, msg: "Itens sem peso não podem ser colocados na balança." };
      const have = Number(item.system.quantity ?? 1) || 1;
      const qty = Math.max(1, Math.min(have, Math.floor(Number(payload.qty) || 1)));
      const kg = each * qty;
      if (panKg(pan) + kg > def.maxPanKg + 1e-9)
        return { ok: false, msg: `O prato aguenta no máximo ${def.maxPanKg} kg (tem ${fmtKg(panKg(pan))}).` };
      const data = item.toObject();
      delete data._id;
      foundry.utils.setProperty(data, "system.quantity", qty);
      if (qty >= have) await item.delete();
      else await item.update({ "system.quantity": have - qty });
      pan.push({ id: foundry.utils.randomID(), kind: "item", name: item.name, img: item.img, kg, qty, data, by: actor.name });
      await save();
      return { ok: true };
    }
    case "placeCurrency": {
      const denom = payload.denom;
      if (!CONFIG.DND5E.currencies[denom]) return { ok: false, msg: "Moeda inválida." };
      const have = Number(actor.system.currency?.[denom]) || 0;
      const amount = Math.floor(Number(payload.amount) || 0);
      if (amount <= 0) return { ok: false, msg: "Informe uma quantidade." };
      if (amount > have) return { ok: false, msg: `Você só tem ${have} ${denom}.` };
      const kg = amount / COINS_PER_KG;
      if (panKg(pan) + kg > def.maxPanKg + 1e-9)
        return { ok: false, msg: `O prato aguenta no máximo ${def.maxPanKg} kg (tem ${fmtKg(panKg(pan))}).` };
      await actor.update({ [`system.currency.${denom}`]: have - amount });
      const pile = pan.find(e => e.kind === "currency" && e.denom === denom);
      if (pile) { pile.amount += amount; pile.kg = pile.amount / COINS_PER_KG; }
      else pan.push({ id: foundry.utils.randomID(), kind: "currency", denom, amount, kg, name: CONFIG.DND5E.currencies[denom].label });
      await save();
      return { ok: true };
    }
    case "take": {
      let from = null, entry = null;
      for (const side of ["left", "right"]) {
        const i = state.pans[side].findIndex(e => e.id === payload.entryId);
        if (i >= 0) { from = side; entry = state.pans[side].splice(i, 1)[0]; break; }
      }
      if (!entry) return { ok: false, msg: "Esse objeto já foi retirado." };
      if (entry.kind === "item") {
        // stack back onto a matching item when the sheet already has one
        const same = actor.items.find(i => i.name === entry.data.name && i.type === entry.data.type
          && (i.system.quantity ?? null) !== null && (entry.data.system?.quantity ?? null) !== null);
        if (same) await same.update({ "system.quantity": (Number(same.system.quantity) || 0) + (Number(entry.data.system.quantity) || 1) });
        else await actor.createEmbeddedDocuments("Item", [entry.data]);
      } else if (entry.kind === "currency") {
        const have = Number(actor.system.currency?.[entry.denom]) || 0;
        await actor.update({ [`system.currency.${entry.denom}`]: have + entry.amount });
      } else if (entry.kind === "soul") {
        const own = actor.items.find(i => i.name === entry.name && i.type === "loot");
        if (own) await own.update({ "system.quantity": (Number(own.system.quantity) || 0) + 1 });
        else await actor.createEmbeddedDocuments("Item", [{
          name: entry.name, type: "loot", img: entry.img,
          system: { quantity: 1, weight: { value: entry.kg, units: "kg" },
            description: { value: "<p>Uma moeda escurecida, fria ao toque. Parece pulsar fracamente.</p>" } }
        }]);
      }
      await save();
      Hooks.callAll(`${MODULE_ID}.taken`, { puzzleId, scene, entry, from, actor, state });
      return { ok: true };
    }
  }
  return { ok: false, msg: `Ação desconhecida: ${type}` };
}

/* -------------------------------------------- */
/*  3D scale view                               */
/* -------------------------------------------- */

const DENOM_COLOR = { pp: 0xe8ecf2, gp: 0xf0c040, sp: 0xc8ccd2, cp: 0xc0703a };

class ScaleView {
  constructor(container, { onTake, onDrop, canInteract }) {
    this.container = container;
    this.onTake = onTake;
    this.onDrop = onDrop;
    this.canInteract = canInteract;
    this.entryMeshes = new Map(); // entryId -> mesh
    this.textures = new Map();
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
    Object.assign(key.shadow.camera, { left: -1, right: 1, top: 1, bottom: -1 });
    this.scene.add(key);
    const rim = new THREE.PointLight(0x7fa6ff, 0.6, 5);
    rim.position.set(-1.4, 1.2, -1.2);
    this.scene.add(rim);

    this._buildPlaceholder();

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.hovered = null;
    this.hold = null;
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

    const pedestal = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.32, 0.5), stone);
    pedestal.position.y = 0.16;
    pedestal.castShadow = pedestal.receiveShadow = true;
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
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.032, 20, 14), dark);
    this.pivot.add(cap);

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
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x9a7a4a }));
        g.add(line);
      }
      const content = new THREE.Group();
      content.position.y = -0.3 + 0.0125;
      g.add(content);
      this.scene.add(g);
      this.pans[side] = { group: g, dish, content };
    }
  }

  _texture(url) {
    if (!url) return null;
    if (this.textures.has(url)) return this.textures.get(url);
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin("anonymous");
    const tex = loader.load(url, undefined, undefined, () => {});
    tex.colorSpace = THREE.SRGBColorSpace;
    this.textures.set(url, tex);
    return tex;
  }

  /** Rebuild the pan contents from the puzzle state. */
  update(state) {
    for (const mesh of this.entryMeshes.values()) {
      mesh.parent?.remove(mesh);
      mesh.geometry?.dispose();
    }
    this.entryMeshes.clear();
    this.hovered = null;

    for (const side of ["left", "right"]) {
      const content = this.pans[side].content;
      const entries = state.pans[side] ?? [];
      entries.forEach((e, i) => {
        const mesh = this._entryMesh(e);
        const slot = this._slot(i, entries.length);
        mesh.position.x = slot.x;
        mesh.position.z = slot.z;
        mesh.position.y = slot.y + (mesh.userData.height ?? 0) / 2;
        mesh.userData.entryId = e.id;
        mesh.castShadow = true;
        content.add(mesh);
        this.entryMeshes.set(e.id, mesh);
      });
    }
    const diff = panKg(state.pans.right) - panKg(state.pans.left);
    this.targetTilt = THREE.MathUtils.clamp(-diff * 0.45, -0.32, 0.32);
  }

  _slot(i, n) {
    if (n === 1 || i === 0) return { x: 0, z: 0, y: 0 };
    const ring = (i - 1) % 6, layer = Math.floor((i - 1) / 6);
    const a = (ring / 6) * Math.PI * 2;
    return { x: Math.cos(a) * 0.075, z: Math.sin(a) * 0.075, y: layer * 0.05 };
  }

  _entryMesh(e) {
    let mesh;
    if (e.kind === "soul") {
      const h = 0.009;
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, h, 28),
        new THREE.MeshStandardMaterial({ color: 0x4a3a20, metalness: 0.9, roughness: 0.4, emissive: 0x1a0a00 }));
      mesh.userData.height = h;
    } else if (e.kind === "currency") {
      const h = THREE.MathUtils.clamp(e.amount * 0.0012, 0.004, 0.09);
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.028, h, 24),
        new THREE.MeshStandardMaterial({ color: DENOM_COLOR[e.denom] ?? 0xf0c040, metalness: 0.9, roughness: 0.3 }));
      mesh.userData.height = h;
    } else {
      const side = THREE.MathUtils.clamp(0.05 * Math.cbrt(e.kg / 0.2), 0.03, 0.17);
      const tex = this._texture(e.img);
      const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: tex, roughness: 0.7 });
      mesh = new THREE.Mesh(new THREE.BoxGeometry(side, side, side), mat);
      mesh.userData.height = side;
    }
    mesh.userData.baseEmissive = mesh.material.emissive?.getHex() ?? 0;
    return mesh;
  }

  _bindEvents() {
    const el = this.renderer.domElement;
    el.addEventListener("contextmenu", ev => ev.preventDefault());
    el.addEventListener("pointermove", ev => this._onMove(ev));
    el.addEventListener("pointerdown", ev => this._onDown(ev));
    window.addEventListener("pointerup", this._up = () => this._cancelHold());
    el.addEventListener("pointerleave", () => this._setHover(null));
    el.addEventListener("dragover", ev => { if (this.canInteract()) ev.preventDefault(); });
    el.addEventListener("drop", ev => {
      ev.preventDefault();
      if (!this.canInteract()) return;
      let data;
      try { data = JSON.parse(ev.dataTransfer.getData("text/plain")); } catch { return; }
      this.onDrop(data, this._panAt(ev));
    });
  }

  _setPointer(ev) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  _entryAt(ev) {
    this._setPointer(ev);
    const hit = this.raycaster.intersectObjects([...this.entryMeshes.values()], false)[0];
    return hit?.object ?? null;
  }

  _panAt(ev) {
    this._setPointer(ev);
    const hit = this.raycaster.intersectObjects([this.pans.left.dish, this.pans.right.dish, ...this.entryMeshes.values()], false)[0];
    if (hit) {
      let o = hit.object;
      while (o && !o.userData.pan && o !== this.scene) o = o.parent;
      if (o?.userData.pan) return o.userData.pan;
      for (const side of ["left", "right"]) if (this.pans[side].content.children.includes(hit.object)) return side;
    }
    // nearest pan on screen
    const r = this.renderer.domElement.getBoundingClientRect();
    const dist = side => {
      const p = new THREE.Vector3(); this.pans[side].dish.getWorldPosition(p); p.project(this.camera);
      const sx = (p.x + 1) / 2 * r.width + r.left, sy = (1 - p.y) / 2 * r.height + r.top;
      return Math.hypot(sx - ev.clientX, sy - ev.clientY);
    };
    return dist("left") < dist("right") ? "left" : "right";
  }

  _setHover(mesh) {
    if (this.hovered === mesh) return;
    if (this.hovered?.material?.emissive) this.hovered.material.emissive.setHex(this.hovered.userData.baseEmissive);
    this.hovered = mesh;
    if (mesh?.material?.emissive) mesh.material.emissive.setHex(0x8a5a10);
    this.renderer.domElement.style.cursor = mesh ? "pointer" : "";
  }

  _onMove(ev) {
    if (!this.canInteract()) return this._setHover(null);
    this._setHover(this._entryAt(ev));
  }

  _onDown(ev) {
    if (ev.button !== 0 || !this.canInteract()) return;
    const mesh = this._entryAt(ev);
    if (!mesh) return;
    const entryId = mesh.userData.entryId;
    this.hold = { mesh, start: performance.now(), done: false, timer: setTimeout(() => {
      if (!this.hold) return;
      this.hold.done = true;
      this.onTake(entryId);
      this.hold = null;
    }, 450) };
  }

  _cancelHold() {
    if (!this.hold) return;
    clearTimeout(this.hold.timer);
    this.hold.mesh.scale.setScalar(1);
    this.hold = null;
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
    // spring toward the target tilt
    const k = 28, damp = 6.5;
    this.tiltVel += ((this.targetTilt - this.tilt) * k - this.tiltVel * damp) * dt;
    this.tilt += this.tiltVel * dt;
    this.pivot.rotation.z = this.tilt;
    const p = new THREE.Vector3();
    for (const side of ["left", "right"]) {
      this.beamEnds[side].getWorldPosition(p);
      this.pans[side].group.position.copy(p);
    }
    if (this.hold) {
      const t = Math.min((performance.now() - this.hold.start) / 450, 1);
      this.hold.mesh.scale.setScalar(1 + 0.25 * t);
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    window.removeEventListener("pointerup", this._up);
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

const { ApplicationV2 } = foundry.applications.api;

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
    this.view = new ScaleView(stage, {
      canInteract: () => this.mode === "interact" && this.isOperator,
      onTake: entryId => this._act("take", { entryId }),
      onDrop: (data, pan) => this._drop(data, pan)
    });
    if (this.mode === "interact") this.heartbeat = setInterval(() => request("heartbeat", this._payload()), HEARTBEAT_MS);
    this.refresh();
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
    const actor = this._actor();
    const item = actor?.items.get(data.itemId);
    if (!item) return;
    let qty = 1;
    const have = Number(item.system.quantity ?? 1) || 1;
    if (have > 1) {
      qty = await foundry.applications.api.DialogV2.prompt({
        window: { title: item.name },
        content: `<p>Quantas unidades colocar no prato? (você tem ${have})</p><input type="number" name="qty" min="1" max="${have}" value="1" autofocus>`,
        ok: { label: "Colocar", callback: (ev, btn) => Number(btn.form.elements.qty.value) },
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
      ? "Botão direito: girar • Roda: zoom • Segure o clique esquerdo para retirar • Arraste itens para um prato"
      : "Assistindo • Botão direito: girar • Roda: zoom";

    const lock = state.lock;
    el.querySelector(".tp-status").innerHTML = lock
      ? `<i class="fa-solid fa-hand"></i> <b>${foundry.utils.escapeHTML(lock.actorName ?? lock.userName)}</b> está interagindo${lock.userId === game.user.id ? " (você)" : ""}.`
      : `<i class="fa-solid fa-eye"></i> Ninguém está interagindo.`;

    const L = panKg(state.pans.left), R = panKg(state.pans.right);
    el.querySelector(".tp-weights").innerHTML =
      `<div><span>Prato esquerdo</span><b>${fmtKg(L)}</b></div><div><span>Prato direito</span><b>${fmtKg(R)}</b></div>`;

    const controls = el.querySelector(".tp-controls");
    controls.innerHTML = "";
    const btn = (label, icon, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.innerHTML = `<i class="fa-solid ${icon}"></i> ${label}`;
      b.addEventListener("click", fn);
      controls.appendChild(b);
    };
    if (operating) btn("Parar de interagir", "fa-hand-back-fist", () => this._stopInteracting());
    else if (!lock || game.user.isGM) btn("Interagir", "fa-hand", () => this._startInteracting());
    if (game.user.isGM) {
      if (lock && !operating) btn("Liberar", "fa-unlock", () => this._act("release"));
      btn("Resetar", "fa-rotate-left", async () => {
        const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: "Resetar balança" },
          content: "<p>Voltar a balança ao estado inicial? Itens e moedas deixados nos pratos serão perdidos.</p>" });
        if (ok) this._act("reset");
      });
    }

    this._renderInventory(operating);
  }

  _renderInventory(operating) {
    const box = this.element.querySelector(".tp-inventory");
    if (!operating) { box.innerHTML = ""; return; }
    const actor = this._actor();
    if (!actor) { box.innerHTML = "<p>Personagem não encontrado.</p>"; return; }
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
          <button type="button" data-pan="left"><i class="fa-solid fa-coins"></i> Prato esquerdo</button>
          <button type="button" data-pan="right"><i class="fa-solid fa-coins"></i> Prato direito</button>
        </div>
      </div>
      <p class="tp-note">Arraste um item para um dos pratos (máx. ${PUZZLES[this.puzzleId].maxPanKg} kg por prato).</p>
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
    if (!tok) return ui.notifications.warn(`Selecione um token seu a até ${PUZZLES[this.puzzleId].reachFt} ft da balança.`);
    const r = await this._act("claim", { tokenUuid: tok.uuid });
    if (!r?.ok) return;
    this.mode = "interact";
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => request("heartbeat", this._payload()), HEARTBEAT_MS);
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
/*  Entry point                                 */
/* -------------------------------------------- */

async function open(puzzleId) {
  const def = PUZZLES[puzzleId];
  if (!def) return ui.notifications.error(`Theia Puzzles: puzzle "${puzzleId}" não existe.`);
  const scene = findPuzzleScene(puzzleId);
  if (!scene) return ui.notifications.error("Theia Puzzles: nenhum tile de pedestal com esse puzzle.");
  const existing = PuzzleWindow.instances.get(puzzleId);
  if (existing?.rendered) return existing.bringToFront();

  const state = getState(scene, puzzleId);
  const lock = state.lock;
  const stale = lock && (Date.now() - lock.ts > LOCK_TIMEOUT_MS || !game.users.get(lock.userId)?.active);
  const busy = lock && !stale && lock.userId !== game.user.id;
  const near = nearTokenFor(game.user, scene, puzzleId);

  const buttons = [{ action: "watch", label: "Assistir", icon: "fa-solid fa-eye" }];
  if (!busy || game.user.isGM) buttons.unshift({ action: "interact", label: "Interagir", icon: "fa-solid fa-hand", default: true });
  buttons.push({ action: "cancel", label: "Cancelar", icon: "fa-solid fa-xmark" });
  const why = busy ? `<p><b>${foundry.utils.escapeHTML(lock.actorName ?? lock.userName)}</b> já está interagindo com a balança. Você pode assistir.</p>`
    : (!near && !game.user.isGM ? `<p>Para interagir, selecione seu token a até ${def.reachFt} ft da balança. Você pode assistir de qualquer lugar.</p>` : "");
  const choice = await foundry.applications.api.DialogV2.wait({
    window: { title: def.title, icon: "fa-solid fa-scale-balanced" },
    content: `<p>Interagir com a balança?</p>${why}`, buttons, rejectClose: false
  });
  if (!choice || choice === "cancel") return;

  let mode = "watch";
  if (choice === "interact") {
    const tok = near ?? (game.user.isGM ? canvas.tokens.controlled[0]?.document : null);
    if (!tok) return ui.notifications.warn(`Selecione um token seu a até ${def.reachFt} ft da balança.`);
    const r = await request("claim", { puzzleId, sceneId: scene.id, tokenUuid: tok.uuid });
    if (!r?.ok) { if (r?.msg) ui.notifications.warn(r.msg); return; }
    mode = "interact";
  }
  const win = new PuzzleWindow(puzzleId, scene, mode);
  PuzzleWindow.instances.set(puzzleId, win);
  win.render(true);
}

Hooks.once("init", () => {
  game.modules.get(MODULE_ID).api = { open, PUZZLES, getState, request };
});

Hooks.once("ready", () => {
  game.socket.on(SOCKET, async msg => {
    if (msg.type === "result") {
      if (msg.to === game.user.id) pending[msg.rid]?.(msg.result);
      return;
    }
    if (!isActiveGM()) return;
    const result = await gmHandle(msg);
    game.socket.emit(SOCKET, { type: "result", to: msg.userId, rid: msg.rid, result });
  });

  // Live updates for every open window.
  Hooks.on("updateScene", (scene, changes) => {
    if (!foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`)) return;
    for (const win of PuzzleWindow.instances.values()) if (win.sceneDoc === scene) win.refresh();
  });

  // GM: free the lock if its holder disconnects or goes silent.
  Hooks.on("userConnected", (user, connected) => {
    if (connected || !isActiveGM()) return;
    for (const scene of game.scenes) for (const puzzleId of Object.keys(PUZZLES)) {
      if (scene.getFlag(MODULE_ID, `state.${puzzleId}`)?.lock?.userId === user.id)
        gmHandle({ type: "release", payload: { puzzleId, sceneId: scene.id }, userId: game.user.id });
    }
  });
  setInterval(() => {
    if (!isActiveGM()) return;
    for (const scene of game.scenes) for (const puzzleId of Object.keys(PUZZLES)) {
      const lock = scene.getFlag(MODULE_ID, `state.${puzzleId}`)?.lock;
      if (lock && Date.now() - lock.ts > LOCK_TIMEOUT_MS)
        gmHandle({ type: "release", payload: { puzzleId, sceneId: scene.id }, userId: game.user.id });
    }
  }, 30_000);
});
