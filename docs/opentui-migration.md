# OpenTUI migration

Pappardelle now uses OpenTUI's React renderer and Bun for the CLI, development,
builds, tests, installer, updater, popup PTYs, and background status monitors.
Installed releases embed the runtime: neither Node nor a separate Bun is needed
to run them. Bun is required only for development, builds, and updates. Existing workspace, tracker, agent,
tmux, configuration, and status protocols remain in place.

## Design decisions

- **Native React components:** use OpenTUI `box`, `text`, `span`, `input`, and
  `textarea`, `useKeyboard`, `useRenderer`, and `useTerminalDimensions` directly.
  There is no Ink compatibility renderer. A small shortcut adapter keeps the
  application's existing, independently tested shortcut reducers.
- **Terminal ownership:** each terminal has its own `createCliRenderer` and React
  root. OpenTUI owns alternate-screen entry/exit, input decoding, mouse tracking,
  resizing, and incremental cell output. Popups use their own PTY streams and
  cannot terminate the rail process. The updater suspends the renderer before
  running the installer with inherited stdio. Confirmed tmux geometry is applied
  immediately, even before SIGWINCH arrives.
- **Native editing:** single-line search uses `input`; prompts use `textarea`.
  OpenTUI handles fragmented bracketed paste, Unicode editing, caret movement,
  scrolling, selection, undo/redo, and Kitty keyboard events. Enter submits the
  prompt; parent pickers retain Up/Down/Tab/Esc ownership. Existing readline and
  Alt-word shortcuts are explicitly bound. Parent value echoes preserve the
  caret, while completion replacements move it to the end. The custom raw-byte
  parser, CSI-u normalizer, and cursor reconciliation implementation are removed.
- **Mouse selection:** rows receive native click events and select by workspace
  identity. This covers both lines of two-line rows, ignores pending rows and
  non-left clicks, and avoids maintaining header/banner coordinate offsets.
- **Styling:** preserve ANSI palette indices and the terminal's default foreground
  so both dark and light themes work. Keep tracker RGB colors, emphasis, selected
  rows, emoji/tmux width handling, clipping, and dialog padding. Native titled
  borders add a short border segment before the title; dim titled boxes use
  native opacity. Actual CLI PTY captures at 80×24 were compared for the rail,
  help, and new-session prompt; narrow-pane and emoji layout tests use the native
  offscreen renderer.
- **Scheduling:** render on demand with a 60 FPS ceiling. Keep the shared,
  low-frequency application animation clock for spinner/blink states rather
  than scheduling every workspace at 60 Hz. A React error boundary keeps render
  failures visible and dismissible; Esc restores the terminal. Render failures
  are logged explicitly with their stack because Bun console writes bypass the
  stderr interceptor. OpenTUI captures reconciler console diagnostics with its
  console overlay kept closed (`openConsoleOnError: false`), preventing raw
  output from corrupting the application view. Input bindings are shared and
  common input props are memoized to avoid rebuilding keymaps on each keystroke.
- **Production packaging:** `bun run build` produces a native executable with
  Bun's ESM startup bytecode, production React, and embedded OpenTUI assets.
  It also produces a production JavaScript bundle with code splitting, linked
  source maps, and preserved function names for development/fallback. Minification
  removes whitespace and simplifies syntax; it does not rename identifiers.
  `bun run start`, `bun link`, and the installed shim prefer the executable.
  The slower alternatives remain reproducible benchmark modes, not competing
  default launch paths. The build no longer emits unused `.d.ts` distribution
  files; this package is a CLI, not a typed library.
- **Native resource and process paths:** compiled `import.meta` URLs point inside
  Bun's virtual filesystem. A shared runtime module resolves real scripts and
  package metadata relative to the executable instead. An internal monitor entry
  dispatches before UI initialization. Self-close and restart invoke the binary
  once, while updates restart through the installed shim. Direct `idow` launches
  discover the adjacent executable, so monitoring also works without Bun on PATH.
  Compiled releases do not autoload a workspace's `.env`, `bunfig.toml`, tsconfig,
  or package configuration.
- **Runtime installation:** retain macOS/Linux, x64/ARM64 support and staged
  installation/rollback. Builds require Bun 1.4.4+, which the installer can
  download privately and verify against the official SHA-256 checksum. x64
  runtime downloads and compiled executables use baseline targets. CI pins Bun
  1.4.4; OpenTUI packages are pinned together at 0.8.2. `node:` imports use APIs
  implemented by Bun; they do not launch or require Node.
- **What is standalone:** the executable embeds Bun, JavaScript/bytecode, and
  OpenTUI's native assets. Scripts, hooks, and package metadata remain ordinary
  files beside `dist/`. The existing clone-and-build installer retains its source
  checkout, build dependencies, and JavaScript fallback. A minimal runtime
  distribution could omit those dependencies: the relocation test runs from
  only the executable and package metadata with no Node, Bun, or `node_modules`.
  This PR does not introduce a cross-platform binary release/download pipeline.
