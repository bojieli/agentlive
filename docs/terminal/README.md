# Terminal acceptance evidence

Run `node scripts/probe-terminal.mjs` after `node node_modules/typescript/bin/tsc -b --pretty false`. The probe requires Python 3 and a POSIX pseudo-terminal implementation. It creates a synthetic public recording and portable archive in a temporary directory, exercises the actual CLI, and removes the temporary recording afterward.

The [macOS report](pty-2026-09-10.json) records 14 passing checks against Node 26.8.1:

- Watch and offline replay enter raw input mode and accept fragmented CSI Left Arrow and SS3 Right Arrow sequences.
- Backward/forward steps select the expected text prefix; bracketed paste cannot invoke quit or seek controls.
- Event stepping remains functional after window-size changes and SIGWINCH at 120×40, 60×20, and 80×24.
- Replay exits with q; watch exits with Ctrl-C. Both restore the original terminal attributes.
- Redirected replay includes the recording text without ANSI escapes; redirected interactive replay explicitly rejects the missing terminal.

The source fixture includes a long line and an injected ANSI clear-screen sequence. The output must escape that source sequence. The viewer emits a scrolling transcript and delegates line wrapping to the terminal; it does not maintain a full-screen cursor layout.

The probe exposed and verified a fix for a replay race: input arriving during initial snapshot output must navigate from that snapshot's accepted event prefix, even before its output finishes draining.

This evidence proves POSIX terminal I/O and resize survival. It does not prove visual reflow in particular terminal emulators, screen-reader usability, Windows/WSL support, long-session responsiveness, or the production gate. The latest run writes `probe-results/terminal/report.json`.
