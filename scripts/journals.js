// Theia Puzzles — journal pages found with Unboxing the Mystery are shown to every player.
// Unboxing grants a found page to the user who opened the tile only, and the journal itself usually stays hidden, so
// the page can't be opened at all. When a page linked by an Unboxing tile is granted to a player, the GM shares that
// page with everyone, makes its journal Limited (so it shows up) and closes the journal's other pages explicitly, so
// nothing that hasn't been found is revealed.

const MODULE_ID = "theia-puzzles";
const { NONE, LIMITED, OBSERVER } = CONST.DOCUMENT_OWNERSHIP_LEVELS;

const isActiveGM = () => game.user.isGM && game.users.activeGM?.isSelf;

/** Uuids of the journal pages linked by Unboxing tiles, in every scene. */
function unboxingPages() {
  const out = new Set();
  for (const scene of game.scenes) for (const tile of scene.tiles) {
    const f = tile.flags?.["unboxing-mystery"] ?? {};
    for (const j of f.tileLinkedJournals ?? []) if (j?.uuid) out.add(j.uuid);
    if (f.linkedDocumentUuid && /JournalEntryPage/.test(f.linkedDocumentUuid)) out.add(f.linkedDocumentUuid);
  }
  return out;
}

/** Share one page with every player; the journal becomes Limited with its other pages closed. */
export async function sharePage(page) {
  const entry = page.parent;
  if (!entry) return false;
  if ((entry.ownership.default ?? NONE) < LIMITED) {
    // pages left on "inherit" would otherwise show as Limited too
    const closed = entry.pages.filter(p => p.id !== page.id && (p.ownership.default ?? -1) < NONE).map(p => ({ _id: p.id, "ownership.default": NONE }));
    if (closed.length) await entry.updateEmbeddedDocuments("JournalEntryPage", closed);
    await entry.update({ "ownership.default": LIMITED });
  }
  if ((page.ownership.default ?? -1) < OBSERVER) await page.update({ "ownership.default": OBSERVER });
  return true;
}

export function registerJournals() {
  game.settings.register(MODULE_ID, "sharePages", {
    name: "Unboxing: share found journal pages with everyone",
    hint: "When Unboxing the Mystery reveals a journal page to a player, show that page (only that page) to every player. Its journal becomes Limited and its unfound pages stay hidden.",
    scope: "world", config: true, type: Boolean, default: true
  });
  Hooks.on("updateJournalEntryPage", (page, changes) => {
    if (!isActiveGM() || !changes.ownership || !game.settings.get(MODULE_ID, "sharePages")) return;
    const toPlayer = Object.entries(page.ownership).some(([id, lvl]) => id !== "default" && lvl >= OBSERVER && game.users.get(id) && !game.users.get(id).isGM);
    if (!toPlayer || (page.ownership.default ?? -1) >= OBSERVER) return;
    if (!unboxingPages().has(page.uuid)) return;
    sharePage(page).catch(err => console.error(`${MODULE_ID} | share page`, err));
  });
}
