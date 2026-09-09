import type { BrowserSession } from "./session.js";

/** Track elapsed presentation time only while the page is foregrounded. */
export class ForegroundClock {
  private previous: number;
  private active = true;
  interrupted = false;
  constructor(private readonly now: () => number = () => performance.now()) {
    this.previous = now();
  }
  reset() {
    this.previous = this.now();
    this.interrupted = false;
  }
  setActive(active: boolean) {
    this.active = active;
    this.reset();
  }
  elapsed() {
    const now = this.now();
    const gap = Math.max(0, now - this.previous);
    // A foreground tab can sleep without a visibility event. Do not fast-forward after an unobserved gap.
    this.interrupted = this.active && gap > 2000;
    const elapsed = this.active && !this.interrupted ? gap : 0;
    this.previous = now;
    return elapsed;
  }
}

/** Each mounted viewer owns and removes its own page lifecycle listeners. */
export function bindPageLifecycle(
  session: Pick<BrowserSession, "setActive" | "reconnect">,
  page: EventTarget & { readonly visibilityState: DocumentVisibilityState },
  windowEvents: EventTarget,
  clock: ForegroundClock,
) {
  let pageHidden = false;
  const update = () => {
    const active = !pageHidden && page.visibilityState === "visible";
    clock.setActive(active);
    session.setActive(active);
    return active;
  };
  const hide = () => {
    pageHidden = true;
    update();
  };
  const show = () => {
    pageHidden = false;
    if (update()) session.reconnect();
  };
  const revalidate = () => {
    if (update()) session.reconnect();
  };
  page.addEventListener("visibilitychange", revalidate);
  windowEvents.addEventListener("pagehide", hide);
  windowEvents.addEventListener("pageshow", show);
  windowEvents.addEventListener("online", revalidate);
  windowEvents.addEventListener("focus", revalidate);
  update();
  return () => {
    page.removeEventListener("visibilitychange", revalidate);
    windowEvents.removeEventListener("pagehide", hide);
    windowEvents.removeEventListener("pageshow", show);
    windowEvents.removeEventListener("online", revalidate);
    windowEvents.removeEventListener("focus", revalidate);
  };
}
