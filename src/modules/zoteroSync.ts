import type { ParseMode } from "../utils/prefs";
import { getSyncIncludeImages, getSyncParseResults } from "../utils/prefs";
import { refreshAllMinerUParseStatuses } from "./itemTreeColumn";
import type { StorageAdapter } from "./storage";

/**
 * Tags used to mark the Note/Attachment pair created for a source PDF, so a
 * later push can find and update them instead of creating duplicates, and so
 * an incoming sync can recognize MinerU-managed items on the pull side.
 */
export const MINERU_SYNC_NOTE_TAG = "_mineru-parse-note";
export const MINERU_SYNC_DATA_TAG = "_mineru-parse-data";

/**
 * Every file that makes up a local parse result, copied verbatim into (and
 * back out of) the synced data attachment's storage folder so that folder is
 * a complete, self-sufficient mirror. Files that don't exist locally (e.g. no
 * lite result) are silently skipped by `copyResultFiles`.
 */
const PRECISE_RESULT_FILE_NAMES = [
  "manifest.json",
  "mineru-result.json",
  "boxes.normalized.json",
  "content.md",
];
const LITE_RESULT_FILE_NAMES = ["lite-manifest.json", "lite-content.md"];
const RESULT_FILE_NAMES = [
  ...PRECISE_RESULT_FILE_NAMES,
  ...LITE_RESULT_FILE_NAMES,
];
const IMAGES_DIR_NAME = "images";

/**
 * Minimal view of the source PDF attachment needed to push a parse result to
 * Zotero. Kept narrow (rather than the full `Zotero.Item`) so it stays easy
 * to fake in tests.
 */
export interface ZoteroSyncSourceItem {
  id: number;
  key: string;
  libraryID: number;
  parentItemID?: number | false;
  fileName: string;
}

export interface ZoteroSyncManagedItemRef {
  key: string;
}

export interface ZoteroSyncManagedPair {
  note?: ZoteroSyncManagedItemRef;
  dataAttachment?: ZoteroSyncManagedItemRef;
}

export interface SaveNoteInput {
  source: ZoteroSyncSourceItem;
  existing?: ZoteroSyncManagedItemRef;
  markdown: string;
}

export interface SaveDataAttachmentInput {
  source: ZoteroSyncSourceItem;
  existing?: ZoteroSyncManagedItemRef;
  localDir: string;
  includeImages: boolean;
}

export interface PushResultInput {
  source: ZoteroSyncSourceItem;
  storage: StorageAdapter;
  kind: ParseMode;
}

export interface ZoteroSyncDependencies {
  isSyncEnabled: () => boolean;
  isSyncIncludeImages: () => boolean;
  isLibraryEditable: (libraryID: number) => boolean;
  isLibraryFilesEditable: (libraryID: number) => boolean;
  findManagedItems: (
    source: ZoteroSyncSourceItem,
  ) => Promise<ZoteroSyncManagedPair>;
  saveNote: (input: SaveNoteInput) => Promise<ZoteroSyncManagedItemRef>;
  saveDataAttachment: (
    input: SaveDataAttachmentInput,
  ) => Promise<ZoteroSyncManagedItemRef>;
  /**
   * Resolves a `<libraryID>-<key>` pair from the local result folder to the
   * live source attachment, for the migration pass. Returns null when the
   * item no longer exists (e.g. deleted since it was parsed).
   */
  getSourceItem: (
    libraryID: number,
    key: string,
  ) => Promise<ZoteroSyncSourceItem | null>;
  log: (...args: unknown[]) => void;
}

export interface MigrationSummary {
  migrated: number;
  skippedStandalone: number;
  skippedNoPermission: number;
  skippedMissingItem: number;
  failed: number;
}

export interface ZoteroSync {
  pushResultBestEffort(input: PushResultInput): Promise<void>;
}

export function createZoteroSync(
  dependencies: Partial<ZoteroSyncDependencies> = {},
): ZoteroSync {
  const deps: ZoteroSyncDependencies = {
    ...createDefaultZoteroSyncDependencies(),
    ...dependencies,
  };

  return {
    async pushResultBestEffort(input) {
      try {
        await pushResult(input, deps);
      } catch (error) {
        deps.log("MinerU Zotero sync push failed", {
          attachmentID: input.source.id,
          attachmentKey: input.source.key,
          libraryID: input.source.libraryID,
          kind: input.kind,
          error,
        });
      }
    },
  };
}

