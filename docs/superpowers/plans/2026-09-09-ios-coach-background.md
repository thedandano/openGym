# iOS AI Coach Background Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a bring-your-own-key AI Coach request survive normal iOS backgrounding or system termination, then resume the existing JavaScript validation pipeline without sending a duplicate provider request.

**Architecture:** Keep the Coach pipeline and provider adapters in JavaScript. Give each pipeline run a deterministic sequence of native request ids and route only full iOS Coach requests through a custom Capacitor plugin backed by a background `URLSessionUploadTask` from a file. Persist the allowlisted pipeline input in the device Coach record and persist raw HTTP results natively, so a new WebView can replay completed transport calls through the same parser, validator, and repair round.

**Tech Stack:** JavaScript, Vitest, Capacitor 7, Swift 5, Foundation background `URLSession`, `os.Logger`, XCTest, Xcode 16+

**Spec:** `docs/superpowers/specs/2026-09-09-ios-coach-background.md`

**Required simplifier:** Use `ponytail:ponytail` at full intensity throughout implementation.
Re-run its ladder against the final diff before committing the feature.

## Global Constraints

- The iOS deployment target remains 15.5.
- Only full bring-your-own-key Coach generation requests use the new background transport.
- Model listing keeps the existing 20-second foreground `CapacitorHttp` path.
- The provider request remains non-streaming.
- Swift transports and persists raw HTTP results; JavaScript remains authoritative for provider decoding, `coach_contract`, validation, repair, and proposal creation.
- One logical Coach job may make several provider calls, and each call uses a stable `<job-id>.<zero-based-index>` id.
- Reusing a request id attaches to or replays that request; it never sends it twice.
- A missing task that was previously recorded as running becomes an interruption; it is not restarted automatically.
- The API key remains in Keychain and is never written into the device Coach file, native metadata, logs, or test output.
- Native request and response files are excluded from backup and use `FileProtectionType.completeUntilFirstUserAuthentication` so a locked phone can complete the transfer after its first unlock.
- A native response is limited to 2 MiB.
- JavaScript active-job recovery expires after 24 hours; unacknowledged native terminal records expire after 48 hours.
- Keep the existing 5-minute cloud and 25-minute compatible-provider deadlines. Cross-layer timeout unification remains separate.
- A user force-quit may cancel the request. Reopening reports the interruption and does not resend it.
- Preserve the current uncommitted signing changes in `frontend/ios/App/App.xcodeproj/project.pbxproj` and `frontend/ios/App/App/Info.plist`; add only the background-Coach project entries needed by this feature.
- Add no dependency, general background mode, `BGTask`, streaming layer, or native provider parser. Foundation and the existing Capacitor bridge are enough.
- Keep the native implementation in one production file unless it becomes impossible to review safely; do not add protocols or factories solely to make mocks.

---

## File Structure

### New files

- `frontend/src/lib/coach-background-fetch.js` — creates one deterministic fetch closure per Coach job and hides the iOS Capacitor plugin behind the ordinary fetch response shape.
- `frontend/src/lib/coach-background-fetch.test.js` — pins iOS routing, request ids, aborts, native errors, and the unchanged Android fallback.
- `frontend/ios/App/App/CoachBackgroundPlugin.swift` — owns the small Codable transfer record, protected files, background session, lifecycle decisions, and Capacitor methods.
- `frontend/ios/App/AppTests/CoachBackgroundPluginTests.swift` — tests file behavior and pure lifecycle decisions without mocking Foundation networking.
- `frontend/ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme` — checks the new `AppTests` target into the shared test scheme.

### Modified files

