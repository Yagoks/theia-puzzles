// Theia Puzzles — locked doors: keys, breaking the door, picking the lock.
// A door with flags.theia-puzzles.door = { material, key, lockpick, ... } opens a small window when someone clicks it
// while it is locked: the keys that character carries, "break the door" (an attack against the door's AC; damage below
// its threshold doesn't count) and "pick the lock" (the Unboxing the Mystery minigame configured on that door).
// A door with a combination (door.combo = a puzzle id) has no lock to pick: "enter the combination" opens that puzzle,
// whose trigger opens the door.
// Every change goes through the GM.

const MODULE_ID = "theia-puzzles";
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
const REACH = 1.6; // squares, from the token's center to the door segment

/** AC, Hit Points and damage threshold by material (DMG objects: Large, resilient). */
export const DOOR_MATERIALS = {
  pedra: { label: "Porta de pedra", ac: 17, hp: 27, threshold: 10 },
  ferro: { label: "Porta de ferro", ac: 19, hp: 30, threshold: 15 },
  grade: { label: "Grade de ferro", ac: 19, hp: 20, threshold: 10 },
  madeira: { label: "Porta de madeira reforçada", ac: 15, hp: 18, threshold: 5 },
  // a vault door: only huge blows even mark it
  cofre: { label: "Porta do cofre", ac: 25, hp: 150, threshold: 25 }
};

export function getDoor(wall) {
  const d = foundry.utils.getProperty(wall?.flags ?? {}, `${MODULE_ID}.door`);
  if (!d) return null;
  const m = DOOR_MATERIALS[d.material] ?? DOOR_MATERIALS.pedra;
  return { label: m.label, ac: m.ac, hp: m.hp, threshold: m.threshold, damage: 0, lockpick: true, alert: "casa-angelo", ...d };
}

const isKey = item => !!foundry.utils.getProperty(item.flags ?? {}, `${MODULE_ID}.key`) || /\b(chave|key)\b/i.test(item.name);
const LOCKED = () => CONST.WALL_DOOR_STATES.LOCKED;
const center = wall => ({ x: (wall.c[0] + wall.c[2]) / 2, y: (wall.c[1] + wall.c[3]) / 2 });

function distToDoor(td, wall) {
  const g = wall.parent.grid.size;
  const [x1, y1, x2, y2] = wall.c;
  const px = td.x + (td.width * g) / 2, py = td.y + (td.height * g) / 2;
  const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy || 1;
  const u = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + u * dx), py - (y1 + u * dy)) / g;
}

/** The clicker's token next to the door (controlled first, then any owned token there). */
function tokenAtDoor(wall) {
  const near = t => t.document.parent === wall.parent && distToDoor(t.document, wall) <= REACH;
  return canvas.tokens.controlled.find(near) ?? canvas.tokens.placeables.find(t => t.actor?.isOwner && near(t)) ?? null;
}

/* -------------------------------------------- */
/*  Player side                                 */
/* -------------------------------------------- */

let request = null;

async function openDoorWindow(wall) {
  const door = getDoor(wall);
  const token = tokenAtDoor(wall);
  if (!token) return ui.notifications.info("Selecione seu token junto da porta.");
  const actor = token.actor;
  const keys = actor.items.filter(isKey);
  const weapons = actor.items.filter(i => i.type === "weapon" && i.system.activities?.some(a => a.type === "attack"))
    .sort((a, b) => Number(b.system.equipped) - Number(a.system.equipped));
  const tools = actor.items.some(i => i.type === "tool" && /thieves/i.test(i.name + " " + (i.system.type?.baseItem ?? "")));
  const content = `<div class="tp-door">
    <p><b>${esc(door.label)}</b> — trancada.</p>
    ${keys.length ? `<h4>Chaves de ${esc(token.name)}</h4><div class="tp-door-keys">${keys.map(k =>
      `<button type="button" data-key="${k.id}"><img src="${esc(k.img)}" alt=""> ${esc(k.name)}</button>`).join("")}</div>` : ""}
    <h4>Arrombar a porta</h4>
    <div class="tp-door-row"><select class="tp-door-weapon">${weapons.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join("")}</select>
      <button type="button" data-do="break" ${weapons.length ? "" : "disabled"}><i class="fa-solid fa-hammer"></i> Atacar a porta</button></div>
    ${door.combo ? `<h4>Abrir a fechadura</h4>
      <button type="button" disabled><i class="fa-solid fa-key"></i> Sem fechadura disponível</button>
      <h4>Combinação</h4>
      <button type="button" data-do="combo"><i class="fa-solid fa-circle-notch"></i> Inserir combinação</button>`
    : door.lockpick && door.ubMode ? `<h4>Abrir a fechadura</h4>
      <button type="button" data-do="pick" ${tools ? "" : "disabled"}><i class="fa-solid fa-key"></i> Lockpick${tools ? "" : " (precisa de Thieves' Tools)"}</button>` : ""}
  </div>`;

  const dlg = new foundry.applications.api.DialogV2({
    window: { title: door.label, icon: "fa-solid fa-door-closed" },
    classes: ["tp-door-dialog"],
    content,
    buttons: [{ action: "close", label: "Fechar", default: true }],
    rejectClose: false
  });
  await dlg.render(true);
  const root = dlg.element;
  const base = { sceneId: wall.parent.id, wallId: wall.id, tokenId: token.id };
  root.querySelectorAll("[data-key]").forEach(b => b.addEventListener("click", async () => {
    const r = await request("doorKey", { ...base, itemId: b.dataset.key });
    if (r?.msg) ui.notifications[r.ok ? "info" : "warn"](r.msg);
    if (r?.ok) dlg.close();
  }));
  root.querySelector('[data-do="break"]')?.addEventListener("click", async () => {
    const item = actor.items.get(root.querySelector(".tp-door-weapon")?.value);
    if (!item) return;
    const r = await attackDoor(token, item, base);
    if (r?.opened) dlg.close();
  });
  root.querySelector('[data-do="combo"]')?.addEventListener("click", () => {
    dlg.close();
    game.modules.get(MODULE_ID)?.api?.open(door.combo);
  });
  root.querySelector('[data-do="pick"]')?.addEventListener("click", async () => {
    dlg.close();
    await pickLock(wall, base);
  });
}