/**
 * Convenience wrapper so callers don't need to construct a `ZoteroSync`
 * instance for a single push, mirroring `parseAttachment`'s relationship to
 * `createParseManager`.
 */
export async function pushResultBestEffort(
  input: PushResultInput,
): Promise<void> {
  await createZoteroSync().pushResultBestEffort(input);
}

/**
 * Walks the existing local parse results and pushes each one to Zotero,
 * for users who already had a `mineru-copy` backlog before sync existed.
 * Safe to run more than once: `pushResult` looks up any already-linked
 * Note/attachment before creating a new pair, so re-running just refreshes
 * them instead of duplicating.
 */
export async function migrateLocalResultsToZotero(
  storage: StorageAdapter,
  dependencies: Partial<ZoteroSyncDependencies> = {},
): Promise<MigrationSummary> {
  const deps: ZoteroSyncDependencies = {
    ...createDefaultZoteroSyncDependencies(),
    ...dependencies,
  };
  const summary: MigrationSummary = {
    migrated: 0,
    skippedStandalone: 0,
    skippedNoPermission: 0,
    skippedMissingItem: 0,
    failed: 0,
  };

  if (!deps.isSyncEnabled()) {
    return summary;
  }

  const statuses = await storage.listParseStatuses();
  for (const [dirName, status] of statuses) {
    const ref = parseAttachmentDirName(dirName);
    if (!ref) {
      continue;
    }

    try {
      const source = await deps.getSourceItem(ref.libraryID, ref.key);
      if (!source) {
        summary.skippedMissingItem += 1;
        continue;
      }
      if (!source.parentItemID) {
        summary.skippedStandalone += 1;
        continue;
      }
      if (!deps.isLibraryEditable(source.libraryID)) {
        summary.skippedNoPermission += 1;
        continue;
      }

      await pushResult(
        { source, storage, kind: status.preciseReady ? "precise" : "lite" },
        deps,
      );
      summary.migrated += 1;
    } catch (error) {
      summary.failed += 1;
      deps.log("MinerU Zotero sync migration failed for attachment", {
        dirName,
        error,
      });
    }
  }

  return summary;
}

function parseAttachmentDirName(
  dirName: string,
): { libraryID: number; key: string } | null {
  const match = /^(\d+)-([A-Z0-9]+)$/.exec(dirName);
  if (!match) {
    return null;
  }
  return { libraryID: Number(match[1]), key: match[2] };
}

// ---------------------------------------------------------------------------
// Pull: mirror an incoming synced Note/data-attachment pair back into the
// local `mineru-copy` cache, so the rest of the plugin (which only reads
// from that local folder) picks up results synced in from another computer.
// ---------------------------------------------------------------------------

export interface AttachmentKeyRef {
  libraryID: number;
  key: string;
}

/**
 * Minimal view of a Zotero item needed to decide whether (and how) to pull
 * it, kept narrow so it's easy to fake in tests.
 */
export interface PulledSyncItem extends AttachmentKeyRef {
  isDataAttachment: boolean;
  isManagedNote: boolean;
  relatedItemKeys: string[];
}

export interface ZoteroSyncPullDependencies {
  isSyncEnabled: () => boolean;
  resolveByID: (itemID: number) => Promise<PulledSyncItem | null>;
  resolveByKey: (
    libraryID: number,
    key: string,
  ) => Promise<PulledSyncItem | null>;
  /**
   * Ensures the data attachment's file is downloaded locally (triggering a
   * download if it's currently cloud-only) and returns its storage
   * directory, or null if it isn't available.
   */
  ensureDataAttachmentDownloaded: (
    libraryID: number,
    key: string,
  ) => Promise<string | null>;
  getLocalTargetDir: (ref: AttachmentKeyRef) => string;
  copyBundle: (sourceDir: string, targetDir: string) => Promise<void>;
  onPulled?: (ref: AttachmentKeyRef) => Promise<void>;
  log: (...args: unknown[]) => void;
}

/**
 * Registers a `Zotero.Notifier` observer that watches for MinerU-tagged
 * Notes/attachments arriving via Zotero's own sync and mirrors them into the
 * local cache. Returns an observer id to pass to
 * `unregisterZoteroSyncObserver` later.
 */