- `frontend/src/lib/coach-device.js` — adds the private `active` Coach job record.
- `frontend/src/lib/coach-local.js` — persists jobs before transport, resumes them after a WebView restart, and acknowledges native results only after the JavaScript outcome is saved.
- `frontend/src/lib/coach-local.test.js` — proves process recovery, stable call ids, one cap charge, and no duplicate transport.
- `frontend/ios/App/App/BridgeViewController.swift` — registers `CoachBackgroundPlugin` next to `HealthKitPlugin`.
- `frontend/ios/App/App/AppDelegate.swift` — reconnects the background session and forwards iOS background-session events.
- `frontend/ios/App/App.xcodeproj/project.pbxproj` — adds Swift sources and an `AppTests` target without disturbing signing settings.
- `docs/AI_COACH.md` — documents normal background completion and the force-quit boundary after implementation.

---

### Task 1: Add the JavaScript background-fetch boundary

**Files:**

- Create: `frontend/src/lib/coach-background-fetch.js`
- Create: `frontend/src/lib/coach-background-fetch.test.js`

**Interfaces:**

- Consumes: `nativeFetch(url, init)` from `frontend/src/lib/capacitor-fetch.js`.
- Produces: `coachFetchFor(jobId: string, timeoutMs: number): (url: string, init?: RequestInit) => Promise<ResponseLike>`.
- Produces: `cancelCoachJob(jobId: string): Promise<void>` and `discardCoachJob(jobId: string): Promise<void>`.

- [ ] **Step 1: Write failing routing and idempotency tests**

Mock `@capacitor/core` so the test can select iOS or Android and inspect plugin calls:

```js
const URL = 'http://ollama.test/v1/chat/completions'
const POST = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }

const native = vi.hoisted(() => ({
  platform: 'ios',
  request: vi.fn(),
  cancelJob: vi.fn(async () => {}),
  discardJob: vi.fn(async () => {})
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => native.platform },
  registerPlugin: () => native
}))
```

Pin sequential ids and the unchanged Android path:

```js
it('numbers every provider call under one durable Coach job', async () => {
  native.request
    .mockResolvedValueOnce({ status: 503, data: '{"error":"busy"}' })
    .mockResolvedValueOnce({ status: 200, data: '{"ok":true}' })
  const fetch = coachFetchFor('local-one', 25 * 60000)

  expect((await fetch(URL, POST)).status).toBe(503)
  expect((await fetch(URL, POST)).status).toBe(200)
  expect(native.request.mock.calls.map(([x]) => x.id)).toEqual(['local-one.0', 'local-one.1'])
})

it('leaves Android on the existing CapacitorHttp transport', async () => {
  native.platform = 'android'
  await coachFetchFor('local-one', 25 * 60000)(URL, POST)
  expect(native.request).not.toHaveBeenCalled()
  expect(capacitorHttpRequest).toHaveBeenCalledOnce()
})
```

Also test that HTTP 400/500 responses resolve normally, native timeout code becomes an error
whose `name` is `AbortError`, other native failures keep their human-readable message, aborting
the supplied signal calls `cancelJob`, and `discardCoachJob('local-one')` passes the logical job
id rather than one numbered request id.

- [ ] **Step 2: Run the focused test and confirm the new module is missing**

```bash
cd frontend
npm test -- src/lib/coach-background-fetch.test.js
```

Expected: FAIL because `./coach-background-fetch.js` does not exist.

- [ ] **Step 3: Implement the smallest platform adapter**

Use one closure-local counter so replaying the pipeline begins at `.0` again:

```js
import { nativeFetch } from './capacitor-fetch.js'

let pluginPromise = null
const plugin = async () => {
  if (!pluginPromise) {
    pluginPromise = import('@capacitor/core').then(m => ({
      Capacitor: m.Capacitor,
      bridge: m.registerPlugin('CoachBackground')
    }))
  }
  return pluginPromise
}

export function coachFetchFor(jobId, timeoutMs) {
  let index = 0
  return async (url, init = {}) => {
    const loaded = await plugin()
    if (!loaded.Capacitor.isNativePlatform() || loaded.Capacitor.getPlatform() !== 'ios') {
      return nativeFetch(url, init)
    }
    const id = `${jobId}.${index++}`
    const result = await requestOnIOS(loaded.bridge, { id, url, init, timeoutMs })
    const text = String(result.data ?? '')
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      text: async () => text,
      json: async () => JSON.parse(text)
    }
  }
}
```

