import { assert } from "chai";
import {
  buildNoteHtml,
  copyBundleDefault,
  createZoteroSync,
  migrateLocalResultsToZotero,
  pullManagedItem,
  type PulledSyncItem,
  type PushResultInput,
  type SaveDataAttachmentInput,
  type SaveNoteInput,
  type ZoteroSyncDependencies,
  type ZoteroSyncPullDependencies,
  type ZoteroSyncSourceItem,
} from "../src/modules/zoteroSync";

describe("zoteroSync", function () {
  describe("buildNoteHtml", function () {
    it("puts the visible title before the hidden marker div", function () {
      // Zotero derives a note's displayed name from the first line of its
      // own content (there is no separate title field). A leading
      // empty/hidden element there blanks out the name Zotero shows in the
      // items list.
      const html = buildNoteHtml(
        {
          id: 1,
          key: "ABC123",
          libraryID: 12,
          parentItemID: 99,
          fileName: "paper.pdf",
        },
        "# hello",
      );

      const titleIndex = html.indexOf("MinerU parse: paper.pdf");
      const markerIndex = html.indexOf("data-mineru-sync-source-key");
      assert.isAtLeast(titleIndex, 0);
      assert.isAtLeast(markerIndex, 0);
      assert.isBelow(titleIndex, markerIndex);
    });
  });

  describe("pushResultBestEffort", function () {
    it("does nothing when sync is disabled", async function () {
      const calls = createCallLog();
      const sync = createZoteroSync(
        fakeDependencies(calls, { isSyncEnabled: () => false }),
      );

      await sync.pushResultBestEffort(pushInput());

      assert.deepEqual(calls.saveNote, []);
      assert.deepEqual(calls.saveDataAttachment, []);
    });

    it("skips standalone attachments with no parent item", async function () {
      const calls = createCallLog();
      const sync = createZoteroSync(fakeDependencies(calls));

      await sync.pushResultBestEffort(
        pushInput({ source: source({ parentItemID: false }) }),
      );

      assert.deepEqual(calls.saveNote, []);
      assert.deepEqual(calls.saveDataAttachment, []);
    });

    it("skips libraries the user cannot edit", async function () {
      const calls = createCallLog();
      const sync = createZoteroSync(
        fakeDependencies(calls, { isLibraryEditable: () => false }),
      );

      await sync.pushResultBestEffort(pushInput());

      assert.deepEqual(calls.saveNote, []);
      assert.deepEqual(calls.saveDataAttachment, []);
    });

    it("skips empty markdown without creating a note", async function () {
      const calls = createCallLog();
      const sync = createZoteroSync(fakeDependencies(calls));

      await sync.pushResultBestEffort(
        pushInput({ storage: fakeStorage({ markdown: "   " }) }),
      );

      assert.deepEqual(calls.saveNote, []);
    });

    it("syncs both the note and data attachment for lite results too", async function () {
      // The data attachment mirrors whatever local files exist
      // (manifest.json OR lite-manifest.json), so lite-only results still
      // get a bundle synced — this is what makes the pull path able to
      // reconstruct them elsewhere.
      const calls = createCallLog();
      const sync = createZoteroSync(fakeDependencies(calls));

      await sync.pushResultBestEffort(pushInput({ kind: "lite" }));

      assert.equal(calls.saveNote.length, 1);
      assert.equal(calls.saveDataAttachment.length, 1);
    });

    it("syncs both the note and the data attachment for precise results", async function () {
      const calls = createCallLog();
      const sync = createZoteroSync(
        fakeDependencies(calls, { isSyncIncludeImages: () => true }),
      );

      await sync.pushResultBestEffort(
        pushInput({
          storage: fakeStorage({
            dir: "/tmp/mineru-copy/attachments/12-ABC123",
          }),
        }),
      );

      assert.equal(calls.saveNote.length, 1);
      assert.equal(calls.saveNote[0].markdown, "# parsed content");
      assert.equal(calls.saveDataAttachment.length, 1);
      assert.equal(
        calls.saveDataAttachment[0].localDir,
        "/tmp/mineru-copy/attachments/12-ABC123",
      );
      assert.isTrue(calls.saveDataAttachment[0].includeImages);
    });

    it("skips the data attachment when files are not editable", async function () {
      const calls = createCallLog();
      const sync = createZoteroSync(
        fakeDependencies(calls, { isLibraryFilesEditable: () => false }),
      );

      await sync.pushResultBestEffort(pushInput());

      assert.equal(calls.saveNote.length, 1);
      assert.deepEqual(calls.saveDataAttachment, []);
    });

    it("passes through existing managed item refs so updates reuse them", async function () {
      const calls = createCallLog();
      const sync = createZoteroSync(
        fakeDependencies(calls, {
          findManagedItems: async () => ({
            note: { key: "NOTE1" },
            dataAttachment: { key: "DATA1" },
          }),
        }),
      );

      await sync.pushResultBestEffort(pushInput());

      assert.equal(calls.saveNote[0].existing?.key, "NOTE1");
      assert.equal(calls.saveDataAttachment[0].existing?.key, "DATA1");
    });

    it("swallows errors from dependencies and logs them instead of throwing", async function () {
      const logs: unknown[][] = [];
      const sync = createZoteroSync({
        isSyncEnabled: () => true,
        isSyncIncludeImages: () => false,
        isLibraryEditable: () => true,
        isLibraryFilesEditable: () => true,
        findManagedItems: async () => ({}),
        saveNote: async () => {
          throw new Error("boom");
        },
        saveDataAttachment: async () => ({ key: "DATA1" }),
        log: (...args) => logs.push(args),
      });

      await sync.pushResultBestEffort(pushInput());

      assert.equal(logs.length, 1);
    });
  });

  describe("migrateLocalResultsToZotero", function () {
    it("does nothing when sync is disabled", async function () {
      const calls = createCallLog();
      const summary = await migrateLocalResultsToZotero(
        fakeMigrationStorage({
          "12-ABC123": { preciseReady: true, liteReady: false },
        }),
        {
          ...fakeDependencies(calls),
          isSyncEnabled: () => false,
          getSourceItem: async () => source(),
        },
      );

      assert.deepEqual(summary, {
        migrated: 0,
        skippedStandalone: 0,
        skippedNoPermission: 0,
        skippedMissingItem: 0,
        failed: 0,
      });
      assert.deepEqual(calls.saveNote, []);
    });

    it("migrates a ready precise result and syncs both the note and data attachment", async function () {
      const calls = createCallLog();
      const summary = await migrateLocalResultsToZotero(
        fakeMigrationStorage({
          "12-ABC123": { preciseReady: true, liteReady: false },
        }),
        {
          ...fakeDependencies(calls),
          getSourceItem: async (libraryID, key) => source({ libraryID, key }),
        },
      );

      assert.equal(summary.migrated, 1);
      assert.equal(calls.saveNote.length, 1);
      assert.equal(calls.saveDataAttachment.length, 1);
    });

    it("syncs both the note and data attachment when only a lite result is ready", async function () {
      const calls = createCallLog();
      const summary = await migrateLocalResultsToZotero(
        fakeMigrationStorage({
          "12-ABC123": { preciseReady: false, liteReady: true },
        }),
        {
          ...fakeDependencies(calls),
          getSourceItem: async (libraryID, key) => source({ libraryID, key }),
        },
      );

      assert.equal(summary.migrated, 1);
      assert.equal(calls.saveNote.length, 1);
      assert.equal(calls.saveDataAttachment.length, 1);
    });

    it("counts standalone attachments as skipped", async function () {
      const calls = createCallLog();
      const summary = await migrateLocalResultsToZotero(
        fakeMigrationStorage({
          "12-ABC123": { preciseReady: true, liteReady: false },
        }),
        {
          ...fakeDependencies(calls),
          getSourceItem: async () => source({ parentItemID: false }),
        },
      );

      assert.equal(summary.skippedStandalone, 1);
      assert.equal(summary.migrated, 0);
    });

    it("counts libraries without edit permission as skipped", async function () {
      const calls = createCallLog();
      const summary = await migrateLocalResultsToZotero(
        fakeMigrationStorage({
          "12-ABC123": { preciseReady: true, liteReady: false },
        }),
        {
          ...fakeDependencies(calls),
          isLibraryEditable: () => false,
          getSourceItem: async (libraryID, key) => source({ libraryID, key }),
        },
      );

      assert.equal(summary.skippedNoPermission, 1);
      assert.equal(summary.migrated, 0);
    });

    it("counts items that no longer exist as skipped", async function () {
      const calls = createCallLog();
      const summary = await migrateLocalResultsToZotero(
        fakeMigrationStorage({
          "12-ABC123": { preciseReady: true, liteReady: false },
        }),
        {
          ...fakeDependencies(calls),
          getSourceItem: async () => null,
        },
      );

      assert.equal(summary.skippedMissingItem, 1);
      assert.equal(summary.migrated, 0);
    });

    it("counts a failure without stopping the rest of the migration", async function () {
      const calls = createCallLog();
      const summary = await migrateLocalResultsToZotero(
        fakeMigrationStorage({
          "12-BAD001": { preciseReady: true, liteReady: false },
          "12-GOOD01": { preciseReady: true, liteReady: false },
        }),
        {
          ...fakeDependencies(calls),
          getSourceItem: async (libraryID, key) => {
            if (key === "BAD001") {
              throw new Error("boom");
            }
            return source({ libraryID, key });
          },
        },
      );

      assert.equal(summary.failed, 1);
      assert.equal(summary.migrated, 1);
    });

    it("ignores malformed directory names", async function () {
      const calls = createCallLog();
      const summary = await migrateLocalResultsToZotero(
        fakeMigrationStorage({
          "not-a-valid-dir": { preciseReady: true, liteReady: false },
        }),
        {
          ...fakeDependencies(calls),
          getSourceItem: async (libraryID, key) => source({ libraryID, key }),
        },
      );

      assert.deepEqual(summary, {
        migrated: 0,
        skippedStandalone: 0,
        skippedNoPermission: 0,
        skippedMissingItem: 0,
        failed: 0,
      });
    });

    it("re-running migration updates existing items instead of duplicating", async function () {
      const calls = createCallLog();
      const deps = {
        ...fakeDependencies(calls),
        findManagedItems: async () => ({
          note: { key: "NOTE1" },
          dataAttachment: { key: "DATA1" },
        }),
        getSourceItem: async (libraryID: number, key: string) =>
          source({ libraryID, key }),
      };

      await migrateLocalResultsToZotero(
        fakeMigrationStorage({
          "12-ABC123": { preciseReady: true, liteReady: false },
        }),
        deps,
      );

      assert.equal(calls.saveNote[0].existing?.key, "NOTE1");
      assert.equal(calls.saveDataAttachment[0].existing?.key, "DATA1");
    });
  });

  describe("pullManagedItem", function () {
    it("does nothing when sync is disabled", async function () {
      const calls = createPullCallLog();
      await pullManagedItem(
        1,
        fakePullDependencies(calls, {
          isSyncEnabled: () => false,
          resolveByID: async () => pulledItem({ isDataAttachment: true }),
        }),
      );

      assert.deepEqual(calls.copyBundle, []);
    });

    it("ignores items with no MinerU tags", async function () {
      const calls = createPullCallLog();
      await pullManagedItem(
        1,
        fakePullDependencies(calls, {
          resolveByID: async () => pulledItem({}),
        }),
      );

      assert.deepEqual(calls.copyBundle, []);
    });

    it("does nothing yet when only the note has arrived", async function () {
      const calls = createPullCallLog();
      await pullManagedItem(
        1,
        fakePullDependencies(calls, {
          resolveByID: async () => pulledItem({ isManagedNote: true }),
        }),
      );

      assert.deepEqual(calls.copyBundle, []);
    });

    it("pulls the data attachment bundle into the local target dir", async function () {
      const calls = createPullCallLog();
      await pullManagedItem(
        1,
        fakePullDependencies(calls, {
          resolveByID: async () =>
            pulledItem({ isDataAttachment: true, relatedItemKeys: ["SRC1"] }),
          resolveByKey: async (libraryID, key) =>
            key === "SRC1" ? pulledItem({ key: "SRC1", libraryID }) : null,
          ensureDataAttachmentDownloaded: async () =>
            "/tmp/zotero-storage/DATA1",
        }),
      );

      assert.deepEqual(calls.copyBundle, [
        {
          sourceDir: "/tmp/zotero-storage/DATA1",
          targetDir: "/tmp/local/12-SRC1",
        },
      ]);
      assert.deepEqual(calls.onPulled, [{ libraryID: 12, key: "SRC1" }]);
    });

    it("skips related items that are themselves note/data-attachment tagged", async function () {
      const calls = createPullCallLog();
      await pullManagedItem(
        1,
        fakePullDependencies(calls, {
          resolveByID: async () =>
            pulledItem({
              isDataAttachment: true,
              relatedItemKeys: ["NOTE1", "SRC1"],
            }),
          resolveByKey: async (libraryID, key) => {
            if (key === "NOTE1") {
              return pulledItem({
                key: "NOTE1",
                libraryID,
                isManagedNote: true,
              });
            }
            if (key === "SRC1") {
              return pulledItem({ key: "SRC1", libraryID });
            }
            return null;
          },
          ensureDataAttachmentDownloaded: async () =>
            "/tmp/zotero-storage/DATA1",
        }),
      );

      assert.equal(calls.copyBundle.length, 1);
      assert.deepEqual(calls.onPulled, [{ libraryID: 12, key: "SRC1" }]);
    });

    it("does nothing when the source item can't be resolved via relations", async function () {
      const calls = createPullCallLog();
      await pullManagedItem(
        1,
        fakePullDependencies(calls, {
          resolveByID: async () =>
            pulledItem({ isDataAttachment: true, relatedItemKeys: [] }),
        }),
      );

      assert.deepEqual(calls.copyBundle, []);
    });

    it("does nothing when the file can't be downloaded", async function () {
      const calls = createPullCallLog();
      await pullManagedItem(
        1,
        fakePullDependencies(calls, {
          resolveByID: async () =>
            pulledItem({ isDataAttachment: true, relatedItemKeys: ["SRC1"] }),
          resolveByKey: async (libraryID, key) =>
            key === "SRC1" ? pulledItem({ key: "SRC1", libraryID }) : null,
          ensureDataAttachmentDownloaded: async () => null,
        }),
      );

      assert.deepEqual(calls.copyBundle, []);
    });

    it("swallows errors and logs them instead of throwing", async function () {
      const logs: unknown[][] = [];
      await pullManagedItem(1, {
        isSyncEnabled: () => true,
        resolveByID: async () => {
          throw new Error("boom");
        },
        resolveByKey: async () => null,
        ensureDataAttachmentDownloaded: async () => null,
        getLocalTargetDir: () => "",
        copyBundle: async () => {},
        log: (...args) => logs.push(args),
      });

      assert.equal(logs.length, 1);
    });
  });

  describe("copyBundleDefault", function () {
    // Regression coverage for the bug where a data attachment's item record
    // (and even its main file) could be visible before every file in its
    // storage folder had finished downloading — previously this copied
    // `manifest.json` alone, so the local cache claimed "ready" with no
    // boxes/content actually present.
    it("copies nothing when the source has only a partial precise result", async function () {
      const source = await makeScratchDir();
      const target = await makeScratchDir();
      await writeScratchFile(source, "manifest.json", '{"status":"ready"}');
      // boxes.normalized.json and content.md are "still downloading".

      await copyBundleDefault(source, target);

      assert.isFalse(await scratchFileExists(target, "manifest.json"));
      assert.isFalse(await scratchFileExists(target, "boxes.normalized.json"));
    });

    it("copies the full precise bundle once every file is present", async function () {
      const source = await makeScratchDir();
      const target = await makeScratchDir();
      await writeScratchFile(source, "manifest.json", '{"status":"ready"}');
      await writeScratchFile(source, "mineru-result.json", "{}");
      await writeScratchFile(source, "boxes.normalized.json", "[]");
      await writeScratchFile(source, "content.md", "# hi");

      await copyBundleDefault(source, target);

      for (const name of [
        "manifest.json",
        "mineru-result.json",
        "boxes.normalized.json",
        "content.md",
      ]) {
        assert.isTrue(await scratchFileExists(target, name), name);
      }
    });

    it("copies a complete lite bundle even while the precise bundle is still partial", async function () {
      const source = await makeScratchDir();
      const target = await makeScratchDir();
      await writeScratchFile(source, "manifest.json", '{"status":"ready"}');
      // precise is incomplete (no boxes/content), but lite is fully present.
      await writeScratchFile(
        source,
        "lite-manifest.json",
        '{"status":"ready"}',
      );
      await writeScratchFile(source, "lite-content.md", "# lite");

      await copyBundleDefault(source, target);

      assert.isFalse(await scratchFileExists(target, "manifest.json"));
      assert.isTrue(await scratchFileExists(target, "lite-manifest.json"));
      assert.isTrue(await scratchFileExists(target, "lite-content.md"));
    });
  });
});