export function registerZoteroSyncObserver(
  storage: StorageAdapter,
  dependencies: Partial<ZoteroSyncPullDependencies> = {},
): string {
  const deps: ZoteroSyncPullDependencies = {
    ...createDefaultPullDependencies(storage),
    ...dependencies,
  };

  return Zotero.Notifier.registerObserver(
    {
      notify: async (event, type, ids) => {
        if (type !== "item" || (event !== "add" && event !== "modify")) {
          return;
        }
        for (const rawID of ids) {
          const itemID = Number(rawID);
          if (Number.isFinite(itemID)) {
            await pullManagedItem(itemID, deps);
          }
        }
      },
    },
    ["item"],
    "mineru-zotero-sync",
  );
}

export function unregisterZoteroSyncObserver(observerID: string): void {
  Zotero.Notifier.unregisterObserver(observerID);
}

/**
 * Re-attempts a pull for every known MinerU data attachment. A live
 * `Zotero.Notifier` event only fires once per change, so if a pull was ever
 * skipped as incomplete (the attachment's file finished downloading between
 * notifier events, or the notifier missed it entirely) and nothing about
 * that item changes again, it would otherwise stay stuck forever. Cheap to
 * run on every startup: `pullManagedItem` is a no-op for anything already
 * mirrored correctly.
 */
export async function reconcileZoteroSync(
  storage: StorageAdapter,
  dependencies: Partial<ZoteroSyncPullDependencies> = {},
): Promise<void> {
  const deps: ZoteroSyncPullDependencies = {
    ...createDefaultPullDependencies(storage),
    ...dependencies,
  };
  if (!deps.isSyncEnabled()) {
    return;
  }

  const itemIDs = await findDataAttachmentItemIDs();
  for (const itemID of itemIDs) {
    await pullManagedItem(itemID, deps);
  }
}

async function findDataAttachmentItemIDs(): Promise<number[]> {
  const ids: number[] = [];
  for (const library of Zotero.Libraries.getAll()) {
    const items = await Zotero.Items.getAll(library.libraryID, false, false);
    for (const item of items) {
      if (item.hasTag(MINERU_SYNC_DATA_TAG)) {
        ids.push(item.id);
      }
    }
  }
  return ids;
}

/**
 * Pulls one notified item if it's a MinerU-managed data attachment, best
 * effort (never throws, so a pull failure can't disrupt Zotero's own
 * notifier dispatch to other observers).
 */
export async function pullManagedItem(
  itemID: number,
  deps: ZoteroSyncPullDependencies,
): Promise<void> {
  try {
    await pullManagedItemInner(itemID, deps);
  } catch (error) {
    deps.log("MinerU Zotero sync pull failed", { itemID, error });
  }
}

async function pullManagedItemInner(
  itemID: number,
  deps: ZoteroSyncPullDependencies,
): Promise<void> {
  if (!deps.isSyncEnabled()) {
    return;
  }

  const item = await deps.resolveByID(itemID);
  if (!item || (!item.isDataAttachment && !item.isManagedNote)) {
    return;
  }
  if (!item.isDataAttachment) {
    // Only the Note has arrived so far; it carries no manifest, so there is
    // nothing structural to mirror yet. The data attachment's own add/modify
    // event (when it syncs down) is what actually triggers a pull.
    return;
  }

  const source = await resolveSourceRef(item, deps);
  if (!source) {
    return;
  }

  const storageDir = await deps.ensureDataAttachmentDownloaded(
    item.libraryID,
    item.key,
  );
  if (!storageDir) {
    return;
  }

  const targetDir = deps.getLocalTargetDir(source);
  await deps.copyBundle(storageDir, targetDir);
  await deps.onPulled?.(source);
}

async function resolveSourceRef(
  item: PulledSyncItem,
  deps: ZoteroSyncPullDependencies,
): Promise<AttachmentKeyRef | null> {
  for (const relatedKey of item.relatedItemKeys) {
    const related = await deps.resolveByKey(item.libraryID, relatedKey);
    if (related && !related.isDataAttachment && !related.isManagedNote) {
      return { libraryID: related.libraryID, key: related.key };
    }
  }
  return null;
}