`requestOnIOS` copies only string headers, requires a string body, races the native request
against the supplied abort signal, invokes `cancelJob({ jobId })` on abort, and translates native
error code `timeout` to `AbortError`. It does not log request options.

- [ ] **Step 4: Run the focused tests**

```bash
cd frontend
npm test -- src/lib/coach-background-fetch.test.js src/lib/capacitor-fetch.test.js
```

Expected: PASS. Existing Android timeout assertions remain unchanged.

- [ ] **Step 5: Commit the JavaScript boundary**

```bash
git add frontend/src/lib/coach-background-fetch.js frontend/src/lib/coach-background-fetch.test.js
git commit -m "feat(ios): add Coach background transport boundary"
```

---

### Task 2: Build and test the durable iOS transfer engine

**Files:**

- Create: `frontend/ios/App/App/CoachBackgroundPlugin.swift`
- Create: `frontend/ios/App/AppTests/CoachBackgroundPluginTests.swift`
- Modify: `frontend/ios/App/App.xcodeproj/project.pbxproj`
- Create: `frontend/ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme`

**Interfaces:**

- Produces: `CoachTransferRecord` containing only id, state, timestamps, HTTP status, byte count, and filenames.
- Produces: `CoachHTTPResult { status: Int, data: String }` as the native response value.
- Produces: a file-private store with `createRequest`, `appendResponse`, `complete`, `fail`, `record`, `removeJob`, and `removeExpired`.
- Produces: `CoachBackgroundSession.shared.request`, `cancelJob`, `discardJob`, `prepare`, and `handleEvents`.
- Produces: pure `nextAction(record:hasSystemTask:)` returning `.start`, `.attach`, `.replay`, or `.interrupt`; XCTest pins this decision without a network abstraction.

- [ ] **Step 1: Add the `AppTests` target without changing signing values**

Add a unit-test bundle named `AppTests` with these exact settings:

```text
PRODUCT_BUNDLE_IDENTIFIER = dandano.opengym.tests
IPHONEOS_DEPLOYMENT_TARGET = 15.5
SWIFT_VERSION = 5.0
TEST_HOST = $(BUILT_PRODUCTS_DIR)/App.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/App
BUNDLE_LOADER = $(TEST_HOST)
GENERATE_INFOPLIST_FILE = YES
```

Make `AppTests` depend on `App`, add the test file to its Sources phase, and add `AppTests` to
the shared `App` scheme's TestAction. Preserve the existing `DEVELOPMENT_TEAM`, bundle id,
entitlements, and every other current signing edit byte-for-byte.

- [ ] **Step 2: Write failing store tests**

Use an XCTest temporary directory injected into `CoachBackgroundStore`:

```swift
func testRecordNeverContainsHeadersOrBody() throws {
    let record = try store.createRequest(
        id: "local-one.0", body: Data("secret body".utf8), now: now
    )
    let encoded = try JSONEncoder().encode(record)
    XCTAssertFalse(String(decoding: encoded, as: UTF8.self).contains("secret body"))
    XCTAssertEqual(record.state, .running)
}

func testCompletedResponseCanBeReplayedUntilJobIsDiscarded() throws {
    try store.appendResponse(id: "local-one.0", data: Data("answer".utf8))
    try store.complete(id: "local-one.0", status: 200, now: now)
    XCTAssertEqual(try store.response(id: "local-one.0"), Data("answer".utf8))
    try store.removeJob("local-one")
    XCTAssertNil(try store.record(id: "local-one.0"))
}
```

Also test 2 MiB acceptance, rejection of the next byte, request-file deletion after terminal
completion, file protection, backup exclusion, and cleanup only after 48 hours.

- [ ] **Step 3: Write failing lifecycle decision tests**

Test the pure decision that the real session uses before creating an upload task:

```swift
func testRunningRecordWithSystemTaskAttaches() {
    XCTAssertEqual(nextAction(record: .runningFixture, hasSystemTask: true), .attach)
}

func testRunningRecordWithoutSystemTaskInterruptsInsteadOfResending() {
    XCTAssertEqual(nextAction(record: .runningFixture, hasSystemTask: false), .interrupt)
}

func testCompletedRecordReplays() {
    XCTAssertEqual(nextAction(record: .succeededFixture, hasSystemTask: false), .replay)
}
```

Also test that no record means `.start`, terminal failures replay their saved error, timeout maps
from `NSURLErrorTimedOut`, cancel/discard match only the exact job-id prefix, response overflow
fails, and the saved background-events completion handler is taken exactly once.

- [ ] **Step 4: Run iOS tests and confirm production types are missing**

```bash
xcodebuild test \
  -workspace frontend/ios/App/App.xcworkspace \
  -scheme App \
  -destination 'platform=iOS Simulator,name=iPhone 17,OS=latest' \
  CODE_SIGNING_ALLOWED=NO
```

Expected: FAIL because the transfer record, file store, and lifecycle decision do not exist.

- [ ] **Step 5: Implement the protected store**

Define explicit states inside `CoachBackgroundPlugin.swift` and keep secrets out of the Codable
record:

```swift
enum CoachTransferState: String, Codable {
    case running, succeeded, failed, cancelled, interrupted
}

struct CoachTransferRecord: Codable, Equatable {
    let id: String
    var state: CoachTransferState
    let startedAt: Date
    var finishedAt: Date?
    var statusCode: Int?
    var responseBytes: Int
    let requestFilename: String
    var responseFilename: String?
    var errorCode: String?
}
```

Use atomic writes. Apply `.isExcludedFromBackupKey = true` and
`.fileProtectionKey = FileProtectionType.completeUntilFirstUserAuthentication` to the directory
and every created file. Throw contextual errors for every failed file operation.

- [ ] **Step 6: Implement the background session directly with Foundation**

Create one stable background configuration:

```swift
let configuration = URLSessionConfiguration.background(
    withIdentifier: "dandano.opengym.coach.background"
)
configuration.sessionSendsLaunchEvents = true
configuration.waitsForConnectivity = true
configuration.isDiscretionary = false
configuration.timeoutIntervalForResource = 40 * 60
```

For a new request, validate `POST`, validate an `http` or `https` URL, write the body first,
build a `URLRequest` with its exact `timeoutMs`, set headers without logging them, create an
`uploadTask(with:fromFile:)`, set `taskDescription` to the request id, save the running record,
then call `resume()`.

Implement these delegate methods:

```swift
func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                didReceive response: URLResponse,
                completionHandler: @escaping (URLSession.ResponseDisposition) -> Void)
func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                didReceive data: Data)
func urlSession(_ session: URLSession, task: URLSessionTask,
                didCompleteWithError error: Error?)
func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession)
```

Append response chunks through the bounded store. Resolve attached waiters only after the
terminal record is durable. Resolve HTTP status failures as responses. Reject timeout,
cancellation, overflow, storage, and reachability failures with explicit codes and messages.
Log only ids, host, status, elapsed time, and numeric native error codes.

- [ ] **Step 7: Run native tests**

Run the Step 4 `xcodebuild test` command.

Expected: PASS for `CoachBackgroundPluginTests`.

- [ ] **Step 8: Commit the native engine and tests**

```bash
git add frontend/ios/App/App/CoachBackgroundPlugin.swift \
  frontend/ios/App/AppTests/CoachBackgroundPluginTests.swift \
  frontend/ios/App/App.xcodeproj/project.pbxproj \
  frontend/ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme
git commit -m "feat(ios): persist Coach background transfers"
```

---

### Task 3: Expose the iOS session through Capacitor and app lifecycle hooks

**Files:**

