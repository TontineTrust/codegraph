# Intermediate campaign 204 — Haskell audit, 19–20 September 2026

This is the closed evidence record for intermediate engine **`204ce9b`**.
All timestamps are UTC. Results below belong to that engine and the unchanged
remote baseline `80b8969`; they are not validation of a successor.

The current-baseline comparison completed three repetitions for each normal
corpus and GHC without testsuite. HLS median indexing fell **79.4%**, while
GHC core took **2.625× as long (+162.5%)**. Neither full-GHC arm produced a
qualified run. Source review supported all 99 selected additions but confirmed
**two lost valid constructor calls**, to `FieldLabelString` and `ConInfo`, among
14 distinct removed edges. Engine 204 therefore remains intermediate.
Successor `172fd3b` is separately identified as under validation; no restored
corpus edge, successful validation or new measurement is claimed for it here.

This continues the [18 September audit](haskell-audit-2026-09-18.md).
The remote checks on 19 September and resumption on 20 September found the same
baseline and existing [draft audit PR #5](https://github.com/TontineTrust/codegraph/pull/5).
The isolated audit checkout preserves the original user checkout. No merge,
version change or npm publication is part of these recorded results.

## Identities and protocol

| Arm | Production revision | Dist files | Dist SHA-256 |
|---|---|---:|---|
| `baseline-20260920` | `80b89692056381a4e95b2d855f8d3516a5b8535c` | 1,038 | `b4684753bb251e9b35651f9d09ea122bb8fc72b0fb075ea96f4b3bc2213e9c5e` |
| `candidate-local-proof-16k-20260920` | `204ce9b172cd9c9729b111c9be2512daf3bd7914` | 1,042 | `17f30bf95e5da31857346c655d0e52a835c04801fb35a2fb1d5670de5bf57917` |

Both frozen builds are byte-identical to their corresponding 19 September
arms. The validation dates below remain 19 September; no rerun is implied.

| Corpus | Pinned revision | Scope |
|---|---|---|
| xmonad | `1a875b3413e72a766ce2b1d4c39b8f796c1ac311` | Tracked archive, existing ignore rules |
| Pandoc | `b913622e1ff87c69ab8b1a606577122e220925cd` | Tracked archive, existing ignore rules |
| HLS | `c98343b869786994a0ece7830910551bd8a0c195` | Tracked archive, existing ignore rules |
| Express | `3ce6d0eb86e9d93529ff3191c6bb5db8ce6e72c8` | JavaScript control |
| GHC core and full | `82c73b223a985bc0bcc00cb6252b2b535082d831` | Core excludes `testsuite/`; full includes it |

Each attempt uses a fresh disposable archive and separate index. Existing
filters still apply: Haskell `.hs` is supported, `.lhs` is excluded; submodules
and corpus dependencies are not installed. These are static graph checks,
not corpus builds or typechecks. The [manifest](../../scripts/benchmarks/haskell-audit-corpora.json),
[runner](../../scripts/benchmarks/haskell-audit-matrix.py) and
[harness](../../scripts/benchmarks/haskell-corpus.cjs) retain the protocol.

Measurements are serial, without concurrent heavy validation or diagnostics,
with profiling cleared and `CODEGRAPH_KERNEL=0`. Whole-harness caps are 600 s
for normal corpora and 1,800 s for GHC. An incomplete first attempt stops that
arm/scope's repeats. Normal order is repetition 1–3, then xmonad/Pandoc/HLS/
Express, baseline followed by candidate for each pair. GHC core runs three
candidates then three baselines. Neither order is randomized; caches are not
flushed. Fresh archives do not establish cold operating-system caches.

The [matrix](haskell-audit-2026-09-20-intermediate-results.json) contains **32 attempts**:
24 qualified normal runs, six qualified GHC-core runs and two incomplete
full-GHC attempts. Timings below are median [minimum–maximum], n=3 per arm,
unless explicitly labeled otherwise. RSS is the process high-water mark,
not an isolated phase or descendant-summed peak. Storage is live DB+WAL.

## Normal corpus results

All 24 runs exit 0, with equal full semantic fingerprints within each group.
Their starts span 20 September 05:22:29–05:32:53.

| Corpus | Baseline index, s | 204 index, s | Median change |
|---|---:|---:|---:|
| xmonad | 0.558 [0.485–0.581] | 0.497 [0.487–0.614] | −11.0% |
| Pandoc | 10.360 [9.352–10.863] | 10.773 [9.797–11.108] | +4.0% |
| HLS | 33.243 [31.413–34.289] | 6.859 [6.103–7.120] | −79.4% |
| Express | 0.441 [0.422–0.452] | 0.430 [0.408–0.443] | −2.6% |

HLS has a large reduction in this sample. The other ranges overlap; three
ordered repeats do not establish significance or absence of regression.
Pandoc's increased median is retained, and memory does not improve uniformly.

| Corpus | Baseline resolution/synthesis, s | 204 resolution/synthesis, s | Baseline harness, s | 204 harness, s |
|---|---:|---:|---:|---:|
| xmonad | 0.154 [0.149–0.202] | 0.162 [0.161–0.180] | 1.960 [1.830–2.024] | 1.857 [1.833–1.959] |
| Pandoc | 5.755 [5.352–5.991] | 5.947 [5.541–5.988] | 24.956 [24.551–25.590] | 25.429 [25.298–25.597] |
| HLS | 29.701 [27.772–31.124] | 3.458 [3.066–3.490] | 128.800 [126.647–131.158] | 21.467 [20.928–22.239] |
| Express | 0.190 [0.185–0.193] | 0.187 [0.182–0.191] | 0.833 [0.785–0.834] | 0.787 [0.755–0.822] |

Resolution/synthesis is the index remainder after parsing, not an isolated
resolver benchmark. Harness time includes synchronization and actual explore calls.

| Corpus | Baseline index RSS, MiB | 204 index RSS, MiB | Baseline process RSS, MiB | 204 process RSS, MiB |
|---|---:|---:|---:|---:|
| xmonad | 518.3 [513.1–520.2] | 517.5 [513.0–522.5] | 518.3 [513.1–520.2] | 517.5 [513.0–522.5] |
| Pandoc | 1,688.9 [1,629.0–1,700.9] | 1,727.3 [1,709.0–1,729.8] | 1,732.3 [1,714.6–1,952.5] | 1,803.5 [1,747.6–1,964.2] |
| HLS | 1,641.6 [1,623.8–1,734.5] | 1,699.1 [1,640.3–1,716.5] | 1,662.9 [1,642.5–1,734.5] | 1,699.1 [1,689.1–1,738.0] |
| Express | 436.3 [429.7–437.9] | 432.3 [431.3–439.2] | 455.6 [451.5–460.1] | 449.9 [449.8–451.0] |

All **72 no-change syncs** preserve full graph fingerprints. The next table
aggregates each run's median of three syncs, then the three run medians.

| Corpus | Baseline no-change, ms | 204 no-change, ms | Baseline initial → final live, MiB | 204 initial → final live, MiB |
|---|---:|---:|---:|---:|
| xmonad | 46.604 [46.372–71.125] | 45.290 [44.937–46.115] | 3.805 → 8.368 | 3.805 → 8.375 |
| Pandoc | 86.560 [82.279–89.938] | 92.552 [85.525–95.781] | 142.711 → 339.724 | 142.703 → 339.697 |
| HLS | 105.878 [101.976–117.563] | 107.092 [100.859–113.159] | 62.484 → 185.605 | 62.566 → 185.977 |
| Express | 51.115 [49.649–51.282] | 51.610 [51.385–51.978] | 4.141 → 4.141 | 4.141 → 4.141 |

Each storage checkpoint has identical byte totals across its three repeats;
these are not compacted or post-VACUUM sizes. The 18 normal Haskell runs pass
**72 edit/restore cycles, 144 sync operations and 72 restoration checks**.
Express and both GHC scopes skip edits. Edit/restore seconds, n=3 each:

| Corpus / edit | Baseline edit | 204 edit | Baseline restore | 204 restore |
|---|---:|---:|---:|---:|
| xmonad / comment | 0.100 [0.098–0.110] | 0.096 [0.092–0.097] | 0.072 [0.071–0.076] | 0.069 [0.068–0.070] |
| xmonad / body | 0.070 [0.068–0.075] | 0.068 [0.068–0.069] | 0.069 [0.068–0.082] | 0.070 [0.067–0.071] |
| xmonad / import | 0.155 [0.154–0.179] | 0.156 [0.156–0.160] | 0.151 [0.147–0.168] | 0.144 [0.136–0.151] |
| xmonad / export | 0.148 [0.146–0.148] | 0.160 [0.155–0.160] | 0.143 [0.143–0.148] | 0.145 [0.144–0.159] |
| Pandoc / comment | 0.145 [0.144–0.163] | 0.144 [0.140–0.144] | 0.118 [0.113–0.118] | 0.125 [0.123–0.127] |
| Pandoc / body | 0.107 [0.103–0.121] | 0.109 [0.109–0.118] | 0.102 [0.101–0.105] | 0.102 [0.101–0.106] |
| Pandoc / import | 2.854 [2.821–2.963] | 2.852 [2.795–3.090] | 2.804 [2.737–2.928] | 2.788 [2.758–2.883] |
| Pandoc / export | 2.806 [2.766–2.827] | 2.753 [2.694–2.881] | 2.888 [2.805–2.986] | 2.806 [2.782–2.856] |
| HLS / comment | 0.143 [0.139–0.143] | 0.127 [0.124–0.128] | 0.112 [0.106–0.112] | 0.106 [0.101–0.106] |
| HLS / body | 0.092 [0.091–0.099] | 0.097 [0.094–0.102] | 0.095 [0.092–0.096] | 0.091 [0.091–0.094] |
| HLS / import | 22.833 [22.491–23.214] | 2.874 [2.863–2.946] | 23.224 [22.498–23.643] | 2.905 [2.788–2.912] |
| HLS / export | 22.995 [22.821–24.137] | 2.847 [2.801–2.990] | 22.854 [22.739–24.449] | 2.936 [2.934–3.034] |

All quick checks pass with zero FK violations/orphan edges. Eight independent
exact comparisons pass full SQLite integrity/FK checks on preserved copies.

| Corpus | Nodes, both arms | Baseline → 204 edges | Difference from prior audit `f4dc4df` |
|---|---:|---:|---|
| xmonad | 1,075 | 3,220 → 3,220 | None |
| Pandoc | 18,498 | 67,145 → 67,178 | None |
| HLS | 22,128 | 45,101 → 45,145 | 37 additions only |
| Express | 1,124 | 3,154 → 3,154 | None |

Baseline node differences are confined to decorators in 67/1,384/970 xmonad/
Pandoc/HLS records; normal comparisons remove or modify no edge identities.
Pins, full semantic fingerprints and eight exact delta ledgers match the
reviewed predecessors, allowing source-review reuse without timing reuse.
All 33 Pandoc and seven prior HLS additions retain the prior review; all 37
new HLS additions are source-supported (25 calls, 12 references), and the four
historical `Test.Hls.kick` calls remain. HLS has two parse-warning files despite
zero fatal file errors. [Graph evidence](haskell-audit-2026-09-20-normal-graphs.json)
and [HLS source review](haskell-audit-2026-09-20-hls-source-review.json)
retain scopes, heuristics, CPP qualifications and preservation.

## GHC core: gain in paths, substantial indexing cost

All six runs exit 0, with candidate starts 05:34:20–06:13:44 and baseline starts
06:33:30–06:48:39. Host/cache drift across that nonrandomized order remains.

| Measurement | Baseline median [range], n=3 | 204 median [range], n=3 |
|---|---:|---:|
| Index, s | 446.248134 [444.426848–463.879136] | 1,171.531170 [1,170.059727–1,174.710277] |
| Harness, s | 452.809553 [450.995111–470.431511] | 1,179.537723 [1,178.016802–1,182.712967] |
| Index/process RSS, MiB | 5,579.172 [5,318.000–5,746.047] | 5,379.938 [5,119.094–6,408.609] |
| No-change sync, ms, per-run median | 237.284 [228.841–252.374] | 249.504 [247.209–251.141] |
| Initial live DB+WAL, MiB | 417.676 [417.676–417.676] | 434.246 [434.246–434.246] |
| Final live DB+WAL, MiB | 353.676 [353.676–353.676] | 370.246 [370.246–370.246] |

The **2.625× / +162.5% index cost** prevents a general performance-improvement
claim. RSS ranges overlap and the candidate maximum is higher. Initial WALs
are 64 MiB; final reported WALs are empty. Each run has 2,795 indexed files,
117,910 nodes, zero fatal file errors, 20 C-header parse warnings and 1,449
unsupported files. Each arm's full fingerprints repeat exactly; all 18
no-change syncs preserve them. Quick/FK/orphan checks pass. `skipSyncEdits=true`.

| Stable core result | Baseline | 204 |
|---|---:|---:|
| Edges | 278,316 | 424,317 |
| Failed reference records | 410,926 | 262,678 |
| Surfaced three-step canonical Flows, each run | 0/3 | 3/3 |

The net 146,001 edges and 148,248 fewer failed references are different measures.
Exact EXCEPT counts and bounded streaming classification agree: versus baseline,
146,015 additions / 14 removals / zero modified edges and 7,268 decorator-only
node changes; versus `f4dc4df`, 146,025 / 10 / zero, with all semantic nodes equal.
The original helper's 100,000-row guard remains recorded separately from the
successful streaming pass. Both representative pairs pass full integrity/FK
checks. [Graph evidence](haskell-audit-2026-09-20-ghc-graphs.json)
retains every selected sample and all 24 comparison-specific removal records.

The [source bundle](haskell-audit-2026-09-20-ghc-source-review.json) joins frozen
ordinals 1–99 exactly: **99 source-supported**, zero contradicted/unresolved.
It also covers the complete 14-identity removal union: **12 justified removals
and two confirmed constructor-call regressions**. These are FieldLabelString
and ConInfo, lost valid targets in 204. Supported additions do not cancel those
defects. The purposive selection is not an estimate of whole-graph precision.
One coordinate marks a section expression's parenthesis rather than the first
identifier byte; both positions are recorded. Capture records retain all 226
queries, follow-up/fallback limitations, owned-process closure and DB/WAL preservation.

## Full GHC: two incomplete attempts, separate snapshot diagnostics

Candidate n=1 times out at 1,800 s (exit 143; **1,800.214304 s** elapsed).
Its report remains indexing, without a completed index duration. Last progress
is 1,787.421901 s, resolving 623,483/793,438 items; this is not completion time.
The timed harness produces no synchronization or Flow result for that attempt.

Baseline n=1 fails (exit 1; **1,423.295483 s** elapsed). Its recorded index
operation is 1,418.956970 s, but only 14,889/14,891 discovered files succeed.
`parsing001.hs` times out at 60 s and `T27434.hs` at 30 s, with 44 additional
warnings. Phase is flows, `ok=false`, and its three queries surface no Flow.
The harness aborts before synchronization; final after/stable records are absent.
Neither arm attempts repetitions 2–3 or contributes a qualified timing group.

Later completed [snapshot diagnostics](haskell-audit-2026-09-20-ghc-full-diagnostics.json)
inspect isolated read-only copies; they do not complete or heal either index.

| Snapshot observation | Baseline | Intermediate 204 |
|---|---:|---:|
| Persisted index state | complete | indexing |
| Stored file records / nodes | 14,891 / 232,604 | 14,891 / 232,604 |
| Edges | 445,389 | 549,994 |
| Failed / pending references | 566,562 / 0 | 289,602 / 169,959 |
| Warning / error diagnostics | 44 / 2 | 44 / 2 |
| Postmeasurement canonical Flows | 0/3 | 3/3 |

Both snapshots pass full integrity and FK checks with zero missing endpoints;
21 file records have no nodes. Both retain the same two parser timeouts. The
baseline complete marker includes errored file accounting, while the candidate's
pending references establish incomplete resolution. Neither storage integrity
nor candidate snapshot Flows establish a qualified full-GHC benchmark.
Two candidate explore outputs truncate source context, but neither their Flow
sections nor stored responses truncate. DB/WAL before/after records match.
These four diagnostic JSONs record completion, not independent process-census
or supervisor-exit proof. Their n=1 diagnostic latencies are excluded from macros.

## Actual workflows and resolver checks

The normal matrix executes **72 actual ToolHandler queries**, zero tool errors,
and no truncated retained Flow excerpts: xmonad 0/3, Pandoc 2/3, HLS 2/3,
Express 0/3, identically in all repeats/arms. There are 24 three-step responses
and 48 without Flow. Full-response truncation is not independently recorded.
The [matrix](haskell-audit-2026-09-20-intermediate-results.json) preserves every fixed prompt.
The 18 GHC-core queries show 0/3 baseline versus 3/3 candidate each repeat:
`hsc_typecheck → tcRnModule' → tcRnModule`, `hscDesugar → hscDesugar' → deSugar`,
and `hscSimplify → hscSimplify' → core2core`, with no tool/excerpt error.

Twelve post hoc xmonad/Express probes execute 54 queries on inactive snapshots,
with zero tool/truncation errors and unchanged originals. xmonad has three
source-supported positive paths and an absent negative control. Express has
one supported path (`send json stringify`), one wrong target (`sendStatus type
set`, ending at app.set rather than the response header setter), two missing
intended paths and an absent negative control. This pre-existing JavaScript
defect is not credited as success. [Source review](haskell-audit-2026-09-20-express-source-review.json)
and [supplemental replay](haskell-audit-2026-09-20-supplemental-flows.json)
remain separate from frozen prompts and performance samples.

Engine 204 keeps exact-walk limits of 10,000 visits/depth 64 and an independent
16,384-unit proof allowance per root lookup. Absence/singleton proofs and
inherited-predicate shortcuts are lookup-local; exact traversal still authorizes
targets. Haskell ancestor tracking is restored in finally. Immutable owner
patterns use a 1,024-entry FIFO cache and 1,024-UTF-16-unit keys, not node outcomes.
These bounds do not guarantee total CPU/memory ceilings; failed proofs add work.

[Diagnostics](haskell-audit-2026-09-20-resolver-diagnostics.json)
record 1,000 differential queries: old `f4dc4df` completes 916/exhausts 84;
407 returned targets remain and 27 additions match a 200,000-visit oracle,
with zero mismatches. The 57 both-unresolved cases are not proved equivalence.
All 1,000 warm checks and 12 dedicated history rows preserve outcomes.
Fresh resolution finds all three compiler targets, 76 walks/zero exhaustion,
against the old graph whose actual Flow remains 0/3. A separate n=1 instrumented
300-reference sample returns 145 targets, with 90 exhausted walks; it neither
certifies the large delta nor supplies macro performance evidence.

## Exact-revision validation on 19 September

| Check for 204 | Recorded result |
|---|---|
| TypeScript / focused / build | Pass; 124 focused tests, seven files, 1.54 s; frozen dist seal matches |
| macOS full suite | 5,069 passed / 192 skipped; 284 files passed / 16 skipped; 127.57 s Vitest / 128.187 s process |
| Linux full suite | Same counts; 142.48 s Vitest / 143.496 s process |
| Fresh source-package CLI + real stdio MCP | All 13 commands exit 0; expected three-step Flow; no error/truncation |

Vitest is 2.1.9, at most four workers. macOS arm64 uses Node 24.18.0/npm 11.16.0
and forked workers with `--liftoff-only` for the known V8 WASM failure; default-V8
macOS suite success is not established. Linux arm64 uses Node 22.23.2/npm 10.9.8,
default V8 flags and the optional kernel disabled. No retained validation fails.

The source package remains 1.6.0: 1,129 entries, 8,863,403 archive bytes,
83,758,513 unpacked bytes, SHA-256
`a5fff684f467e20890cbdef82e7be854f281ebaccff68a5c44093ab0bfe6a91b`.
Thirty grammars, licenses, schema, viewer, safe paths and installed file parity
pass. A clean macOS consumer uses default CLI runtime flags, three Haskell files,
11 nodes/12 edges, complete state, zero pending references and valid integrity/FK.
Separately installed **MCP SDK 1.30.0** verifies real stdio `alpha → beta → gamma`
(1,401 response bytes). Consumer processes close and original inputs remain.
This validates the source npm package, not platform-bundled releases or Windows.
[Validation](haskell-audit-2026-09-20-validation.json) and
[package evidence](haskell-audit-2026-09-20-package.json)
retain the actual dates: validation closes 19 September 07:52:02 before the
first candidate macro at 07:52:27. Those successes did not catch the two later
confirmed constructor regressions and cannot validate successor 172fd3b.

## Recovery, preservation and unexecuted coverage

The 20 September heartbeat resumes an interrupted Pandoc attempt with no final
report/process status; its last saved 19 September checkpoint is preserved.
Cause is unknown, not an observed timeout. Missing temporary Express/GHC sources
are restored at unchanged pins; archive-preparation failure is separate from
indexing. Unchanged-code Pandoc takes 25.901/25.709 s on 19 September and 9.536 s
after recovery, so those mixed-day runs are excluded from primary timing groups.
The 20 September contemporaneous comparison was created to address that drift.

The [real lifecycle records and separate stub smoke](haskell-audit-2026-09-20-lifecycle.json)
distinguish controller behavior from corpus results. Normal finishes 05:32:54.188
with complete/exit 0; GHC finishes 07:50:19.978 with incomplete corpora/exit 2.
Both report zero active owned groups and free lease. Those terminal records do
not independently inventory every worker or prove control-socket removal.

Earlier 600-second pilots remain rejected n=1 attempts. Prototype b6df16b was
operator-stopped at 442.379361 s, explicitly not a timeout, after distinct prior
queries changed depth-limited recall through shared ABSENT/SINGLETON proofs.
No false target was demonstrated; 204 removes that cross-lookup proof reuse.
An initial read-only probe of an older original DB created a 0-byte WAL and
32,768-byte SHM; only main-file size/mtime preservation is asserted for that
initial event. Later helpers use disposable copies and recorded DB/WAL checks.

Agent-eval A/B was **not executed**: refreshed 20 September 05:27:42 presence
checks lack Claude, tmux and credential environment prerequisites. The prescribed
Sonnet/high-effort, two-runs-per-arm, prewarmed-MCP comparison is not replaced by
deterministic probes. Parallels prerequisites are absent; Windows is untested.
The [preconditions](haskell-audit-2026-09-20-preconditions.json)
contain presence checks only, without secret values. Raw machine-path logs stay
private. The dated companions describe this intermediate campaign; successor
results require their own identities and evidence.
