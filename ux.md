# Parcel Hopscotch visual guidance

Work, Explore, and Audit support order details, proposal review, acceptance, Undo, tutorials, and tool examples. Keep the interface focused on the task and its outcome. Avoid development-process commentary in user-facing copy.

## Work and chat

Use work paper `#F9F6F0`, outer neutral `#E9ECE8`, graphite text `#425057`, secondary text `#626C6D`, and separators `#D1D6D0`. Chat uses muted blue `#D6E1E6`, ink `#334E5B`, and human messages `#C1D2DA`. Keep the 24px work/chat gap and 360px default desktop chat width. A double-left-chevron control may widen chat on explicit request, up to 560px while leaving room for Work; a double-right-chevron restores the default. Hide the width control when chat stacks below Work. Agent proposals use `#E5EEF2`; tutorials use dark blue with paper text. Ready states and ordinary work actions use sage `#3D6034`.

The explicit feedback was that brown on brown obscured business data versus agent guidance. These colors override the house palette's usual brown text. Use the system UI font. The brand icon is 32px in the top-left header.

Chat has familiar messages and a composer with placeholder Message and an accessible icon-only Send control. It has no visible title, contextual subtitle, composer label, or explanatory footer. Use subheadings sparingly elsewhere. Queue rows are compact. Order details show evidence and the exact proposed change. Tutorials contain a short instruction, progress, and dismissal.

Assistant messages render their existing Markdown as readable headings, emphasis, lists, links, and code within the chat palette. Keep human messages literal. Long code scrolls inside its block. Plain multiline answers such as queue totals keep their line breaks. The width control has an accessible name, tooltip, and visible keyboard focus; width changes do not alter a draft or current work.

Proposal review shows included changes, before/after values, consequences, and exclusions. Human acceptance leads to a receipt and safe Undo. Green means deterministic eligibility checks passed; pair it with text.

## Explore

Use four scenario cards and a filterable catalogue generated from the real tool registry. Categories are Read, Guide, Prepare, and Classify. Rows expand to show the effect and example call/result JSON with copy. Keep examples explicitly illustrative. Scenario actions take the user to working flows. Include the reset tool without inventing another screen.

## Audit

Use the full width and hide chat. Each user request has one row showing start time, prompt, models, outcome, send-to-completed-work duration, turn count, total tokens, and total cost. Expand requests independently to show model calls as chronological turns, then expand a turn for its existing details. The server groups and paginates by owner, workspace generation, and agent turn ID, never by prompt text. Search returns complete matching requests, including their other turns. Unknown measurements stay unknown. Add freeform multi-term search, a clear control, a match count, and an empty state. Rows expand to request, response, and application-result details with provider, bytes, tokens, costs, retries, and cancellations. Unknown cost is unknown, not zero.

Show only completed-request, completed-turn, and committed-command durations with clear labels. A spinner or partial response is not completed work.

## Responsive behavior and proof

Guided help uses Notes on work beside the relevant item, with a muted blue
outline and a pointer. Keep the real control reachable. A compact Task trail
holds the task and return action while moving between views. Show me is the
consent step before navigation for an offered guide. A direct chat request to
locate the Ready review control may open Ready and point to that control. The
person performs every business action.
Keep explanations short and specific to current evidence. If another tab has
already resolved an item, say so and help the person request a fresh review.

At narrow widths, put the note in the normal reading flow instead of covering
the work. Manual navigation pauses the guide; Resume is explicit. Dismiss and
Escape remove annotations and restore a useful focus target. A missing target
must leave readable guidance with a recovery action, not an arrow to empty
space. These choices favor continuing real work over locking the page inside a
tour.

At narrow widths, chat follows work. Keep horizontal overflow inside the Audit table, with no page-wide overflow at 320px. Preserve keyboard actions, focus visibility, accessible icon names, and reduced-motion preferences. Use styled shadcn controls without importing its default appearance.

For every UI PR, capture and inspect meaningful application states at desktop and narrow widths. Show the app before or after the change, or show the new feature when there is no earlier state. Use matching viewport and browser settings when showing both Before and After. Attach selected PNGs through `gh --attach`. Check contrast, clipping, overlap, spacing, sizing, and reachable actions. Use Trace View for interaction history and optional video when motion matters. See [browser testing](docs/browser-testing.md).
