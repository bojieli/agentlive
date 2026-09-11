import { useEffect, useRef, useState } from "react";
import { accountFetch } from "./account-transport.js";
import { request } from "@agentlive/client/transport";
type Device = { id: string; createdAt: number | null; expiresAt: number };
export function Devices() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const active = useRef<AbortController | undefined>(undefined);
  async function run(id?: string) {
    if (active.current) return;
    const stop = new AbortController();
    active.current = stop;
    setBusy(true);
    setError("");
    const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(15000)]);
    try {
      if (id)
        await request(
          accountFetch,
          "/auth/devices/revoke",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id }),
          },
          signal,
          4096,
        );
      const response = await request(
        accountFetch,
        "/auth/devices",
        {},
        signal,
        2 * 1024 * 1024,
      );
      const result = JSON.parse(response.text);
      if (
        !Array.isArray(result.devices) ||
        result.devices.length > 10000 ||
        result.devices.some(
          (item: Device) =>
            !item ||
            typeof item.id !== "string" ||
            !/^[a-f0-9]{32}$/.test(item.id) ||
            !Number.isSafeInteger(item.expiresAt) ||
            !(item.createdAt === null || Number.isSafeInteger(item.createdAt)),
        )
      )
        throw new Error("Invalid device list");
      if (!signal.aborted) setDevices(result.devices);
    } catch {
      if (!stop.signal.aborted)
        setError(
          "Device access could not be updated. Refresh before retrying an uncertain request.",
        );
    } finally {
      if (active.current === stop) {
        active.current = undefined;
        if (!stop.signal.aborted) setBusy(false);
      }
    }
  }
  useEffect(() => {
    void run();
    return () => {
      active.current?.abort();
      active.current = undefined;
    };
  }, []);
  return (
    <section aria-label="Approved CLI devices">
      <h2>Approved CLI devices</h2>
      <button disabled={busy} onClick={() => void run()}>
        Refresh devices
      </button>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Updating devices…</p>}
      {!busy && !error && devices.length === 0 && <p>No active CLI devices.</p>}
      <ul>
        {devices.map((device) => (
          <li key={device.id}>
            Device {device.id.slice(0, 8)} ·{" "}
            {device.createdAt === null
              ? "Approval time unavailable"
              : `Approved ${new Date(device.createdAt).toLocaleString()}`}{" "}
            · Expires {new Date(device.expiresAt).toLocaleString()}{" "}
            <button
              disabled={busy}
              aria-label={`Revoke device ${device.id.slice(0, 8)}`}
              onClick={() => void run(device.id)}
            >
              Revoke device
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
