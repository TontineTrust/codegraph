# Haskell audit — 2026-09-18

This audit starts from `80b89692056381a4e95b2d855f8d3516a5b8535c` on
`TontineTrust/codegraph:feat/haskell-support-clean`, after PR #4 and the earlier
scope, provenance, traversal-budget and performance corrections. Package
version remains **1.6.0**. The [companion results JSON](haskell-audit-2026-09-18-results.json)
contains sanitized per-run evidence. Extraction revision advances from 28 to 29: rebuild
existing indexes to obtain the corrected scopes and import visibility.

The work uses a separate checkout, frozen built engines, and disposable public
corpus archives. It does not use private corpus sources or publish private
corpus identifiers. Results establish the specific behavior tested; they do
not establish absence of all vulnerabilities or complete Haskell semantics.

The final candidate fixes scoped bindings, import/export visibility, bounded
source reads and interrupted-store recovery. It passes 4,984 tests on macOS
(with the documented Liftoff test-worker setting) and Linux arm64. HLS median
indexing falls 54.1%, with 4.9% higher peak index RSS; all four comparable corpus
graphs retain existing edges. GHC core completes three times, while full GHC
still reaches the process cap and the examined GHC import proofs remain bounded
by export traversal. Windows and the prescribed Claude Sonnet/high agent A/B
could not be run. The limitations and raw numeric observations are retained below.

## Confirmed findings

| Impact | Reproduction | Correction |
|---|---|---|
| P1 resource exhaustion | A sparse oversized source is read before its size rejection; an indexed source that grows is also read in full by MCP. | Bounded descriptor reads reuse the existing 1 MiB extraction ceiling for the affected extraction and source-serving paths. Known oversized files allocate no source buffer; growth during a read consumes at most the ceiling plus one detection byte and is not parsed as partial source. Nonregular files are rejected and oversized markers remain recoverable. Viewer reads preserve their existing 8 MiB ceiling and caller-specific limits. |
| P1 resource exhaustion | Long legal dash operators and deeply parenthesized names cause quadratic import scanning/name normalization. | Consume dash runs once and unwrap parentheses in linear time with constant auxiliary memory; preserve malformed inputs and spelling. |
| P1 graph integrity | Interrupted chunk stores lose incoming references, or retain nodes removed from a replacement source. | Persist incoming references with deletion and an explicit incomplete-file checkpoint; reconcile replaced or removed partial stores before retry. |
| P1 graph integrity | An exception after extraction commits leaves warmed resolver caches stale; a no-delta recovery loses a newly valid link. | Invalidate resolver caches on failed full indexing and synchronization, as already done for `indexFiles`. |
| P2 incorrect edges | `case`-alternative `where` values/functions do not shadow surrounding bindings correctly. | Apply the alternative's binding scope to its guards and RHS. |
| P2 incorrect edges | Guard helpers escape to earlier/sibling guards; comprehension helpers capture earlier qualifiers; `where` helpers capture LHS view patterns or escape a value binding. | Record precise ranges and comprehension exclusions; resolve the innermost visible binding, including sequential lets. |
| P2 missing exports | `T(A), T(B)` overwrites the first child set. | Union repeated grouped exports. |
| P2 missing exports | A facade exporting `T(..)` or `O.T(..)` loses selected children imported through `T(Selected)` or separate `type T, pattern Selected` entries. | Preserve the visible subset and its parent/namespace restrictions. |
| P2 false callback flow | Imports such as `Prelude (Maybe(..))` or `Prelude hiding (Functor(..))` incorrectly prove canonical `map`/`fmap`. | Carry import/export visibility through origin proofs, including defining class ownership and alternative routes. |
| P2 missing calls / repeated work | Expanding individually imported children into several `T(..)` facade routes repeats equivalent walks, exhausting 10,000 visits and losing four valid HLS `kick` calls in the pre-review candidate. | Walk equivalent source/name/namespace routes once with a union of allowed owners; preserve parent resets, wildcard intersections, ambiguity and conservative exhaustion. |
| P2 namespace leakage | A bare upper-case import or qualified facade can expose a constructor that the type-only import/export excludes. | Preserve Haskell type/value namespace rules. |

P1/P2 express prioritization within this local code-intelligence threat model,
not a CVSS score. Hostile repository inputs can stall the local indexing/MCP
process; the tested resource issues do not demonstrate remote code execution.

## Validation design

The prior reports, and commits `82eca65`, `9bb2af4`, `b977b39`, and `80b8969`,
were read before changes. Existing limits remain: re-export depth 64 for
Haskell, shared work budget 10,000 visits, and conservative failure when a
proof exhausts that budget. No speedup is credited to lowering these limits.

Each completed configuration has at least three runs. Indexing, phase timing,
RSS, three no-change syncs, comment/body/import/export edits and restoration,
actual `codegraph_explore` Flow text, full semantic node/edge fingerprints,
and SQLite integrity are measured separately. HLS now repeats all four edit
kinds in all three runs, unlike the earlier report's single edited HLS run.
GHC uses both the core (testsuite excluded) and full source scopes. A first
incomplete capped attempt is retained and is not replaced with a successful
sample. GHC and Express skip source edits; Haskell fixtures separately cover
incremental semantics and recovery.

Timing phases emitted as `parsing` include parser-worker startup, storage and retries;
they are not isolated parser CPU time. `resolution-and-synthesis` wraps the
actual engine method. Fresh copies do not imply cold OS caches. Measurements
run serially; builds, tests, and diagnostic profiles run outside measured
workloads. Arms are measured in separate chronological batches, without OS
cache flushing or randomized interleaving; host/cache variation is not isolated. A scheduler-only pause after baseline HLS run 1 does not interrupt
the measured child; scheduler elapsed time for that one run is not used.

The 600-second ceiling applies to the entire harness process, including
initialization and subsequent sync/edit/query/check phases, not to indexing
alone. On timeout the scheduler sends SIGTERM, allows five seconds for cleanup,
then uses SIGKILL if needed. Completed-run indexing RSS is the process
high-water mark captured when `indexAll` returns; it includes earlier startup
and extraction work and is not a phase-isolated peak or a sum over descendant
processes. Interrupted-run RSS is the process high-water mark at interruption.

## Public corpus inventory

Tracked inventory precedes filtering and is not the indexed-file count. Git
submodules and corpus dependencies are not initialized. GHC core excludes only
`testsuite/`; the full scope includes it. Every archive retains tracked ignore
files and starts without `.git` or `.codegraph`.

