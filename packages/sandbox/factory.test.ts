import { describe, expect, mock, test } from "bun:test";
import type { Sandbox } from "./interface";

function createSandboxMock(): Sandbox {
  return {
    type: "cloud",
    workingDirectory: "/tmp",
    readFile: async () => "",
    readFileBuffer: async () => Buffer.from(""),
    writeFile: async () => {},
    stat: async () => ({
      isDirectory: () => false,
      isFile: () => true,
      size: 0,
      mtimeMs: 0,
    }),
    access: async () => {},
    mkdir: async () => {},
    readdir: async () => [],
    exec: async () => ({
      success: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      truncated: false,
    }),
    stop: async () => {},
  };
}

describe("connectSandbox", () => {
  test("routes vercel state to the vercel connector", async () => {
    const vercelConnect = mock(async () => createSandboxMock());
    const e2bConnect = mock(async () => createSandboxMock());

    mock.module("./vercel/connect", () => ({
      connectVercel: vercelConnect,
    }));
    mock.module("./e2b/connect", () => ({
      connectE2B: e2bConnect,
    }));

    const { connectSandbox } = await import(
      `./factory?test=${crypto.randomUUID()}`
    );

    await connectSandbox({ type: "vercel", sandboxName: "session_1" });

    expect(vercelConnect).toHaveBeenCalledTimes(1);
    expect(e2bConnect).not.toHaveBeenCalled();
  });

  test("routes e2b state to the e2b connector", async () => {
    const vercelConnect = mock(async () => createSandboxMock());
    const e2bConnect = mock(async () => createSandboxMock());

    mock.module("./vercel/connect", () => ({
      connectVercel: vercelConnect,
    }));
    mock.module("./e2b/connect", () => ({
      connectE2B: e2bConnect,
    }));

    const { connectSandbox } = await import(
      `./factory?test=${crypto.randomUUID()}`
    );

    await connectSandbox({ type: "e2b", sandboxName: "session_2" });

    expect(e2bConnect).toHaveBeenCalledTimes(1);
    expect(vercelConnect).not.toHaveBeenCalled();
  });
});
