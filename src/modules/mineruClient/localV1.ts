import { requestJson, requestOk } from "./api";
import { MinerUTaskError } from "./errors";
import { readImagesFromZip, readRawResultFromZip } from "./result";
import type {
  FetchLike,
  MinerUParseMode,
  MinerUParseResult,
  ZipEntries,
} from "./types";
import { decodeText, readZipWithFileFallback } from "./zip";

/**
 * MinerU 4.x 本地 API（`mineru-api` / `mineru-router`）的 `/v1` 任务流程：
 * POST `/v1/tasks` 创建任务 → PUT 上传 PDF 到返回的上传地址 →
 * GET `/v1/tasks/{id}` 轮询 → 下载文件的 `result_url`（ZIP）。
 */

/** MinerU 4.x 本地上传使用的短文件名，避免长标题或特殊字符被拒绝。 */
export const LOCAL_V1_UPLOAD_FILE_NAME = "mineru-local.pdf";

type V1ErrorDetail = { code?: string; message?: string };

type V1TaskFile = {
  file_id?: string;
  file_name?: string;
  status?: string;
  upload?: {
    url?: string;
    headers?: Record<string, string>;
  } | null;
  result_url?: string | null;
  error?: V1ErrorDetail | null;
};

type V1TaskResponse = {
  task_id?: string;
  status?: string;
  files?: V1TaskFile[];
  error?: V1ErrorDetail | null;
};

type V1TierListResponse = {
  data?: Array<{ id?: string }>;
};

export interface V1LocalContext {
  baseURL: string;
  request: FetchLike;
  mode: MinerUParseMode;
  saveImages: boolean;
}

export interface V1SubmittedTask {
  taskID: string;
  fileID: string;
}

/**
 * 创建 `/v1/tasks` 任务并把 PDF 字节上传到服务端返回的上传地址。
 */
export async function submitV1LocalTask(
  context: V1LocalContext,
  bytes: Uint8Array,
): Promise<V1SubmittedTask> {
  const tier = await selectV1Tier(context);
  const created = await requestJson<V1TaskResponse>(
    context.request,
    `${context.baseURL}/v1/tasks`,
    "local-submit",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(tier ? { tier } : {}),
        output_formats: ["default"],
        files: [
          { file_name: LOCAL_V1_UPLOAD_FILE_NAME, bytes: bytes.byteLength },
        ],
      }),
    },
  );
  const taskID = created.task_id;
  const file = created.files?.[0];
  if (!taskID) {
    throw new MinerUTaskError("Local MinerU submit response missing task_id");
  }
  if (!file?.file_id) {
    throw new MinerUTaskError("Local MinerU submit response missing file_id");
  }
  const uploadURL = file.upload?.url;
  if (!uploadURL) {
    throw new MinerUTaskError(
      "Local MinerU submit response missing upload URL",
    );
  }

  await requestOk(
    context.request,
    resolveV1URL(context.baseURL, uploadURL),
    "local-upload",
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        ...(file.upload?.headers ?? {}),
      },
      body: bytes,
    },
  );
  return { taskID, fileID: file.file_id };
}

/**
 * 轮询 `/v1/tasks/{id}`，以单个文件状态为准转换为统一任务状态。
 */
export async function pollV1LocalTask(
  context: V1LocalContext,
  taskID: string,
): Promise<{
  status: "running" | "succeeded" | "failed";
  error?: string;
  resultURL?: string;
}> {
  const task = await fetchV1Task(context, taskID);
  const file = task.files?.[0];
  const status = String(file?.status ?? task.status ?? "").toLowerCase();
  if (status === "completed") {
    return {
      status: "succeeded",
      resultURL: file?.result_url ?? undefined,
    };
  }
  if (["failed", "canceled", "cancelled"].includes(status)) {
    return {
      status: "failed",
      error:
        file?.error?.message ||
        task.error?.message ||
        `Local MinerU task ${status}`,
    };
  }
  if (task.status === "failed" || task.status === "canceled") {
    return {
      status: "failed",
      error: task.error?.message || `Local MinerU task ${task.status}`,
    };
  }
  return { status: "running" };
}

