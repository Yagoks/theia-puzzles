// Theia Puzzles — triggers: conditions checked by the GM after every change on a puzzle, and the actions they run
// (traps, rewards, chat, macros, closing the window). Shared by every puzzle; editable in the Triggers window.

export const CONDITION_TYPES = {
  souls: { label: "Soul Coins in", fields: ["pan", "op", "value"] },
  weight: { label: "Weight (kg) in", fields: ["pan", "op", "value"] },
  difference: { label: "Left − right weight (kg)", fields: ["op", "value"] },
  hasItem: { label: "Item on", fields: ["pan", "name"] }
};

export const PAN_OPTIONS = { left: "Left pan", right: "Right pan", any: "Both pans", removed: "Taken off the scale" };
export const OPS = { lt: "<", lte: "≤", eq: "=", ne: "≠", gte: "≥", gt: ">" };

export const ACTION_TYPES = {
  trap: {
    label: "Trap (area save + damage)",
    fields: { radius: 10, animation: "", sound: "", ability: "con", dc: 14, damage: "2d6", damageType: "poison", half: true,
      status: "", statusSeconds: 3600, flavor: "" }
  },
  chat: { label: "Chat message", fields: { text: "", gmOnly: false } },
  giveItem: { label: "Give item to the operator", fields: { uuid: "", quantity: 1, text: "" } },
  macro: { label: "Run macro", fields: { name: "", args: "" } },
  closeWindow: { label: "Close the puzzle window", fields: {} }
};

const TOL = 0.005;

function compare(a, op, b) {
  switch (op) {
    case "lt": return a < b - TOL;
    case "lte": return a <= b + TOL;
    case "eq": return Math.abs(a - b) <= TOL;
    case "ne": return Math.abs(a - b) > TOL;
    case "gte": return a >= b - TOL;
    case "gt": return a > b + TOL;
  }
  return false;
}

const kgOf = list => (list ?? []).reduce((s, e) => s + (e.kg ?? 0), 0);

/** Does every condition of a trigger hold for this state? */
export function conditionsMet(trigger, state, def) {
  const conds = trigger.conditions ?? [];
  if (!conds.length) return false;
  const pans = state.pans;
  const listOf = pan => pan === "any" ? [...pans.left, ...pans.right] : pans[pan] ?? [];
  return conds.every(c => {
    const value = Number(c.value) || 0;
    switch (c.type) {
      case "souls": {
        const onScale = [...pans.left, ...pans.right].filter(e => e.kind === "soul").length;
        const n = c.pan === "removed" ? Math.max(0, (def.soulCount ?? 0) - onScale) : listOf(c.pan).filter(e => e.kind === "soul").length;
        return compare(n, c.op, value);
      }
      case "weight": return compare(kgOf(listOf(c.pan)), c.op, value);
      case "difference": return compare(kgOf(pans.left) - kgOf(pans.right), c.op, value);
      case "hasItem": {
        const name = String(c.name ?? "").trim().toLowerCase();
        return !!name && listOf(c.pan).some(e => String(e.name ?? "").toLowerCase() === name);
      }
    }
    return false;
  });
}

/* -------------------------------------------- */
/*  Actions                                     */
/* -------------------------------------------- */

function tileCenter(tile) {
  return { x: tile.x + tile.width / 2, y: tile.y + tile.height / 2 };
}

