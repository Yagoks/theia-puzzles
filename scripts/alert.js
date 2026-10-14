// Theia Puzzles — alert counters (GM only): a dungeon-wide alarm level that traps and puzzles raise, that the GM
// can raise or lower by hand, and that offers to drop one level after a quiet stretch of game time.

const MODULE_ID = "theia-puzzles";
const SOCKET = `module.${MODULE_ID}`;

export const ALERTS = {
  "casa-angelo": {
    title: "Casa Angelo — Alert",
    max: 3,
    decayMinutes: 10, // game minutes without a new signal before offering to drop a level
    floorAfterIntrusion: 1,
    bell: "psfx.cantrips.toll-the-dead.ominous-bell.001",
    // The bell rings from this Ambient Sound (its position, radius, easing and "constrained by walls" setting)
    // and this tile swings. Without them the bell is heard everywhere at the same volume.
    bellAmbientSound: "TwWkXAnp7Tl8mc6J",
    bellTile: "yzrSfxmnRhHpRl8l",
    bellVolume: 0.9,
    levels: [
      { name: "Busca", text: "Os invasores permanecem nas posições iniciais." },
      { name: "Suspeita", text: "O Imp de L04 procura a causa do ruído. Se estiver indisponível, 1x Imp do grupo de L16 assume essa tarefa." },
      { name: "Intrusão confirmada", text: "2x Bearded Devil de L10 ocupam o acesso de L15; o Barbed Devil permanece protegendo o arquivo. Vercal guarda os documentos e desloca 1x Imp de L16 para L22 (se esse Imp não lutar em L16, o encontro com a comissão passa a 6.100 XP)." },
      { name: "Retirada", text: "Vercal procura sair por L18 e L24 com o que conseguiu recolher. Se ainda faltar um dos alvos da comissão, pode tentar uma última barganha." }
    ],
    // Signals that can be switched off in play (e.g. the T1 cable cut). Raises with a disabled source are ignored.
    sources: { t1: "T1 — pressure plate (L02)", t9: "T9 — slot table (L22)" },
    manual: ["Door forced open", "Messenger reached Vercal", "Knock / L22 door broken", "Bell from the L11 panel", "Other noise"]
  }
};

const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
const isActiveGM = () => game.user.isGM && game.users.activeGM?.isSelf;

function initial() {
  return { level: 0, intruded: false, lastSignal: null, lastReason: "", promptedFor: null, disabled: {}, log: [] };
}

export function getAlert(id) {
  return foundry.utils.mergeObject(initial(), foundry.utils.deepClone(game.settings.get(MODULE_ID, "alert")?.[id] ?? {}));
}

async function saveAlert(id, state) {
  const all = foundry.utils.deepClone(game.settings.get(MODULE_ID, "alert") ?? {});
  all[id] = state;
  await game.settings.set(MODULE_ID, "alert", all);
}

const floorOf = (def, s) => (s.intruded ? def.floorAfterIntrusion ?? 0 : 0);
const levelLine = (def, n) => `<b>${n} — ${esc(def.levels[n]?.name)}</b>: ${esc(def.levels[n]?.text)}`;
const gmWhisper = content => ChatMessage.create({ content, whisper: ChatMessage.getWhisperRecipients("GM"), speaker: { alias: "Alert" } });