/**
 * 下载 `/v1` 任务结果 ZIP，并按 precise/lite 模式转换为统一结果。
 */
export async function downloadV1LocalResult(
  context: V1LocalContext,
  task: { taskID: string; fileID?: string; resultURL?: string },
): Promise<MinerUParseResult> {
  const resultURL = await resolveV1ResultURL(context, task);
  const response = await requestOk(
    context.request,
    resultURL,
    "local-download",
    { method: "GET" },
  );
  const zip = await readZipWithFileFallback(
    await response.arrayBuffer(),
    "mineru-local-result.zip",
  );
  const markdown = readV1ZipMarkdown(zip);
  if (context.mode === "lite") {
    return { kind: "lite", markdown };
  }
  return {
    kind: "precise",
    markdown,
    rawResult: readV1ZipRawResult(zip),
    images: context.saveImages ? readImagesFromZip(zip) : undefined,
  };
}

async function fetchV1Task(
  context: V1LocalContext,
  taskID: string,
): Promise<V1TaskResponse> {
  return requestJson<V1TaskResponse>(
    context.request,
    `${context.baseURL}/v1/tasks/${encodeURIComponent(taskID)}`,
    "local-poll",
    { method: "GET" },
  );
}

async function resolveV1ResultURL(
  context: V1LocalContext,
  task: { taskID: string; fileID?: string; resultURL?: string },
): Promise<string> {
  if (task.resultURL) {
    return resolveV1URL(context.baseURL, task.resultURL);
  }
  const detail = await fetchV1Task(context, task.taskID);
  const file = detail.files?.[0];
  if (file?.result_url) {
    return resolveV1URL(context.baseURL, file.result_url);
  }
  const fileID = file?.file_id ?? task.fileID;
  if (fileID) {
    return `${context.baseURL}/v1/files/${encodeURIComponent(fileID)}/content`;
  }
  throw new MinerUTaskError("Local MinerU task has no downloadable result");
}

/**
 * lite 模式优先使用服务端公布的 `flash` 档位；precise 模式交给服务端默认档位
 * （standard → basic → flash → advanced 中第一个可用的）。
 */
async function selectV1Tier(
  context: V1LocalContext,
): Promise<string | undefined> {
  if (context.mode !== "lite") {
    return undefined;
  }
  try {
    const tiers = await requestJson<V1TierListResponse>(
      context.request,
      `${context.baseURL}/v1/tiers`,
      "local-tiers",
      { method: "GET" },
    );
    return tiers.data?.some((tier) => tier.id === "flash")
      ? "flash"
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 服务端返回的上传/结果地址按原样使用；相对地址按本地 API base URL 解析。
 */
function resolveV1URL(baseURL: string, url: string): string {
  if (/^https?:\/\//i.test(url)) {
    return url;
  }
  return `${baseURL}/${url.replace(/^\/+/, "")}`;
}

function readV1ZipMarkdown(zip: ZipEntries): string {
  const entries = Array.from(zip.values());
  const entry =
    zip.get("markdown.md") ??
    entries.find((item) => item.name.endsWith("/markdown.md")) ??
    entries.find((item) => item.name.endsWith(".md"));
  return entry ? decodeText(entry.bytes) : "";
}

function readV1ZipRawResult(zip: ZipEntries): unknown {
  const entries = Array.from(zip.values());
  const middle =
    zip.get("middle_json.json") ??
    entries.find(
      (item) =>
        item.name.endsWith("/middle_json.json") ||
        item.name.endsWith("_middle.json"),
    );
  if (middle) {
    return JSON.parse(decodeText(middle.bytes));
  }
  return readRawResultFromZip(zip) ?? {};
}
