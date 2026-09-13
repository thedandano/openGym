# TODO

## Unify AI Coach timeouts

- [ ] Make one overall Coach deadline the source of truth and pass it through the phone, server,
  HTTP adapter, and native transport. Keep connection and read timeouts as phase-specific guards
  that cannot expire before that deadline. Preserve short model-list checks, distinguish timeout
  failures from unreachable hosts, and cover iOS and Android behavior with integration tests.

## Run AI Coach requests in the background on Android

- [ ] After the iOS background transport ships, implement the same `CoachBackground` request,
  cancel, and discard contract in Kotlin with one long-running WorkManager worker and its required
  ongoing notification. Persist job and raw HTTP results, keep request ids idempotent, never retry
  an ambiguous interrupted request automatically, resume JavaScript validation when the app
  returns, and test normal backgrounding, process recreation, cancellation, and force-stop limits
  across the supported Android versions. Keep provider decoding and `coach_contract` validation
  in the shared JavaScript pipeline.