/** GM side of every change. op: "raise" | "lower" | "set" | "toggle" */
async function apply(id, op, opts = {}) {
  const def = ALERTS[id];
  if (!def) return { ok: false, msg: `Unknown alert "${id}".` };
  const s = getAlert(id);
  const now = game.time.worldTime;
  switch (op) {
    case "raise": {
      if (opts.source && s.disabled[opts.source]) return { ok: false, msg: `${def.sources[opts.source]} is disabled.` };
      const before = s.level;
      s.level = Math.min(def.max, s.level + (Number(opts.amount) || 1));
      s.intruded = true;
      s.lastSignal = now;
      s.lastReason = opts.reason ?? "";
      s.promptedFor = null;
      s.log.unshift({ t: now, from: before, to: s.level, reason: s.lastReason });
      s.log = s.log.slice(0, 20);
      await saveAlert(id, s);
      if (opts.bell !== false) ringBell(id);
      await gmWhisper(`<p><i class="fa-solid fa-bell"></i> <b>${esc(def.title)}</b>: ${before} → <b>${s.level}</b>${s.lastReason ? ` <em>(${esc(s.lastReason)})</em>` : ""}</p>
        ${s.level !== before ? `<p>${levelLine(def, s.level)}</p>` : "<p>Already at the highest level.</p>"}`);
      return { ok: true, level: s.level };
    }
    case "lower": {
      const floor = floorOf(def, s);
      if (s.level <= floor) return { ok: false, msg: `The alert can't go below ${floor}.` };
      if (opts.ifSignal !== undefined && opts.ifSignal !== s.lastSignal) return { ok: false, msg: "The alert changed since this suggestion." };
      const before = s.level;
      s.level -= 1;
      s.lastSignal = now; // another quiet stretch is needed before the next drop
      s.promptedFor = null;
      s.log.unshift({ t: now, from: before, to: s.level, reason: opts.reason ?? "Quiet for a while" });
      s.log = s.log.slice(0, 20);
      await saveAlert(id, s);
      await gmWhisper(`<p><b>${esc(def.title)}</b>: ${before} → <b>${s.level}</b></p><p>${levelLine(def, s.level)}</p>`);
      return { ok: true, level: s.level };
    }
    case "set": {
      const next = initial();
      next.disabled = s.disabled;
      if (opts.level) Object.assign(next, { level: Math.min(def.max, opts.level), intruded: opts.level > 0, lastSignal: now });
      next.log = [{ t: now, from: s.level, to: next.level, reason: opts.reason ?? "Set by the GM" }, ...s.log].slice(0, 20);
      await saveAlert(id, next);
      return { ok: true, level: next.level };
    }
    case "toggle": {
      s.disabled[opts.source] = !s.disabled[opts.source];
      await saveAlert(id, s);
      return { ok: true, disabled: s.disabled[opts.source] };
    }
  }
  return { ok: false };
}

/** Raise / lower from any client (players' tile macros reach the GM over the socket). */
export function alertOp(id, op, opts = {}) {
  if (isActiveGM()) return apply(id, op, opts);
  game.socket.emit(SOCKET, { type: "alert", id, op, opts });
  return Promise.resolve({ ok: true, sent: true });
}

export function onAlertSocket(msg) {
  if (msg.type === "alertBell") { ringLocal(msg.id); return true; }
  if (msg.type !== "alert" || !isActiveGM()) return false;
  apply(msg.id, msg.op, msg.opts ?? {});
  return true;
}

/* -------------------------------------------- */
/*  The bell                                    */
/* -------------------------------------------- */

/** Ring on every client: positional sound from the bell's Ambient Sound, and the bell tile swings. */
function ringBell(id) {
  game.socket.emit(SOCKET, { type: "alertBell", id });
  ringLocal(id);
}

/** A Sequencer database key ("psfx....") or a plain path → a playable file. */
function soundFile(src) {
  if (!src || src.includes("/")) return src;
  const entry = globalThis.Sequencer?.Database?.getEntry?.(src);
  const file = Array.isArray(entry) ? entry[0]?.file : entry?.file;
  return Array.isArray(file) ? file[Math.floor(Math.random() * file.length)] : file;
}

export function testBell(id) {
  return ringLocal(id);
}