/** Roll the weapon against the door; the GM applies AC, threshold and Hit Points. */
async function attackDoor(token, item, base) {
  const act = item.system.activities.find(a => a.type === "attack");
  const toHit = String(act?.labels?.toHit ?? "+0").replace(/\s/g, "") || "+0";
  const dmgFormula = (act?.labels?.damage ?? []).map(d => d.formula).filter(Boolean).join(" + ") || "1";
  const rollData = token.actor.getRollData();
  const attack = await new Roll(`1d20 ${toHit.startsWith("-") ? toHit : `+ ${toHit.replace("+", "")}`}`, rollData).evaluate();
  const damage = await new Roll(dmgFormula, rollData).evaluate();
  const nat20 = attack.dice[0]?.total === 20;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ token: token.document }),
    content: `<p><b>${esc(token.name)}</b> golpeia a porta com <b>${esc(item.name)}</b>.</p>`,
    rolls: [attack, damage]
  });
  const r = await request("doorHit", { ...base, attack: attack.total, damage: damage.total, nat20 });
  return r;
}

/** The Unboxing lock: the GM switches its minigame on for this door, the player plays it, the GM switches it off. */
async function pickLock(wall, base) {
  const r = await request("doorPickStart", base);
  if (!r?.ok) return ui.notifications.warn(r?.msg ?? "A fechadura não pode ser trabalhada agora.");
  // Wait for the door's Unboxing settings to arrive here.
  for (let i = 0; i < 20 && (foundry.utils.getProperty(wall.flags, "unboxing-mystery.mode") ?? "none") === "none"; i++) {
    await new Promise(res => setTimeout(res, 100));
  }
  try {
    const { DoorUnboxingApp } = await import("/modules/unboxing-mystery/scripts/DoorUnboxingApp.js");
    const app = new DoorUnboxingApp(wall);
    const done = () => request("doorPickEnd", base);
    const origClose = app.close.bind(app);
    app.close = async (...args) => { const out = await origClose(...args); done(); return out; };
    app.render(true);
  } catch (err) {
    console.error(`${MODULE_ID} | lockpick`, err);
    request("doorPickEnd", base);
    ui.notifications.error("Não foi possível abrir o minigame de lockpick (Unboxing the Mystery).");
  }
}

/* -------------------------------------------- */
/*  GM side                                     */
/* -------------------------------------------- */

const raised = new Set(); // doors that already made noise this session

