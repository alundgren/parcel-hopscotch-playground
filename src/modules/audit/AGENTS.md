# Audit guidance

Keep Audit target IDs and guide steps in `index.ts`. Register `audit.search` on the actual search input and `audit.results` on the visible request region or its empty state. Complete the result step only after the selected Application result panel has loaded and rendered. Opening the Audit view or clicking a row alone does not complete it.

Update the guidance runtime unit tests and rendered Audit tests when changing a target or completion event. Keep request bodies and provider payloads out of model guidance context.