function ringLocal(id) {
  const def = ALERTS[id];
  if (!def || !canvas.ready) return;
  const file = soundFile(def.bell);
  const ambient = def.bellAmbientSound ? canvas.scene?.sounds.get(def.bellAmbientSound) : null;
  if (file) {
    const base = def.bellVolume ?? 0.9;
    if (ambient && ambient.walls) {
      // Muffled by walls, as the Ambient Sound is configured.
      canvas.sounds.playAtPosition(file, { x: ambient.x, y: ambient.y, elevation: ambient.elevation ?? 0 }, ambient.radius,
        { volume: base, easing: ambient.easing, walls: true, gmAlways: !canvas.tokens.controlled.length }).catch(err => console.warn(err));
    } else if (ambient) {
      // Not constrained by walls: volume from the distance alone. (Foundry's own path is unreliable here: Terrain
      // Mapper 0.5.2 drops the "ignore walls" option, so walls would still block the sound.)
      const volume = bellVolumeAt(ambient, base);
      if (volume > 0) foundry.audio.AudioHelper.play({ src: file, volume, autoplay: true, loop: false }, false);
    } else if (!def.bellAmbientSound) {
      foundry.audio.AudioHelper.play({ src: file, volume: base, autoplay: true, loop: false }, false);
    }
  }
  swingTile(def.bellTile ? canvas.tiles?.get(def.bellTile) : null);
}

/**
 * Volume for this client, from the distance between the sound and the closest listening token: the selected tokens,
 * or (players) the tokens they own. A GM with no token selected hears it at full volume.
 */
function bellVolumeAt(ambient, base) {
  if (game.user.isGM && !canvas.tokens.controlled.length) return base;
  const tokens = canvas.tokens.controlled.length ? canvas.tokens.controlled
    : canvas.tokens.placeables.filter(t => t.actor?.isOwner);
  if (!tokens.length) return 0;
  const radiusPx = ambient.radius * canvas.dimensions.distancePixels;
  const d = Math.min(...tokens.map(t => Math.hypot(t.center.x - ambient.x, t.center.y - ambient.y)));
  if (d >= radiusPx) return 0;
  const k = 1 - d / radiusPx;
  return base * (ambient.easing ? k * k * (3 - 2 * k) : 1);
}

/** Swing a tile like a struck bell (local animation, nothing is saved). */
function swingTile(tile) {
  const mesh = tile?.mesh;
  if (!mesh) return;
  const base = Math.toRadians(tile.document.rotation ?? 0);
  const start = performance.now();
  const duration = 3200, amplitude = Math.toRadians(16), period = 700;
  const tick = () => {
    const t = performance.now() - start;
    if (t >= duration || mesh.destroyed) {
      canvas.app.ticker.remove(tick);
      if (!mesh.destroyed) mesh.rotation = base;
      return;
    }
    mesh.rotation = base + amplitude * Math.exp(-t / 1100) * Math.sin((2 * Math.PI * t) / period);
  };
  canvas.app.ticker.add(tick);
}

/** GM: after a quiet stretch of game time, offer to drop one level (a button in a whispered card). */
async function checkDecay() {
  if (!isActiveGM()) return;
  const now = game.time.worldTime;
  for (const [id, def] of Object.entries(ALERTS)) {
    const s = getAlert(id);
    if (s.lastSignal === null || s.level <= floorOf(def, s) || s.promptedFor === s.lastSignal) continue;
    const quiet = (now - s.lastSignal) / 60;
    if (quiet < def.decayMinutes) continue;
    s.promptedFor = s.lastSignal;
    await saveAlert(id, s);
    await gmWhisper(`<p><i class="fa-solid fa-hourglass-half"></i> <b>${esc(def.title)}</b>: ${Math.floor(quiet)} min without new signals.</p>
      <p>Lower to <b>${s.level - 1} — ${esc(def.levels[s.level - 1]?.name)}</b>?</p>
      <button type="button" data-tp-alert-lower="${id}" data-signal="${s.lastSignal}"><i class="fa-solid fa-arrow-down"></i> Lower the alert</button>`);
  }
}

/* -------------------------------------------- */
/*  GM panel                                    */
/* -------------------------------------------- */

const { ApplicationV2 } = foundry.applications.api;

