# Discovery surface

Discovery extends the existing shared marketing workspace. It uses the incumbent DM Sans typography, pale canvas, dark ink, green primary action, flat dividers, visible focus outline, and gently rounded form controls. `DESIGN.md` and `.impeccable/design.json` remain the system authority; this file records the surface rather than redefining that authority.

## Purpose and flow

The team selects a category, target location, optional keywords, and result limit. Public search results remain candidates until a deliberate review and save. Each candidate exposes its source link, host, and available excerpt. Optional AI assessment is requested per candidate and presents confidence, evidence quotes, and verification caveats. Search does not require an assessment.

Review reuses the editable prospect form. Target location is not copied as a verified address; contact details start empty. The original search link and excerpt remain attached as evidence. Saved candidates link to their prospect; other candidates can be dismissed and restored. Unsaved edits receive a keep/discard confirmation on navigation.

## Composition and responsive behavior

Search settings sit above the working area. At desktop widths, candidates occupy the main column and persisted search history a 260px right column, separated by a 48px gap. At 900px and below the working area stacks and search settings use two columns. At 600px and below settings become a single column and the primary search action fills the available width. Candidate actions wrap; history follows results.

## States

Preserve visible labels, current navigation and history states, loading feedback, retry actions, provider setup guidance, remaining search allowance, missing excerpts, no results, dismissed candidates, and explicit save feedback. Empty states explain the next action without invented counts. Provider failures retain search settings and history. Core candidate review remains usable when AI is unavailable.

## Implementation and evidence

- `apps/web/src/features/discovery/DiscoveryWorkspace.tsx`: search settings, result/history composition, review transition, candidate actions, and state copy.
- `apps/web/src/features/WorkspaceNavigation.tsx`: Prospects/Discovery navigation.
- `apps/web/src/features/prospects/ProspectForm.tsx`: editable review and save.
- `apps/web/src/styles.css`: incumbent primitives and surface responsive rules.
- Reviewed captures: `.impeccable/review/desktop.png`, `.impeccable/review/mobile.png`, `.impeccable/review/user-520.png`. These use explicitly labeled synthetic browser-test content.
