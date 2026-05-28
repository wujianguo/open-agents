import type { SandboxHooks } from "../interface";
import type { Source } from "../types";

export interface E2BSandboxConfig {
  name?: string;
  source?: Source;
  restoreSnapshotId?: string;
  gitUser?: {
    name: string;
    email: string;
  };
  env?: Record<string, string>;
  githubToken?: string;
  timeout?: number;
  baseSnapshotId?: string;
  hooks?: SandboxHooks;
  skipGitWorkspaceBootstrap?: boolean;
}

export interface E2BSandboxConnectConfig {
  sandboxId?: string;
  sandboxName?: string;
  env?: Record<string, string>;
  githubToken?: string;
  hooks?: SandboxHooks;
  remainingTimeout?: number;
}
