// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { DatabaseProvider, DatabaseContextType } from "../src/react/DatabaseProvider";
import { useDatabase } from "../src/react/useDatabase";
import type { DbClient } from "../src/core/types";

const stubClient: DbClient = {
  select: async () => [],
  execute: async () => ({}),
  executeBatch: async () => {},
  close: async () => {},
};

function createProbe() {
  const snapshots: DatabaseContextType[] = [];
  function Probe() {
    snapshots.push(useDatabase());
    return null;
  }
  return { snapshots, Probe };
}

afterEach(cleanup);

describe("DatabaseProvider", () => {
  it("starts in loading state and becomes ready once the client resolves", async () => {
    const { snapshots, Probe } = createProbe();
    render(
      <DatabaseProvider client={Promise.resolve(stubClient)}>
        <Probe />
      </DatabaseProvider>,
    );

    expect(snapshots[0]?.isLoading).toBe(true);
    expect(snapshots[0]?.isDbReady).toBe(false);

    await waitFor(() => {
      expect(snapshots.at(-1)?.isDbReady).toBe(true);
    });
    const latest = snapshots.at(-1)!;
    expect(latest.dbClient).toBe(stubClient);
    expect(latest.isLoading).toBe(false);
    expect(latest.dbError).toBeNull();
  });

  it("exposes dbError when the client promise rejects", async () => {
    const { snapshots, Probe } = createProbe();
    render(
      <DatabaseProvider client={Promise.reject(new Error("init failed"))}>
        <Probe />
      </DatabaseProvider>,
    );

    await waitFor(() => {
      expect(snapshots.at(-1)?.dbError?.message).toBe("init failed");
    });
    const latest = snapshots.at(-1)!;
    expect(latest.isDbReady).toBe(false);
    expect(latest.isLoading).toBe(false);
  });

  it("re-runs initialization when the client prop gets a new promise (retry semantics)", async () => {
    const { snapshots, Probe } = createProbe();
    const otherClient: DbClient = { ...stubClient };

    const { rerender } = render(
      <DatabaseProvider client={Promise.resolve(stubClient)}>
        <Probe />
      </DatabaseProvider>,
    );
    await waitFor(() => {
      expect(snapshots.at(-1)?.dbClient).toBe(stubClient);
    });

    rerender(
      <DatabaseProvider client={Promise.resolve(otherClient)}>
        <Probe />
      </DatabaseProvider>,
    );

    // 换 promise 后先回到完全未就绪状态：窗口期内不允许把旧 client 当作可用连接暴露出去。
    // （rerender 在 act 内同步 flush effect，所以此刻 loading 态已经生效）
    const duringRetry = snapshots.at(-1)!;
    expect(duringRetry.isLoading).toBe(true);
    expect(duringRetry.isDbReady).toBe(false);
    expect(duringRetry.dbClient).toBeNull();

    await waitFor(() => {
      expect(snapshots.at(-1)?.dbClient).toBe(otherClient);
    });
    expect(snapshots.at(-1)?.isDbReady).toBe(true);
  });

  it("accepts a resolved DbClient directly, not only a promise", async () => {
    const { snapshots, Probe } = createProbe();
    render(
      <DatabaseProvider client={stubClient}>
        <Probe />
      </DatabaseProvider>,
    );

    await waitFor(() => {
      expect(snapshots.at(-1)?.isDbReady).toBe(true);
    });
    expect(snapshots.at(-1)?.dbClient).toBe(stubClient);
  });

  it("survives StrictMode double-mounting without duplicate resolution", async () => {
    const { snapshots, Probe } = createProbe();
    render(
      <React.StrictMode>
        <DatabaseProvider client={Promise.resolve(stubClient)}>
          <Probe />
        </DatabaseProvider>
      </React.StrictMode>,
    );

    await waitFor(() => {
      expect(snapshots.at(-1)?.isDbReady).toBe(true);
    });
    expect(snapshots.at(-1)?.dbClient).toBe(stubClient);
    expect(snapshots.at(-1)?.dbError).toBeNull();
  });

  it("ignores a promise that resolves after unmount", async () => {
    const { snapshots, Probe } = createProbe();
    let resolveClient!: (client: DbClient) => void;
    const pending = new Promise<DbClient>((resolve) => {
      resolveClient = resolve;
    });

    const { unmount } = render(
      <DatabaseProvider client={pending}>
        <Probe />
      </DatabaseProvider>,
    );
    unmount();
    // 卸载后才 resolve：cancelled 分支不应触达已卸载组件（React 18+ 对卸载后 setState 不再
    // 告警，但状态也不应再变化）
    resolveClient(stubClient);
    await pending;
    expect(snapshots.at(-1)?.isDbReady).toBe(false);
  });
});

describe("useDatabase", () => {
  it("throws when used outside a DatabaseProvider", () => {
    function Bare() {
      useDatabase();
      return null;
    }
    expect(() => render(<Bare />)).toThrow(/within a DatabaseProvider/);
  });
});
