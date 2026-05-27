import type { Source } from "../types";

/**
 * State configuration for connecting to an E2B-compatible sandbox provider.
 * Kept shape-compatible with existing cloud sandbox state for easier migration.
 */
export interface E2BState {
  source?: Source;
  sandboxName?: string;
  sandboxId?: string;
  snapshotId?: string;
  expiresAt?: number;
}
