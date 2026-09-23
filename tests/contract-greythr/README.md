# @cloudpunch/tests-contract-greythr

Contract tests that every implementation of the `GreythrAdapter`
interface (from `@cloudpunch/shared`) must pass.

Purpose (per ADR-0006 §12):

- Guarantee that the shape of what the backend expects from greytHR
  is consistent across the concrete implementations
  (`GreythrApiClient`, `GreythrCsvClient`, `GreythrMockAdapter`).
- Provide a mock adapter that the backend and other test suites use
  when they need "some working greytHR" without spinning up a real
  service.
- Fail loudly if any adapter drifts from the contract (e.g., silently
  drops the `webhooksTermination` capability advertisement).

## Layout

```
src/
  mock-adapter.ts        — GreythrMockAdapter (in-memory, deterministic)
  mock-adapter.test.ts   — contract tests + happy-path exercises
  fixtures/              — sample greytHR shapes (Phase 4 will grow this)
```

Phase 4 will add:

- WireMock-backed contract tests for `GreythrApiClient` against a real
  greytHR sandbox once entitlement is confirmed.
- Round-trip tests for `GreythrCsvClient` against the S3 file layout.

## Rules

- The mock adapter is **deterministic**: same input → same output. No
  wall-clock dependencies inside the mock beyond what tests inject.
- The mock adapter is **conservative**: capabilities default to
  `false`. Individual tests enable capabilities explicitly.
- Every capability in `CapabilitySet` has at least one contract test
  that verifies "when advertised, methods exist and return the
  documented shape".