| Corpus | Revision | Tracked files | `.hs` / `.lhs` |
|---|---|---:|---:|
| xmonad | `1a875b3413e72a766ce2b1d4c39b8f796c1ac311` | 63 | 30 / 1 |
| pandoc | `b913622e1ff87c69ab8b1a606577122e220925cd` | 2,842 | 367 / 0 |
| hls | `c98343b869786994a0ece7830910551bd8a0c195` | 1,945 | 1,443 / 7 |
| express | `3ce6d0eb86e9d93529ff3191c6bb5db8ce6e72c8` | 214 | 0 / 0 |
| ghc | `82c73b223a985bc0bcc00cb6252b2b535082d831` | 26,973 | 14,014 / 28 |

## Reproduction

The checked-in `scripts/benchmarks/haskell-audit-corpora.json` pins every public
revision, all 15 query strings (GHC's three queries in both scopes), and exact
edit substitutions. `haskell-audit-matrix.py` clones pinned revisions read-only,
archives disposable copies, sanitizes profiling settings, sets
`CODEGRAPH_KERNEL=0`, and runs one workload at a time with a 600-second cap.

Build independent baseline and candidate checkouts with `npm ci` and
`npm run build`; keep their `dist/` trees unchanged throughout measurement.

```sh
python3 scripts/benchmarks/haskell-audit-matrix.py /absolute/baseline-engine /new/baseline-results
python3 scripts/benchmarks/haskell-audit-matrix.py /absolute/candidate-engine /new/candidate-results
node scripts/benchmarks/haskell-compare-graphs.cjs BASE_DB CANDIDATE_DB NEW_COMPARISON.json
node scripts/benchmarks/haskell-import-scan.cjs /absolute/baseline-engine /new/baseline-hostile.json
node scripts/benchmarks/haskell-import-scan.cjs /absolute/candidate-engine /new/candidate-hostile.json
node scripts/benchmarks/haskell-import-scan.cjs /absolute/baseline-engine /new/baseline-normalize.json normalize
node scripts/benchmarks/haskell-import-scan.cjs /absolute/candidate-engine /new/candidate-normalize.json normalize
```

For the separate HLS diagnostic, archive the pinned HLS revision into another
fresh directory and copy its manifest options with `skipSyncEdits: true`.
Run the following once per engine, outside the normal matrix:

```sh
CODEGRAPH_KERNEL=0 CODEGRAPH_NO_PARALLEL_RESOLVE=1 HASKELL_PROFILE=1 \
CODEGRAPH_RESOLVE_PROFILE=2 CODEGRAPH_SYNTH_TIMINGS=1 \
node --cpu-prof --cpu-prof-dir=/new/profile-output \
  --cpu-prof-name=hls.cpuprofile scripts/benchmarks/haskell-corpus.cjs \
  /absolute/engine /fresh/hls-archive /new/profile.json /absolute/profile-options.json
```

Use inactive copies of both database files and any nonempty WAL files for
`BASE_DB` and `CANDIDATE_DB`. Read-only SQLite can create coordination sidecars;
the audit never opens the original measured database for these comparisons.
The comparison script uses `node:sqlite` (Node 22+); this campaign uses Node 24.

The graph comparison excludes only node timestamps and surrogate edge IDs;
all other node fields, edge positions, metadata and provenance participate.
It uses `EXCEPT` plus row counts, so row changes are not inferred from counts.
The harness's ordered hashes additionally preserve multiplicity.

The commands above reproduce raw measurement JSON; the companion results file
contains the sanitized summaries and per-run observations from this campaign.
Campaign-specific staging and aggregation are not required to run the published
measurement protocol. Raw outputs contain local paths and should be reviewed
before sharing.

The supplemental diagnostics are also checked in. Stop all measured processes
first and keep each indexed corpus inactive throughout the probes. Use a new
output filename for every invocation. The Flow/health helpers internally copy
the database and WAL, enforce their documented process/memory/input caps, and
verify that the originals remain unchanged. `GHC_OPTIONS` is the generated
`ghc-core-1.options.json` (its three queries also apply to full GHC).

```sh
node scripts/benchmarks/haskell-supplemental-flows.cjs ENGINE XMONAD_ROOT NEW_XMONAD.json
node scripts/benchmarks/haskell-ghc-flow-diagnostics.cjs ENGINE GHC_ROOT GHC_OPTIONS NEW_GHC_FLOW.json
GHC_RESOLVER_PROBE=1 GHC_EXPLORE_EVIDENCE=NEW_GHC_FLOW.json \
  node scripts/benchmarks/haskell-ghc-flow-diagnostics.cjs ENGINE GHC_ROOT GHC_OPTIONS NEW_GHC_TRACE.json
node scripts/benchmarks/haskell-ghc-snapshot-health.cjs GHC_ROOT NEW_GHC_HEALTH.json
node scripts/benchmarks/haskell-classify-graph-deltas.cjs hls BASE_DB_COPY CANDIDATE_DB_COPY NEW_HLS_DELTAS.json
```

Run the GHC commands separately for each engine and scope. The trace is an
in-memory, return-preserving instrumentation of the pinned built resolver;
it checks its expected marker and requires matching actual-explore evidence.
It neither modifies the engine nor repairs the index. The classifier supplements
the exact SQL comparison with every differing edge identity, metadata and
provenance; independent source review still determines whether changes are valid.

## Engine identity and validation

Final candidate production code and regression tests: `f4dc4df79d5b83cd1d5f8de8cf773ecb40094bb1`.
Final candidate run tags start with `candidate-final-`; the earlier `8e7be8e` and
`bf3ff869` engines and measurements are retained as historical diagnostics and
excluded from final performance summaries. The row-level graph review found and
corrected the four-call regression before this final campaign.
The normal campaign uses frozen compiled engines. SHA-256 covers sorted relative
`dist/` paths followed by a NUL and their bytes, for every file:

| Engine | Compiled files | Dist SHA-256 |
|---|---:|---|
| baseline | 1038 | `b4684753bb251e9b35651f9d09ea122bb8fc72b0fb075ea96f4b3bc2213e9c5e` |
| candidate | 1042 | `97a94b36cba528c1d3776c368ebe9e33ac4fa368a382f427595ad0c001c9b559` |

The final macOS explicit-workspace suite passes **4,984 tests**, with
**192 skipped**, across **279 passing and 16 skipped files** in **81.76 seconds**,
using `--liftoff-only` in the test-worker configuration. This is a qualified
runtime result, not a pass under default macOS V8 settings. Validation history:
an outdated `readFileSync` injection was moved to the bounded descriptor open,
preserving the transient read-failure/retry assertion; an earlier revision then
passed 4,955 tests. Before the parent-route correction, the default run reported
4,953 passed tests but one extraction worker aborted with V8 `Fatal process out of
memory: Zone`. The unchanged baseline reproduces the same failure after
641/657 extraction tests. Direct worker configuration with `--liftoff-only`
passes all 657; a first external-config full attempt then missed the Svelte
workspace plugin, so its UI suite failed despite passing engine tests. The
corrected explicit-workspace run supplies the final result above, including
all 16 UI tests. The baseline control establishes a pre-existing failure in
this environment, not a universal upstream V8 diagnosis. The Liftoff setting
is not used in corpus timings. Build and viewer/grammar asset checks pass.

To reproduce the macOS test setting, use a temporary root config that imports
`vitest.config.mts` and overrides only the fork pool:

```js
import base from '/absolute/checkout/vitest.config.mts';
export default {
  ...base,
  test: {
    ...base.test,
    pool: 'forks',
    poolOptions: { forks: { execArgv: ['--liftoff-only'] } },
  },
};
```

From the checkout, run:

```sh
node node_modules/vitest/vitest.mjs run --config /absolute/temporary-config.mjs \
  --workspace vitest.workspace.mts --maxWorkers=4 --minWorkers=1
```

Selecting the workspace explicitly preserves the UI's Svelte plugin and jsdom.
The CLI already uses the documented Liftoff runtime mitigation; no production
runtime flags were changed for this audit.

The source-package `npm pack` archive is **8,849,097 bytes** (**83,721,173 unpacked**),
version **1.6.0**, with shasum `06598ebff9f1d29ab0c6c7247cfe1b0af2e4a953`.
Its extracted source reader, viewer, schema, 30 grammars and required license
assets are checked, and its CLI reports 1.6.0 using the isolated checkout's
installed dependencies through `NODE_PATH`. This is an extracted-package
smoke check, not a clean consumer installation. The packaged `dist/` fingerprint
equals the measured final engine. The four
standalone diagnostic scripts added after engine validation were syntax-checked
and exercised on the final snapshots; they do not change production `dist/`.
The source package is **not published**; this check does not claim all
release-runtime bundles were exercised.

Linux arm64 (Docker, kernel 6.12.76-linuxkit, Node 22.23.2, npm 10.9.8,
8 CPUs): the final build and full suite pass **4,984 tests**, with **192 skipped**,
across **279 passing and 16 skipped files** in **73.31 seconds**. Windows
validation is unavailable: no Parallels CLI or configured guest is present.
No Windows execution is claimed; the other platforms do not validate Windows
file, symlink, lock, or process semantics.

## Environment and prerequisites

macOS Darwin 25.6.0 / arm64, Apple M5 Pro, 18 logical CPUs, 48 GiB RAM,
Node 24.18.0, npm 11.16.0. Docker 29.6.2 is available. GHC 9.10.3 is available
for checking namespace fixture validity; corpus Haskell packages are not built.
The engine uses the WASM extraction path in this campaign.

The `agent-eval` skill was applied with the already-selected local version,
Haskell/public corpus and automated harness. Its global-install wrapper was
not used because this task requires isolated installations. The repository's
actual A/B policy is Claude **Sonnet / high**, at least two trials per arm,
with CLI contamination checks and persistent daemon prewarming. Rechecking
PATH and conventional installation locations found no `claude`; `tmux` is
also absent. Neither an Anthropic API/auth token nor a conventional Claude
credential file is configured (only presence was checked, no secret read).
The available Codex CLI is not the prescribed model/host and is
not substituted. No A/B, agent latency, tool-displacement, cost, or sufficiency
result is claimed.

Actual tool-output probes are not a substitute for that agent evaluation and
do not establish a zero-Read/Grep outcome.

## Results

The final matrix retains **30 attempts: 27 complete and three capped**. Both
engines complete three xmonad, Pandoc, HLS and Express runs. The candidate also
completes all three GHC-core runs; neither full-GHC arm completes. Six omitted
GHC repetitions are explicitly unrun under the first-incomplete-attempt rule.
The earlier measured candidates remain historical evidence only.

The baseline GHC-core attempt reaches the 600-second process cap during
resolution, with its last progress event at 496,224 of 573,754 references.
Parsing accounts for 34.369 seconds; interrupted-process peak RSS is
4,879.1 MiB. Its partial graph is retained. The September 15 report used an
older engine; its completed timings cannot replace this newer baseline.

The final candidate completes GHC core in all three runs, with median initial
indexing **516.345 s [512.218–557.163]** and peak index RSS **5,409.6 MiB
[5,404.2–5,607.7]**. Each has 2,795 files, 117,910 nodes and 278,302 edges, with
identical full semantic fingerprints. Whole verification processes take
525.235, 521.094 and 566.805 seconds. No completed-baseline speedup ratio or
cross-arm GHC graph parity is claimed: the baseline is incomplete and the
extracted reference sets also differ.

Both full-GHC attempts reach the 600-second process cap during resolution.
Baseline parsing takes 381.532 seconds, its last progress event is
188,483/793,937 references and interrupted-process peak RSS is 3,956.2 MiB.
The final candidate records 386.798 seconds of parsing, 193,483/793,438 at its
last progress event, and 4,501.3 MiB peak RSS at interruption. These are partial
workload observations, not completed-index timings or coverage comparisons.

<!-- AUDIT_METRICS_START -->
### Completed timing and incremental checks — final campaign

Only `baseline` and `candidate-final` are included. Values are median
[minimum–maximum] of completed eligible verification runs; sample counts are
explicit. Capped, failed and incomplete runs are excluded from these timing
distributions. Peak index RSS includes startup. A dash means no eligible sample.

| Corpus | Arm | Complete / attempts | Index s | Parsing phase s | Resolution + synthesis s | Peak index RSS MiB | No-change s, median of per-run medians |
|---|---|---:|---:|---:|---:|---:|---:|
| xmonad | baseline | 3/3 | 0.883 [0.685–1.054] | 0.489 [0.400–0.669] | 0.299 [0.217–0.317] | 526.6 [521.0–527.4] | 0.064 [0.060–0.068] |
| xmonad | candidate-final | 3/3 | 0.608 [0.561–0.621] | 0.342 [0.303–0.351] | 0.197 [0.196–0.219] | 524.2 [509.8–524.9] | 0.055 [0.055–0.056] |
| pandoc | baseline | 3/3 | 16.100 [16.035–16.201] | 6.525 [6.507–6.692] | 9.321 [9.293–9.329] | 1609.0 [1599.3–1613.2] | 0.120 [0.114–0.124] |
| pandoc | candidate-final | 3/3 | 10.877 [10.740–11.010] | 4.864 [4.783–4.903] | 5.818 [5.775–5.920] | 1662.4 [1623.9–1692.2] | 0.105 [0.105–0.106] |
| hls | baseline | 3/3 | 53.135 [49.983–55.755] | 4.704 [4.502–5.756] | 48.262 [45.325–49.716] | 1628.2 [1617.7–1631.7] | 0.134 [0.129–0.258] |
| hls | candidate-final | 3/3 | 24.377 [24.069–24.803] | 3.747 [3.716–3.923] | 20.299 [20.203–20.902] | 1707.8 [1699.8–1720.9] | 0.127 [0.122–0.131] |
| express | baseline | 3/3 | 0.580 [0.556–0.624] | 0.243 [0.226–0.287] | 0.263 [0.258–0.264] | 436.9 [435.1–449.6] | 0.071 [0.070–0.072] |
| express | candidate-final | 3/3 | 0.526 [0.525–0.546] | 0.205 [0.198–0.229] | 0.249 [0.248–0.257] | 439.9 [431.2–443.4] | 0.061 [0.060–0.062] |
| ghc-core | baseline | 0/1 | — | — | — | — | — |
| ghc-core | candidate-final | 3/3 | 516.345 [512.218–557.163] | 26.587 [26.575–26.587] | 489.199 [485.081–529.992] | 5409.6 [5404.2–5607.7] | 0.289 [0.283–0.305] |
| ghc | baseline | 0/1 | — | — | — | — | — |
| ghc | candidate-final | 0/1 | — | — | — | — | — |

| Corpus | Arm | Edit | n | Edit s | Restoration s | Restorations equal / checked |
|---|---|---|---:|---:|---:|---:|
| xmonad | baseline | comment | 3 | 0.144 [0.141–0.146] | 0.097 [0.097–0.101] | 3/3 (unknown 0) |
| xmonad | baseline | body | 3 | 0.097 [0.095–0.107] | 0.095 [0.095–0.096] | 3/3 (unknown 0) |
| xmonad | baseline | import | 3 | 0.251 [0.226–0.262] | 0.212 [0.212–0.217] | 3/3 (unknown 0) |
| xmonad | baseline | exportDefinition | 3 | 0.208 [0.206–0.208] | 0.205 [0.205–0.261] | 3/3 (unknown 0) |
| xmonad | candidate-final | comment | 3 | 0.122 [0.120–0.122] | 0.088 [0.088–0.089] | 3/3 (unknown 0) |
| xmonad | candidate-final | body | 3 | 0.088 [0.087–0.088] | 0.088 [0.087–0.089] | 3/3 (unknown 0) |
| xmonad | candidate-final | import | 3 | 0.200 [0.199–0.204] | 0.196 [0.185–0.197] | 3/3 (unknown 0) |
| xmonad | candidate-final | exportDefinition | 3 | 0.186 [0.185–0.188] | 0.185 [0.182–0.185] | 3/3 (unknown 0) |
| pandoc | baseline | comment | 3 | 0.217 [0.210–0.274] | 0.174 [0.166–0.194] | 3/3 (unknown 0) |
| pandoc | baseline | body | 3 | 0.156 [0.147–0.180] | 0.164 [0.142–0.171] | 3/3 (unknown 0) |
| pandoc | baseline | import | 3 | 4.190 [4.116–4.440] | 4.075 [4.074–4.209] | 3/3 (unknown 0) |
| pandoc | baseline | exportDefinition | 3 | 4.155 [4.004–4.189] | 4.087 [4.045–4.563] | 3/3 (unknown 0) |
| pandoc | candidate-final | comment | 3 | 0.192 [0.190–0.199] | 0.150 [0.148–0.150] | 3/3 (unknown 0) |
| pandoc | candidate-final | body | 3 | 0.134 [0.134–0.134] | 0.133 [0.132–0.134] | 3/3 (unknown 0) |
| pandoc | candidate-final | import | 3 | 3.275 [3.260–3.302] | 3.050 [3.036–3.089] | 3/3 (unknown 0) |
| pandoc | candidate-final | exportDefinition | 3 | 3.071 [3.034–3.072] | 3.173 [3.131–3.191] | 3/3 (unknown 0) |
| hls | baseline | comment | 3 | 0.203 [0.201–0.377] | 0.147 [0.145–0.234] | 3/3 (unknown 0) |
| hls | baseline | body | 3 | 0.128 [0.125–0.197] | 0.132 [0.126–0.228] | 3/3 (unknown 0) |
| hls | baseline | import | 3 | 41.110 [37.001–47.093] | 37.619 [35.183–47.656] | 3/3 (unknown 0) |
| hls | baseline | exportDefinition | 3 | 38.563 [36.189–39.856] | 36.909 [35.242–40.371] | 3/3 (unknown 0) |
| hls | candidate-final | comment | 3 | 0.175 [0.174–0.177] | 0.138 [0.132–0.139] | 3/3 (unknown 0) |
| hls | candidate-final | body | 3 | 0.118 [0.117–0.119] | 0.119 [0.117–0.120] | 3/3 (unknown 0) |
| hls | candidate-final | import | 3 | 16.058 [15.482–16.116] | 15.702 [15.688–15.846] | 3/3 (unknown 0) |
| hls | candidate-final | exportDefinition | 3 | 15.865 [15.704–15.952] | 16.071 [15.615–16.406] | 3/3 (unknown 0) |

| Corpus | Metric | Candidate-final median change vs baseline | Observed ranges overlap |
|---|---|---:|---|
| xmonad | indexMs | -31.2% | no |
| xmonad | indexMaxRSSMiB | -0.5% | yes |
| xmonad | noChangeMedianMs | -13.6% | no |
| pandoc | indexMs | -32.4% | no |
| pandoc | indexMaxRSSMiB | +3.3% | no |
| pandoc | noChangeMedianMs | -12.7% | no |
| hls | indexMs | -54.1% | no |
| hls | indexMaxRSSMiB | +4.9% | no |
| hls | noChangeMedianMs | -5.7% | yes |
| express | indexMs | -9.3% | no |
| express | indexMaxRSSMiB | +0.7% | yes |
| express | noChangeMedianMs | -13.6% | no |

Positive changes mean larger values; negative changes mean smaller values.
Range overlap is descriptive and does not establish statistical significance.
The campaign does not isolate causes of allocation or timing differences.
Small absolute timings should not be generalized as universal speedups.

Per-attempt fingerprints, restoration outcomes, integrity checks and actual
ToolHandler Flow presence remain in the companion results JSON (`normalMatrix`).
Graph equality across engines requires the separate exact row comparison;
counts alone do not establish it. Before-close DB/WAL snapshots do not measure
post-checkpoint disk growth.

HLS median indexing falls from 53.135 to 24.377 seconds (**54.1% less**), while
peak index RSS rises from 1,628.2 to 1,707.8 MiB (**4.9% more**). Pandoc's median
falls from 16.100 to 10.877 seconds, with **3.3% more** peak index RSS. These
are observed local tradeoffs; the campaign does not isolate their causes.
All **81 no-change checks** and **72 edit restorations** preserve their initial
semantic graph. Every completed engine/corpus group has identical fingerprints
across its three repetitions. All 27 completed runs pass the harness's SQLite
quick checks, foreign-key and orphan-edge checks.
<!-- AUDIT_METRICS_END -->

### Diagnostic CPU profile — final campaign

Separate HLS diagnostics use sequential resolution, V8 CPU profiling and
origin counters. These runs are excluded from normal benchmark medians.
Main-thread samples do not measure worker CPU. Each diagnostic includes
three no-change syncs, graph checks and Flow queries, with edits disabled.

| Tag | Index s | Whole report elapsed s | Main-thread sampled s |
|---|---:|---:|---:|
| baseline-hls-1-profile | 86.832 | 89.305 | 89.320 |
| candidate-final-hls-1-profile | 44.588 | 46.763 | 46.778 |

| Main-thread frame | Baseline sampled self time | Candidate-final sampled self time |
|---|---:|---:|
| `findExportedSymbolWalk` | 50.036 s | 18.483 s |
| `resolveImportPath` | 13.583 s | 8.738 s |
| `haskellReExportCouldExposeName` | 7.796 s | 3.079 s |
| `getHaskellVisibilityIndex` | Not in retained frames | 3.416 s |
| `normalizeHaskellReferenceName` | 0.207 s | 0.109 s |
| `stripHaskellComments` | 0.204 s | 0.105 s |

The table sums matching names among the retained top frames only.
An unlisted frame is not evidence of zero cost. Sampled self time can
move into a helper after refactoring; the parent frame alone cannot
establish a net performance gain.

| Tag | Counter | Calls | Unique file/name pairs | Total ms | Maximum ms |
|---|---|---:|---:|---:|---:|
| baseline-hls-1-profile | `haskellCombinatorHasCanonicalOrigin` | 1077 | 397 | 50.338 | 1.293 |
| baseline-hls-1-profile | `haskellEffectHeadHasCanonicalOrigin` | 5 | 5 | 0.403 | 0.148 |
| candidate-final-hls-1-profile | `haskellCombinatorHasCanonicalOrigin` | 1077 | 397 | 35.894 | 0.562 |
| candidate-final-hls-1-profile | `haskellEffectHeadHasCanonicalOrigin` | 5 | 5 | 0.307 | 0.107 |

Instrumented counters overlap sampled frames and must not be added to
sampled CPU or wall time. This single sequential diagnostic is not a
normal-run median and does not by itself establish causal attribution.
Hostile-input measurements are summarized independently in
the next section and companion results JSON (`hostileScaling`). No previous-candidate data is used.

The visibility optimization compiles immutable import/re-export name lists and
parent constraints into weakly owned indexes. The visibility lookup preserves
namespace predicates and cache invalidation;
14 parity tests also pass against the prior implementation. The subsequent
parent-route correction groups equivalent walks using an OR of owner constraints.
Named hops replace these constraints and selected wildcards intersect them.
Its 15 tests cover namespace/package separation, hiding, ambiguity, reset and
intersection rules, and failure when a different branch exhausts
the unchanged budget. Neither optimization memoizes recursive walk results.
On the four HLS `kick` references, the old facade expansion spent over 10,000
visits; the final resolver succeeds in 6,300 or 6,309 visits. Original re-export
records remain intact for canonical-origin proofs. The new lookup frame's cost is
reported explicitly; lower `findExportedSymbolWalk` self time alone would not
prove a net gain.

The earlier report’s canonical-origin bottleneck is not reproduced on this
baseline: its measured counters total about 50 ms, while export-walk samples
dominate this diagnostic. No callback proof was disabled for these measurements.

### Hostile-input scaling — final campaign

Only `baseline` and `candidate-final` are included. Three isolated child
processes are recorded per size and engine, with a 3 s process timeout and a
256 MiB heap cap configured by the benchmark script. Values are operation-time
median [minimum, maximum] among completed samples, in milliseconds; startup is
excluded. Incomplete sets retain their explicit completion and failure counts.
Timeouts are reported separately and excluded from operation-time statistics.

| Probe | Size | Baseline | Candidate-final |
|---|---:|---|---|
| Dash operator | 1,024 | 10.890 [10.199, 13.576] ms; 3 complete; checks pass | 7.928 [7.922, 7.948] ms; 3 complete; checks pass |
| Dash operator | 4,096 | 21.150 [20.485, 21.242] ms; 3 complete; checks pass | 8.100 [8.094, 8.196] ms; 3 complete; checks pass |
| Dash operator | 16,384 | 198.086 [194.962, 201.576] ms; 3 complete; checks pass | 8.030 [7.839, 8.561] ms; 3 complete; checks pass |
| Dash operator | 65,536 | —; 3 timeout; checks not completed | 9.160 [8.813, 11.991] ms; 3 complete; checks pass |
| Parenthesis depth | 1,024 | 7.575 [5.860, 9.808] ms; 3 complete; checks pass | 2.238 [2.206, 2.263] ms; 3 complete; checks pass |
| Parenthesis depth | 4,096 | 51.969 [51.685, 53.373] ms; 3 complete; checks pass | 2.579 [2.535, 2.596] ms; 3 complete; checks pass |
| Parenthesis depth | 16,384 | 811.854 [799.979, 1201.484] ms; 3 complete; checks pass | 3.634 [3.612, 3.924] ms; 3 complete; checks pass |
| Parenthesis depth | 65,536 | —; 3 timeout; checks not completed | 6.081 [6.055, 6.371] ms; 3 complete; checks pass |

The gains above concern isolated hostile inputs, not whole-corpus speedups.
The normalization regression suite compares 19,531 short combinations with the
prior behavior and separately covers malformed and deeply nested inputs.

### Namespace fixture validity

GHC 9.10.3 checks the same minimal `data T = T Int` source under
`Haskell2010`, `ExplicitNamespaces`, `PatternSynonyms`, `DataKinds`, and
all three extensions together. Across 20 compile checks, `import Origin (T)` admits the type but
rejects the term-level constructor, while `T(..)` and explicit
`type T, pattern T` imports admit their appropriate namespaces. Two existing
positive tests used invalid bare imports; their inputs now import the
constructors explicitly, retaining the original edge assertions.

### Exact semantic graph comparison

Every completed cross-arm corpus has the same node identities and source
coordinates. Exact SQL comparison checks all node columns except timestamps
and all edge fields except surrogate IDs, including metadata and provenance.

| Corpus | Nodes | Edges, baseline → final | Changed node records | Added / removed / modified edges |
|---|---:|---:|---:|---:|
| xmonad | 1,075 | 3,220 → 3,220 | 67 lexical-range annotations | 0 / 0 / 0 |
| Pandoc | 18,498 | 67,145 → 67,178 | 1,384 lexical-range annotations | 33 / 0 / 0 |
| HLS | 22,128 | 45,101 → 45,108 | 970 lexical-range annotations | 7 / 0 / 0 |
| Express | 1,124 | 3,154 → 3,154 | 0 | 0 / 0 / 0 |

The complete enumeration finds no changed node field except `decorators`, and
within those arrays only `haskell-lexical-range` entries differ. xmonad replaces
59 existing ranges and adds eight; Pandoc replaces 964 and adds 420; HLS replaces
810 and adds 160. These are extraction scope changes, not node identity churn.
Express has exact semantic node-and-edge parity.

All 33 Pandoc additions are source-reviewed uses of `Text.XML.Light`'s `Content.Text`,
visible through `Content(..)`. `Data.Text (Text)` is a type-only alternative and
must not capture these value references. The additions comprise 26 references,
five constructor calls and two synthesized combinator calls; those last two
retain their **heuristic** provenance. HLS adds five pattern references to
`GhcSessionDeps`, one `GetParsedModule` constructor reference and one `ShakeExtras`
record-pattern reference through their documented import/export routes. Every
final added edge matches the independently reviewed source site, target,
metadata and provenance from the prior pinned-source review. This is static
source evidence; the corpus packages were not compiled.

The historical `bf3ff86` graph had additionally lost four valid calls to
`Test.Hls.kick`. Comparing that graph to the final graph finds exactly those
four restored calls, no other edge changes and no node changes. Their identities,
metadata and provenance match the baseline, at Cabal `Utils.hs:82,85` and HLint
`Main.hs:360,363`. The final graph therefore retains the seven valid new HLS
references without the pre-review recall regression.

Full `integrity_check` and `foreign_key_check` pass for the copied databases
used in all five pair comparisons. Original database/WAL hashes, sizes and
mtimes remain unchanged. The companion JSON contains the exact counts, every
added edge and restored-call evidence; graph parity is not inferred from totals.

### Actual Flow per historical prompt

Presence is shown as surfaced/executed repetitions, followed by the distinct
step counts. A dash means the query was not reached. Errors and truncation below
refer to tool errors and the retained Flow excerpt; the normal harness did not
record full-response truncation notices. Supplemental probes are reported separately.

| Corpus / query | Baseline presence; steps | Candidate-final presence; steps | Tool errors, baseline/final | Truncated Flow excerpts, baseline/final |
|---|---|---|---|---|
| xmonad: `manage float windows` | 0/3; 0 | 0/3; 0 | 0/0 | 0/0 |
| xmonad: `kill withFocused killWindow` | 0/3; 0 | 0/3; 0 | 0/0 | 0/0 |
| xmonad: `refresh windows modifyWindowSet` | 0/3; 0 | 0/3; 0 | 0/0 | 0/0 |
| pandoc: `readMarkdown readWithM parseMarkdown` | 0/3; 0 | 0/3; 0 | 0/0 | 0/0 |
| pandoc: `writeHtml5 writeHtml' pandocToHtml` | 3/3; 3 | 3/3; 3 | 0/0 | 0/0 |
| pandoc: `writeLaTeX pandocToLaTeX blockListToLaTeX` | 3/3; 3 | 3/3; 3 | 0/0 | 0/0 |
| hls: `Ide.Main.defaultMain runLspMode Development.IDE.Main.defaultMain` | 3/3; 3 | 3/3; 3 | 0/0 | 0/0 |
| hls: `getIdeas moduleEx getParsedModuleWithComments` | 3/3; 3 | 3/3; 3 | 0/0 | 0/0 |
| hls: `hover request logAndRunRequest getAtPoint` | 0/3; 0 | 0/3; 0 | 0/0 | 0/0 |
| express: `json stringify` | 0/3; 0 | 0/3; 0 | 0/0 | 0/0 |
| express: `render tryRender` | 0/3; 0 | 0/3; 0 | 0/0 | 0/0 |
| express: `set compileQueryParser` | 0/3; 0 | 0/3; 0 | 0/0 | 0/0 |
| ghc-core: `hsc_typecheck tcRnModule' tcRnModule` | — | 0/3; 0 | —/0 | —/0 |
| ghc-core: `hscDesugar hscDesugar' deSugar` | — | 0/3; 0 | —/0 | —/0 |
| ghc-core: `hscSimplify hscSimplify' core2core` | — | 0/3; 0 | —/0 | —/0 |
| ghc: `hsc_typecheck tcRnModule' tcRnModule` | — | — | —/— | —/— |
| ghc: `hscDesugar hscDesugar' deSugar` | — | — | —/— | —/— |
| ghc: `hscSimplify hscSimplify' core2core` | — | — | —/— | —/— |

### Actual Flow and explained boundaries

Historical prompts are retained even when source review shows that they do
not request one demonstrated linear path. Their result is distinct from a
source-reviewed supplemental probe. Successful tool execution, an internal
two-node path, and a surfaced three-node Flow are separate measurements.

- xmonad: `kill` and `refresh` are indexed as constants, excluded from ordinary
  callable Flow endpoints. `killWindow` is a function argument, requiring
  interprocedural callback substitution through `withFocused` and `whenJust`.
  `manage float windows` mixes a separate operation with `W.float` inside a
  callback; `windows` does not call `modifyWindowSet` at this revision.
- Pandoc: `readMarkdown` passes `parseMarkdown` to `readWithM`, which forwards
  it to external `runParserT`. The persisted argument link is a reference,
  and `parseMarkdown` is a constant endpoint. The HTML and LaTeX prompts
  produce the expected direct three-node paths in both engines.
- HLS: the bare `hover` name has five callable candidates, triggering the
  existing ambiguity filter. The intended implementation also passes
  `getAtPoint` through `getResults` to `logAndRunRequest`; a call-through edge
  for that callback is absent. The entrypoint and HLint prompts produce the
  expected direct paths in both engines.

The Flow renderer requires at least three steps; the two-symbol Express prompts
therefore produce no surfaced Flow even where the internal named path exists.
Post hoc xmonad controls return three unchanged positive three-step paths in
both engines: `manage userCodeDef userCode`, `XMonad.Operations.float floatLocation
applySizeHintsContents`, and `windows catchX runX`. The negative control
`windows sendMessageWithNoRefresh updateLayout` returns no Flow in either.
These four probes use actual ToolHandler output, with no errors or output
truncation, on isolated read-only copies. They are supplemental source-selected
controls, separate from the historical 0/3 xmonad prompts and from agent A/B.

These are concrete observed boundaries; no result is attributed to output
truncation or exhausted traversal limits without corresponding evidence.

### GHC diagnostics: completed and interrupted indexes

Baseline `80b89692056381a4e95b2d855f8d3516a5b8535c`; final candidate `f4dc4df79d5b83cd1d5f8de8cf773ecb40094bb1`, dist SHA-256 `97a94b36cba528c1d3776c368ebe9e33ac4fa368a382f427595ad0c001c9b559`, 1,042 files. GHC source revision `82c73b223a985bc0bcc00cb6252b2b535082d831`. Earlier candidate bf3ff86 observations remain in their separate report and are not final-candidate evidence.

This report combines saved baseline diagnostics with six new serial probes of the two final snapshots. Persisted states are shown below; benchmark process caps and completion must also be read from the main campaign results. An incomplete marker rules out completed-index parity claims. Counts and progress alone establish neither a semantic gain nor regression.

| Snapshot | State | Nodes | Edges | Failed refs | Pending refs | Actual Flow |
|---|---|---:|---:|---:|---:|---:|
| baseline core | indexing | 117,910 | 250,470 | 361,273 | 77,530 | 0/3 |
| baseline full | indexing | 232,604 | 293,578 | 113,565 | 605,454 | 0/3 |
| candidate-final core | complete | 117,910 | 278,302 | 410,452 | 0 | 0/3 |
| candidate-final full | indexing | 232,604 | 295,001 | 117,133 | 599,955 | 0/3 |

Flow is extracted from actual `ToolHandler.execute('codegraph_explore')` output using the campaign harness rule. Internal two-node routes are not counted as a surfaced three-symbol Flow. Exact responses' error and truncation flags remain visible.

- baseline core: 0 explore errors; 0 truncated responses; selected evidence truncation={"nodes":false,"outgoingEdges":false,"references":false}; file scan truncated=false; public diagnostic examples truncated=false.
- baseline full: 0 explore errors; 0 truncated responses; selected evidence truncation={"nodes":false,"outgoingEdges":false,"references":false}; file scan truncated=false; public diagnostic examples truncated=false.
- candidate-final core: 0 explore errors; 0 truncated responses; selected evidence truncation={"nodes":false,"outgoingEdges":false,"references":false}; file scan truncated=false; public diagnostic examples truncated=false.
- candidate-final full: 0 explore errors; 0 truncated responses; selected evidence truncation={"nodes":false,"outgoingEdges":false,"references":false}; file scan truncated=false; public diagnostic examples truncated=false.

#### Fresh resolver evidence

- baseline core, `deSugar`: stored=failed; fresh target=null; exhausted walks=1; observed ambiguity=false; first exhausted module=compiler/GHC/Prelude.hs.
- baseline core, `tcRnModule`: stored=failed; fresh target=null; exhausted walks=1; observed ambiguity=false; first exhausted module=compiler/GHC/Prelude.hs.
- baseline core, `core2core`: stored=failed; fresh target=null; exhausted walks=1; observed ambiguity=false; first exhausted module=compiler/GHC/Prelude.hs.
- candidate-final core, `deSugar`: stored=failed; fresh target=null; exhausted walks=1; observed ambiguity=false; first exhausted module=compiler/GHC/Prelude.hs.
- candidate-final core, `tcRnModule`: stored=failed; fresh target=null; exhausted walks=1; observed ambiguity=false; first exhausted module=compiler/GHC/Prelude.hs.
- candidate-final core, `core2core`: stored=failed; fresh target=null; exhausted walks=1; observed ambiguity=false; first exhausted module=compiler/GHC/Prelude.hs.
- candidate-final full, `deSugar`: stored=pending; fresh target=null; exhausted walks=1; observed ambiguity=false; first exhausted module=compiler/GHC/Prelude.hs.
- candidate-final full, `tcRnModule`: stored=pending; fresh target=null; exhausted walks=1; observed ambiguity=false; first exhausted module=compiler/GHC/Prelude.hs.
- candidate-final full, `core2core`: stored=pending; fresh target=null; exhausted walks=1; observed ambiguity=false; first exhausted module=compiler/GHC/Prelude.hs.

These are observed fresh and return-preserving instrumented calls on copied snapshots. A budget exhaustion is incomplete proof, not proof of competing definitions. Missing/resolved references are never fabricated: compare stored edges, pending/failed status and any probeWarning in the JSON. Do not infer final full behavior from core, or SCC extraction loss from absent Flow.

The completed final core stores all three local first hops at `compiler/GHC/Driver/Main/Passes.hs` lines 428, 495 and 1444; those resolved references are correctly absent from `unresolved_refs`. The three imported second hops at lines 458, 503 and 1457 remain extracted `calls` references with status `failed`. Final full retains all six calls as `pending` and stores none of those six edges. Each imported target is present once, exported, and mapped to its correct defining module. In both final scopes every traced first walk has `remaining=-1`, `exhausted=true`, `ambiguous=false`, `target=null` in `compiler/GHC/Prelude.hs`; the original and instrumented resolvers both return null. This directly reproduces the 10,000-visit proof limit, including on the completed core; these three missing paths cannot be explained solely by interruption, missing extraction, or a cold-versus-warm cache difference. The full snapshot's fresh probe is not a completed full indexing run.

#### Storage and extraction diagnostics

| Snapshot | Integrity OK | FK OK | Edges missing endpoint | Refs missing source | Nodes missing file | Pages | Free pages | Files with diagnostics |
|---|---|---|---:|---:|---:|---:|---:|---:|
| baseline core | true | true | 0 | 0 | 0 | 79,270 | 19,776 | 20 |
| baseline full | true | true | 0 | 0 | 0 | 123,939 | 37,319 | 46 |
| candidate-final core | true | true | 0 | 0 | 0 | 90,512 | 0 | 20 |
| candidate-final full | true | true | 0 | 0 | 0 | 123,908 | 37,178 | 46 |

- baseline full: `testsuite/tests/perf/compiler/parsing001.hs` — Parse timed out after 60000ms
- baseline full: `testsuite/tests/rts/T27434.hs` — Parse timed out after 30000ms
- candidate-final full: `testsuite/tests/perf/compiler/parsing001.hs` — Parse timed out after 60000ms
- candidate-final full: `testsuite/tests/rts/T27434.hs` — Parse timed out after 30000ms

The bounded JSON retains severity counts with their coverage qualification, source file diagnostics and truncation flags. Structural checks do not establish semantic completeness or FTS-to-content equality. Physical DB/WAL sizes are matched to the root task's pre-diagnostic inventory; committed logical pages and historical WAL frames are different measurements. Nothing was checkpointed or vacuumed.

#### Bounds and preservation

Each existing probe retains its 30-second child-process cap, 512 MiB JS heap setting and 1 GiB combined DB+WAL guard. Health uses a 32 MiB SQLite cache target and mmap=0; these are not total RSS guarantees. Only isolated DB+WAL copies were opened readOnly/query_only. Original DB/WAL hashes, sizes and mtimes are verified unchanged within probes and consistent between final probes. Baseline evidence is reused without reopening baseline DBs. No lifecycle open/heal/index/sync/final sweep, source mutation, original SHM write or benchmark rerun occurred. All probe children exited. Diagnostic durations are metadata, not A/B performance measurements.

The actual executed helpers were the published `scripts/benchmarks/haskell-ghc-flow-diagnostics.cjs` and `scripts/benchmarks/haskell-ghc-snapshot-health.cjs`, after successful syntax validation. Their executable contents match the earlier scratch helpers apart from usage strings. All six runtime invocations exited successfully, with respective worker durations 2.635 s (core Flow), 11.515 s (full Flow), 1.295 s (core fresh/trace), 2.566 s (full fresh/trace), 3.741 s (core health) and 3.909 s (full health). No temporary snapshot directories remain.

The GHC evidence object occupies 127,677 bytes before embedding (below its
256 KiB guard). It is included as `ghcDiagnostics` in the companion results
JSON, together with raw evidence filenames. This report makes no row-exact or completed-index semantic-parity claim.


## Storage interpretation

Every completed group has identical final graph fingerprints across repetitions.
After successful engine close, the completed normal-run WAL is empty or absent.
These physical sizes were recorded before the diagnostics; partial GHC attempts
did not close cleanly and their WAL includes committed history, not only live graph data.

| Corpus | Baseline DB bytes | Final DB bytes | Baseline pages / free | Final pages / free |
|---|---:|---:|---:|---:|
| xmonad | 4,464,640 | 4,481,024 | 1090 / 96 | 1094 / 105 |
| pandoc | 95,817,728 | 95,821,824 | 23393 / 315 | 23394 / 332 |
| hls | 68,902,912 | 68,898,816 | 16822 / 206 | 16821 / 213 |
| express | 4,341,760 | 4,341,760 | 1060 / 1 | 1060 / 1 |

Each completed core-candidate database is 370,737,152 bytes (90,512 pages,
zero free pages) and has no nonempty WAL. It is not directly comparable to the
baseline’s incomplete core snapshot. GHC page/freelist, structural integrity,
physical DB/WAL sizes and completion states are retained separately in the
companion JSON. Post-measurement diagnostics applied no vacuum, checkpoint, index repair or
final resolution sweep to any original measured snapshot.

Read-only SQLite can still create an empty WAL or SHM coordination file. The
final diagnostic scripts open copies to prevent those side effects on originals.
Pre-close WAL peaks and partial-index DB+WAL sizes are not permanent disk growth.

## Remaining coverage and limits

The default Haskell extension map contains `.hs`; tracked `.lhs` counts do
not imply literate-Haskell support. Ignored/unsupported files and absent
submodules limit the source available to the graph. Corpus dependencies are
not installed and the Haskell packages are not typechecked; the GHC namespace
checks validate specific fixtures only. Three repetitions support a local
comparison, not a universal performance bound.

Small SCC fixtures and the three actual GHC source calls retain their call
references. The resolution causes above do not establish complete extraction,
resolution, or runtime-call coverage for GHC.

Recovery tests inject logical interruptions after committed chunks, then
exercise unchanged, replaced, and deleted sources through `indexFiles`,
`indexAll`, and `sync`. Recovered semantic node/edge state matches a fresh
index; this does not simulate every power-loss or WAL boundary. Durable replay
applies to incoming resolution references with reconstructible stamps;
legacy or synthesized unstamped edges retain their existing remapping
behavior. A successful narrow retry does not mean the entire index is
complete: the indexing state remains until full recovery synchronization.

The source-reader correction bounds affected source reads, not configuration
or ignore-file reads, total parser CPU, aggregate process RSS, or every
hostile input. The sparse-file reproduction used bounded 2 MiB fixtures,
without attempting host memory exhaustion. A per-read byte ceiling is not
a bound on total process memory; growth can briefly retain both old and new
buffers. Nonblocking FIFO rejection is tested on POSIX only.

Indexing intentionally permits in-root symlinks into external source trees
under existing policy, so external source metadata can enter the local graph.
MCP source rendering retains stricter real-path containment checks. Static
symlink replacement is tested, but validation followed by a later open still
permits a symlink-swapping race; these changes do not provide race-free
filesystem confinement. Resolver lexical `../` refusal is covered by an
internal-context regression; no end-to-end traversal exploit through valid
Haskell module syntax was established.

## Semantic references

- [Haskell 2010 expressions: scopes and comprehensions](https://www.haskell.org/onlinereport/haskell2010/haskellch3.html).
- [Haskell 2010 modules: import/export visibility](https://www.haskell.org/onlinereport/haskell2010/haskellch5.html).
- [GHC explicit namespaces](https://downloads.haskell.org/ghc/latest/docs/users_guide/exts/explicit_namespaces.html).
