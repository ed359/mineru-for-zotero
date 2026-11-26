import { requestOk } from "./api";
import { MinerURequestError } from "./errors";
import { readFileBytes, readPdfBytes } from "./file";
import {
  createFormDataRequest,
  errorMessage,
  normalizeBinary,
  responseErrorDetail,
} from "./http";
import {
  downloadLegacyLocalResult,
  pollLegacyLocalTask,
  submitLegacyLocalTask,
} from "./localLegacy";
import {
  downloadV1LocalResult,
  pollV1LocalTask,
  submitV1LocalTask,
} from "./localV1";
import { normalizeBaseURL } from "./path";
import type {
  FetchLike,
  MinerUClient,
  MinerUClientOptions,
  MinerUParseMode,
} from "./types";

/** 本地 MinerU API 版本：`v1` 为 MinerU 4.x，`legacy` 为 MinerU 3.x。 */
export type LocalApiVersion = "v1" | "legacy";

type LocalTaskState =
  | { api: "v1"; fileID?: string; resultURL?: string }
  | { api: "legacy" };

/**
 * 创建本地 MinerU API client。提交前探测服务版本：
 * MinerU 4.x 暴露 `/v1/health`，走 `/v1/tasks` JSON 任务流程；
 * 否则回退到 MinerU 3.x 的 `/health` + multipart `/tasks` 流程。
 */
export function createLocalMinerUClient(
  options: MinerUClientOptions & {
    mode: MinerUParseMode;
    localApiBaseURL: string;
    saveImages?: boolean;
  },
): MinerUClient {
  const baseURL = normalizeBaseURL(options.localApiBaseURL);
  const request = options.fetch ?? createFormDataRequest();
  const readBinary = options.readBinary ?? readFileBytes;
  const context = {
    baseURL,
    request,
    mode: options.mode,
    saveImages: options.saveImages !== false,
  };
  const tasks = new Map<string, LocalTaskState>();

  const taskState = (taskID: string): LocalTaskState =>
    tasks.get(taskID) ?? { api: "v1" };

  return {
    /**
     * 检查本地服务健康状态和 API 版本后提交 PDF 解析任务。
     */
    async submitPdf(filePath) {
      const api = await detectLocalApiVersion(request, baseURL);
      const bytes = normalizeBinary(await readPdfBytes(readBinary, filePath));
      if (api === "v1") {
        const submitted = await submitV1LocalTask(context, bytes);
        tasks.set(submitted.taskID, { api, fileID: submitted.fileID });
        return { taskID: submitted.taskID };
      }
      const taskID = await submitLegacyLocalTask(context, bytes, filePath);
      tasks.set(taskID, { api });
      return { taskID };
    },

    /**
     * 轮询本地异步任务状态，并转换为统一任务状态。
     */
    async pollTask(taskID) {
      const state = taskState(taskID);
      if (state.api === "legacy") {
        return pollLegacyLocalTask(context, taskID);
      }
      const { resultURL, ...status } = await pollV1LocalTask(context, taskID);
      if (resultURL) {
        tasks.set(taskID, { ...state, resultURL });
      }
      return status;
    },

    /**
     * 下载本地任务结果，并按 precise/lite 模式转换为统一结果。
     */
    async downloadResult(taskID) {
      const state = taskState(taskID);
      if (state.api === "legacy") {
        return downloadLegacyLocalResult(context, taskID);
      }
      return downloadV1LocalResult(context, {
        taskID,
        fileID: state.fileID,
        resultURL: state.resultURL,
      });
    },
  };
}

/**
 * 探测本地 MinerU 服务版本：`/v1/health` 可用即为 MinerU 4.x；
 * 返回 404/405 时回退检查 MinerU 3.x 的 `/health`。
 */
export async function detectLocalApiVersion(
  request: FetchLike,
  baseURL: string,
): Promise<LocalApiVersion> {
  let response: Response;
  try {
    response = await request(`${baseURL}/v1/health`, { method: "GET" });
  } catch (error) {
    throw new MinerURequestError("local-health", 0, errorMessage(error));
  }
  if (response.ok) {
    return "v1";
  }
  if (response.status !== 404 && response.status !== 405) {
    // 4.x 服务在模型未就绪时 `/v1/health` 返回 503，直接报告该状态。
    throw new MinerURequestError(
      "local-health",
      response.status,
      await responseErrorDetail(response),
    );
  }
  await requestOk(request, `${baseURL}/health`, "local-health", {
    method: "GET",
  });
  return "legacy";
}
