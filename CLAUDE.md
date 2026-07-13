# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Angular SPA ("Demand Control Room") that walks a SKU through a **19-stage** demand-planning / replenishment-governance simulation pipeline: demand cleaning (stockout/promo normalization), ABC/XYZ classification, seasonality/trend detection, forecasting, safety stock, order sizing, budget allocation, approval/release, and post-audit. It's a data-dense, operator-facing tool, not a marketing site.

Full project contract (design system, local skills, tech stack) lives in **[AGENTS.md](AGENTS.md)** — read it, it is not duplicated here in detail.

## Business rules & governance docs — read this before implementing/changing any stage

`docs/Demand-Planning-Governance-Package-v1/` is the **authoritative business-rule source** for this app — more authoritative than any single doc referenced ad hoc elsewhere in the repo or its parent folder. Its own `00-README-Nguon-su-that.md` defines a strict priority order for resolving conflicts (highest first):

1. `01-Danh-sach-quyet-dinh-nghiep-vu.md` — locked business decisions (`DEC-xxx`, status `ĐÃ KHÓA`/`ĐỀ XUẤT`/`CHỜ DỮ LIỆU`/`KHÔNG ÁP DỤNG HIỆN TẠI`). Highest authority in the package.
2. `02-Hop-dong-du-lieu-dau-vao.md` — the POS/ERP → Demand Planning data contract.
3. `04-Dac-ta-trien-khai-Demand-Planning.md` — implementation spec, precise enough to code and test directly from.
4. `07-Danh-muc-Golden-Test.md` (+ its test data) — expected results used for acceptance.
5. `Tài liệu giải pháp - Demand Planning & Replenishment Governance(25).md` — the readable business-solution doc (for MC/LGT/BA/MD/Thu mua/IT audiences).
6. `demand-planing-data-source-notes-v3.md` — source-table survey, join keys, real-data computation logic, data risk notes (identical content to `../Sql/demand-planing-data-source-notes.md` one level up — same doc, kept in both places).
7. `demand-planing-v3.sql` — proposed SQL to pull real source + real-derived stock data.
8. Old simulation reports / historical JSON — evidence of past inputs/outputs only, never a source of new rules.

Key locked architectural facts from that README (§3) that constrain how the engine must behave:
- POS/ERP source data is **sparse** — a row only exists when a real transaction/event happened in the DB.
- The SQL layer must **not** synthesize a continuous calendar or 15-day cycles, and must not backfill gaps — that's entirely the Angular module's job (`catalog.ts`/`simulation-engine.ts` stages 1–5).
- `OpenStock`/`CloseStock` are never a stored raw-inventory table; they're computed from recorded sales/returns/receipts/issues/adjustments.
- A day with no POS row is **not** automatically `Sales=0` — zero is only used when there's real evidence it's a true zero.
- The current test session is `HISTORICAL_VALIDATION` with no confirmed real future-promo plan, so stage 13 currently only ever runs its `PASSTHROUGH_NO_FUTURE_PROMO` branch.
- Running the pipeline on a subset of SKUs ("đã chạy") does **not** by itself lock an official ABC classification for the whole catalog ("đã khóa") — those are distinct states.

**Note**: the parent-directory copy `../Tài liệu giải pháp - Demand Planning & Replenishment Governance.md` (no version suffix) currently has content differences from the package's `(25)` version — treat the package's `(25)` copy as the priority-ordered one per its own README, and flag/reconcile the discrepancy with the user rather than silently picking one when a change depends on wording that differs between them.

**Contradiction-handling protocol** (from the README, apply this instead of guessing): if the spec is unclear or two sources conflict, don't pick whichever reading is convenient for the code — record it in `01-Danh-sach-quyet-dinh-nghiep-vu.md` with status `CHỜ DUYỆT` and do not treat a `CHỜ DUYỆT`/`ĐỀ XUẤT` item as official operating behavior; it may be implemented behind a default-off config/flag if the spec calls for preparing it in advance, matching the bucket-(c) default philosophy already used in the engine (see below).

`README-SU-DUNG.md` in that folder gives the intended reading order for four scenarios (business review, POS/ERP data verification, handing a single stage to an AI coder, reviewing simulation results) — worth a look if any of those is literally what you're about to do, especially §3's rule for AI handoffs: one stage at a time, attach `04`+`05`+`07` and the matching solution-doc section, and never accept "done" without the golden tests actually run.

## Commands

```bash
npm start                  # ng serve — dev server
npm run build               # ng build — production build, must be 0 errors
npm run test                 # vitest run — full suite, must be green
npm run test:watch           # vitest watch mode
npx vitest run <path>        # run a single spec file
npx vitest run -t "<name>"   # run a single test by name
npm run convert:real-data    # regenerate src/assets/demand-planning-real.json from the .txt source
```