function createDefaultPullDependencies(
  storage: StorageAdapter,
): ZoteroSyncPullDependencies {
  return {
    isSyncEnabled: getSyncParseResults,
    resolveByID: resolveByIDDefault,
    resolveByKey: resolveByKeyDefault,
    ensureDataAttachmentDownloaded: ensureDataAttachmentDownloadedDefault,
    getLocalTargetDir: (ref) => storage.getResolvedAttachmentDir(ref),
    copyBundle: copyBundleDefault,
    onPulled: async () => {
      await refreshAllMinerUParseStatuses();
    },
    log: (...args) => ztoolkit.log(...args),
  };
}

async function resolveByIDDefault(
  itemID: number,
): Promise<PulledSyncItem | null> {
  const item = Zotero.Items.get(itemID);
  return item ? toPulledSyncItem(item) : null;
}

async function resolveByKeyDefault(
  libraryID: number,
  key: string,
): Promise<PulledSyncItem | null> {
  const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
  return item ? toPulledSyncItem(item) : null;
}

function toPulledSyncItem(item: Zotero.Item): PulledSyncItem {
  return {
    libraryID: item.libraryID,
    key: item.key,
    isDataAttachment: item.hasTag(MINERU_SYNC_DATA_TAG),
    isManagedNote: item.hasTag(MINERU_SYNC_NOTE_TAG),
    relatedItemKeys: item.relatedItems ?? [],
  };
}

async function ensureDataAttachmentDownloadedDefault(
  libraryID: number,
  key: string,
): Promise<string | null> {
  const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
  if (!item) {
    return null;
  }
  const path = await item.getFilePathAsync();
  if (!path) {
    return null;
  }
  return Zotero.Attachments.getStorageDirectory(item).path;
}

/**
 * Zotero can surface a data attachment's item record (and even let
 * `getFilePathAsync()` resolve its main file) before every file in that
 * attachment's storage folder has finished downloading — so `manifest.json`
 * can land before its `boxes.normalized.json`/`content.md` siblings. Only
 * copy a result's files (and only write its manifest) once its *complete*
 * set is confirmed present in the source folder, so the local cache never
 * ends up with a manifest claiming "ready" while its data is still missing.
 * An incomplete precise/lite result here is left for a later pull attempt —
 * Zotero fires another `item`/`modify` notification once the download
 * actually finishes, which re-triggers `pullManagedItem`.
 */
export async function copyBundleDefault(
  sourceDir: string,
  targetDir: string,
): Promise<void> {
  const [preciseComplete, liteComplete] = await Promise.all([
    allFilesExist(sourceDir, PRECISE_RESULT_FILE_NAMES),
    allFilesExist(sourceDir, LITE_RESULT_FILE_NAMES),
  ]);
  if (!preciseComplete && !liteComplete) {
    return;
  }

  await IOUtils.makeDirectory(targetDir, {
    createAncestors: true,
    ignoreExisting: true,
  });

  const fileNames = [
    ...(preciseComplete ? PRECISE_RESULT_FILE_NAMES : []),
    ...(liteComplete ? LITE_RESULT_FILE_NAMES : []),
  ];
  await copyResultFiles(sourceDir, targetDir, preciseComplete, fileNames);
}

async function allFilesExist(
  dir: string,
  fileNames: string[],
): Promise<boolean> {
  const results = await Promise.all(
    fileNames.map((fileName) => IOUtils.exists(PathUtils.join(dir, fileName))),
  );
  return results.every(Boolean);
}

async function pushResult(
  input: PushResultInput,
  deps: ZoteroSyncDependencies,
): Promise<void> {
  if (!deps.isSyncEnabled()) {
    return;
  }
  if (!input.source.parentItemID) {
    // Standalone attachments have no parent item to attach a sibling
    // Note/attachment to, so there is nothing to sync them into.
    return;
  }
  if (!deps.isLibraryEditable(input.source.libraryID)) {
    return;
  }

  const markdown = await input.storage.readPreferredMarkdown(input.source);
  if (!markdown.trim()) {
    return;
  }

  const existing = await deps.findManagedItems(input.source);
  await deps.saveNote({
    source: input.source,
    existing: existing.note,
    markdown,
  });

  if (!deps.isLibraryFilesEditable(input.source.libraryID)) {
    return;
  }

  await deps.saveDataAttachment({
    source: input.source,
    existing: existing.dataAttachment,
    localDir: input.storage.getResolvedAttachmentDir(input.source),
    includeImages: deps.isSyncIncludeImages(),
  });
}

