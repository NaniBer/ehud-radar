# Ehud Radar

<!-- impeccable:product-schema 1 -->

## Platform
web

## Stack
React, Node.js, PostgreSQL; Serper for web search and OpenRouter free models for optional, on-demand fit assessments.

## Users
Ehud AI's marketing team, using one shared account.

## Product Purpose
Find relevant prospects, retain source evidence, prepare communication, and track outreach and follow-ups.

## Operating Context
Discovery becomes a saved prospect directory and an ongoing relationship workflow. Model usage is limited; core workflows must work without model calls.

## Capabilities and Constraints
Shared-account login and manual prospect management are implemented. The confirmed username is `ehudaiuser`; the user configures the password. No public registration, invitations, roles, or teammate assignments. PostgreSQL stores the account, sessions, and prospects. The directory supports adding, reopening, editing, searching, category filtering, and source evidence. Discovery searches, persisted search history, candidate review/save, dismiss/restore, and optional source-grounded AI fit assessments are implemented. Search results are candidates until reviewed; target location is not a verified address. Search and assessment attempts are each limited to 20 per rolling 24 hours. Research summaries, contact-role/source references, outreach status, follow-up dates, and editable manual or AI-assisted email/LinkedIn drafts are implemented inside each prospect. AI drafting uses saved public source excerpts and an explicit goal; contact details and internal notes stay in Radar. Draft generations are cached and limited to 10 attempts per rolling 24 hours. Sending and automated reminders remain later modules.

## Evidence on Hand
No official logo or visual identity assets have been supplied. Do not fabricate prospect counts, customer claims, or marketing outcomes.

## Open Decisions
Hosting and the final visual identity remain undecided. Local development is the current environment.
