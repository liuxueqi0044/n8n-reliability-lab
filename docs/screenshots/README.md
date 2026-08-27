# Screenshot Capture Notes

This directory contains real screenshots captured from the fixed local n8n UI. Generated mockups, fabricated node layouts, credential views, and placeholders are not accepted. Non-content-altering cropping is allowed to keep node labels readable.

Published evidence:

- `approval-and-delivery.png`: complete workflow overview.
- `approval-gate.png`: input validation, atomic approval decision, and the delivery gate.
- `retry-dead-letter.png`: retry classification, bounded waits, dead-letter decision, and alert path.

Additional evidence can be captured after a successful bootstrap and real acceptance run:

1. The workflows list showing all three active workflows.
2. Lead Intake showing its production webhook and atomic ledger path.
3. Failure Recovery showing the protected replay webhook and Execute Workflow handoff.
4. A real execution view for a recoverable lead, including the three failed attempts and successful replay.

To update the evidence, run the focused scenario with a unique `test_` event ID, open the corresponding execution in the n8n UI at the configured host port, capture the browser without exposing credential values, save a descriptive PNG in this directory, and update the root README links during final integration. Before publishing, verify that no image contains headers, passwords, tokens, private URLs, or customer-like payloads.