function source(
  overrides?: Partial<ZoteroSyncSourceItem>,
): ZoteroSyncSourceItem {
  return {
    id: 1,
    key: "ABC123",
    libraryID: 12,
    parentItemID: 99,
    fileName: "a.pdf",
    ...overrides,
  };
}

function fakeStorage(options?: {
  markdown?: string;
  dir?: string;
}): PushResultInput["storage"] {
  return {
    getResolvedAttachmentDir: () =>
      options?.dir ?? "/tmp/mineru-copy/attachments/12-ABC123",
    readPreferredMarkdown: async () => options?.markdown ?? "# parsed content",
  } as unknown as PushResultInput["storage"];
}

function fakeMigrationStorage(
  statuses: Record<string, { preciseReady: boolean; liteReady: boolean }>,
): PushResultInput["storage"] {
  return {
    ...fakeStorage(),
    listParseStatuses: async () => new Map(Object.entries(statuses)),
  } as unknown as PushResultInput["storage"];
}

function pushInput(overrides?: Partial<PushResultInput>): PushResultInput {
  return {
    source: source(),
    storage: fakeStorage(),
    kind: "precise",
    ...overrides,
  };
}

interface CallLog {
  saveNote: SaveNoteInput[];
  saveDataAttachment: SaveDataAttachmentInput[];
}

