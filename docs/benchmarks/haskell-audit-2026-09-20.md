# Haskell audit — 20 September 2026, candidate 172fd3b

Evidence JSON files named in this report are retained locally and are not
included in the PR. Their basenames identify local evidence; no JSON download
links are provided.

**Completed bounded audit campaign; full GHC remains incomplete under its cap.**
This report separates completed evidence for `172fd3b` from the intermediate
`204ce9b` campaign. All dates and times are UTC. No intermediate GHC timing,
graph repair or validation is attributed to the current candidate.

The new candidate passes its focused tests, complete macOS/Linux suites, build
and fresh source-package/stdio-MCP checks. Its twelve normal corpus runs also
complete, with repeated graph fingerprints and successful synchronization.
HLS median indexing is **6.517 s versus 33.243 s** in the reused baseline
(−80.4%). Those arms ran about three hours apart on the same day, so this is
a descriptive comparison with temporal and cache limitations. Three new GHC
core runs also complete, but median indexing takes **2.919× as long (+191.9%)**
as the earlier baseline; the full-GHC attempt reaches its 1,800-second cap.

The constructor correction resolves the two actual stored references that
failed in 204: `FieldLabelString` and `ConInfo`. Exact comparison now confirms
both calls in the fresh GHC index. The change adds 56 edges, with no old nodes
or edges changed. All 56 additions have individual source review; one
`Fingerprint` route is supported only for the observed CPP branch `>= 1000`.

