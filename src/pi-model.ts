import { join } from "node:path";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PiModel } from "./decision-worker.ts";

/** One ModelRuntime per agentDir per process; ModelRuntime.create() reads auth/models files and should not be repeated per call. */
const runtimeCache = new Map<string, Promise<ModelRuntime>>();

/**
 * Resolve a `provider/model-id` spec to a Pi `Model`. `undefined`/empty input
 * keeps Pi's configured default. Any other failure — a malformed spec or an
 * unavailable provider/model — throws rather than silently falling back, so a
 * misconfigured model never quietly runs the Decision Worker or Reviewer on a
 * different model than requested.
 */
export async function resolvePiModel(spec: string | undefined, agentDir = getAgentDir()): Promise<PiModel | undefined> {
  if (!spec || !spec.trim()) return undefined;
  const separator = spec.indexOf("/");
  if (separator <= 0 || separator === spec.length - 1) {
    throw new Error(`Pi model must be written as provider/model-id: ${spec}`);
  }
  const providerId = spec.slice(0, separator);
  const modelId = spec.slice(separator + 1);
  const runtime = await getRuntime(agentDir);
  const model = runtime.getModel(providerId, modelId);
  if (!model) throw new Error(`Pi model is not available: ${spec}`);
  return model;
}

function getRuntime(agentDir: string): Promise<ModelRuntime> {
  let cached = runtimeCache.get(agentDir);
  if (!cached) {
    cached = ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
    runtimeCache.set(agentDir, cached);
  }
  return cached;
}

/** Test seam: force the next resolvePiModel() call to build a fresh ModelRuntime. */
export function __resetPiModelCacheForTests(): void {
  runtimeCache.clear();
}
