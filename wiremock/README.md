# WireMock fixtures

The mappings provide deterministic local CRM fault injection. `success` returns 201; `transient` advances 500 → 429 → 201; `permanent` always returns 503; `nonretryable` always returns 400; and `recoverable` returns 503 three times before returning 201 thereafter. Scenario state and WireMock's request journal make call counts observable in tests.

`POST /alerts/dead-letter` returns 202. These are fixtures only: no live service, credential, or secret is present. The lab uses 0.25 and 0.5 second waits; production retries normally need exponential backoff, jitter, and longer intervals.
