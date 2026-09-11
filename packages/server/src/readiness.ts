import { access, stat, statfs } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

/** Read-only storage admission check, not a guarantee of the next durable write. */
export function storageReadiness(directory: string) {
  let pending: Promise<boolean> | undefined;
  return (): Promise<boolean> => {
    if (!pending) {
      const work = (async () => {
        const sessions = join(directory, "sessions");
        const [root, children, filesystem, rootAccess, childAccess] =
          await Promise.allSettled([
            stat(directory),
            stat(sessions),
            statfs(directory, { bigint: true }),
            access(directory, constants.R_OK | constants.W_OK | constants.X_OK),
            access(sessions, constants.R_OK | constants.W_OK | constants.X_OK),
          ]);
        return (
          root.status === "fulfilled" &&
          children.status === "fulfilled" &&
          filesystem.status === "fulfilled" &&
          rootAccess.status === "fulfilled" &&
          childAccess.status === "fulfilled" &&
          root.value.isDirectory() &&
          children.value.isDirectory() &&
          filesystem.value.bavail > 0n &&
          filesystem.value.bsize > 0n
        );
      })().catch(() => false);
      // Keep one in-flight probe even after callers time out. A stuck filesystem
      // must not create an unbounded backlog of new probe operations.
      const result = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 1000);
        void work.then((ready) => {
          clearTimeout(timer);
          resolve(ready);
        });
      });
      pending = result;
      void work.then(() => {
        if (pending === result) pending = undefined;
      });
    }
    // All callers share the same deadline result, including after timeout.
    // No new timers or promise handlers accumulate on a stalled filesystem.
    return pending;
  };
}