/** Area trap around the pedestal: animation + sound, one damage roll, a save per creature, half on success. */
export async function runTrap(action, { scene, tile, distanceToPedestalFt }) {
  const radius = Number(action.radius) || 10;
  const targets = scene.tokens.filter(t => t.actor && !t.hidden && (t.actor.system.attributes?.hp?.max ?? 0) > 0
    && distanceToPedestalFt(t, tile) <= radius + 0.01);
  const origin = tileCenter(tile);

  if (game.modules.get("sequencer")?.active) {
    const seq = new Sequence();
    if (action.sound) seq.sound().file(action.sound);
    for (const t of targets) {
      if (action.animation) seq.effect().file(action.animation).atLocation(origin).stretchTo(t.object ?? t).delay(Math.random() * 250);
    }
    if (!targets.length && action.animation) seq.effect().file(action.animation).atLocation(origin);
    seq.play();
  }

  const speaker = { alias: action.speaker || "Trap" };
  if (!targets.length) {
    await ChatMessage.create({ speaker, content: `<p><em>${action.flavor || "The trap goes off."}</em></p><p>No one is caught.</p>` });
    return;
  }

  const dmgRoll = action.damage ? await new Roll(String(action.damage)).evaluate() : null;
  if (dmgRoll) await dmgRoll.toMessage({ speaker, flavor: `${action.flavor || "Trap"} — ${action.damageType || ""} damage` });

  const rows = [];
  const status = action.status ? CONFIG.statusEffects.find(s => s.id === action.status) : null;
  for (const t of targets) {
    const actor = t.actor;
    let saveTotal = null, saved = false;
    if (action.ability && action.dc) {
      const rolls = await actor.rollSavingThrow({ ability: action.ability, target: Number(action.dc) },
        { configure: false }, { data: { flavor: `${CONFIG.DND5E.abilities[action.ability]?.label ?? action.ability} save DC ${action.dc} — ${action.flavor || "trap"}` } });
      const roll = Array.isArray(rolls) ? rolls[0] : rolls;
      saveTotal = roll?.total ?? 0;
      saved = saveTotal >= Number(action.dc);
    }
    let dealt = 0;
    if (dmgRoll) {
      dealt = saved ? (action.half ? Math.floor(dmgRoll.total / 2) : 0) : dmgRoll.total;
      if (dealt > 0) await actor.applyDamage([{ value: dealt, type: action.damageType || undefined }]);
    }
    let gotStatus = false;
    if (status && !saved) {
      const immune = actor.system.traits?.ci?.value?.has?.(status.id);
      if (!immune) {
        // Use the system's own condition (so other modules recognize it), then give it the trap's duration.
        await actor.toggleStatusEffect(status.id, { active: true });
        const eff = actor.effects.find(e => e.statuses.has(status.id));
        const secs = Number(action.statusSeconds) || 0;
        if (eff && secs) await eff.update({ "duration.seconds": secs, "duration.startTime": game.time.worldTime, "flags.theia-puzzles.trap": true });
        gotStatus = true;
      }
    }
    rows.push(`<li><b>${foundry.utils.escapeHTML(t.name)}</b>: ${saveTotal !== null ? `save ${saveTotal} — ${saved ? "success" : "failure"}, ` : ""}${dealt} damage${gotStatus ? `, ${game.i18n.localize(status.name)}` : ""}</li>`);
  }
  await ChatMessage.create({ speaker, content: `<p><em>${action.flavor || "The trap goes off."}</em></p><ul>${rows.join("")}</ul>` });
}

export async function runAction(action, ctx) {
  switch (action.type) {
    case "trap": return runTrap(action, ctx);
    case "chat":
      return ChatMessage.create({ speaker: { alias: ctx.def.title }, content: action.text || "",
        whisper: action.gmOnly ? ChatMessage.getWhisperRecipients("GM") : [] });
    case "giveItem": {
      const src = action.uuid ? await fromUuid(action.uuid) : null;
      if (!src || !ctx.actor) return;
      const data = src.toObject();
      delete data._id; delete data.folder; delete data.ownership;
      foundry.utils.setProperty(data, "system.quantity", Number(action.quantity) || 1);
      await ctx.giveItem(ctx.actor, data);
      if (action.text) await ChatMessage.create({ speaker: { alias: ctx.def.title }, content: action.text });
      return;
    }
    case "macro": {
      const macro = game.macros.getName(action.name);
      if (!macro) return ui.notifications.warn(`Theia Puzzles: macro "${action.name}" not found.`);
      return macro.execute({ puzzleId: ctx.puzzleId, scene: ctx.scene, tile: ctx.tile, actor: ctx.actor, token: ctx.tokenDoc, args: action.args, state: ctx.state });
    }
    case "closeWindow":
      return ctx.closeWindows();
  }
}