function createDefaultZoteroSyncDependencies(): ZoteroSyncDependencies {
  return {
    isSyncEnabled: getSyncParseResults,
    isSyncIncludeImages: getSyncIncludeImages,
    isLibraryEditable: (libraryID) => Zotero.Libraries.isEditable(libraryID),
    isLibraryFilesEditable: (libraryID) =>
      Zotero.Libraries.isFilesEditable(libraryID),
    findManagedItems: findManagedItemsDefault,
    saveNote: saveNoteDefault,
    saveDataAttachment: saveDataAttachmentDefault,
    getSourceItem: getSourceItemDefault,
    log: (...args) => ztoolkit.log(...args),
  };
}

async function getSourceItemDefault(
  libraryID: number,
  key: string,
): Promise<ZoteroSyncSourceItem | null> {
  const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
  if (!item) {
    return null;
  }
  return {
    id: item.id,
    key: item.key,
    libraryID: item.libraryID,
    parentItemID: item.parentItemID,
    fileName: item.attachmentFilename || item.key,
  };
}

async function findManagedItemsDefault(
  source: ZoteroSyncSourceItem,
): Promise<ZoteroSyncManagedPair> {
  const sourceItem = await Zotero.Items.getByLibraryAndKeyAsync(
    source.libraryID,
    source.key,
  );
  if (!sourceItem) {
    return {};
  }

  const result: ZoteroSyncManagedPair = {};
  for (const relatedKey of sourceItem.relatedItems ?? []) {
    if (result.note && result.dataAttachment) {
      break;
    }
    const related = await Zotero.Items.getByLibraryAndKeyAsync(
      source.libraryID,
      relatedKey,
    );
    if (!related) {
      continue;
    }
    if (!result.note && related.hasTag(MINERU_SYNC_NOTE_TAG)) {
      result.note = { key: related.key };
    }
    if (!result.dataAttachment && related.hasTag(MINERU_SYNC_DATA_TAG)) {
      result.dataAttachment = { key: related.key };
    }
  }
  return result;
}

async function saveNoteDefault(
  input: SaveNoteInput,
): Promise<ZoteroSyncManagedItemRef> {
  const html = buildNoteHtml(input.source, input.markdown);

  if (input.existing) {
    const item = await Zotero.Items.getByLibraryAndKeyAsync(
      input.source.libraryID,
      input.existing.key,
    );
    if (item) {
      item.setNote(html);
      await item.saveTx();
      return { key: item.key };
    }
  }

  const note = new Zotero.Item("note");
  note.libraryID = input.source.libraryID;
  note.parentItemID = input.source.parentItemID as number;
  note.setNote(html);
  note.addTag(MINERU_SYNC_NOTE_TAG);
  await note.saveTx();

  await linkToSource(input.source, note);
  return { key: note.key };
}

async function saveDataAttachmentDefault(
  input: SaveDataAttachmentInput,
): Promise<ZoteroSyncManagedItemRef> {
  if (input.existing) {
    const item = await Zotero.Items.getByLibraryAndKeyAsync(
      input.source.libraryID,
      input.existing.key,
    );
    if (item) {
      await copyResultFiles(
        input.localDir,
        Zotero.Attachments.getStorageDirectory(item).path,
        input.includeImages,
      );
      return { key: item.key };
    }
  }

  const manifestPath = await resolvePrimaryLocalFile(input.localDir);
  const item = await Zotero.Attachments.importFromFile({
    file: manifestPath,
    parentItemID: input.source.parentItemID as number,
    libraryID: input.source.libraryID,
    title: `MinerU parse data: ${input.source.fileName}`,
    contentType: "application/json",
  });
  item.addTag(MINERU_SYNC_DATA_TAG);
  await item.saveTx();

  await copyResultFiles(
    input.localDir,
    Zotero.Attachments.getStorageDirectory(item).path,
    input.includeImages,
  );
  await linkToSource(input.source, item);
  return { key: item.key };
}

