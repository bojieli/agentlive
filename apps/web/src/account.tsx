import { useEffect, useState } from "react";
import { Devices } from "./devices.js";
import { accountFetch, setAccountCsrf } from "./account-transport.js";
import { request, readText } from "@agentlive/client/transport";

export function AccountControls({
  changed,
  leave,
}: {
  changed: (signedIn: boolean) => void;
  leave: () => Promise<void>;
}) {
  const [hosted, setHosted] = useState(false);
  const [name, setName] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [deviceCode, setDeviceCode] = useState("");
  const [deviceNotice, setDeviceNotice] = useState("");
  const [deviceRefresh, setDeviceRefresh] = useState(0);
  useEffect(() => {
    const stop = new AbortController();
    const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(15000)]);
    void (async () => {
      try {
        const config = await request(
          fetch,
          "/api/v1/auth-config",
          {},
          signal,
          4096,
        );
        if (JSON.parse(config.text).mode !== "hosted" || signal.aborted) return;
        setHosted(true);
        const response = await fetch("/auth/session", {
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal,
        });
        if (response.status === 401) {
          await response.body?.cancel();
          setAccountCsrf(undefined);
          changed(false);
          return;
        }
        if (!response.ok) throw new Error("Session unavailable");
        const data = JSON.parse(await readText(response, 16384, signal));
        if (
          typeof data.account?.displayName !== "string" ||
          data.account.displayName.length > 200 ||
          typeof data.csrf !== "string" ||
          !/^[a-f0-9]{64}$/.test(data.csrf)
        )
          throw new Error("Invalid session");
        if (signal.aborted) return;
        setAccountCsrf(data.csrf);
        setName(data.account.displayName);
        changed(true);
      } catch {
        if (!stop.signal.aborted)
          setError("Account status could not be loaded. Reload to retry.");
      }
    })();
    return () => {
      stop.abort();
      setAccountCsrf(undefined);
    };
  }, []);
  if (!hosted && !error) return null;
  return (
    <section aria-label="Account">
      {name ? (
        <>
          <p>Signed in as {name}</p>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setDeviceNotice("");
              const approve =
                (event.nativeEvent as SubmitEvent).submitter?.getAttribute(
                  "value",
                ) === "approve";
              try {
                await request(
                  accountFetch,
                  "/auth/device/decide",
                  {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ userCode: deviceCode, approve }),
                  },
                  AbortSignal.timeout(15000),
                  4096,
                );
                setDeviceNotice(
                  approve
                    ? "Device approved. Return to your terminal."
                    : "Device request denied.",
                );
                setDeviceCode("");
                setDeviceRefresh((value) => value + 1);
              } catch {
                setDeviceNotice(
                  "Device request could not be completed. Check the code and expiry before retrying.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <p>
              Link your CLI to this account. Approving grants access to your
              recordings and allows new publishing. Enter only a code from a
              login you started in your own terminal.
            </p>
            <label>
              Device code{" "}
              <input
                value={deviceCode}
                maxLength={32}
                required
                onChange={(event) => setDeviceCode(event.target.value)}
                autoComplete="off"
              />
            </label>
            <button type="submit" value="approve" disabled={busy}>
              Approve device
            </button>
            <button type="submit" value="deny" disabled={busy}>
              Deny device
            </button>
          </form>
          {deviceNotice && <p role="status">{deviceNotice}</p>}
          <Devices key={deviceRefresh} />
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await request(
                  accountFetch,
                  "/auth/logout",
                  { method: "POST" },
                  AbortSignal.timeout(15000),
                  4096,
                );
                setAccountCsrf(undefined);
                setName(undefined);
                changed(false);
                await leave();
              } catch {
                setError(
                  "Sign out could not be confirmed. Reload to check your session.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Signing out…" : "Sign out"}
          </button>
        </>
      ) : (
        hosted && <a href="/auth/login">Sign in</a>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