The work continues the [18 September audit](haskell-audit-2026-09-18.md)
in the isolated checkout, preserving the original user checkout. The existing
[audit PR #5](https://github.com/TontineTrust/codegraph/pull/5) is draft. This
report accompanies the audit branch; merging remains for review and no package
was published. Earlier experiments,
interruption recovery and full-GHC failures remain in the
[intermediate report](haskell-audit-2026-09-20-intermediate.md).

## Candidate, baseline and source pins

| Arm | Source revision | Dist files | Dist SHA-256 |
|---|---|---:|---|
| Reused `baseline-20260920` | `80b89692056381a4e95b2d855f8d3516a5b8535c` | 1,038 | `b4684753bb251e9b35651f9d09ea122bb8fc72b0fb075ea96f4b3bc2213e9c5e` |
| `candidate-constructor-recall-20260920` | `172fd3b01986dc62554ffe3fc1dc4b93fa1e6a0c` | 1,042 | `a70124c4ca4f4d4324a114f24bc8ab7b848406da721795c7341a18f8b5b5af75` |

The candidate's full build, source revision and frozen dist seal agree. Its
validation is a new execution on 20 September, not reuse of the 204 suite.

| Corpus | Revision | Scope |
|---|---|---|
| xmonad | `1a875b3413e72a766ce2b1d4c39b8f796c1ac311` | Tracked archive and existing filters |
| Pandoc | `b913622e1ff87c69ab8b1a606577122e220925cd` | Tracked archive and existing filters |
| HLS | `c98343b869786994a0ece7830910551bd8a0c195` | Tracked archive and existing filters |
| Express | `3ce6d0eb86e9d93529ff3191c6bb5db8ce6e72c8` | JavaScript control |
| GHC | `82c73b223a985bc0bcc00cb6252b2b535082d831` | Core excludes testsuite; full includes it |

Runs use fresh disposable archives and separate indexes. The configured
Haskell scope includes `.hs`, not `.lhs`; submodules and corpus dependencies
are not installed. These are static graph checks, not corpus typechecks.

## Constructor recall and evidence boundaries

The source-review bundle (`haskell-audit-2026-09-20-ghc-source-review.json`, retained locally)
records the exact intermediate-204 delta: 99 frozen selected additions are
source-supported, and all 14 distinct removals are reviewed. Twelve removals
are justified; two lose valid constructor calls. This purposive selection
does not certify every GHC addition or measure whole-graph precision.

Twenty new regression cases cover the constructor correction. Before the fix,
two direct fixtures pass but their variants with 65 unrelated facade hops fail.
The new focused and full suites include these cases. The
actual-reference probes (`haskell-audit-2026-09-20-constructor-recall.json`, retained locally)
use the preserved 204 GHC-core graph, fresh native read-only contexts and the
public `resolveViaImport` API, with caches cleared before each reference.

| Stored source reference | Expected value constructor | 204 probe | 172 probe |
|---|---|---|---|
| `GHC/Tc/Errors.hs:2691:17`, `FieldLabelString` | `Language/Haskell/Syntax/Basic.hs:79` | Unresolved | Expected target ID |
| `GHC/Rename/Names.hs:916:26`, `ConInfo` | `GHC/Types/GREInfo.hs:212` | Unresolved | Expected target ID |

Paths above are relative to `compiler/`; lines are one-based and columns are
zero-based UTF-8 bytes. Both target IDs match the source-reviewed constructors.
The two engines run serially under 30-second child and 512-MiB heap limits,
with a 1-GiB DB+WAL input guard. Both probes close successfully; the original
DB/WAL and stored references remain unchanged. No corpus was reindexed by
these probes, and their single-query timings are not index benchmarks.

The broader resolver work bounds exact traversal at 10,000 visits/depth 64 and
auxiliary proof work at 16,384 units per root lookup. Lookup-local proof state
avoids the rejected prototype's dependence on distinct earlier queries.
The prior boundedness and diagnostic history are retained with their actual
engine identities in the intermediate report; they do not substitute for
fresh corpus outcomes of the constructor correction.

## Normal measurement protocol

All twelve new normal attempts complete with exit 0 and three repeats per
corpus. Candidate starts span **08:35:06–08:37:39**. The reused twelve baseline
attempts started **05:22:29–05:32:52**, during the earlier paired 204 campaign.
Thus baseline and constructor candidate were **not interleaved or randomized**.
The candidate cycles xmonad, Pandoc, HLS and Express for repetitions 1–3.

Both arms have the same 600-second whole-harness cap, matching pinned settings
and profiling disabled. Work is serial, without overlapping heavy validation;
the validation summary closes at 08:34:40 before the first candidate macro.
Fresh archives do not establish cold OS caches. Same-day eligibility in the
aggregator does not remove time-of-day, thermal or filesystem-cache confounding.

The completed normal metadata aggregate (`haskell-audit-2026-09-20-final-results.json`, retained locally)
retains every observation and original precision. Tables show median
[minimum–maximum], n=3 per cell. RSS is the process high-water mark, not a
phase-isolated or descendant-summed peak. Resolution/synthesis is the recorded
index remainder after parsing, not an isolated resolver microbenchmark.

The final results (`haskell-audit-2026-09-20-final-results.json`, retained locally) retain all
32 primary attempts: 30 qualified completions and two excluded full-GHC attempts.
Earlier experiments and interrupted observations remain separately labeled.

## Normal performance, memory and synchronization

| Corpus | Baseline index, s | 172 index, s | Median change |
|---|---:|---:|---:|
| xmonad | 0.558 [0.485–0.581] | 0.532 [0.504–0.604] | −4.7% |
| Pandoc | 10.360 [9.352–10.863] | 9.845 [9.832–9.987] | −5.0% |
| HLS | 33.243 [31.413–34.289] | 6.517 [6.500–6.690] | −80.4% |
| Express | 0.441 [0.422–0.452] | 0.457 [0.399–0.457] | +3.5% |

HLS has a large observed reduction. The other ranges overlap; three ordered
repeats do not establish significance or absence of regression. Express's
higher median is retained. Neither this sample nor the HLS result establishes
a general performance or memory improvement across the corpus.

| Corpus | Baseline resolution/synthesis, s | 172 resolution/synthesis, s | Baseline harness, s | 172 harness, s |
|---|---:|---:|---:|---:|
| xmonad | 0.154 [0.149–0.202] | 0.168 [0.166–0.170] | 1.960 [1.830–2.024] | 1.970 [1.877–1.985] |
| Pandoc | 5.755 [5.352–5.991] | 5.608 [5.597–5.667] | 24.956 [24.551–25.590] | 25.480 [25.118–25.681] |
| HLS | 29.701 [27.772–31.124] | 3.438 [3.411–3.526] | 128.800 [126.647–131.158] | 22.120 [21.715–22.534] |
| Express | 0.190 [0.185–0.193] | 0.196 [0.181–0.210] | 0.833 [0.785–0.834] | 0.816 [0.743–0.847] |

| Corpus | Baseline index RSS, MiB | 172 index RSS, MiB | Baseline process RSS, MiB | 172 process RSS, MiB |
|---|---:|---:|---:|---:|
| xmonad | 518.3 [513.1–520.2] | 518.7 [517.7–520.3] | 518.3 [513.1–520.2] | 518.7 [517.7–520.3] |
| Pandoc | 1,688.9 [1,629.0–1,700.9] | 1,675.6 [1,650.5–1,716.1] | 1,732.3 [1,714.6–1,952.5] | 1,757.2 [1,754.6–1,800.5] |
| HLS | 1,641.6 [1,623.8–1,734.5] | 1,666.1 [1,659.8–1,679.2] | 1,662.9 [1,642.5–1,734.5] | 1,701.4 [1,679.2–1,728.9] |
| Express | 436.3 [429.7–437.9] | 438.5 [437.4–442.1] | 455.6 [451.5–460.1] | 461.1 [455.0–462.1] |

There are **36 new candidate no-change syncs**, all preserving full semantic
fingerprints; the reused baseline contributes 36 more. Each timing cell below
aggregates the per-run median of three syncs. Live storage totals are identical
across each arm/corpus's three repeats, before closing the database.

| Corpus | Baseline no-change, ms | 172 no-change, ms | Baseline initial → final live, MiB | 172 initial → final live, MiB |
|---|---:|---:|---:|---:|
| xmonad | 46.604 [46.372–71.125] | 45.991 [43.501–48.631] | 3.805 → 8.368 | 3.805 → 8.375 |
| Pandoc | 86.560 [82.279–89.938] | 91.045 [88.742–92.302] | 142.711 → 339.724 | 142.703 → 339.697 |
| HLS | 105.878 [101.976–117.563] | 110.647 [107.012–122.282] | 62.484 → 185.605 | 62.566 → 185.977 |
| Express | 51.115 [49.649–51.282] | 53.140 [51.023–57.724] | 4.141 → 4.141 | 4.141 → 4.141 |

These DB+WAL sizes are not compacted or post-VACUUM storage. Candidate Haskell
runs execute **36 edit/restore cycles, 72 sync operations and 36 successful
restoration checks**. Reused baseline evidence adds the same counts. Express
skips edits. All comment/body/import/export-definition restorations match.
The import/export timings below retain the measured HLS benefit and the smaller
Pandoc increases; every cell is seconds, n=3. Other mutation timings remain
in the normal metadata aggregate.

| Corpus / mutation | Baseline edit | 172 edit | Baseline restore | 172 restore |
|---|---:|---:|---:|---:|
| xmonad / import | 0.155 [0.154–0.179] | 0.160 [0.158–0.182] | 0.151 [0.147–0.168] | 0.149 [0.144–0.165] |
| xmonad / export | 0.148 [0.146–0.148] | 0.170 [0.153–0.176] | 0.143 [0.143–0.148] | 0.147 [0.146–0.178] |
| Pandoc / import | 2.854 [2.821–2.963] | 3.061 [3.003–3.113] | 2.804 [2.737–2.928] | 2.908 [2.829–2.969] |
| Pandoc / export | 2.806 [2.766–2.827] | 2.949 [2.895–2.990] | 2.888 [2.805–2.986] | 2.939 [2.931–3.054] |
| HLS / import | 22.833 [22.491–23.214] | 3.060 [3.035–3.087] | 23.224 [22.498–23.643] | 2.976 [2.970–3.239] |
| HLS / export | 22.995 [22.821–24.137] | 3.012 [2.922–3.054] | 22.854 [22.739–24.449] | 3.000 [2.909–3.039] |

## Normal graph and actual MCP outcomes

All twelve candidate quick checks pass, with zero FK violations and orphan
edges. Every group's complete node/edge fingerprints repeat across n=3, and
each restored final fingerprint equals its initial graph.

| Corpus | Nodes, both arms | Baseline → 172 edges | Fixed prompts with Flow, both arms |
|---|---:|---:|---:|
| xmonad | 1,075 | 3,220 → 3,220 | 0/3 |
| Pandoc | 18,498 | 67,145 → 67,178 | 2/3 |
| HLS | 22,128 | 45,101 → 45,145 | 2/3 |
| Express | 1,124 | 3,154 → 3,154 | 0/3 |

The new candidate executes **36 actual ToolHandler queries**, with zero tool
errors or truncated retained Flow excerpts. Together with the reused baseline,
72 recorded queries yield 24 three-step Flows and 48 without Flow. The protocol
does not independently record whole-response truncation. HLS has two warning
files despite zero fatal file errors; the other normal corpora have none.

All eight exact normal comparisons (`haskell-audit-2026-09-20-final-graphs.json`, retained locally)
complete on disposable snapshots, with original DB/WAL preserved. Full semantic
rows for all four normal corpora are identical between 204 and 172. Against
baseline, only the previously reviewed 33 Pandoc and 44 HLS edges are added;
67 xmonad, 1,384 Pandoc and 970 HLS nodes differ only in decorators. Express
is identical. Matching source pins and exact rows support reuse of the earlier
normal source verdicts; this is not an independent source re-review.

The intermediate report retains the reviewed 33 Pandoc and 44 HLS additions,
including 37 additional HLS edges. New serial supplemental replays execute
27 queries across all three fresh xmonad and Express snapshots. Every xmonad
repeat has Flow lengths `[3,3,3,0]`; every Express repeat has `[3,0,0,3,0]`.
Exact normal graph parity supports the existing source interpretation: Express
has one supported path, one wrong target, two missing paths and an absent
negative control. The wrong `sendStatus type set` target is not credited.
All 27 responses have no tool error or recorded response/Flow truncation.

The graph comparison companion (`haskell-audit-2026-09-20-final-graphs.json`, retained locally)
retains all ten completed comparisons, original-preservation checks, bounded
streaming ledgers and the unchanged strict reuse gate.

## GHC core: three completed repeats with a substantial cost

The completed matrix (`haskell-audit-2026-09-20-final-results.json`, retained locally) records
three qualified 172 core runs, all exit 0, with the same 1,800-second cap as the
reused baseline. Candidate starts are 08:38:05, 08:58:36 and 09:20:31; baseline
starts were 06:33:30, 06:41:05 and 06:48:39. The baseline was not rerun by this
campaign. These are separate ordered groups, with no randomization or cache reset.

| Core measurement | Baseline median [range], n=3 | 172 median [range], n=3 |
|---|---:|---:|
| Index, s | 446.248134 [444.426848–463.879136] | 1,302.489834 [1,220.226441–1,530.102017] |
| Resolution/synthesis, s | 426.657891 [424.484735–444.239387] | 1,282.660337 [1,199.541657–1,507.953273] |
| Whole harness, s | 452.809553 [450.995111–470.431511] | 1,311.622619 [1,228.258630–1,542.095612] |
| Index/process RSS, MiB | 5,579.172 [5,318.000–5,746.047] | 5,375.906 [5,159.125–5,509.828] |
| No-change sync, ms, per-run median | 237.284 [228.841–252.374] | 305.732 [246.932–373.680] |
| Initial live DB+WAL, MiB | 417.676 [417.676–417.676] | 434.426 [434.426–434.426] |
| Final live DB+WAL, MiB | 353.676 [353.676–353.676] | 370.426 [370.426–370.426] |

Median index cost is **2.919× baseline (+191.9%)**. Candidate observations rise
from 1,220.226 to 1,302.490 to 1,530.102 seconds, a 309.876-second range. This
variance and the earlier reused baseline limit causal attribution. The cost
remains substantial despite HLS's reduction; lower median RSS does not establish
a general memory gain. Storage is live, with 64-MiB initial WALs and empty final WALs.

Every run has 2,795 indexed files and 117,910 nodes, zero fatal file errors,
20 parse-warning files and 1,449 unsupported files. Within each arm, complete
node/edge fingerprints repeat exactly and all nine no-change syncs preserve them.
Harness quick checks pass with zero FK violations/orphan edges. GHC skips source
edits. The new postmeasurement core snapshot passes full SQLite integrity and
FK checks with no missing node/reference endpoints. Its 20 file diagnostics
are warnings, with no fatal error; 18 file records contain zero nodes. Stable
counts are:

| Core result | Reused baseline | 172 |
|---|---:|---:|
| Edges | 278,316 | 424,373 |
| Failed reference records | 410,926 | 262,621 |
| Three-step canonical Flow responses across three runs | 0/9 | 9/9 |

The fixed paths end at `tcRnModule`, `deSugar` and `core2core`; all nine candidate
queries have no tool error or truncated retained Flow excerpt. The net count
gain is 146,057 versus baseline. Streaming comparison against intermediate 204
confirms **56 additions: 13 calls and 43 references**, with all existing nodes
and edges unchanged. Both lost constructor calls are restored, and all 99 prior
source-review identity joins remain valid. The strict exactly-two-additions
gate returns exit 2 because it finds 56 additions; it is not a failed index run.
The exhaustive new-delta source review (`haskell-audit-2026-09-20-final-source-review.json`, retained locally)
now covers all 56 identities: 41 target value constructors and 15 target record
fields. The field sites are explicit record labels, including labels whose
right-hand expressions have locally bound names; they are not additional calls.
Seventy-seven actual ToolHandler source queries ran in seven serial batches,
followed by documented narrow source fallbacks where headers or route context
were omitted. Every query completed without a tool error and all copies were
closed and removed with original DB/WAL preserved. Tool success alone does not
establish complete source coverage.

No contradiction or unresolved identity remains in this delta review. The
`Fingerprint` route at ordinal 24 is source-supported for the observed
`__GLASGOW_HASKELL__ >= 1000` facade branch; other CPP configurations are not
certified. This qualification is separate from the other 55 reviewed identities.
The original exactly-two-only gate remains **non-certified**. The completed
source companion separately establishes continuity of the 99 earlier selected
verdicts through unchanged rows/pins, while reviewing all new additions. This
does not certify every baseline-relative addition or whole-graph precision.

The direct baseline comparison records **146,069 added and 12 removed edges**,
with no modified edge identity. All 12 remaining removals exactly match earlier
source-supported removal records; the two valid calls formerly lost by 204 are
restored. There are 7,268 decorator-only node changes against baseline, with no
node identity added or removed. For historical comparison only, 204's core
median was 2.625× baseline; it is not the 172 timing.

## Full GHC: bounded failure and preserved partial snapshot

Candidate full n=1 starts at 09:46:17 and reaches the 1,800-second cap: timeout,
SIGTERM/exit 143, **1,800.386238 seconds** process elapsed. Its report remains
`indexing`, with `indexMs=null` and no completed graph, synchronization or Flow
result. The reused baseline full attempt failed with two parser timeouts
(60 s/30 s), as recorded separately in the intermediate report. Neither full
arm has a qualified run or n=3 distribution; repeats 2–3 are unattempted under
the stop rule.

New postmeasurement diagnostics (`haskell-audit-2026-09-20-final-postmeasurement.json`, retained locally)
inspect disposable copies, without reindexing or resuming the source snapshot.
Its persisted state remains `indexing`: 232,604 nodes, 433,693 edges, 14,891 file
records, 201,894 failed and **374,955 pending reference records**. Full integrity
is `ok`, FK violations and missing node/reference endpoints are zero. There
are 21 zero-node file records. Complete stored diagnostic enumeration records
44 warning files and two error files: `parsing001.hs` timed out after 60 s and
`T27434.hs` after 30 s. These are observed partial-index diagnostics, not a
completed extraction of every discovered file.

The three actual ToolHandler queries on this partial snapshot all return the
expected three-step canonical Flows. The first two whole responses are marked
truncated; retained response storage and all three Flow excerpts are not.
All nine postmeasurement stages close with exit 0 under 45-second supervisor
and 30-second/512-MiB worker limits; original DB/WAL size, mtime and recorded
digests agree before and after. The allowlisted summary excludes raw responses
and project metadata. These diagnostics do not make the timed-out benchmark a
success or supply its missing synchronization/three-repeat measurements.

The candidate GHC lifecycle (`haskell-audit-2026-09-20-final-lifecycle.json`, retained locally)
closes at **10:16:18.431694**, `finished_with_incomplete_corpora`/exit 2, with
three core completions and one full timeout. It records zero active owned groups
and a free global lease, not independent worker-exit or socket-removal proof.
The aggregate contains 30 qualified observations and two incomplete full attempts
across new candidate and reused baseline records. Completed postmeasurement
probes are separate evidence from this lifecycle and its failed full run.

## Fresh validation and packaging on 20 September

The final-candidate validation (`haskell-audit-2026-09-20-final-validation.json`, retained locally)
identifies source 172 and its frozen dist throughout. Recorded process groups
close, the disposable Linux container and package consumer are removed, and a
bounded final inventory finds no matching validation processes or containers.

| Check | Result for 172 |
|---|---|
| TypeScript / focused tests | Pass; 185 tests in ten files, including 20 constructor cases; 5.00 s Vitest / 5.607 s process |
| macOS full suite | 5,089 passed / 192 skipped; 285 files passed / 16 skipped; 93.53 s Vitest / 94.221 s process |
| Linux full suite | Same counts; 77.42 s Vitest / 78.235 s process |
| Build and seal | Pass on macOS and Linux; 1,042 frozen dist files match the selected SHA-256 |
| Fresh source-package CLI + actual stdio MCP | Pass; expected ordered three-step Flow, no tool/output/evidence truncation |

Both suites cover engine and UI with Vitest 2.1.9 and at most four workers.
macOS arm64 uses Node 24.18.0/npm 11.16.0 and forked workers with
`--liftoff-only`, the mitigation for the known V8 WASM failure. Default-V8
macOS full-suite success is not claimed. Linux arm64 uses Node 22.23.2/npm
10.9.8, default V8 flags and `CODEGRAPH_KERNEL=0` in a fresh recorded image.
The current macOS validation records Darwin **27.0.0**; the 19 September
validation recorded **25.6.0**. Corpus reports retain their Node version but
not a kernel capture for every attempt. Earlier operating-system metadata is
not assigned to the new runs, and no reason for the version difference is inferred.

The source npm package remains **1.6.0**, with 1,129 entries, 8,864,264 archive
bytes and 83,759,827 unpacked bytes. Its SHA-256 is
`978e11669c5bca19b1b1b53669cf26ea954a9ac0a938384ddef573596ecacaba`.
Checks cover 30 grammars, licenses, schema/viewer, safe archive paths/types and
byte equality of packaged/installed dist and scripts. Original inputs and
the archive remain unchanged; no package publication or version bump occurred.

The clean macOS consumer uses the default CLI runtime, three Haskell files,
11 nodes and 12 edges. Its fresh index is complete at **extraction revision
29**, with zero pending references, `reindexRecommended=false`, expected
`alpha → beta → gamma` calls and valid SQLite integrity/FK checks. This fresh
status does not establish migration or repair of pre-existing indexes.
Separately installed **MCP SDK 1.30.0** validates real stdio Flow in 1,401
response bytes. The client closes and the watcher is disabled for isolation.
This covers the source package, not Windows or the platform-bundled release/shim.

Read-only `npm audit` reports **10 affected package entries** when development
dependencies are included: five moderate, four high and one critical. The
production-filtered command reports zero; all ten entries are omitted under
that filter. This registry snapshot is not an exploitability assessment or
proof about every bundle. The dependency triage (`haskell-audit-2026-09-20-dependency-triage.json`, retained locally)
qualifies 14 distinct advisories against the locked versions and maintainer
conditions. Rollup, PostCSS and Nanoid also participate in the viewer build;
the delivered server itself uses `node:http` and static assets. The observed
Vitest run configuration does not enable the vulnerable API/UI mode, and the
observed PostCSS Nanoid call uses a constant size of six. No attacker-controlled
path to a vulnerable operation was demonstrated. Build-tool advisories remain
recorded separately from the Haskell corrections; dependencies were not upgraded.

## Remaining limits and publication status

The mandated agent-eval A/B has not run: refreshed presence checks lack Claude,
tmux and credential-environment prerequisites. The prescribed Sonnet/high-effort,
two-runs-per-arm, prewarmed-MCP workflow is not replaced by deterministic probes.
Parallels prerequisites are absent and Windows remains untested. The
preconditions record (`haskell-audit-2026-09-20-preconditions.json`, retained locally)
contains presence results, not secret values.

The intermediate companion preserves interruption/recovery, failed pilots,
the operator stop, original-sidecar caveat and dated evidence. Raw logs and
source captures remain private; the locally retained JSON evidence contains
reviewed metadata and pinned public-source references and is excluded from
the PR. The source and frozen dist seals still
match after the campaign. The existing draft PR carries the corrections and
this report; merging remains for review. The daily recurrence is retained.