- Modify: `frontend/ios/App/App/CoachBackgroundPlugin.swift`
- Modify: `frontend/ios/App/App/BridgeViewController.swift`
- Modify: `frontend/ios/App/App/AppDelegate.swift`
- Modify: `frontend/ios/App/App.xcodeproj/project.pbxproj`

**Interfaces:**

- Consumes: `CoachBackgroundSession.shared` from Task 2.
- Produces: Capacitor plugin `CoachBackground` with promise methods `request`, `cancelJob`, and `discardJob`.
- Produces: AppDelegate forwarding for background-session relaunch events.

- [ ] **Step 1: Add plugin argument tests to the native test target**

Factor parsing into `CoachBackgroundRequestOptions.parse(_:)`. Test missing id, non-POST
method, non-HTTP URL, non-string headers, empty body, timeout below one second, and timeout above
40 minutes. Test accepted 5-minute and 25-minute inputs.

- [ ] **Step 2: Run native tests and confirm argument parsing is absent**

Run the Task 2 `xcodebuild test` command.

Expected: FAIL because `CoachBackgroundRequestOptions` and the plugin do not exist.

- [ ] **Step 3: Implement the Capacitor bridge**

Expose only the approved methods:

```swift
@objc(CoachBackgroundPlugin)
public final class CoachBackgroundPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CoachBackgroundPlugin"
    public let jsName = "CoachBackground"
    public let pluginMethods = [
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelJob", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discardJob", returnType: CAPPluginReturnPromise)
    ]
}
```

Resolve `request` with exactly `status` and `data`. Reject with a stable code and readable
message. Log rejected argument names, never values. Keep the plugin thin; all state and network
work stays in `CoachBackgroundSession`.

- [ ] **Step 4: Register the plugin and reconnect background events**

Update `BridgeViewController.capacitorDidLoad()`:

```swift
override func capacitorDidLoad() {
    bridge?.registerPluginInstance(HealthKitPlugin())
    bridge?.registerPluginInstance(CoachBackgroundPlugin())
}
```

Prepare the stable session during application launch and add this AppDelegate callback:

```swift
func application(
    _ application: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
) {
    CoachBackgroundSession.shared.handleEvents(
        identifier: identifier,
        completionHandler: completionHandler
    )
}
```

Do not add `UIBackgroundModes`; a background URLSession transfer does not need general
background-execution permission.

- [ ] **Step 5: Run tests and build the app**

```bash
xcodebuild test \
  -workspace frontend/ios/App/App.xcworkspace \
  -scheme App \
  -destination 'platform=iOS Simulator,name=iPhone 17,OS=latest' \
  CODE_SIGNING_ALLOWED=NO
xcodebuild build \
  -workspace frontend/ios/App/App.xcworkspace \
  -scheme App \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO
```

Expected: both commands succeed with no plugin-registration warning.

- [ ] **Step 6: Commit the bridge wiring**

```bash
git add frontend/ios/App/App/CoachBackgroundPlugin.swift \
  frontend/ios/App/App/BridgeViewController.swift \
  frontend/ios/App/App/AppDelegate.swift \
  frontend/ios/App/App.xcodeproj/project.pbxproj
git commit -m "feat(ios): wire Coach background session lifecycle"
```

---

### Task 4: Make the local Coach job recoverable through the existing pipeline

**Files:**

- Modify: `frontend/src/lib/coach-device.js`
- Modify: `frontend/src/lib/coach-local.js`
- Modify: `frontend/src/lib/coach-local.test.js`

**Interfaces:**

- Consumes: `coachFetchFor`, `cancelCoachJob`, and `discardCoachJob` from Task 1.
- Consumes: unchanged `runPipeline({ adapter, cfg, kind, payload, model, timeoutMs, invokeOpts })`.
- Produces: private device record `active` and process-local `ensureRunning(active)` recovery.
- Preserves: all public `local*` method signatures.

- [ ] **Step 1: Extend test mocks with durable background call ids**

