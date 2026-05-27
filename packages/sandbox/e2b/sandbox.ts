import { FileType, Sandbox as E2BSandboxSDK } from "e2b";
import type { Dirent } from "fs";
import type {
  ExecResult,
  Sandbox,
  SandboxHooks,
  SandboxStats,
  SnapshotResult,
} from "../interface";
import type { E2BSandboxConfig, E2BSandboxConnectConfig } from "./config";
import type { E2BState, E2BSandboxState } from "./state";

const MAX_OUTPUT_LENGTH = 50_000;
const DEFAULT_WORKING_DIRECTORY = "/home/user/workspace";
// Quick probe window for detached commands to catch immediate boot failures.
// A short value keeps detached starts responsive, but failures after this
// window are surfaced only when callers inspect long-running process state.
const DETACHED_QUICK_FAILURE_WINDOW_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 300_000;
const METADATA_SANDBOX_NAME_KEY = "open_agents_sandbox_name";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function truncateCommandOutput(output: string): {
  output: string;
  truncated: boolean;
} {
  if (output.length <= MAX_OUTPUT_LENGTH) {
    return { output, truncated: false };
  }

  return {
    output: output.slice(0, MAX_OUTPUT_LENGTH),
    truncated: true,
  };
}

function asDirent(entry: {
  name: string;
  path: string;
  type?: string;
}): Dirent {
  const isDir = entry.type === FileType.DIR;
  const isFile = entry.type === FileType.FILE;

  return {
    name: entry.name,
    parentPath: entry.path,
    path: entry.path,
    isDirectory: () => isDir,
    isFile: () => isFile,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  } as Dirent;
}

function toDomainUrl(host: string): string {
  return host.startsWith("http://") || host.startsWith("https://")
    ? host
    : `https://${host}`;
}

