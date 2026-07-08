# Demand Control Room

Angular SPA that walks a SKU through an 11-stage demand-planning simulation pipeline (ABC/XYZ classification, seasonality, replenishment, audit trace, formula explainers, etc.). Data-dense, operator-facing tool — not a marketing site.

## Tech stack

- Angular 21, standalone components, TypeScript, RxJS
- Vitest for tests (`npm run test` / `test:watch`)
- KaTeX for rendering formulas (`src/app/ui/math-formula.component.ts`)
- Plain CSS per component — **no Tailwind, no Material/shadcn/other UI kit**
- App structure: `src/app/domain` (simulation logic), `src/app/state`, `src/app/ui` (shared UI pieces), `src/app/app.component.*` (shell + most page CSS)

## Design system: Minimalist Dark (amber-on-slate)

`designs/rawblock-DESIGN.md` documents an aspirational "Minimalist Dark" system (layered slate + warm amber, glass cards, ambient glow, React/Tailwind-flavored). The app already lives in that direction but has its own concrete, evolved implementation — **the tokens and rules below are canonical**. If they ever conflict with `rawblock-DESIGN.md`, follow this file; update the doc if a deliberate restyle changes the direction.

`designs/pipelinepro-DESIGN.md` (indigo/cyan, light-mode CRM system) is **not in use** — ignore it unless the user explicitly asks to apply it somewhere.

### Tokens

Defined once, on `:host` in [app.component.css](src/app/app.component.css#L1-L14) — they cascade to every component under `<app-root>`, so treat that block as the single source of truth and add new tokens there rather than hardcoding hex values inline:

```
--bg          #090b10   page background
--panel       #11141b   panel/card background
--panel-2     #161a23   nested/elevated surface
--line        #292e3a   default border
--line-soft   #20242e   quieter border (inner dividers)
--muted       #7f8798   secondary text
--faint       #555d6e   tertiary/label text
--text        #f3f4f7   primary text
--amber       #ffab2e   accent — CTAs, active state, focus, highlights
--amber-soft  #352510   amber tint background
--cyan        #6ee7e7   secondary accent — links, info, hover accents
--green       #7bddaa   success/positive
--danger      #ff7777   error/negative
```

### Typography

- Headings/labels: `"Bahnschrift Condensed"` / `"Bahnschrift"`
- Body/UI: `"Aptos"`, `"Segoe UI Variable"` (see [styles.css](src/styles.css))
- Numeric/tabular data: `"Cascadia Code"` monospace
- Don't introduce Space Grotesk / Inter / JetBrains Mono from `rawblock-DESIGN.md` — those aren't loaded assets and would fragment the type system.

### Density & spacing

This is an operational data tool, not a landing page — the reference doc's "generous breathing room" (`py-24/32/40`) does **not** apply here. Keep the existing tight scale: type runs 7–19px, component padding 4–16px, panel gaps ~10px. Only reach for generous marketing-style spacing if the user explicitly asks for a new landing/marketing page.

### Component patterns (follow existing, don't reinvent)

- **Buttons**: `.btn`, `.btn.primary` (amber fill + soft amber glow shadow), `.btn.secondary`, `.btn.ghost` — see [app.component.css:41-43](src/app/app.component.css#L41-L43)
- **Panels/cards**: 1px `var(--line)` border, `var(--panel)`/`var(--panel-2)` background, occasional `backdrop-filter: blur()` on sticky headers — no bare white/opaque cards
- **Radius**: small, consistent — 4–9px range used throughout; never large marketing radii (no `rounded-2xl`)
- **Borders**: always 1px, `var(--line)` or `var(--line-soft)`, never heavier or colorful except active/selected states
- **Glow**: amber glow reserved for primary CTAs, active tab/row state, and focus — sparingly, matching `.btn.primary`'s existing `box-shadow`
- **Motion**: 150–350ms `ease`/`ease-out` transitions already in use; no bouncy/spring easing
- **Focus states**: keep the global amber `focus-visible` outline in [styles.css](src/styles.css) — don't override per-component without reason

### Rules for new UI work

1. Reuse `var(--token)` — don't hardcode hex values that already have a token.
2. New palette needs go into the `:host` block in `app.component.css`, following the existing naming pattern.
3. Match existing flat/BEM-ish class naming (e.g. `.stage-tab`, `.panel-head`, `.audit-table`) — no CSS-in-JS, no utility-class frameworks.
4. Keep density high; this app is read by operators scanning tables and traces, not browsing a marketing page.