export class AlertPanel extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    classes: ["theia-alert"],
    window: { title: "Alert", resizable: true, icon: "fa-solid fa-bell" },
    position: { width: 420, height: "auto" }
  };

  constructor(id = "casa-angelo") {
    super({ id: `theia-alert-${id}`, window: { title: ALERTS[id]?.title ?? "Alert" } });
    this.alertId = id;
  }

  async _renderHTML() {
    const def = ALERTS[this.alertId];
    const s = getAlert(this.alertId);
    const now = game.time.worldTime;
    const quiet = s.lastSignal === null ? null : Math.floor((now - s.lastSignal) / 60);
    const floor = floorOf(def, s);
    const levels = def.levels.map((l, n) => `<li class="${n === s.level ? "current" : ""}"><b>${n} — ${esc(l.name)}</b><span>${esc(l.text)}</span></li>`).join("");
    const sources = Object.entries(def.sources).map(([k, label]) =>
      `<label class="ta-source ${s.disabled[k] ? "off" : ""}"><input type="checkbox" data-source="${k}" ${s.disabled[k] ? "" : "checked"}> ${esc(label)}</label>`).join("");
    const log = s.log.slice(0, 6).map(e => `<li>${e.from} → ${e.to} <em>${esc(e.reason)}</em></li>`).join("");
    const root = document.createElement("div");
    root.className = "ta-root";
    root.innerHTML = `
      <div class="ta-level ta-l${s.level}"><span class="ta-num">${s.level}</span><span class="ta-name">${esc(def.levels[s.level]?.name)}</span></div>
      <p class="ta-quiet">${quiet === null ? "No signals yet." : `Last signal ${quiet} min ago (game time)${s.lastReason ? ` — ${esc(s.lastReason)}` : ""}.`}
        ${s.intruded ? `<br>Minimum after an intrusion: ${floor}.` : ""}</p>
      <div class="ta-buttons">
        <select class="ta-reason">${def.manual.map(r => `<option>${esc(r)}</option>`).join("")}</select>
        <button type="button" data-do="raise"><i class="fa-solid fa-arrow-up"></i> +1</button>
        <button type="button" data-do="lower" ${s.level <= floor ? "disabled" : ""}><i class="fa-solid fa-arrow-down"></i> −1</button>
        <button type="button" data-do="reset" title="Back to 0 (new session)"><i class="fa-solid fa-rotate-left"></i></button>
      </div>
      <ol class="ta-levels" start="0">${levels}</ol>
      <h4>Signals</h4><div class="ta-sources">${sources}</div>
      ${log ? `<h4>History</h4><ul class="ta-log">${log}</ul>` : ""}`;
    return root;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
    const reason = () => content.querySelector(".ta-reason").value;
    content.querySelectorAll("[data-do]").forEach(b => b.addEventListener("click", async () => {
      if (b.dataset.do === "raise") await alertOp(this.alertId, "raise", { reason: reason() });
      if (b.dataset.do === "lower") await alertOp(this.alertId, "lower", { reason: "Lowered by the GM" });
      if (b.dataset.do === "reset") await alertOp(this.alertId, "set", { level: 0, reason: "Reset by the GM" });
    }));
    content.querySelectorAll("[data-source]").forEach(cb => cb.addEventListener("change", () => alertOp(this.alertId, "toggle", { source: cb.dataset.source })));
  }

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    this._timer = setInterval(() => this.render(), 30_000);
  }

  _onClose(options) {
    clearInterval(this._timer);
    return super._onClose?.(options);
  }
}

export function registerAlert() {
  game.settings.register(MODULE_ID, "alert", { scope: "world", config: false, type: Object, default: {} });
}

export function readyAlert() {
  Hooks.on("updateSetting", setting => {
    if (setting.key !== `${MODULE_ID}.alert`) return;
    for (const app of foundry.applications.instances.values()) if (app instanceof AlertPanel) app.render();
  });
  Hooks.on("updateWorldTime", () => checkDecay());
  Hooks.on("renderChatMessageHTML", (message, html) => {
    html.querySelectorAll("[data-tp-alert-lower]").forEach(btn => {
      if (!game.user.isGM) return btn.remove();
      btn.addEventListener("click", async () => {
        const r = await alertOp(btn.dataset.tpAlertLower, "lower", { ifSignal: Number(btn.dataset.signal), reason: "Quiet for a while" });
        if (r?.msg) ui.notifications.warn(r.msg);
        btn.disabled = true;
      });
    });
  });
}