Replace the direct `nativeFetch` mock used by full Coach requests with a mock of
`coach-background-fetch.js`. Keep model listing on `capacitor-fetch.js`. Record the logical job id
and numbered request id for every fake response.

- [ ] **Step 2: Write failing recovery tests**

Pin process recreation and duplicate prevention:

```js
it('resumes a saved active job after the JavaScript process is recreated', async () => {
  await local.localReview(state(), 'shoulder')
  await background.waitUntilNativeResultIsSaved()
  local._resetLocal()

  const resumed = await local.localStatus()
  expect(resumed.job?.id).toBe(device.data.active.id)
  const done = await settle()
  expect(done.pending).toBeTruthy()
  expect(background.sentRequestIds).toEqual([`${done.pending.id}.0`])
})

it('charges the daily cap once when a recovered job replays the pipeline', async () => {
  await local.localReview(state())
  const charged = device.data.daily.n
  local._resetLocal()
  await local.localStatus()
  await settle()
  expect(device.data.daily.n).toBe(charged)
})

it('does not resend a request that iOS reports as interrupted', async () => {
  background.replyWithInterruption()
  await local.localReview(state())
  const failed = await settle()
  expect(failed.lastError.detail).toMatch(/interrupted/i)
  expect(background.sentRequestIds).toHaveLength(1)
})
```

Also test recovery through the second repair request (`.1`), expiry after 24 hours, cleanup only
after saving the outcome, `localForget` cancellation, and absence of the API key from `active`,
`pending`, and the training state.

- [ ] **Step 3: Run focused JavaScript tests and confirm recovery fails**

```bash
cd frontend
npm test -- src/lib/coach-local.test.js src/lib/coach-background-fetch.test.js
```

Expected: FAIL because the Coach device has no `active` record and full requests still use
`nativeFetch` directly.

- [ ] **Step 4: Add the private active-job record**

Extend `DEFAULTS` in `coach-device.js` with `active: null`. Keep it out of
`coachDeviceSettings()` so no request payload enters UI state.

Build this value before starting transport:

```js
const active = {
  id,
  kind,
  state: 'running',
  startedAt,
  expiresAt: startedAt + 24 * 60 * 60 * 1000,
  provider: d.provider,
  model: d.model || HTTP_PROVIDERS[d.provider].defaultModel,
  baseUrl: d.baseUrl || null,
  timeoutMs: timeoutFor(d.provider),
  payload,
  resultContext: {
    planHash: planHash(S),
    iteration: opts.iteration || 1,
    ...(kind === 'debrief' ? { workout: workoutMetaOf(S, opts.workoutId) } : {})
  }
}
```

Save `active` and the incremented daily count in one `saveCoachDevice` call. A crash then sees
either no job or one already-charged job, never an uncharged provider request.

- [ ] **Step 5: Resume through the same pipeline**

Use one deterministic fetch closure per active job:

```js
const fetch = coachFetchFor(active.id, active.timeoutMs)
const attempt = await runPipeline({
  adapter,
  cfg: cfgOf(active),
  kind: active.kind,
  payload: active.payload,
  model: active.model,
  timeoutMs: active.timeoutMs,
  invokeOpts: { env: envOf(active, key), fetch }
})
```

`ensureRunning(active)` sets public in-memory `job` before launching the promise and rejects a
second logical job. `localStatus()` loads `active`, expires it visibly after 24 hours, and calls
`ensureRunning` when a new WebView has no matching in-memory run.

For success, no-change, or failure:

1. Save the final pending/error outcome and clear `active`, guarded by matching active id.
2. Only after that save succeeds, call `discardCoachJob(active.id)`.
3. If saving fails, surface the storage error and leave native results intact for replay.
4. In `localForget`, call `cancelCoachJob(active.id)` before clearing device state.

Do not add another parser or validator. Replaying `runPipeline` consumes saved native responses
in the same order and runs the existing repair logic.

- [ ] **Step 6: Run Coach and transport tests**

