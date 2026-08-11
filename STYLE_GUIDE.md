# Comp Builder — Unified Visual Style Guide

## 1. Design direction

The app becomes a **dark-first, token-driven "productive" tool**: a Gray-100-class dark theme built from blue-tinted grays, layered surfaces instead of shadows, one interactive blue accent, and strictly semantic color everywhere else. Every source converges on the same skeleton for data-dense product UIs — a frozen 14px-anchored type ramp with ~6 styles (Carbon productive set, M3 type roles, NN/g's 3-size cap), a 4/8px spacing scale with proximity doing the grouping instead of borders (Carbon, Refactoring UI, NN/g), and hierarchy achieved by de-emphasis: in draft mode only the active pick slot and the recommendation panel are allowed to be loud (Refactoring UI "emphasize by de-emphasizing", NN/g's 2-large-elements cap and squint test). Theme behavior: follow `prefers-color-scheme` with a persistent toggle in the top bar (NN/g), but the dark theme is the design-lead theme because the audience skews dark-mode and long sessions favor lower glare (NN/g + Butterick's soft-poles rule); light mode is a token swap, not a redesign (M3 role tokens).

## 2. Color system

All colors are CSS custom properties; **no raw hex outside `tokens.css`**. Grays are HSL-defined, cool-tinted toward the accent hue (~hue 222, 8–14% saturation) — never pure neutral, never `#000`/`#fff` (Refactoring UI, Butterick).

### Dark theme (default lead theme)

| Token | Hex | Use |
|---|---|---|
| `--surface` | `#14161c` | Page background |
| `--layer-1` | `#1c1f27` | Panels: filter rail, draft board, grid pane |
| `--layer-2` | `#252932` | Cards, inputs, sliders, rows inside panels |
| `--layer-3` | `#2f3440` | Popovers, tooltips, menus (max nesting — flatten anything deeper) |
| `--text-primary` | `#e6e9ef` | Stat values, champion names — **9.6:1** on `--layer-3`, ~15:1 on `--surface` |
| `--text-secondary` | `#a8b0bf` | Labels, supporting stats — **5.7:1** on `--layer-3`, 6.7:1 on `--layer-2` |
| `--text-muted` | `#8a93a5` | Metadata (patch, sample size) — **4.7:1 on `--layer-2` and below only; forbidden on `--layer-3`** (use secondary there) |
| `--accent` / ally | `#5aa2ff` | Interactive only: links, active chips, primary button, ally-side markers — 6.9:1 on `--surface` |
| `--on-accent` | `#0c1524` | Text on accent fills (never gray-on-color — Refactoring UI) |
| `--enemy` | `#ff8a5c` | Enemy-side markers only (orange, **not** red — see conflict note) |
| `--positive` | `#57c78a` | Winning delta, synergy up — 6.9:1 on `--layer-2` |
| `--negative` | `#ff6b6b` | Losing delta, bans, errors — 5.3:1 on `--layer-2` |
| `--warning` | `#eac54f` | Low-sample warnings, caution nudges |
| `--outline` | `#5f6878` | Input borders, slider tracks — ≥3:1 vs all layers |
| `--outline-variant` | `#343a46` | Decorative dividers/hairlines only — never a control's sole boundary (M3) |
| `--focus` | `#7cc4ff` | Focus rings only |
| `--scrim` | `rgba(8,10,14,0.55)` | Modal backdrop |

**Conflict resolved:** LoL convention uses red for the enemy team, but NN/g and Carbon both reserve warm red strictly for errors/warnings so it stays unambiguous. Enemy side therefore uses orange `#ff8a5c` and is *always* paired with the `ENEMY` label and column position (never color alone), leaving `--negative` red exclusively semantic.

### Light theme (token swap)

`--surface #f6f7f9`, `--layer-1 #ffffff`, `--layer-2 #eef0f4`, `--layer-3 #ffffff` (+ `--elev-sm`), `--text-primary #30343c` (Butterick: not pure black), `--text-secondary #5b6270`, `--text-muted #6d7585`, `--accent #2f6fd6`, `--positive #1d7a4a`, `--negative #c93a40`, `--enemy #c65a2e`, `--outline #8d95a3`, `--outline-variant #d8dce3`. Delta badges flip to tint-background/dark-text pairs: `--positive` badge = bg `#dcf3e6` / text `#155e3a` (Refactoring UI accessible-badge pattern).

### Rules

- Depth = layer steps, **no drop shadows for resting elevation** (Carbon/M3). Shadows only on elements floating over champion art: `--elev-sm: 0 1px 2px rgba(0,0,0,.35)`, `--elev-md: 0 4px 6px rgba(0,0,0,.3), 0 1px 3px rgba(0,0,0,.4)`, `--elev-lg: 0 12px 24px rgba(0,0,0,.4)` (drag previews, tooltips, modals).
- Text over splash art gets a bottom scrim: `linear-gradient(transparent, rgba(10,12,16,.85))` reaching ≥80% behind the text line (WCAG least-contrasting-point).
- Colored text never sits on colored fills; on tinted chips use same-hue lighter text or white at 75–80% opacity (Refactoring UI).
- Validate every token pair programmatically (WCAG luminance formula) in a lint step, both themes.

## 3. Typography

**Stack:** `"Inter", "IBM Plex Sans", "Segoe UI", system-ui, sans-serif`, loaded in weights **400 and 600 only** (500 optional for labels). All numerals: `font-variant-numeric: tabular-nums`. Sizes in `rem` (÷16).

Frozen ramp — **no other sizes anywhere**:

| Token | px / rem | Line-height | Weight | Use |
|---|---|---|---|---|
| `--type-hero` | 28 / 1.75rem | 34px (1.2) | 600 | One per view: page title OR draft-phase banner OR hero win-rate number |
| `--type-title` | 20 / 1.25rem | 26px (1.3) | 600 | Section headers (Filters, Draft, Comp) |
| `--type-subtitle` | 16 / 1rem | 22px | 600 | Card/panel titles, selected-champ name |
| `--type-body` | 14 / 0.875rem | 20px (1.43) | 400 | Default: stats, controls, table cells, champion names |
| `--type-label` | 12 / 0.75rem | 16px | 400–500 | Filter labels, slider captions, chip text |
| `--type-caption` | 11 / 0.6875rem | 16px | 500 | Grid-tile name captions, `TOP`/`JG` role tags — uppercase gets `letter-spacing: 0.06em` (Butterick) |

- **Conflict resolved:** Butterick wants 15–25px body; Carbon, M3, and NN/g all anchor dense product UIs at 14px. **14px wins** for stats/controls; prose blocks (matchup advice, empty states, tooltips) step up to 15–16px at `line-height:1.5`, `max-width:65ch`.
- Weight 700 is reserved for one thing per row/tile: the decision-relevant number or the selected state (Butterick + M3 emphasized-variant rule). Never below 400 (anti-aliasing fade, WCAG note).
- Hierarchy within the same size comes from color + weight (`--text-primary` 600 value / `--text-secondary` 400 label), not new sizes (Refactoring UI).
- Labels fold into values: `61% WR · 214 games`, never `Win rate: 61%` (Refactoring UI).
- Mixed-size numbers ("61" + "%") align on baseline; numeric table columns right-align.

## 4. Spacing & layout

**Base unit 4px.** Tokens: `--sp-1:4px --sp-2:8px --sp-3:12px --sp-4:16px --sp-5:24px --sp-6:32px --sp-7:48px --sp-8:64px`. Audit out every 5/10/15/18px value (Carbon).

- Within-group gaps: `4–8px` (grid tiles: 8px gap, icon-to-label: 4px). Between groups: `24px` (filter groups). Between panes: `32px`. Group separation must be ≥2 steps larger than internal spacing — unambiguous grouping (Refactoring UI, NN/g proximity).
- Use `gap` on flex/grid with tokens, not per-child margins (Carbon Stack pattern).
- **Whitespace over borders:** panels are separated by layer color + gutters; delete nested 1px boxes. Section headings get asymmetric space — `24px above / 8px below` — before any divider is considered (Butterick).
- **Shell:** `max-width: 1584px; margin-inline: auto;` 16-column CSS grid, 16px gutters. Desktop draft view: ally picks cols 1–4, champion pool cols 5–12, enemy picks + matchup readout cols 13–16. Below 1056px: 8 columns; below 840px: stacked panes with the draft board pinned first (Carbon grid + M3 panes). Champion grid itself caps at ~900px — don't stretch it across a 1920px viewport; sliders stay 240–320px wide (Refactoring UI).
- All fixed sizes on 8px multiples: portraits 32/48/64px squares, role icons 16–20px, table rows 36–40px (one density step below Carbon's 48px default — sanctioned for scan-heavy surfaces by M3, but dialogs and the confirm controls stay at default 48px height, and density never changes text size).
- Design for worst-case content: "Nunu & Willump" truncates with ellipsis + title tooltip; empty filter results, 0-pick drafts, and max-ban states get designed empty states (NN/g).

## 5. Component conventions

**Buttons** — strict hierarchy, exactly **one** primary per view (Carbon):
- Primary ("Lock In" / "Build Comp"): solid `--accent` fill, `--on-accent` text, 44–48px tall, weight 600.
- Secondary ("Reset draft"): 1px `--outline` border, transparent fill, `--text-primary`.
- Ghost/tertiary (clear filter, copy link, sort): text-only in `--text-secondary`; negative horizontal margin so the label aligns with the panel's text column (Carbon). Destructive turns red only at its confirm step (Refactoring UI).
- Icon-only buttons: 16px glyph, tooltip required, 48px hit area.
- Modals: primary bottom-right; page action bars: primary leads left (Carbon).

**Inputs / search**: `--layer-2` fill (one step above their panel), 1px `--outline` border, 8px radius, 36–40px tall, 14px text. Search field may be pill-shaped (M3).

**Sliders (dual min/max)**: track 4px tall in `--outline` on the panel, filled range in `--accent`; thumbs 16px visual inside a **24px+ padded hit area** (WCAG 2.5.8 — thumbs are the usual violator), 48px preferred (M3). Always show numeric readouts beside the track (`120–840 games`) — never color-only ranges. Subtle inset track shadow allowed.

**Cards / stat tiles**: `--layer-2`, 12px radius, 16px padding, no border (layer contrast separates). Pattern: one big number (`--type-hero` or `--type-subtitle`, weight 600, `--text-primary`) + folded label (`--type-label`, `--text-secondary`) + optional 4px horizontal bar. Default shows only the 3–5 decision-driving stats; the rest behind an expandable row (NN/g dashboard rule). Recommended-pick cards get a 3px left accent border in `--accent`.

**Champion grid**: tiles 4–8px radius (inner portrait radius = outer − padding, M3 optical roundness), 8px gaps, ≥48px hit areas even if visuals are smaller. States:
- Hover: `currentColor` overlay at 8% + one layer lighter, name caption revealed.
- Selected/picked: **2px solid `--accent` ring + corner check badge** (never a tint wash — WCAG state indicators need 3:1).
- Banned: 38% opacity + desaturated art + strike/X overlay icon (M3 disabled + non-color cue).
- Focus: standard ring (below).

**Tables / stat rows**: 36–40px rows, `--outline-variant` hairlines between groups only (not every row), text left-aligned, numerics right-aligned tabular. Bold only the decision number per row. Bars/bullets for winrate/pick-rate — **no donuts, gauges, radials, or 3D ever** (NN/g preattentive attributes); sort bars by value.

**Badges / delta pills**: 11–12px, weight 500. Every delta shows sign + arrow: `▲ +2.3%` in `--positive`, `▼ −1.8%` in `--negative` — the glyph carries the meaning, color reinforces. Dark theme: colored text on `--layer-2`; light theme: dark-on-tint pairs from §2.

**Chips (filters)**: pill shape, `--outline-variant` border; active = `--accent` at 16% fill + `--accent` text + weight 600; chip close-buttons get 24px+ hit areas.

## 6. Interaction & motion

Carbon "productive" motion — no bounce, no expressive curves:

| Event | Duration | Easing |
|---|---|---|
| Hover/press on tiles, buttons, chips | 70ms | `cubic-bezier(0.2, 0, 0.38, 0.9)` |
| Tooltip / panel fade | 110ms | entrance `cubic-bezier(0, 0, 0.38, 0.9)` |
| Filter-group expand/collapse | 150–240ms | entrance |
| Draft pick lands / toast ("Enemy picked Zed") | 400ms | entrance |
| Modal scrim | 700ms fade to `--scrim` | standard |

- State layers (M3): every interactive element gets a `currentColor` overlay — hover 8%, focus-visible 10%, pressed 10%, dragged 16%; disabled content at 38% opacity. One rule covers hundreds of tiles.
- Filtering: checkbox/role filters over the local dataset apply **instantly**; sliders debounce 300ms after last drag (NN/g interactive-filtering rule — no Apply button while data is client-side; add one only if a filter causes a network round trip).
- On recompute: dim the grid to ~50% opacity for the recompute frame instead of popping content; preserve scroll position; show a live count ("37 champs match") beside the filters (NN/g).
- Drag a champ to a slot: raise to `--elev-lg` + 16% state layer while dragging.

## 7. Accessibility checklist

- [ ] All body-tier text ≥ **4.5:1** against its *actual* layer (test `--text-muted` on every surface it's allowed on; it is banned from `--layer-3`). Target ~5.5:1 headroom on 11–12px text (anti-aliasing fade).
- [ ] Large text (≥24px, or ≥18.5px at 600+) may drop to **3:1** — applies to hero numbers only.
- [ ] Controls: slider tracks, input borders, toggle outlines, chart bars, icons ≥ **3:1** vs their panel (`--outline` guarantees this; `--outline-variant` never bounds a control).
- [ ] Selected/banned/picked state indicators ≥ 3:1 (2px ring + badge, never tint-only). Light rings over art get a 1px dark outer keyline.
- [ ] One focus style app-wide: `outline: 2px solid var(--focus); outline-offset: 2px;` on every interactive element (WCAG 2.4.13).
- [ ] Hit areas: everything ≥ 24×24px hard floor; tiles, thumbs, chips ≥ 48px; primary actions 44–48px tall with ≥8px between adjacent targets.
- [ ] Never color alone: deltas carry sign+arrow, bans carry an icon, teams carry `ALLY`/`ENEMY` labels + fixed column positions, heat cells show their number.
- [ ] Inline links in stat text: always-underlined (touch has no hover).
- [ ] `@media (prefers-reduced-motion: reduce)`: all transitions → `1ms`, kill the pick animation and drag elevation transitions; dims/opacity swaps remain.
- [ ] Theme follows `prefers-color-scheme`; toggle persists (localStorage) and is itself a 48px target.
- [ ] CI lint: script every fg/bg token pair through the WCAG luminance formula for both themes (check reds especially — low green channel).
- [ ] Squint test each view after implementation: only the active pick slot + top recommendation may pop in draft mode.

## 8. Source attribution

| Decision | Driven by |
|---|---|
| Dark-first + system-follow + persistent toggle | NN/g (dark mode research), Butterick (soften poles) |
| 4-step layer model, no resting shadows, non-layer text tokens | IBM Carbon (themes/layering), M3 (surface-container ladder) |
| Blue-tinted HSL grays, no on-the-fly shades, no gray-on-color | Refactoring UI |
| Red strictly semantic; enemy = orange + label (conflict resolution) | NN/g (warm brights = warnings) over LoL convention |
| 14px body anchor, frozen 6-style ramp (conflict resolution) | Carbon productive set + M3 + NN/g 3-size cap, over Butterick's 15–25px (his prose rules kept for prose blocks) |
| Two weights, bold-one-thing-per-row, folded labels, caps tracking | Butterick, Refactoring UI ("Labels Are a Last Resort") |
| 4px spacing tokens, gap-based stacks, 8px component sizing, 16-col/1584px shell | IBM Carbon (spacing scale, 2x grid) |
| Whitespace-over-borders grouping, constrained widths | Refactoring UI, NN/g (proximity), Butterick (rules sparingly) |
| One-primary-button rule, ghost label alignment, modal button placement | IBM Carbon (button docs) |
| State layers (8/10/16%), 38% disabled, 48px targets, density as opt-in, corner-radius nesting | Material Design 3 |
| Motion durations/easings | IBM Carbon (productive motion) |
| Instant vs debounced filtering, dim-don't-pop, live result count | NN/g (filter UX) |
| Bars-not-donuts, 3–5 key metrics, sorted encodings | NN/g (preattentive attributes, dashboards) |
| All contrast floors, focus appearance, 24px targets, scrims over art, CI contrast validation | WCAG 2.2 (1.4.3, 1.4.11, 1.4.1, 2.5.8, 2.4.13) |