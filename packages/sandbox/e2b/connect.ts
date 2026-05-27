import type { Sandbox } from "../interface";
import type { ConnectOptions } from "../factory";
import type { E2BState } from "./state";

/**
 * E2B provider connector scaffold.
 * This provides provider-level wiring before a concrete runtime adapter is added.
 */
export async function connectE2B(
  _state: E2BState,
  _options?: ConnectOptions,
): Promise<Sandbox> {
  throw new Error(
    "E2B sandbox provider is not configured yet. Add an E2B runtime adapter before using the E2B provider.",
  );
}