export async function doorGm(type, payload, userId, { alertOp }) {
  const scene = game.scenes.get(payload.sceneId);
  const wall = scene?.walls.get(payload.wallId);
  const door = getDoor(wall);
  if (!wall || !door) return { ok: false, msg: "Porta não encontrada." };
  const token = scene.tokens.get(payload.tokenId);
  const user = game.users.get(userId);
  const P = `flags.${MODULE_ID}.door`;
  const say = (content, whisperGM = false) => ChatMessage.create({
    speaker: { alias: door.label }, content,
    whisper: whisperGM ? ChatMessage.getWhisperRecipients("GM").map(u => u.id) : undefined
  });

  switch (type) {
    case "doorKey": {
      if (wall.ds !== LOCKED()) return { ok: false, msg: "A porta não está trancada." };
      const item = token?.actor?.items.get(payload.itemId);
      if (!item) return { ok: false, msg: "Chave não encontrada." };
      if (!door.key || item.name.trim().toLowerCase() !== String(door.key).trim().toLowerCase()) {
        await say(`<p><em>${esc(token.name)} tenta a <b>${esc(item.name)}</b>, mas ela não entra na fechadura.</em></p>`);
        return { ok: false, msg: "Essa chave não serve." };
      }
      await wall.update({ ds: CONST.WALL_DOOR_STATES.OPEN });
      await say(`<p><em><b>${esc(token.name)}</b> gira a <b>${esc(item.name)}</b>. A tranca cede com um estalo e a porta se abre.</em></p>`);
      return { ok: true };
    }
    case "doorHit": {
      if (wall.ds !== LOCKED() || door.broken) return { ok: false, msg: "A porta já não está trancada." };
      // Breaking a door is loud: the alert rises once per door.
      if (door.alert && !door.noise && !raised.has(wall.uuid)) {
        raised.add(wall.uuid);
        await wall.update({ [`${P}.noise`]: true });
        await alertOp?.(door.alert, "raise", { reason: `Porta sendo arrombada (${door.label})`, origin: center(wall) });
      }
      const hits = payload.nat20 || Number(payload.attack) >= door.ac;
      if (!hits) {
        await say(`<p><em>O golpe resvala na porta.</em></p>`);
        return { ok: true, hit: false };
      }
      const dmg = Number(payload.damage) || 0;
      if (dmg < door.threshold) {
        await say(`<p><em>O golpe acerta, mas não chega a marcar a porta.</em></p>`);
        await say(`<p>${esc(door.label)}: ${dmg} de dano, abaixo do limiar ${door.threshold}. HP ${door.hp - door.damage}/${door.hp}.</p>`, true);
        return { ok: true, hit: true, below: true };
      }
      const total = (Number(door.damage) || 0) + dmg;
      if (total >= door.hp) {
        await wall.update({ ds: CONST.WALL_DOOR_STATES.OPEN, [`${P}.damage`]: door.hp, [`${P}.broken`]: true });
        await say(`<p><b><em>A porta cede e se abre aos pedaços.</em></b></p>`);
        return { ok: true, opened: true };
      }
      await wall.update({ [`${P}.damage`]: total });
      await say(`<p><em>A porta racha${total >= door.hp / 2 ? " e começa a ceder" : ""}.</em></p>`);
      await say(`<p>${esc(door.label)}: ${dmg} de dano. HP ${door.hp - total}/${door.hp}.</p>`, true);
      return { ok: true, hit: true };
    }
    case "doorPickStart": {
      if (wall.ds !== LOCKED()) return { ok: false, msg: "A porta não está trancada." };
      if (door.combo || !door.lockpick || !door.ubMode) return { ok: false, msg: "Esta fechadura não pode ser trabalhada." };
      await wall.update({ [`${P}.picking`]: user?.id ?? true, "flags.unboxing-mystery.mode": door.ubMode });
      return { ok: true };
    }
    case "doorPickEnd": {
      await wall.update({ [`${P}.-=picking`]: null, "flags.unboxing-mystery.mode": "none" });
      return { ok: true };
    }
  }
  return { ok: false };
}

/**
 * GM: a lockpick set up in Unboxing on a Theia door is kept in the door's settings and switched off on the wall, so
 * that the click opens the Theia window (keys / break / lockpick) instead of the minigame straight away.
 */
async function adoptUnboxingMode(wall) {
  const door = getDoor(wall);
  if (!door || door.picking) return;
  const mode = foundry.utils.getProperty(wall.flags, "unboxing-mystery.mode");
  if (!mode || mode === "none") return;
  await wall.update({ [`flags.${MODULE_ID}.door.ubMode`]: mode, "flags.unboxing-mystery.mode": "none" });
}

/* -------------------------------------------- */
/*  GM: settings on the wall                    */
/* -------------------------------------------- */

