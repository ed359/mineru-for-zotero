import { requestJson, requestOk } from "./api";
import { MinerUTaskError } from "./errors";
import { buildLocalTaskFormData } from "./formData";
import { readImagesFromZip } from "./result";
import type {
  FetchLike,
  MinerUParseMode,
  MinerUParseResult,
  ZipEntries,
} from "./types";
import { decodeText, readZipWithFileFallback } from "./zip";

/**
 * MinerU 3.x 本地 API（`/health`、multipart `/tasks`）的请求实现。
 * MinerU 4.x 改为 `/v1/*` JSON 任务接口，见 `localV1.ts`。
 */

type LegacyTaskResponse = {
  task_id?: string;
  taskId?: string;
  status?: string;
  message?: string;
};

type LegacyResultResponse = {
  results?: Record<
    string,
    {
      md_content?: string;
      middle_json?: unknown;
      content_list?: unknown;
      images?: Record<string, string>;
    }
  >;
};

export interface LegacyLocalContext {
  baseURL: string;
  request: FetchLike;
  mode: MinerUParseMode;
  saveImages: boolean;
}

/**
 * 以 multipart/form-data 提交 MinerU 3.x 本地异步任务。
 */
export async function submitLegacyLocalTask(
  context: LegacyLocalContext,
  bytes: Uint8Array,
  filePath: string,
): Promise<string> {
  const multipart = buildLocalTaskFormData({
    filePath,
    bytes,
    mode: context.mode,
    saveImages: context.saveImages,
  });
  const response = await requestJson<LegacyTaskResponse>(
    context.request,
    `${context.baseURL}/tasks`,
    "local-submit",
    {
      method: "POST",
      headers: {
        "Content-Type": multipart.contentType,
      },
      body: multipart.body,
    },
  );
  const taskID = response.task_id ?? response.taskId;
  if (!taskID) {
    throw new MinerUTaskError("Local MinerU submit response missing task_id");
  }
  return taskID;
}

/**
 * 轮询 MinerU 3.x 本地任务状态，并转换为统一任务状态。
 */
export async function pollLegacyLocalTask(
  context: LegacyLocalContext,
  taskID: string,
): Promise<{ status: "running" | "succeeded" | "failed"; error?: string }> {
  const response = await requestJson<LegacyTaskResponse>(
    context.request,
    `${context.baseURL}/tasks/${encodeURIComponent(taskID)}`,
    "local-poll",
    { method: "GET" },
  );
  const status = String(response.status ?? "").toLowerCase();
  if (
    ["done", "success", "succeeded", "finished", "completed"].includes(status)
  ) {
    return { status: "succeeded" };
  }
  if (["failed", "fail", "error"].includes(status)) {
    return {
      status: "failed",
      error: response.message || "Local MinerU task failed",
    };
  }
  return { status: "running" };
}

/**
 * 下载 MinerU 3.x 本地任务结果，并按 precise/lite 模式转换为统一结果。
 */
export async function downloadLegacyLocalResult(
  context: LegacyLocalContext,
  taskID: string,
): Promise<MinerUParseResult> {
  const response = await requestOk(
    context.request,
    `${context.baseURL}/tasks/${encodeURIComponent(taskID)}/result`,
    "local-download",
    { method: "GET" },
  );
  const contentType = response.headers.get("Content-Type") ?? "";
  if (isZipResponse(contentType)) {
    const zip = await readZipWithFileFallback(
      await response.arrayBuffer(),
      "mineru-local-result.zip",
    );
    const markdown = readLegacyZipMarkdown(zip);
    if (context.mode === "lite") {
      return { kind: "lite", markdown };
    }
    return {
      kind: "precise",
      markdown,
      rawResult: readLegacyZipRawResult(zip),
      images: readImagesFromZip(zip),
    };
  }

  const json = (await response.json()) as LegacyResultResponse;
  const result = firstLegacyResult(json);
  const markdown = result.md_content ?? "";
  if (context.mode === "lite") {
    return { kind: "lite", markdown };
  }
  return {
    kind: "precise",
    markdown,
    rawResult: parseMaybeJson(
      result.middle_json ?? result.content_list ?? json,
    ),
    images: decodeDataURLImages(result.images),
  };
}

function firstLegacyResult(response: LegacyResultResponse) {
  return Object.values(response.results ?? {})[0] ?? {};
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function decodeDataURLImages(
  images: Record<string, string> | undefined,
): { path: string; bytes: Uint8Array }[] | undefined {
  if (!images) {
    return undefined;
  }
  const decoded = Object.entries(images).flatMap(([path, value]) => {
    const comma = value.indexOf(",");
    if (comma === -1) {
      return [];
    }
    const binary = decodeBase64(value.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return [{ path, bytes }];
  });
  return decoded.length > 0 ? decoded : undefined;
}

function decodeBase64(value: string): string {
  const runtime = globalThis as typeof globalThis & {
    atob?: (data: string) => string;
    Buffer?: { from: (data: string, encoding: "base64") => Uint8Array };
  };
  if (runtime.atob) {
    return runtime.atob(value);
  }
  const bytes = runtime.Buffer?.from(value, "base64");
  if (!bytes) {
    throw new MinerUTaskError("Cannot decode local MinerU image data");
  }
  return Array.from(bytes)
    .map((byte) => String.fromCharCode(byte))
    .join("");
}

function isZipResponse(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return (
    normalized.includes("application/zip") ||
    normalized.includes("application/x-zip-compressed") ||
    normalized.includes("application/octet-stream")
  );
}

function readLegacyZipMarkdown(zip: ZipEntries): string {
  const entry = Array.from(zip.values()).find((item) =>
    item.name.endsWith(".md"),
  );
  return entry ? decodeText(entry.bytes) : "";
}

function readLegacyZipRawResult(zip: ZipEntries): unknown {
  const entries = Array.from(zip.values());
  const middle = entries.find((item) => item.name.endsWith("_middle.json"));
  const content = entries.find((item) =>
    item.name.endsWith("_content_list.json"),
  );
  const entry = middle ?? content;
  return entry ? JSON.parse(decodeText(entry.bytes)) : {};
}
