# iOS AI Coach Background Requests

## North Star

A person can start an AI Coach request, leave openGym normally, and return to the same request
without the request being duplicated or the Coach response bypassing the existing JavaScript
contract and validator.

## Supported lifecycle

| Event | Required result |
| --- | --- |
| App moves to the background or the phone locks | The provider request continues in a background `URLSession`. |
| iOS suspends or terminates the app | The native transfer finishes when iOS permits it and saves the raw HTTP result. |
| App returns before or after completion | The existing JavaScript pipeline resumes from the saved HTTP result. |
| User force-quits the app | The request may be cancelled. Reopening reports interruption and never silently sends it again. |
| Provider returns malformed or invalid JSON | The existing parser, validator, and single repair round remain authoritative. |

This does not promise background execution after a user force-quit. Apple deliberately treats
that as an instruction to stop the app.

## Architecture

Only full bring-your-own-key Coach requests move to the new path. Model listing remains on
`CapacitorHttp`, with its current short timeout.

```text
coach-local.js
  -> runPipeline() and existing provider adapters
    -> one fetch closure per durable Coach job
      -> iOS: CoachBackground Capacitor plugin
        -> background URLSession upload task from a file
      -> Android/web: existing nativeFetch/fetch path
```

Swift owns transport survival and raw HTTP bytes only. JavaScript continues to own payload
construction, provider response decoding, `coach_contract`, validation, the repair round, and
proposal creation.

Each JavaScript pipeline run numbers its provider calls deterministically (`<job-id>.0`,
`<job-id>.1`, and so on). Calling Swift again with an existing request id attaches to the
running transfer or returns its saved result. It never creates a second transfer for that id.
This lets JavaScript replay the pipeline after a WebView restart without paying for a duplicate
provider call.

## Durable state

The device Coach file gains one `active` record containing:

- the Coach job id, kind, start and expiry times;
- the already allowlisted Coach payload;
- the provider, model, base URL, and current timeout budget;
- the plan hash, iteration, and workout metadata needed to build the final pending card.

It does not contain the API key. The key stays in Keychain and is handed to the native request
only as an HTTP header.

Swift stores transfer metadata and request/response files under `Library/Application Support`
with file protection that remains readable after the first unlock. Those files are excluded
from backup. Request files are deleted when their upload finishes. Raw results and terminal
records remain available for replay until JavaScript acknowledges the whole Coach job, then are
deleted. Orphaned terminal records are removed after 48 hours; JavaScript will not resume an
`active` job after 24 hours.

## Native interface

The Capacitor plugin is named `CoachBackground` and exposes:

```typescript
request(options: {
  id: string
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: string
  timeoutMs: number
}): Promise<{ status: number; data: string }>

cancelJob(options: { jobId: string }): Promise<void>
discardJob(options: { jobId: string }): Promise<void>
```

`request` is idempotent by `id`. `cancelJob` and `discardJob` operate on every numbered request
under the job id. A native timeout is reported to JavaScript as an abort-style timeout. HTTP
responses, including non-2xx responses, resolve normally so the existing adapter can classify
them. Unreachable, interrupted, and storage failures reject with a human-readable reason.

## Safety and observability

- Accept only `http` and `https` URLs and only `POST` requests.
- Cap each saved response at 2 MiB. A larger response fails visibly.
- Never log request headers, body text, response text, or the API key.
- Log the job id, request id, provider host, state transition, HTTP status, elapsed time, and
  numeric native error code through `os.Logger` so the lifecycle is visible in Xcode.
- Do not automatically retry a transport failure whose delivery is ambiguous. The existing
  adapter may still perform its explicit retries after known HTTP status responses.
- Keep the existing 5-minute cloud and 25-minute compatible-provider budgets. Timeout
  unification remains the separate item in `todo.md`.

## Acceptance criteria

1. A request started on the physical iPhone named Comms completes after openGym is backgrounded
   or the phone is locked for longer than 30 seconds.
2. Reopening the app shows one running job or one completed proposal, never a duplicate request.
3. A saved malformed response still goes through the existing repair and validation behavior.
4. A force-quit or vanished native task becomes a visible interruption and is not resent until
   the person explicitly retries.
5. The API key is absent from the device Coach JSON file, native metadata, logs, and test output.
6. Model listing and Android behavior remain unchanged.
7. JavaScript tests, iOS unit tests, a simulator build, and the physical-device checks all pass.

## Out of scope

Android background execution, streaming responses, background notifications, multiple
simultaneous Coach jobs, and the existing cross-layer timeout unification are separate work.