function createCallLog(): CallLog {
  return { saveNote: [], saveDataAttachment: [] };
}

function fakeDependencies(
  calls: CallLog,
  overrides?: Partial<ZoteroSyncDependencies>,
): Partial<ZoteroSyncDependencies> {
  return {
    isSyncEnabled: () => true,
    isSyncIncludeImages: () => false,
    isLibraryEditable: () => true,
    isLibraryFilesEditable: () => true,
    findManagedItems: async () => ({}),
    saveNote: async (input) => {
      calls.saveNote.push(input);
      return { key: "NOTE1" };
    },
    saveDataAttachment: async (input) => {
      calls.saveDataAttachment.push(input);
      return { key: "DATA1" };
    },
    log: () => {},
    ...overrides,
  };
}

async function makeScratchDir(): Promise<string> {
  const dir = PathUtils.join(
    PathUtils.tempDir,
    `mineru-sync-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await IOUtils.makeDirectory(dir, {
    createAncestors: true,
    ignoreExisting: true,
  });
  return dir;
}

async function writeScratchFile(
  dir: string,
  name: string,
  content: string,
): Promise<void> {
  await IOUtils.writeUTF8(PathUtils.join(dir, name), content);
}

async function scratchFileExists(dir: string, name: string): Promise<boolean> {
  return IOUtils.exists(PathUtils.join(dir, name));
}

function pulledItem(overrides: Partial<PulledSyncItem>): PulledSyncItem {
  return {
    libraryID: 12,
    key: "ITEM1",
    isDataAttachment: false,
    isManagedNote: false,
    relatedItemKeys: [],
    ...overrides,
  };
}

interface PullCallLog {
  copyBundle: Array<{ sourceDir: string; targetDir: string }>;
  onPulled: Array<{ libraryID: number; key: string }>;
}

function createPullCallLog(): PullCallLog {
  return { copyBundle: [], onPulled: [] };
}

function fakePullDependencies(
  calls: PullCallLog,
  overrides?: Partial<ZoteroSyncPullDependencies>,
): ZoteroSyncPullDependencies {
  return {
    isSyncEnabled: () => true,
    resolveByID: async () => null,
    resolveByKey: async () => null,
    ensureDataAttachmentDownloaded: async () => null,
    getLocalTargetDir: (ref) => `/tmp/local/${ref.libraryID}-${ref.key}`,
    copyBundle: async (sourceDir, targetDir) => {
      calls.copyBundle.push({ sourceDir, targetDir });
    },
    onPulled: async (ref) => {
      calls.onPulled.push(ref);
    },
    log: () => {},
    ...overrides,
  };
}
