import { describe, it, expect, vi, afterEach } from "vitest";
import { render as _render, cleanup } from "vitest-browser-react";
import { Suspense, useEffect, useRef, useState } from "react";
import { useAgent } from "../react";
import { getTestWorkerHost } from "./test-config";

// Socket traffic legitimately lands outside act() in these tests.
const render: typeof _render = async (...args) => {
  const result = await _render(...args);
  // @ts-expect-error - globalThis is not typed
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  return result;
};

afterEach(() => {
  cleanup();
});

type Observation = {
  name: string;
  exposedName: string;
  readyThenIdentified: Promise<string>;
  call: Promise<unknown>;
};

describe("useAgent when the name changes", () => {
  it.each(["namespace", "base-path"] as const)(
    "identifies only the current socket when returning to a %s address",
    async (routing) => {
      const { host, protocol } = getTestWorkerHost();
      const first = `identity-socket-a-${crypto.randomUUID()}`;
      const other = `identity-socket-b-${crypto.randomUUID()}`;
      const identifiedSockets = new WeakSet<object>();
      const observations: {
        name: string;
        identified: boolean;
        identityReceived: boolean;
      }[] = [];
      const identities: string[] = [];
      const changes: string[][] = [];
      let update: ((name: string) => void) | undefined;

      function TestComponent() {
        const [name, setName] = useState(first);
        function onIdentity(name: string): void {
          identifiedSockets.add(agent);
          identities.push(name);
        }
        const agent = useAgent({
          agent: "TestStateAgent",
          host,
          protocol,
          name,
          basePath:
            routing === "base-path" ? `custom-state/${name}` : undefined,
          onIdentity,
          onIdentityChange: (oldName, newName) =>
            changes.push([oldName, newName])
        });
        observations.push({
          name,
          identified: agent.identified,
          identityReceived: identifiedSockets.has(agent) && agent.name === name
        });
        useEffect(() => {
          update = setName;
        }, []);
        return <div>{agent.identified ? agent.name : "connecting"}</div>;
      }

      await render(
        <Suspense fallback="loading">
          <TestComponent />
        </Suspense>
      );
      await vi.waitFor(() => expect(identities).toEqual([first]), {
        timeout: 10000
      });
      update?.(other);
      await vi.waitFor(() => expect(identities).toEqual([first, other]), {
        timeout: 10000
      });
      update?.(first);
      await vi.waitFor(
        () => expect(identities).toEqual([first, other, first]),
        { timeout: 10000 }
      );
      expect(
        observations.filter(
          ({ identified, identityReceived }) => identified && !identityReceived
        )
      ).toEqual([]);
      expect(changes).toEqual([]);
    }
  );

  it("reports server identity changes when credentials refresh at the same address", async () => {
    const { host, protocol } = getTestWorkerHost();
    const first = `identity-user-a-${crypto.randomUUID()}`;
    const other = `identity-user-b-${crypto.randomUUID()}`;
    const identities: string[] = [];
    const changes: string[][] = [];
    let update: ((name: string) => void) | undefined;

    function TestComponent() {
      const [user, setUser] = useState(first);
      const agent = useAgent({
        agent: "TestStateAgent",
        host,
        protocol,
        basePath: "user",
        query: { user },
        onIdentity: (name) => identities.push(name),
        onIdentityChange: (oldName, newName) => changes.push([oldName, newName])
      });
      useEffect(() => {
        update = setUser;
      }, []);
      return <div>{agent.identified ? agent.name : "connecting"}</div>;
    }

    const { container } = await render(
      <Suspense fallback="loading">
        <TestComponent />
      </Suspense>
    );
    await vi.waitFor(() => expect(identities).toEqual([first]), {
      timeout: 10000
    });
    update?.(other);
    await vi.waitFor(() => expect(container.textContent).toBe(other), {
      timeout: 10000
    });
    update?.(first);
    await vi.waitFor(() => expect(identities).toEqual([first, other, first]), {
      timeout: 10000
    });
    expect(changes).toEqual([
      [first, other],
      [other, first]
    ]);
  });

  it("resolves ready for the new agent's identity and routes calls to it", async () => {
    const { host, protocol } = getTestWorkerHost();
    const observations: Observation[] = [];
    let setName: ((name: string) => void) | undefined;

    function TestComponent() {
      const [name, setNameState] = useState("address-rpc-a");
      useEffect(() => {
        setName = setNameState;
      }, []);
      const agent = useAgent({
        agent: "TestCallableAgent",
        host,
        name,
        protocol
      });
      const latest = useRef(agent);
      latest.current = agent;
      // Runs in the commit where the new socket has not identified yet.
      useEffect(() => {
        observations.push({
          name,
          exposedName: agent.name,
          readyThenIdentified: agent.ready.then(() =>
            latest.current.identified ? latest.current.name : "not identified"
          ),
          call: agent.call("whoAmI")
        });
        // Only name changes are observed.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [name]);
      return <div>{agent.identified ? "identified" : "connecting"}</div>;
    }

    await render(
      <Suspense fallback="loading">
        <TestComponent />
      </Suspense>
    );
    await vi.waitFor(() => expect(observations).toHaveLength(1), {
      timeout: 10000
    });
    await expect(observations[0].call).resolves.toBe("address-rpc-a");

    setName?.("address-rpc-b");
    await vi.waitFor(() => expect(observations).toHaveLength(2), {
      timeout: 10000
    });

    const switched = observations[1];
    expect(switched.exposedName).toBe("address-rpc-b");
    await expect(switched.call).resolves.toBe("address-rpc-b");
    await expect(switched.readyThenIdentified).resolves.toBe("address-rpc-b");
  });

  it("resolves a ready promise taken before switching away and back", async () => {
    const { host, protocol } = getTestWorkerHost();
    let readyForA: Promise<void> | undefined;
    let identifiedAs: string | undefined;
    let setName: ((name: string) => void) | undefined;

    function TestComponent() {
      const [name, setNameState] = useState("address-ready-a");
      const agent = useAgent({
        agent: "TestCallableAgent",
        host,
        name,
        protocol
      });
      readyForA ??= agent.ready;
      identifiedAs = agent.identified ? agent.name : undefined;
      useEffect(() => {
        setName = setNameState;
        // Leave A before its first socket can identify.
        setNameState("address-ready-b");
      }, []);
      return <div>{name}</div>;
    }

    await render(
      <Suspense fallback="loading">
        <TestComponent />
      </Suspense>
    );
    await vi.waitFor(() => expect(identifiedAs).toBe("address-ready-b"), {
      timeout: 10000
    });

    setName?.("address-ready-a");
    await vi.waitFor(() => expect(identifiedAs).toBe("address-ready-a"), {
      timeout: 10000
    });
    await expect(
      Promise.race([
        readyForA!.then(() => "resolved"),
        new Promise((resolve) => setTimeout(() => resolve("pending"), 2000))
      ])
    ).resolves.toBe("resolved");
  });
});
