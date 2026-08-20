---
intent: Ensure independent, successful video delivery when identical or different links arrive concurrently from multiple group chats, and recover automatically from transient Douyin CDN 403 responses.
success_criteria: Concurrent requests never share a writable temporary media path; every event reaches its own send operation; Douyin 403 performs bounded fallback attempts before reporting a clear failure.
risk_level: medium
auto_approve: true
worktree: host
---

## Steps

- [ ] **Step 1: Capture current media utility behavior**
action: Inspect `module/utils/Base.js` and `module/utils/Networks.js`, then add a focused Node-based regression harness in the temporary working area if existing tests are unavailable. The harness must be able to verify unique generated media names and the ordered retry profile selected for a simulated HTTP 403.
loop: false
max_iterations: 1
verify: node --check module/utils/Base.js

- [ ] **Step 2: Isolate request-owned media files**
action: Update `module/utils/Base.js` so the default temporary title used by `downloadVideo` is collision-resistant per invocation, while preserving caller-provided titles and existing cache naming behavior. Update timestamp-title call sites that are part of the Douyin path only when required to delegate to the utility safely.
loop: until syntax checks pass
max_iterations: 3
verify: node --check module/utils/Base.js

- [ ] **Step 3: Add bounded Douyin 403 fallback profiles**
action: Update `module/utils/Networks.js` so an HTTP 403 on a Douyin CDN URL performs a finite ordered retry with a mobile-compatible referer/user-agent profile and without resuming a partially rejected range request. Preserve existing retry behavior for non-Douyin URLs and terminate with the original error after the configured retry budget.
loop: until syntax checks pass
max_iterations: 3
verify: node --check module/utils/Networks.js

- [ ] **Step 4: Validate concurrent paths and fallback selection**
action: Run the focused regression harness to simulate multiple simultaneous calls using the same source URL, confirming distinct temporary path ownership. Simulate a Douyin 403 and assert that fallback retry options differ from the initial request and remain bounded.
loop: until checks pass
max_iterations: 3
verify: node --check module/platform/douyin/douyin.js

- [ ] **Step 5: Review diff and repository checks**
action: Inspect the final diff for unintended changes, run all available package verification scripts, and confirm the design requirements are met without configuration or command compatibility changes.
loop: false
max_iterations: 1
verify: npm test --if-present