function onRenderWallConfig(app, html) {
  if (!game.user.isGM) return;
  const wall = app.document;
  if (!wall?.door) return;
  const root = html instanceof HTMLElement ? html : html[0];
  if (!root || root.querySelector(".tp-door-config")) return;
  const door = getDoor(wall);
  const fs = document.createElement("fieldset");
  fs.className = "tp-door-config";
  const opt = (map, cur) => Object.entries(map).map(([k, v]) => `<option value="${k}" ${k === cur ? "selected" : ""}>${esc(v.label ?? v)}</option>`).join("");
  fs.innerHTML = `<legend class="tp-d-toggle" title="Mostrar ou esconder as opções"><i class="fa-solid fa-caret-right"></i> Theia — porta trancada${door ? " (ativa)" : ""}</legend>
    <div class="tp-d-body" hidden>
    <div class="form-group"><label>Ativa</label><input type="checkbox" class="tp-d-on" ${door ? "checked" : ""}></div>
    <div class="form-group"><label>Material</label><select class="tp-d-mat">${opt(DOOR_MATERIALS, door?.material ?? "pedra")}</select></div>
    <div class="form-group"><label>Chave (nome do item)</label><input type="text" class="tp-d-key" value="${esc(door?.key ?? "")}"></div>
    <div class="form-group"><label>Lockpick</label><input type="checkbox" class="tp-d-pick" ${door?.lockpick !== false ? "checked" : ""}>
      <p class="hint">Configure o minigame em <b>Open Unboxing Controls</b> (modo Lockpick). ${door?.ubMode ? `Configurado: <b>${esc(door.ubMode)}</b>.` : "Ainda não configurado."}</p></div>
    <div class="form-group"><label>Combinação (id do puzzle)</label><input type="text" class="tp-d-combo" value="${esc(door?.combo ?? "")}">
      <p class="hint">Ex.: <code>l23-cofre</code>. A porta fica sem fechadura (sem lockpick) e "Inserir combinação" abre esse puzzle; o gatilho do puzzle abre a porta.</p></div>
    <div class="form-group"><label>Dano recebido</label><input type="number" class="tp-d-dmg" value="${Number(door?.damage) || 0}" min="0">
      <p class="hint">${door ? `AC ${door.ac}, ${door.hp} HP, limiar de dano ${door.threshold}${door.broken ? " — arrombada" : ""}.` : ""}</p></div>
    </div>`;
  // Collapsed by default: clicking the title shows or hides the options and resizes the window.
  fs.querySelector(".tp-d-toggle").addEventListener("click", () => {
    const body = fs.querySelector(".tp-d-body");
    body.hidden = !body.hidden;
    const icon = fs.querySelector(".tp-d-toggle i");
    icon.classList.toggle("fa-caret-right", body.hidden);
    icon.classList.toggle("fa-caret-down", !body.hidden);
    app.setPosition?.({ height: "auto" });
  });
  const save = async () => {
    if (!fs.querySelector(".tp-d-on").checked) return wall.update({ [`flags.${MODULE_ID}.-=door`]: null });
    const damage = Number(fs.querySelector(".tp-d-dmg").value) || 0;
    await wall.update({
      [`flags.${MODULE_ID}.door.material`]: fs.querySelector(".tp-d-mat").value,
      [`flags.${MODULE_ID}.door.key`]: fs.querySelector(".tp-d-key").value.trim(),
      [`flags.${MODULE_ID}.door.lockpick`]: fs.querySelector(".tp-d-pick").checked,
      [`flags.${MODULE_ID}.door.combo`]: fs.querySelector(".tp-d-combo").value.trim(),
      [`flags.${MODULE_ID}.door.damage`]: damage,
      [`flags.${MODULE_ID}.door.broken`]: damage > 0 && damage >= (DOOR_MATERIALS[fs.querySelector(".tp-d-mat").value]?.hp ?? 27)
    });
  };
  fs.querySelectorAll("input, select").forEach(i => i.addEventListener("change", save));
  const anchor = root.querySelector('select[name="ds"]')?.closest("fieldset") ?? root.querySelector("form") ?? root;
  anchor.after?.(fs) ?? root.append(fs);
}

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

export function registerDoors(requestFn) {
  request = requestFn;
  const path = "foundry.canvas.containers.DoorControl.prototype._onMouseDown";
  const handler = function (wrapped, event) {
    const wall = this.wall?.document ?? this.wall;
    const door = getDoor(wall);
    // Left click on a locked Theia door: the door window instead of Foundry's "it's locked".
    if (door && wall.ds === LOCKED() && (event?.button ?? 0) === 0 && !door.picking) {
      event?.stopPropagation?.();
      openDoorWindow(wall);
      return false;
    }
    return wrapped(event);
  };
  if (globalThis.libWrapper) {
    libWrapper.register(MODULE_ID, path, handler, "MIXED");
    // Unboxing and Arms Reach wrap the same click; only Theia doors are taken over, the rest pass through.
    try { libWrapper.ignore_conflicts(MODULE_ID, ["unboxing-mystery", "foundryvtt-arms-reach"], path); } catch { /* older libWrapper */ }
  }
  else {
    const proto = foundry.canvas.containers.DoorControl.prototype;
    const orig = proto._onMouseDown;
    proto._onMouseDown = function (event) { return handler.call(this, orig.bind(this), event); };
  }
  Hooks.on("renderWallConfig", onRenderWallConfig);
  Hooks.on("updateWall", wall => { if (game.user.isGM && game.users.activeGM?.isSelf) adoptUnboxingMode(wall); });
  Hooks.once("ready", () => {
    if (!game.user.isGM || !game.users.activeGM?.isSelf) return;
    for (const s of game.scenes) for (const w of s.walls) if (getDoor(w)) adoptUnboxingMode(w);
  });
}