- **Bun differences:** sort repository directory entries explicitly, preserve
  original subprocess launch errors when pipe draining also fails, and use
  Bun's module mocking for the lifecycle race test. Component fixtures capture
  completed native frames, avoiding reads while presentation owns the buffer.

## Performance

Seven alternating warm-cache runs on Linux x64 (AMD EPYC 9V74, 3 logical CPUs),
Node 24.22.1 / Ink 7.1.1 versus Bun 1.4.4 / OpenTUI 0.8.2. Values are
medians across runs; input percentiles pool all input samples.

| Metric                                     | Upstream Ink / Node | OpenTUI native bytecode |           Change |
| ------------------------------------------ | ------------------: | ----------------------: | ---------------: |
| Release build (ms)                         |            2,414.53 |                1,101.14 |      54.4% lower |
| Typecheck + release build (ms)             |            2,414.53 |                4,314.42 |     78.7% higher |
| CLI: first placeholder row, no layout (ms) |              447.94 |                   66.58 |      85.1% lower |
| CLI `--version` (ms)                       |              316.16 |                   27.30 |      91.4% lower |
| Render callbacks / second                  |               24.51 |                   61.51 | 2.51× throughput |
| Key handler → frame, median (ms)           |               4.568 |                   1.137 |      75.1% lower |
| Key handler → frame, p95 (ms)              |               5.854 |                   2.365 |      59.6% lower |
| Active render CPU, 2 seconds (ms)          |              987.48 |                  333.50 |      66.2% lower |
| Peak rendering-fixture RSS (MiB)           |              151.43 |                   87.09 |      42.5% lower |
| Short idle-window CPU, 1 second (ms)       |                0.37 |                   17.82 |   4676.7% higher |
| Terminal output, entire fixture (bytes)    |              37,801 |                  54,794 |     45.0% higher |

The release build includes both the executable and JavaScript fallback. Type
checking is separate in Bun and remains required: **check + build is slower**,
despite the faster artifact build. Native FPS is configured at 60; the measured
callback rate is slightly above 60 because of timer/frame-boundary granularity.
This is not a display refresh-rate measurement.

Input sample counts: 135 upstream and 133 native. The idle window runs
200–1,200 ms after mounting, so it includes any remaining terminal initialization;
it is not a long-duration power measurement. CPU in that window and total terminal
traffic increased. The latter also reflects substantially more presented frames.

The installed dependency trees in this environment occupy 104.1 MiB (upstream) and 140.9 MiB
(migration), including development dependencies. The existing installer retains
them for rebuilding and the JavaScript fallback, although the native runtime
does not need them. No installation-size reduction is claimed.

[Raw comparison samples](opentui-benchmark.json) include the measured commit IDs.

## Packaging comparison

Five alternating runs per mode. All times are milliseconds; CPU covers the
two-second render stress phase. RSS is the rendering fixture’s high-water mark.

| Packaging                            |  Build | Launch |  FPS | Input median | Active CPU | RSS MiB | Artifact MiB |
| ------------------------------------ | -----: | -----: | ---: | -----------: | ---------: | ------: | -----------: |
| Unbundled, development React         |   37.6 |  196.1 | 61.5 |         1.50 |      447.6 |   105.3 |         0.50 |
| Unbundled, production React          |   44.8 |  203.5 | 61.6 |         1.21 |      372.2 |    94.6 |         0.50 |
| Production bundle, core external     |  124.9 |  160.5 | 61.5 |         1.17 |      343.3 |    91.9 |         5.42 |
| Production bundle, core bundled      |  185.6 |  159.4 | 61.6 |         1.16 |      369.9 |    89.9 |        14.85 |
| Standalone, no bytecode              |  217.6 |  171.1 | 61.5 |         1.12 |      361.6 |    86.5 |       120.10 |
| **Standalone + bytecode (selected)** | 1010.8 |   65.8 | 61.6 |         1.14 |      334.5 |    87.8 |       127.92 |

| Packaging                            | Input p95 (ms) | Short idle CPU (ms) | Terminal bytes |
| ------------------------------------ | -------------: | ------------------: | -------------: |
| Unbundled, development React         |           2.64 |               12.89 |         54,794 |
| Unbundled, production React          |           2.32 |               11.92 |         54,794 |
| Production bundle, core external     |           2.30 |                8.73 |         54,794 |
| Production bundle, core bundled      |           2.43 |               10.75 |         54,794 |
| Standalone, no bytecode              |           2.23 |               17.13 |         54,794 |
| **Standalone + bytecode (selected)** |           2.34 |               12.64 |         54,794 |

