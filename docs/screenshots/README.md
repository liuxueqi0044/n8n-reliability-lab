# Screenshot Capture Notes

This directory must contain only real screenshots captured from the fixed local n8n UI by the integration owner. Do not add generated mockups, edited screenshots, or placeholder images.

Capture these views after a successful bootstrap and real acceptance run:

1. The workflows list showing all three active workflows.
2. Lead Intake showing its production webhook and atomic ledger path.
3. Approval and Delivery showing the approval branch, CRM request, and retry path.
4. Failure Recovery showing the protected replay webhook and Execute Workflow handoff.
5. A real execution view for a recoverable lead, including the three failed attempts and successful replay.

To update the evidence, run the focused scenario with a unique `test_` event ID, open the corresponding execution in the n8n UI at the configured host port, capture the browser without exposing credential values, save a descriptive PNG in this directory, and update the root README links during final integration. Before publishing, verify that no image contains headers, passwords, tokens, private URLs, or customer-like payloads.
