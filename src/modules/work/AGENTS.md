# Work guidance

Keep Work target IDs, action availability, and guide steps in `index.ts`. The React control must use `reviewChangeAvailability` for its disabled state and register the matching `workGuidanceTargets.reviewChange(orderId)` element. A guide can explain and navigate; it cannot prepare or accept a change. Advance its review and acceptance steps only from verified command results for the same order, guide operation, context, and generation. A fresh accepted proposal must match the proposal ID bound by the preceding prepare result.

Update the guidance runtime unit tests and rendered Work tests when changing a target, availability reason, guide step, or completion event. Show both the unresolved and already accepted stale-review paths in tests.

Compute proposal availability from the proposal displayed in the initiating tab. The client supplies that proposal; the server uses its owner-validated `resolveAgentViewContext` result. Keep the two-tab regression where a ready proposal stays open while another tab prepares a held proposal.
