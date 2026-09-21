# Parcel Hopscotch visual guidance

The owner approved the interactive prototype in `docs/design/approved-prototype.html` on 2026-09-21. It contains Work, Explore, and Audit, including order details, proposal review, acceptance, Undo, tutorials, and tool examples. The scripted data and inference figures are illustrative. Preserve its visual treatment while implementing actual behavior.

## Work and chat

Use work paper `#F9F6F0`, outer neutral `#E9ECE8`, graphite text `#425057`, secondary text `#626C6D`, and separators `#D1D6D0`. Chat uses muted blue `#D6E1E6`, ink `#334E5B`, and human messages `#C1D2DA`. Keep the 24px work/chat gap and 360px desktop chat width. Agent proposals use `#E5EEF2`; tutorials use dark blue with paper text. Ready states and ordinary work actions use sage `#3D6034`.

The explicit feedback was that brown on brown obscured business data versus agent guidance. These colors override the house palette's usual brown text. Use the prototype's system UI font to preserve the approved layout. The brand icon is 32px in the top-left header.

Chat has familiar messages and a composer with placeholder Message and an accessible icon-only Send control. It has no visible title, contextual subtitle, composer label, or explanatory footer. Use subheadings sparingly elsewhere. Queue rows are compact. Order details show evidence and the exact proposed change. Tutorials contain a short instruction, progress, and dismissal.

Proposal review shows included changes, before/after values, consequences, and exclusions. Human acceptance leads to a receipt and safe Undo. Green means deterministic eligibility checks passed; pair it with text.

## Explore

Use four scenario cards and a filterable catalogue generated from the real tool registry. Categories are Read, Guide, Prepare, and Classify. Rows expand to show the effect and example call/result JSON with copy. Keep examples explicitly illustrative. Scenario actions take the user to working flows. Include the reset tool without inventing another screen.

## Audit

Use the full width and hide chat. Each inference attempt has one clear row showing time, request, model, outcome, complete duration, tokens, and cost. Add freeform multi-term search, a clear control, a match count, and an empty state. Rows expand to request, response, and application-result details with provider, bytes, tokens, costs, retries, and cancellations. Unknown cost is unknown, not zero.

The final build agreement removes the prototype's first-useful-output metric. Show only completed-request, completed-turn, and committed-command durations with clear labels. A spinner or partial response is not completed work.

## Responsive behavior and proof

At narrow widths, chat follows work. Keep horizontal overflow inside the Audit table, with no page-wide overflow at 320px. Preserve keyboard actions, focus visibility, accessible icon names, and reduced-motion preferences. Use styled shadcn controls without importing its default appearance.

For every UI PR, capture the reference and implementation in the same task state and viewport. Attach labeled side-by-side comparison images and a Playwright recording through `gh --attach`. Inspect the result before publication. Use the approved prototype as the reference, not a newly accepted implementation snapshot.