There is no separate lint script; `ng build` (strict TS + strict Angular templates, see `tsconfig.json`) is the correctness gate along with vitest.

## Architecture

### Pipeline model

`src/app/domain/simulation-engine.ts` defines `runStage1..runStage19`, each a **pure function** `(previous: StageSnapshot, policy) => StageSnapshot`. `SimulationEngine.run(stage, previous, policy)` dispatches to the right one. Each SKU's data is an immutable, copy-on-write `SkuPipelineState` (`Object.freeze`d) carried inside `StageSnapshot.states`; stage N always reads only from stage N‑1's snapshot and returns a new snapshot — never mutates in place. When adding/changing a stage, preserve this: build a new state object, don't reach back into a prior stage's frozen state.

Non-trivial stage logic that isn't simple glue lives in dedicated domain modules, mirrored 1:1 by stage:
- `demand-risk.ts`, `promo-analysis.ts`, `forecast-models.ts` — stages 3–13 (cleaning, classification, forecasting)
- `safety-stock.ts` (stage 15), `order-plan.ts` (stage 16), `budget-allocation.ts` (stage 17), `purchase-orders.ts` (stage 18 grouping)

`runStageN` in `simulation-engine.ts` should stay a thin caller into these modules, not grow business logic inline.

### State flow (UI)

`src/app/state/simulation.store.ts` (`SimulationStore`, Angular Signals) owns the current dataset, policy, and the map of per-stage snapshots; it builds the `StageViewModel` (inputs/calculations/outputs shown per stage) consumed by `app.component.ts`/`.html`. `src/app/domain/stage-trace.ts` (~1500 lines) builds the human-readable, formula-substituted "trace" shown in the audit panel for a given stage + SKU (+ optional focused date/point) — this is what operators actually read, so wording changes matter as much as the math. `src/app/domain/report-builder.ts` scans all stage snapshots for anomalies (`STAGE_CHECKERS[stage]`) and feeds the "Báo cáo mô phỏng" report view (`src/app/ui/simulation-report.component.*`).

### Data sourcing — the bucket (a/b/c) rule

`src/app/domain/catalog.ts` has two producers of `SkuDefinition[]`: `buildCatalog()` (synthetic mock catalog for dev/tests) and `parseRealDataset()` (parses the real ERP export). **The real ERP export is missing many columns the solution document assumes exist** — see `Sql/demand-planing-data-source-notes.md` §9.2 for the authoritative list (e.g. `supplier`, `inboundPlan`, `leadTimeHistoryDays`, MOQ-related fields, `purchaseTermsComplete`, `futurePromotions`, `periodBudget`). Every field is one of:
- **(a)** a real ERP column,
- **(b)** computed/derived from other real fields, or
- **(c)** a policy-level default used only because no source data exists.

**Mandatory invariant**: any check or gate that depends on a bucket-(c) default must degrade to no-op / non-binding when the data is absent — never silently exclude or reject a SKU that would otherwise be valid just because a field defaulted. When a stage's trace text shows a bucket-(c) value, say so explicitly (e.g. "CHƯA CÓ TRƯỜNG RIÊNG TỪ ERP — mặc định 0") rather than presenting it as measured.

### Acceptance-gate tests

`src/app/domain/trace-sanity.spec.ts` and `solution-contract.spec.ts` are literal acceptance gates, not ordinary unit tests: they assert exact per-stage step counts and literal Vietnamese marker substrings (e.g. `DisplayMin`, `CoverWindow`, `bucket = CHƯA CẤU HÌNH`, `WAPE_base`). If you change a stage's trace structure or wording, these will fail by design — update the expected counts/markers deliberately in the same change, don't treat a failure here as unrelated noise. Other domain specs (`math.spec.ts`, `forecast-models.spec.ts`, `catalog.spec.ts`, `stage-insights.spec.ts`, `formula-registry.spec.ts`, `stage-trace-contracts.spec.ts`, `acceptance.spec.ts`) cover individual modules more conventionally.

### Backward-compatible defaults

New numeric fields introduced for later-stage rework (e.g. `unitsPerCarton`, `orderStep`) are deliberately chosen so that at their default value, new formulas collapse exactly to the old formula (e.g. `roundToPurchaseUnits` with `unitsPerCarton=orderStep=1` reduces to the old `ceil(raw/moq)*moq`). Keep this property when adding new default-able fields — it's what keeps the mock-data test suite from regressing when a stage's algorithm is extended.

## Local skills

This repo has project-specific agent skills under `.agents/skills/` (design, frontend-design, brainstorming, clean-code, html-diagram, etc.) that are part of the project contract per **[AGENTS.md](AGENTS.md)** — check there for routing rules before doing UI or planning work. `.cursor/skills/` contains the same/adjacent third-party skill bundles for other tools; treat `.agents/skills/` as the canonical copy for Claude Code.
