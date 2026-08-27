# Acceptance Tests

This guide is for a reviewer or the next engineer taking over the repository. Run commands from the repository root with Docker Desktop available.

## Prerequisites

- Docker Desktop is running and has enough memory for PostgreSQL, n8n, its runner, and WireMock.
- Node.js 20 or newer and npm are installed.
- Host ports 5432, 5678, and 8080 are available, or overridden through the documented environment variables.

## Bring up the lab

```bash
docker compose up -d --wait
npm ci
npm test
```

Use `npm run bootstrap` to re-import the three workflows after editing their JSON. Focused scripts are available as `test:platform`, `test:database`, `test:intake`, `test:approval`, `test:delivery`, `test:recovery`, and `test:artifacts`.

## Core acceptance scenarios

| Scenario | Injection / action | Expected HTTP and database result | Expected downstream calls |
|---|---|---|---:|
| Standard intake | Valid standard payload | 202; `processing`, then `delivered` | 1 CRM call |
| Duplicate intake | Repeat the same `event_id` | 200 duplicate; one inbound event | 1 CRM call total |
| Approval gate | High-value lead before approval | 202; `awaiting_approval` and pending approval | 0 |
| Approval delivery | First approved decision | 200; `processing`, then `delivered` | 1 |
| Opposing decision | Reject, then approve | 409 conflict; state remains rejected | 0 |
| Transient retry | `wiremock-transient` | Attempts 500, 429, 201; delivered | 3 |
| Exhausted retry | `wiremock-permanent` | Three 503 attempts; one open DLQ | 3 CRM + 1 alert |
| Non-retryable failure | `wiremock-nonretryable` | One 400 attempt; one open DLQ | 1 CRM + 1 alert |
| Recovery | `wiremock-recoverable`, then replay | Cycle increments; fourth CRM response delivers; DLQ recovered | 4 CRM total |
| Replay duplicate | Repeat recovery after delivery | 200 no-op; replay count unchanged | no new CRM call |

## Fault injection map

| `source` | WireMock CRM path | Sequence | Ledger expectation |
|---|---|---|---|
| Other source | `/crm/leads/success` | 201 | delivered |
| `wiremock-transient` | `/crm/leads/transient` | 500, 429, 201 | three attempts, delivered |
| `wiremock-permanent` | `/crm/leads/permanent` | 503, 503, 503 | dead letter |
| `wiremock-nonretryable` | `/crm/leads/nonretryable` | 400 | dead letter on first attempt |
| `wiremock-recoverable` | `/crm/leads/recoverable` | 503, 503, 503, then 201 | DLQ followed by recovered delivery |

## Isolation and restart checks

Every test event must start with `test_` plus a UUID. Tests reset only their WireMock journal/scenario and delete child rows followed by the precise inbound IDs they created. They never truncate business tables or delete Docker volumes. For persistence evidence, close the test pool, restart PostgreSQL, wait for health, reconnect, then restart n8n and wait for readiness before asserting durable state and replay behavior.

## Troubleshooting

- `db-migrate` fails: inspect `docker compose logs db-migrate` and verify the PostgreSQL health check before retrying.
- A webhook returns 404: run `npm run bootstrap`; imported workflows must be published before the main n8n service starts.
- An operator endpoint returns 401/403: confirm the rendered `httpHeaderAuth` credential and operator header environment variables.
- Delivery is stuck: query `workflow_runs`, `delivery_attempts`, and `dead_letter_events` by `event_id`; do not alter state manually.
- WireMock count is unexpected: reset its journal and scenarios before the isolated scenario.

## Evidence recorded during development

The final integrated `npm test` run passed locally with **51/51** tests: platform **5**, database **16**, intake **13**, approval **5**, delivery **4**, recovery **3**, and artifacts **5**. The run includes an observed PostgreSQL outage and n8n reconnection, an n8n restart, exact WireMock request counts, workflow import checks, and repository secret scanning. GitHub Actions remains the independent clean-environment verification for each pushed commit.