Bytecode gives the strongest launch improvement, with similar steady-state
throughput to the other production modes. It adds executable size and compilation
time. Bundling OpenTUI core into JavaScript did not materially improve launch
over keeping its native/worker asset loading in the installed package. Native
bytecode is therefore the release default; the external-core bundle is the
debuggable fallback. JavaScript artifact sizes include their source maps where
emitted, but exclude Bun and installed dependencies. Native artifact sizes
include the runtime and native assets, so these size columns are not equivalent
deployment footprints.

[Raw packaging samples](opentui-packaging-benchmark.json) record every repetition.

The comparison includes unbundled modules with development and production React,
production bundles with OpenTUI core external or bundled, standalone without
bytecode, and standalone with bytecode. All use the same application source and
row workload. Build timing excludes fixture compilation; binary size includes
Bun, while JavaScript artifact sizes exclude the external runtime/dependencies.
The default release build also retains the JavaScript fallback, so its build
cost is slightly higher than compiling only the bytecode artifact.

```sh
python3 scripts/benchmarks/packaging.py --runs 5
```

Dependencies and matching Bun compiler runtimes are cached before timed runs.
The first native build can download its baseline compiler runtime. The packaging
script builds into temporary folders and removes them after the comparison.

## Reproduce

Install dependencies in an unmodified upstream checkout at
`b802bd7a4871b5ef9cf3d95b32c0cc34fa2b6847` with `npm ci`, and run its `npm run
build`. Install this branch with `bun install --frozen-lockfile` and `bun run
build`. The comparison requires Node only to run the historical baseline.

```sh
python3 scripts/benchmarks/benchmark.py --baseline /path/to/ink-checkout --runs 7
```

The harness alternates variants on each repetition, uses warm filesystem caches,
and creates isolated HOME/git repositories. Launch is process creation to the
first `main` placeholder row received from the CLI with `--no-layout` in an
80×30 PTY, using a tiny temporary repository. The placeholder is published before
main-worktree discovery completes; it does not mean that the workspace is ready.
`--version` is measured separately. No tmux layout setup, workspace session
creation/attachment, interactive shell initialization, agent startup/resume,
remote tracker calls, or network-dependent update check is included in launch
timing. These numbers are **not end-to-end cold-start workspace readiness**.

The rendering fixture uses each checkout's actual built `SpaceListItem`, with
20 equivalent rows and a changing selection. The native fixture compiles the
application's actual row component together with React/OpenTUI under the selected
packaging mode, preserving a single React instance. After startup it measures 1 second
idle, 2 seconds with 120 state-update requests per second, and 2.1 seconds of
PTY-delivered `j` input at approximately 10 keys/second. FPS counts framework
presentation callbacks, not a terminal emulator's physical refresh rate. Input
latency is from the application key callback to a presentation callback after
React renders that input; it excludes terminal input transport and display
scanout. CPU is process user+system time; RSS is the process high-water mark.
Output bytes include terminal setup, all phases, and teardown.

These are measurements of the combined **Ink/Node → OpenTUI/Bun migration** on
one Linux machine, not an isolated comparison of renderer libraries, cold-start
measurements, remote tmux performance, or a guarantee for every platform. The
stress fixture is intentionally busier than the normal status rail.

## Validation and limits

- Original upstream baseline: 2,604 AVA tests passed.
- Migrated full suite: 2,494 AVA tests passed with a failing `node` executable
  first on PATH, including install/update, process launch, provider, workspace,
  popup, rendering, native editor, mouse, and keyboard coverage. Removed tests
  targeted the deleted Ink parser/editor implementation. The compiled CLI also
  passed all 24 command tests after relocation. Native runtime checks cover
  launching without Bun/Node/node_modules, embedded monitor ownership and exit,
  and executable restart commands.
- Bun build, TypeScript checking, Prettier, and XO passed under the same Node
  trap. XO reports existing complexity/size warnings, with no errors.
- Real tmux status transport, lifecycle, cleanup, and full-App integrations passed,
  including native status transitions, ownership, stale-lease races, and teardown.
- All nine shell suites passed, including the sandboxed installer/shim check.
  Python hook tests: 194 passed, 2 skipped. The updated installer/shim suite
  passed 13 checks, including launch with the pinned Bun absent.
- Local execution was Linux x64. CI now includes Linux and macOS Bun jobs and
  repeats the Node trap. ARM64/macOS runtime and terminal-specific rendering
  need their CI/platform coverage; no local macOS result is claimed.
- External-service integration harnesses that create tracker issues or launch
  real agents were not run. Existing provider/unit coverage was retained.
- The upstream sync-back workflow also copies changes to a separate monorepo.
  Its maintainers should mirror Bun setup and the typecheck step in that
  monorepo's Pappardelle workflow when syncing this migration.
