# Demand Control Room

Angular SPA that walks a SKU through an 11-stage demand-planning simulation pipeline (ABC/XYZ classification, seasonality, replenishment, audit trace, formula explainers, etc.). Data-dense, operator-facing tool — not a marketing site.

## Automatic Ponytail mode

Default coding stance in this repo: treat `/ponytail full` as active every turn.

- Apply the Ponytail ladder before adding code: skip speculative work, reuse existing code, prefer standard library/native platform features, avoid new dependencies, and choose the shortest working diff.
- Respect the latest explicit override: `/ponytail lite`, `/ponytail full`, `/ponytail ultra`, `/ponytail off`, `stop ponytail`, or `normal mode`.
- Keep Ponytail below safety and correctness: never simplify away validation at trust boundaries, data-loss prevention, security, accessibility basics, or an explicit user requirement.
- For non-trivial logic changes, leave the smallest useful runnable check unless the change is documentation-only or plainly mechanical.

## Tech stack

- Angular 21, standalone components, TypeScript, RxJS
- Vitest for tests (`npm run test` / `test:watch`)
- KaTeX for rendering formulas (`src/app/ui/math-formula.component.ts`)
- Plain CSS per component — **no Tailwind, no Material/shadcn/other UI kit**
- App structure: `src/app/domain` (simulation logic), `src/app/state`, `src/app/ui` (shared UI pieces), `src/app/app.component.*` (shell + most page CSS)

## Design system: Minimalist Dark (amber-on-slate)

`designs/rawblock-DESIGN.md` documents an aspirational "Minimalist Dark" system (layered slate + warm amber, glass cards, ambient glow, React/Tailwind-flavored). The app already lives in that direction but has its own concrete, evolved implementation — **the tokens and rules below are canonical**. If they ever conflict with `rawblock-DESIGN.md`, follow this file; update the doc if a deliberate restyle changes the direction.

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


## Local skills in this repository

This repo has local agent skills under:

```
.agents/skills
```

These skills are part of the project contract. An AI agent working in this repo must not ignore them just because they are not listed in the global/system skill registry.

Before doing work that matches one of the skill descriptions below:

1. Open and read the matching `.agents/skills/<skill-name>/SKILL.md`.
2. Follow the skill unless it conflicts with the user's latest explicit instruction.
3. If the user names a skill, treat that as a hard routing constraint.
4. Mention briefly that the local skill is being used.
5. If the skill references local examples or references, read only the relevant ones needed for the task.

Available local skills:

| Skill | Path | Use when | Important repo-specific constraint |
| --- | --- | --- | --- |
| `brainstorming` | `.agents/skills/brainstorming/SKILL.md` | Before creative/product work: new features, components, behavior changes, or ambiguous design decisions. | Keep it lightweight. Ask one question at a time. Do not block simple bug fixes with excessive ideation. |
| `frontend-design` | `.agents/skills/frontend-design/SKILL.md` | Building or restyling UI, dashboards, pages, components, HTML/CSS layouts. | The skill encourages bold design, but this app's Minimalist Dark design system remains canonical. Do not introduce foreign palettes, fonts, Tailwind, Material, shadcn, or marketing-site spacing unless explicitly requested. |
| `html-diagram` | `.agents/skills/html-diagram/SKILL.md` | When the user explicitly asks for `$html-diagram`, `html-diagram`, `effective-html`, standalone HTML architecture diagrams, or visual architecture/system-flow artifacts. | Source locked in `skills-lock.json` to `plannotator/effective-html`. Build self-contained HTML with high-quality SVG, dark mode, localStorage theme persistence, and apply-before-paint script. Prefer native HTML/SVG over diagram libraries. |
| `clean-code` | `.agents/skills/clean-code/SKILL.md` | Any code edit or refactor where maintainability matters. | Apply pragmatically. Do not follow impossible/foreign script paths blindly; use this repo's actual commands from `package.json`. |
| `lead-research-assistant` | `.agents/skills/lead-research-assistant/SKILL.md` | Lead research, ICP, target companies, sales/BD/marketing research. | Usually irrelevant to normal code work in this app. Use only when the user asks for lead/business development research. |

### Skill routing rules

- If the user says `use skill html-diagram`, `use effective-html`, or similar, do not substitute another diagram library.
- If the user rejects an implementation route, stop defending the current approach and switch to the route they named.
- If a local skill conflicts with this `AGENTS.md`, follow this order:

  1. User's latest explicit instruction.
  2. This `AGENTS.md` project contract.
  3. The local skill's `SKILL.md`.
  4. General/default agent behavior.

### `html-diagram` details

`skills-lock.json` maps:

```json
"html-diagram": {
  "source": "plannotator/effective-html",
  "sourceType": "github",
  "skillPath": "skills/html-diagram/SKILL.md"
}
```

When using `html-diagram`:

- Read `.agents/skills/html-diagram/SKILL.md`.
- Review `.agents/skills/html-diagram/references/architecture-example.html` when building a full architecture diagram.
- Review only the relevant files in `.agents/skills/html-diagram/references/html-effectiveness/`; do not load the whole reference folder unless necessary.
- Output should be a self-contained HTML artifact focused on visual understanding, not prose-heavy documentation.
- Use SVG for the primary diagram.
- Include dark mode using CSS variables on `:root` / `html.dark`.
- Include a theme toggle, `localStorage` persistence, and an apply-before-paint script in `<head>`.
- Style SVG through CSS classes and variables; avoid hard-coded hex inside SVG.

### `brainstorming` details

Use this when the task is not just a mechanical fix and requires product/design judgment.

Expected behavior:

- Inspect current project state first.
- Ask one focused question at a time.
- Prefer multiple-choice when helpful.
- Offer 2-3 approaches with trade-offs.
- Save validated plans to `docs/plans/YYYY-MM-DD-<topic>-design.md` only when the user has agreed to a design/planning flow.

Do not use `brainstorming` to delay obvious, narrow fixes.

### `frontend-design` details

Use for UI work, but adapt it to this app:

- Keep the existing dense operational dashboard feel.
- Use existing CSS tokens from `app.component.css`.
- Keep typography consistent with the loaded fonts.
- Do not add external UI kits or design systems.
- Do not add broad visual restyles unless requested.

### `clean-code` details

Use for implementation hygiene:

- Keep changes small and scoped.
- Prefer simple, local solutions.
- Check dependent files before changing shared types/components.
- Avoid unnecessary helper files, wrappers, or abstractions.
- Verify with the repo's real commands where practical:

```bash
npm run test
npm run build
```

If browser rendering is unavailable, validate with build/tests and structural checks rather than blocking.
