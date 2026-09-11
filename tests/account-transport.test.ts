import { expect, it, vi } from "vitest";
import {
  accountFetch,
  setAccountCsrf,
} from "../apps/web/src/account-transport.js";
it("uses cookies and CSRF only for same-origin account requests without bearer authorization", async () => {
  const fetcher = vi.fn(async () => new Response("ok"));
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("location", { origin: "https://app.example" });
  try {
    setAccountCsrf("a".repeat(64));
    await accountFetch("/api/v1/streams/x/watch-ticket", {
      method: "POST",
      credentials: "omit",
    });
    const options = fetcher.mock.calls.at(-1)![1] as RequestInit;
    expect(options.credentials).toBe("same-origin");
    expect(new Headers(options.headers).get("x-csrf-token")).toBe(
      "a".repeat(64),
    );
    await accountFetch("/api/v1/streams", { credentials: "omit" });
    expect(
      new Headers((fetcher.mock.calls.at(-1)![1] as RequestInit).headers).has(
        "x-csrf-token",
      ),
    ).toBe(false);
    const explicit = {
      method: "POST",
      credentials: "omit" as const,
      headers: { authorization: "Bearer explicit" },
    };
    await accountFetch("/api/v1/streams", explicit);
    expect(fetcher.mock.calls.at(-1)![1]).toBe(explicit);
    const remote = { method: "POST", credentials: "omit" as const };
    await accountFetch("https://other.example/api", remote);
    expect(fetcher.mock.calls.at(-1)![1]).toBe(remote);
    setAccountCsrf(undefined);
    await accountFetch("/api/v1/streams", remote);
    expect(fetcher.mock.calls.at(-1)![1]).toBe(remote);
  } finally {
    setAccountCsrf(undefined);
    vi.unstubAllGlobals();
  }
});
