# Angular Simulation Refactor Design

## Scope

Refactor the existing 15-stage demand-planning simulation into an Angular standalone application. The solution document and `Tài liệu kỹ thuật - Developer Spec.md` are the business source of truth. Stages 16–19 remain out of scope.

## Architecture

- Angular standalone components with Signals.
- Pure TypeScript domain processors implement stage formulas without DOM dependencies.
- A single `SimulationStore` owns input data, policy parameters, selected SKU, active stage, completed stage, and immutable stage snapshots.
- A stage may run only after its predecessor is locked. Viewing a previous stage never recalculates it.
- `activeStage` and `completedStage` are independent. The UI can inspect an earlier completed stage, but it cannot display outputs from a stage that has not run.

## Data flow

Every stage processor receives the preceding locked snapshot and returns a new snapshot plus an audit log. The shared stage view model drives all three columns atomically:

- Left: inputs available to the active stage.
- Center: input → rule/formula → substituted values → result → lock status.
- Right: selected-SKU snapshot as of the active stage.

Changing SKU updates all columns from the same snapshot. Running all stages executes 1 through 15 sequentially and stops on a contract violation.

## Domain rules

- Stage results are immutable and never recalculated by later stages.
- Missing records are not zero demand.
- Only locked cycles feed stages 6–11.
- Only daily `baseDemand` is aggregated into cycles.
- Processed days cannot become references for other days.
- Policy thresholds are named, versioned parameters.
- Formula variables such as `t`, `m`, and `k` are defined beside every formula that uses them.

## UI direction

Retain the existing dark industrial control-room character while improving hierarchy, responsiveness, accessibility, and auditability. Stage navigation distinguishes locked, active, available, and unavailable stages. Unrun outputs use an explicit waiting state instead of placeholders derived from future metadata.

### Audit Explorer extension

The left column has two modes. `Dữ liệu` is the default audit workbench: stages 1–4 show daily records and stages 5–15 show locked-cycle data. `Danh mục` preserves fast search and SKU switching. Selecting a distorted day highlights the target plus clean references before and after it, shows the median and selection reason, and renders the record lineage across completed stages up to the active stage only. Balance states are explicit: balanced, temporary review, fixed unbalanced, insufficient, and technical fill.

Mathematical formulas render through KaTeX while variable definitions remain visible in plain Vietnamese. The stage hero becomes compact and sticky inside the center workbench so stage context remains visible while the calculation content scrolls.

## Error handling

Stage processors return typed contract errors. The store leaves the last valid snapshot intact, marks the failed stage, and presents the violated precondition and affected SKU. No partial stage output is committed.

## Testing

- Unit tests cover all 21 acceptance cases in the developer specification.
- Store tests cover sequential gating, immutable snapshots, reset behavior, and run-all failure handling.
- UI tests cover synchronized SKU changes across all columns and prevention of future-stage data leakage.
- Production build and browser-level smoke tests validate the final application.