async function linkToSource(
  source: ZoteroSyncSourceItem,
  managed: Zotero.Item,
): Promise<void> {
  const sourceItem = await Zotero.Items.getByLibraryAndKeyAsync(
    source.libraryID,
    source.key,
  );
  if (!sourceItem) {
    return;
  }
  sourceItem.addRelatedItem(managed);
  managed.addRelatedItem(sourceItem);
  await sourceItem.saveTx();
  await managed.saveTx();
}

/**
 * The synced attachment's main file has to be a real, already-existing local
 * file. `manifest.json` only exists once a precise result has been written,
 * so a lite-only result falls back to `lite-manifest.json` — by the time
 * this runs, `pushResult` has already confirmed some markdown is readable,
 * which guarantees at least one of the two exists.
 */
async function resolvePrimaryLocalFile(localDir: string): Promise<string> {
  const precisePath = PathUtils.join(localDir, "manifest.json");
  if (await IOUtils.exists(precisePath)) {
    return precisePath;
  }
  return PathUtils.join(localDir, "lite-manifest.json");
}

async function copyResultFiles(
  sourceDir: string,
  targetDir: string,
  includeImages: boolean,
  fileNames: string[] = RESULT_FILE_NAMES,
): Promise<void> {
  for (const fileName of fileNames) {
    const sourcePath = PathUtils.join(sourceDir, fileName);
    if (await IOUtils.exists(sourcePath)) {
      await IOUtils.copy(sourcePath, PathUtils.join(targetDir, fileName));
    }
  }

  if (!includeImages) {
    return;
  }
  const imagesSourceDir = PathUtils.join(sourceDir, IMAGES_DIR_NAME);
  if (await IOUtils.exists(imagesSourceDir)) {
    await IOUtils.copy(
      imagesSourceDir,
      PathUtils.join(targetDir, IMAGES_DIR_NAME),
      {
        recursive: true,
      },
    );
  }
}

// Zotero's sync backend rejects notes whose HTML content (markup included)
// exceeds ~250,000 characters ("Note is too long to sync"). Stay well under
// that so escaping overhead and future edits to the wrapper HTML can't tip a
// borderline note over the real server-side limit. The data attachment (see
// `saveDataAttachmentDefault`) always carries the untruncated markdown, so
// truncating this preview loses nothing sync-relevant.
const NOTE_SYNC_SAFE_LENGTH = 200_000;
const NOTE_TRUNCATION_NOTICE =
  '\n\n[Note truncated: this preview is capped to stay under Zotero\'s sync size limit. The full parse result is stored in the linked "MinerU parse data" attachment.]';

export function buildNoteHtml(
  source: ZoteroSyncSourceItem,
  markdown: string,
): string {
  // Zotero derives a note's displayed name from the first line of its own
  // content — there is no separate title field — so the visible heading must
  // come first. The hidden marker div goes after it; if it came first, its
  // empty text would become (or blank out) the note's displayed name.
  const title = `<p><strong>MinerU parse: ${escapeHtml(source.fileName)}</strong></p>`;
  const marker =
    `<div data-mineru-sync-source-library-id="${source.libraryID}" ` +
    `data-mineru-sync-source-key="${escapeHtml(source.key)}" ` +
    `style="display:none"></div>`;
  const wrapperLength =
    title.length + marker.length + "<pre>".length + "</pre>".length;
  const body = `<pre>${buildNoteBody(wrapperLength, escapeHtml(markdown))}</pre>`;
  return `${title}${marker}${body}`;
}

/**
 * Fits the escaped markdown into whatever room is left after `wrapperLength`
 * (title + marker + `<pre>`/`</pre>`) under `NOTE_SYNC_SAFE_LENGTH`,
 * truncating with a pointer to the full-fidelity data attachment when it
 * doesn't fit. Truncating the already-escaped string keeps the budget exact
 * against Zotero's real (markup-inclusive) limit; a cut landing mid-entity is
 * a harmless cosmetic wrinkle in a `<pre>` preview.
 */
function buildNoteBody(wrapperLength: number, escapedMarkdown: string): string {
  if (wrapperLength + escapedMarkdown.length <= NOTE_SYNC_SAFE_LENGTH) {
    return escapedMarkdown;
  }
  const bodyBudget =
    NOTE_SYNC_SAFE_LENGTH - wrapperLength - NOTE_TRUNCATION_NOTICE.length;
  return (
    escapedMarkdown.slice(0, Math.max(bodyBudget, 0)) + NOTE_TRUNCATION_NOTICE
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
