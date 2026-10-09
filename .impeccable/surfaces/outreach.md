# Research and outreach surface

Mode: Operate.

Research and outreach extends the established prospect profile in the shared marketing workspace. It retains DM Sans, the pale canvas, dark ink, green primary action, flat dividers, offset keyboard focus, and gently rounded form controls. `DESIGN.md` and `.impeccable/design.json` remain the system authority; this brief records the implemented surface composition.

## Purpose and flow

The team opens a saved prospect and switches between **Overview & sources** and **Research & outreach**. A concise research brief leads with the saved summary or prospect relevance, source count and evidence link, contact and role, contact-source link, outreach status, and follow-up date. An explicit due indicator appears when the saved follow-up date is today or earlier and the relationship is not closed.

**Edit research & follow-up** expands an inline form for the summary, contact role and source URL, status, follow-up date, and internal outreach notes. Contact details remain editable through the existing prospect form. Saving research closes the inline form and updates the brief.

The message editor supports manual email and LinkedIn drafts. Email exposes a subject; both channels keep a labeled message field. Save and copy actions follow the editor, alongside unsaved-edit feedback and saved origin/date metadata. AI draft evidence and verification caveats sit in an expandable section below the message. Evidence remains attached to the original draft when its wording is edited; changed prospect sources prompt another review before sending.

An optional **Draft with AI** section follows the manual editor. The team provides a message goal and deliberately requests generation from the saved public source excerpts. The UI states which information is used and that contact details and internal research notes stay in Radar. It displays setup guidance, missing-evidence guidance, and the rolling allowance. Manual writing and saving remain available without AI. The team reviews and sends every message manually.

Saved draft history lets the team reopen completed drafts, see manual/AI origin and generating/failed states, and page through older records. Opening another draft or starting a manual draft guards unsaved message edits. Profile navigation, source review, prospect editing, sign-out, browser history, and page exit also guard unsaved research or message changes.

## Composition and responsive behavior

Profile tabs and the research brief precede the working area. At desktop widths, the editor occupies the main column and saved drafts a 250px right column with a 48px gap. At 900px and below, history follows the editor in one column with a 36px gap and a separating divider. The expanded research form uses two columns for compact fields and becomes one column at 600px and below. Its summary and notes remain full width.

At mobile widths, section headings and actions wrap, generation actions stack, and the primary generation action spans the available width. Persistent labels remain visible for channel, subject, message, message goal, and every research field. Long text and source URLs wrap within the working area. The composition uses the existing flat workspace treatment without introducing a new visual identity.

## States and interaction rules

Preserve loading and retry feedback, explicit save/copy notices, empty history guidance, failed/running generation states, remaining generation allowance, disabled busy actions, research conflict/reload handling, and request failures that retain edits. Keep saved research distinct from unsaved form values. Protect edits while polling generation history or changing history pages. Selected history entries and the active profile section have visible current states.

Core operation must not require a model call. Generation requires a configured provider, a saved source excerpt, a nonempty goal, available allowance, and no unsaved message edits. Do not invent contact information, prospect outcomes, or evidence. Sending and automated reminders remain later modules.

## Implementation and evidence

- `apps/web/src/features/outreach/OutreachPanel.tsx`: research brief/form, draft editor, evidence, optional generation, history, and message-change guards.
- `apps/web/src/features/outreach/api.ts`: request contract, typed research/drafts, and edit-preserving request failure copy.
- `apps/web/src/features/prospects/ProspectsWorkspace.tsx`: profile tabs, route persistence, source/contact transitions, and page/navigation guards.
- `apps/web/src/styles.css`: incumbent primitives and surface responsive rules.
- Visually inspected captures: `.impeccable/review/outreach/desktop.png`, `mobile.png`, `user-1280.png`, `research-desktop.png`, and `research-mobile.png`. Their prospect, contact, message, and evidence content is explicitly labeled synthetic browser-test data.