```bash
cd frontend
npm test -- src/lib/coach-local.test.js \
  src/lib/coach-background-fetch.test.js \
  src/lib/capacitor-fetch.test.js \
  src/lib/coach.test.js
```

Expected: PASS, including existing `coach_contract`, malformed JSON, daily cap, and Android
timeout assertions.

- [ ] **Step 7: Commit durable JavaScript recovery**

```bash
git add frontend/src/lib/coach-device.js \
  frontend/src/lib/coach-local.js \
  frontend/src/lib/coach-local.test.js
git commit -m "feat(coach): recover iOS background requests"
```

---

### Task 5: Verify the lifecycle and document its boundary

**Files:**

- Modify: `docs/AI_COACH.md`
- Verify: all files changed in Tasks 1–4

**Interfaces:**

- Consumes: the complete iOS transport and recovery flow.
- Produces: user-facing lifecycle documentation and release evidence.

- [ ] **Step 1: Document background behavior**

Add this subsection under “Performance on a small box”:

```markdown
#### Leaving the iPhone while the Coach thinks

On iPhone, a Coach request that uses the phone's own provider key keeps its HTTP transfer in an
iOS background session. You can lock the phone or use another app and return later; openGym then
runs the saved answer through the same contract checks before showing it. Force-quitting openGym
may cancel the request, and the app will ask you to retry rather than silently sending it twice.
```

- [ ] **Step 2: Run every JavaScript test and the production mobile build**

```bash
cd frontend
npm test
npm run build:mobile
```

Expected: all Vitest suites pass and Capacitor sync succeeds.

- [ ] **Step 3: Re-run native tests after Capacitor sync**

```bash
xcodebuild test \
  -workspace frontend/ios/App/App.xcworkspace \
  -scheme App \
  -destination 'platform=iOS Simulator,name=iPhone 17,OS=latest' \
  CODE_SIGNING_ALLOWED=NO
```

Expected: all `AppTests` pass after mobile assets and dependencies are synchronized.

- [ ] **Step 4: Build and install on Comms without launching**

```bash
xcodebuild build \
  -workspace frontend/ios/App/App.xcworkspace \
  -scheme App \
  -configuration Debug \
  -destination 'platform=iOS,name=Comms' \
  -derivedDataPath /tmp/opengym-ios-device-build \
  -allowProvisioningUpdates
xcrun devicectl device install app \
  --device Comms \
  /tmp/opengym-ios-device-build/Build/Products/Debug-iphoneos/App.app
```

Do not run `devicectl device process launch`.

- [ ] **Step 5: Perform physical checks with Xcode logs visible**

On Comms:

1. Start one compatible/Ollama review and immediately lock the phone for at least 60 seconds.
2. Unlock and verify the same job is running or has produced exactly one proposal.
3. Repeat while switching to another app for longer than 30 seconds.
4. Trigger an invalid response and verify the saved response still uses one repair round and
   retains `coach_contract` enforcement.
5. Start another request, force-quit openGym, reopen it, and verify interruption is reported
   without a second request.
6. List models and verify the short foreground check still succeeds independently.
7. Verify `CoachBackground` logs show ids, state, host, status, and time but no authorization
   header, body text, API key, or training detail.

- [ ] **Step 6: Review the final diff with the Ponytail ladder**

```bash
git status --short
git diff --check
git diff -- frontend/src/lib frontend/ios/App/App frontend/ios/App/AppTests docs/AI_COACH.md todo.md
```

Expected: no whitespace errors, Android source changes, streaming changes, unrelated signing
rollback, or unintended generated files.

Apply `ponytail:ponytail` at full intensity to the actual diff. Confirm that Foundation replaces
any proposed dependency, no one-implementation abstraction remains, and every retained branch is
needed for background survival, duplicate prevention, error visibility, or data protection.

- [ ] **Step 7: Commit documentation**

```bash
git add docs/AI_COACH.md
git commit -m "docs(coach): explain iOS background requests"
```