function toTimestamp(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

async function runCommandOrThrow(
  sandbox: E2BSandboxSDK,
  command: string,
  cwd: string,
  envs?: Record<string, string>,
): Promise<void> {
  const result = await sandbox.commands.run(command, {
    cwd,
    envs,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed (${result.exitCode}): ${command}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

async function configureGitHubToken(
  sandbox: E2BSandboxSDK,
  token?: string,
  envs?: Record<string, string>,
): Promise<void> {
  await runCommandOrThrow(
    sandbox,
    "git config --global --unset-all http.https://github.com/.extraheader || true",
    "/",
    envs,
  );

  if (!token) {
    return;
  }

  const base64EncodedToken = Buffer.from(
    `x-access-token:${token}`,
    "utf-8",
  ).toString("base64");
  await runCommandOrThrow(
    sandbox,
    `git config --global http.https://github.com/.extraheader ${shellQuote(`AUTHORIZATION: basic ${base64EncodedToken}`)}`,
    "/",
    envs,
  );
}

export class E2BSandbox implements Sandbox {
  readonly type = "cloud" as const;
  readonly id: string;
  readonly workingDirectory: string;
  readonly env?: Record<string, string>;
  readonly currentBranch?: string;
  readonly hooks?: SandboxHooks;
  readonly host?: string;
  readonly name?: string;

  private sdk: E2BSandboxSDK;
  private isStopped = false;
  private _expiresAt?: number;
  private _timeout?: number;
  private source?: E2BState["source"];
  private snapshotId?: string;

  get expiresAt(): number | undefined {
    return this._expiresAt;
  }

  get timeout(): number | undefined {
    return this._timeout;
  }

  private constructor(params: {
    sdk: E2BSandboxSDK;
    workingDirectory: string;
    env?: Record<string, string>;
    currentBranch?: string;
    hooks?: SandboxHooks;
    timeout?: number;
    startTime?: number;
    name?: string;
    source?: E2BState["source"];
    snapshotId?: string;
  }) {
    this.sdk = params.sdk;
    this.id = params.sdk.sandboxId;
    this.workingDirectory = params.workingDirectory;
    this.env = params.env;
    this.currentBranch = params.currentBranch;
    this.hooks = params.hooks;
    this.host = toDomainUrl(params.sdk.sandboxDomain);
    this.name = params.name;
    this.source = params.source;
    this.snapshotId = params.snapshotId;

    if (params.timeout !== undefined && params.startTime !== undefined) {
      this._timeout = params.timeout;
      this._expiresAt = params.startTime + params.timeout;
    }
  }

  private getCommandEnv(extra?: Record<string, string>): Record<string, string> {
    return {
      ...(this.env ?? {}),
      ...(extra ?? {}),
    };
  }

  static async create(config: E2BSandboxConfig = {}): Promise<E2BSandbox> {
    const {
      name,
      source,
      restoreSnapshotId,
      gitUser,
      env,
      githubToken,
      timeout = DEFAULT_TIMEOUT_MS,
      baseSnapshotId,
      hooks,
      skipGitWorkspaceBootstrap = false,
    } = config;

    const template = restoreSnapshotId ?? baseSnapshotId ?? "base";
    const sdk = await E2BSandboxSDK.create({
      template,
      timeoutMs: timeout,
      envs: env,
      lifecycle: { onTimeout: "pause", autoResume: true },
      metadata: name ? { [METADATA_SANDBOX_NAME_KEY]: name } : undefined,
    });

    if (!source && !skipGitWorkspaceBootstrap) {
      await runCommandOrThrow(
        sdk,
        `mkdir -p ${shellQuote(DEFAULT_WORKING_DIRECTORY)}`,
        "/",
        env,
      );
    }

    let didConfigureGitHubToken = false;
    if (githubToken) {
      await configureGitHubToken(sdk, githubToken, env);
      didConfigureGitHubToken = true;
    }

    try {
      if (source) {
        const cloneParts = ["git clone"];
        if (source.branch) {
          cloneParts.push(`--branch ${shellQuote(source.branch)}`);
        }
        cloneParts.push(
          shellQuote(source.url),
          shellQuote(DEFAULT_WORKING_DIRECTORY),
        );
        await runCommandOrThrow(sdk, cloneParts.join(" "), "/", env);
      } else if (!restoreSnapshotId && !skipGitWorkspaceBootstrap) {
        await runCommandOrThrow(
          sdk,
          "git init",
          DEFAULT_WORKING_DIRECTORY,
          env,
        );
      }

      if (gitUser && (source || !skipGitWorkspaceBootstrap)) {
        await runCommandOrThrow(
          sdk,
          `git config user.name ${shellQuote(gitUser.name)}`,
          DEFAULT_WORKING_DIRECTORY,
          env,
        );
        await runCommandOrThrow(
          sdk,
          `git config user.email ${shellQuote(gitUser.email)}`,
          DEFAULT_WORKING_DIRECTORY,
          env,
        );
      }

      if (
        !source &&
        !restoreSnapshotId &&
        gitUser &&
        !skipGitWorkspaceBootstrap
      ) {
        await runCommandOrThrow(
          sdk,
          "git commit --allow-empty -m 'Initial commit'",
          DEFAULT_WORKING_DIRECTORY,
          env,
        );
      }

      let currentBranch: string | undefined;
      if (source?.newBranch) {
        await runCommandOrThrow(
          sdk,
          `git checkout -b ${shellQuote(source.newBranch)}`,
          DEFAULT_WORKING_DIRECTORY,
          env,
        );
        currentBranch = source.newBranch;
      } else if (source?.branch) {
        currentBranch = source.branch;
      }

      const sandbox = new E2BSandbox({
        sdk,
        workingDirectory: DEFAULT_WORKING_DIRECTORY,
        env,
        currentBranch,
        hooks,
        timeout,
        startTime: Date.now(),
        name,
        source,
        snapshotId: restoreSnapshotId,
      });

      if (hooks?.afterStart) {
        await hooks.afterStart(sandbox);
      }

      return sandbox;
    } finally {
      if (githubToken && didConfigureGitHubToken) {
        await configureGitHubToken(sdk, undefined, env);
      }
    }
  }

  static async connect(
    config: E2BSandboxConnectConfig,
  ): Promise<E2BSandbox | null> {
    const { sandboxId, sandboxName, env, hooks, remainingTimeout } = config;

    let resolvedSandboxId = sandboxId;
    if (!resolvedSandboxId && sandboxName) {
      const paginator = E2BSandboxSDK.list({
        query: {
          metadata: { [METADATA_SANDBOX_NAME_KEY]: sandboxName },
          state: ["running", "paused"],
        },
        limit: 1,
      });
      const [match] = await paginator.nextItems();
      resolvedSandboxId = match?.sandboxId;
    }

    if (!resolvedSandboxId) {
      return null;
    }

    const sdk = await E2BSandboxSDK.connect(resolvedSandboxId, {
      ...(remainingTimeout !== undefined ? { timeoutMs: remainingTimeout } : {}),
    });

    const info = await sdk.getInfo();
    const now = Date.now();
    const timeout = Math.max(toTimestamp(info.endAt) - now, 0);
    const sandbox = new E2BSandbox({
      sdk,
      workingDirectory: DEFAULT_WORKING_DIRECTORY,
      env,
      hooks,
      timeout,
      startTime: now,
      name: sandboxName,
    });

    if (hooks?.afterStart) {
      await hooks.afterStart(sandbox);
    }

    return sandbox;
  }

  async readFile(path: string, _encoding: "utf-8"): Promise<string> {
    // E2B text file reads are UTF-8 by default, so the encoding argument is
    // accepted for interface compatibility but does not affect behavior.
    return this.sdk.files.read(path, { format: "text" });
  }

  async readFileBuffer(path: string): Promise<Buffer> {
    const bytes = await this.sdk.files.read(path, { format: "bytes" });
    return Buffer.from(bytes);
  }

  async writeFile(
    path: string,
    content: string,
    _encoding: "utf-8",
  ): Promise<void> {
    await this.sdk.files.write(path, content);
  }

  async stat(path: string): Promise<SandboxStats> {
    const info = await this.sdk.files.getInfo(path);
    const isDir = info.type === FileType.DIR;
    const mtimeMs = info.modifiedTime?.getTime() ?? Date.now();

    return {
      isDirectory: () => isDir,
      isFile: () => !isDir,
      size: info.size,
      mtimeMs,
    };
  }

  async access(path: string): Promise<void> {
    const exists = await this.sdk.files.exists(path);
    if (!exists) {
      throw new Error(`ENOENT: no such file or directory, access '${path}'`);
    }
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    if (options?.recursive ?? false) {
      await this.sdk.files.makeDir(path);
      return;
    }

    const created = await this.sdk.files.makeDir(path);
    if (!created) {
      throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
    }
  }

  async readdir(
    path: string,
    _options: { withFileTypes: true },
  ): Promise<Dirent[]> {
    const entries = await this.sdk.files.list(path);
    return entries.map((entry) =>
      asDirent({
        name: entry.name,
        path,
        type: entry.type,
      }),
    );
  }

  async exec(
    command: string,
    cwd: string,
    timeoutMs: number,
    options?: { signal?: AbortSignal },
  ): Promise<ExecResult> {
    try {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = options?.signal
        ? AbortSignal.any([timeoutSignal, options.signal])
        : timeoutSignal;
      const result = await this.sdk.commands.run(command, {
        cwd,
        envs: this.getCommandEnv(),
        timeoutMs,
        signal,
      });

      const stdout = truncateCommandOutput(result.stdout ?? "");
      const stderr = truncateCommandOutput(result.stderr ?? "");

      return {
        success: result.exitCode === 0,
        exitCode: result.exitCode,
        stdout: stdout.output,
        stderr: stderr.output,
        truncated: stdout.truncated || stderr.truncated,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }

      if (error instanceof Error && error.name === "TimeoutError") {
        return {
          success: false,
          exitCode: null,
          stdout: "",
          stderr: `Command timed out after ${timeoutMs}ms`,
          truncated: false,
        };
      }

      return {
        success: false,
        exitCode: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        truncated: false,
      };
    }
  }

  async execDetached(
    command: string,
    cwd: string,
  ): Promise<{ commandId: string }> {
    const handle = await this.sdk.commands.run(command, {
      cwd,
      envs: this.getCommandEnv(),
      background: true,
    });

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutResult = new Promise<{ kind: "timeout" }>((resolve) => {
      timeoutId = setTimeout(() => {
        resolve({ kind: "timeout" });
      }, DETACHED_QUICK_FAILURE_WINDOW_MS);
    });

    const waitResult = handle
      .wait()
      .then((finished) => ({ kind: "finished", finished }) as const)
      .catch((error: unknown) => ({ kind: "error", error }) as const);

    const quickProbe = await Promise.race([waitResult, timeoutResult]);
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    if (quickProbe.kind === "timeout") {
      return { commandId: String(handle.pid) };
    }

    if (quickProbe.kind === "error") {
      throw quickProbe.error;
    }

    if (quickProbe.finished.exitCode !== 0) {
      throw new Error(
        `Background command exited with code ${quickProbe.finished.exitCode}. stderr:\n${quickProbe.finished.stderr}`,
      );
    }

    return { commandId: String(handle.pid) };
  }

  domain(port: number): string {
    return toDomainUrl(this.sdk.getHost(port));
  }

  async setGitHubAuthToken(token?: string): Promise<void> {
    await configureGitHubToken(this.sdk, token, this.getCommandEnv());
  }

  async extendTimeout(additionalMs: number): Promise<{ expiresAt: number }> {
    if (additionalMs <= 0) {
      throw new Error("additionalMs must be positive");
    }

    const info = await this.sdk.getInfo();
    const remainingMs = Math.max(toTimestamp(info.endAt) - Date.now(), 0);
    const nextTimeout = remainingMs + additionalMs;
    await this.sdk.setTimeout(nextTimeout);

    const expiresAt = Date.now() + nextTimeout;
    this._expiresAt = expiresAt;
    this._timeout = nextTimeout;

    if (this.hooks?.onTimeoutExtended) {
      await this.hooks.onTimeoutExtended(this, additionalMs);
    }

    return { expiresAt };
  }

  async snapshot(): Promise<SnapshotResult> {
    const snapshot = await this.sdk.createSnapshot();
    return { snapshotId: snapshot.snapshotId };
  }

  async stop(): Promise<void> {
    if (this.isStopped) {
      return;
    }
    this.isStopped = true;
    this._expiresAt = undefined;

    if (this.hooks?.beforeStop) {
      try {
        await this.hooks.beforeStop(this);
      } catch (error) {
        console.error("[E2BSandbox] beforeStop hook failed:", error);
      }
    }

    await this.sdk.kill();
  }

  getState(): E2BSandboxState {
    return {
      type: "e2b",
      ...(this.name ? { sandboxName: this.name } : {}),
      sandboxId: this.id,
      ...(this.source ? { source: this.source } : {}),
      ...(this.snapshotId ? { snapshotId: this.snapshotId } : {}),
      ...(this.expiresAt !== undefined ? { expiresAt: this.expiresAt } : {}),
    };
  }
}

export async function connectE2BSandbox(
  config: E2BSandboxConfig | E2BSandboxConnectConfig = {},
): Promise<E2BSandbox> {
  const connectConfig = config as E2BSandboxConnectConfig;

  if (connectConfig.sandboxId || connectConfig.sandboxName) {
    const connected = await E2BSandbox.connect(connectConfig);
    if (!connected) {
      throw new Error("E2B sandbox not found");
    }
    return connected;
  }

  return E2BSandbox.create(config as E2BSandboxConfig);
}
