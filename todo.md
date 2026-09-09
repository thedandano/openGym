# TODO

## Unify AI Coach timeouts

- [ ] Make one overall Coach deadline the source of truth and pass it through the phone, server,
  HTTP adapter, and native transport. Keep connection and read timeouts as phase-specific guards
  that cannot expire before that deadline. Preserve short model-list checks, distinguish timeout
  failures from unreachable hosts, and cover iOS and Android behavior with integration tests.
