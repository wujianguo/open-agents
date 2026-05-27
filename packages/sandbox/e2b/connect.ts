import type { Sandbox } from "../interface";
import type { ConnectOptions } from "../factory";
import type { E2BSandboxConfig, E2BSandboxConnectConfig } from "./config";
import { E2BSandbox } from "./sandbox";
import type { E2BState } from "./state";

const MIN_REMAINING_TIMEOUT_MS = 10_000;

function getRemainingTimeout(
  expiresAt: number | undefined,
): number | undefined {
  if (!expiresAt) {
    return undefined;
  }

  const remaining = expiresAt - Date.now();
  return remaining > MIN_REMAINING_TIMEOUT_MS ? remaining : undefined;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isSandboxNotFoundError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return message.includes("not found") || message.includes("404");
}

function buildCreateConfig(
  state: E2BState,
  options?: ConnectOptions,
): E2BSandboxConfig {
  return {
    name: state.sandboxName,
    ...(state.source
      ? {
          source: {
            url: state.source.repo,
            branch: state.source.branch,
            newBranch: state.source.newBranch,
          },
        }
      : {}),
    ...(state.snapshotId ? { restoreSnapshotId: state.snapshotId } : {}),
    env: options?.env,
    githubToken: options?.githubToken,
    gitUser: options?.gitUser,
    hooks: options?.hooks,
    ...(options?.timeout !== undefined && { timeout: options.timeout }),
    ...(options?.baseSnapshotId && {
      baseSnapshotId: options.baseSnapshotId,
    }),
    ...(options?.skipGitWorkspaceBootstrap && {
      skipGitWorkspaceBootstrap: true,
    }),
  };
}

async function connectExistingSandbox(
  state: E2BState,
  options?: ConnectOptions,
): Promise<Sandbox> {
  const connectConfig: E2BSandboxConnectConfig = {
    sandboxId: state.sandboxId,
    sandboxName: state.sandboxName,
    env: options?.env,
    githubToken: options?.githubToken,
    hooks: options?.hooks,
    remainingTimeout: getRemainingTimeout(state.expiresAt),
  };

  const connected = await E2BSandbox.connect(connectConfig);
  if (!connected) {
    throw new Error("E2B sandbox not found");
  }

  return connected;
}

/**
 * Connect to the E2B-backed cloud sandbox based on the provided state.
 */
export async function connectE2B(
  state: E2BState,
  options?: ConnectOptions,
): Promise<Sandbox> {
  if (state.sandboxId || state.sandboxName) {
    try {
      return await connectExistingSandbox(state, options);
    } catch (error) {
      if (!options?.createIfMissing || !isSandboxNotFoundError(error)) {
        throw error;
      }
    }
  }

  return E2BSandbox.create(buildCreateConfig(state, options));
}
