export const SANDBOX_PROVIDERS = ["vercel", "e2b"] as const;

export type SandboxProvider = (typeof SANDBOX_PROVIDERS)[number];

export const DEFAULT_SANDBOX_PROVIDER: SandboxProvider = "vercel";

export function isSandboxProvider(value: unknown): value is SandboxProvider {
  return (
    typeof value === "string" &&
    SANDBOX_PROVIDERS.includes(value as SandboxProvider)
  );
}
