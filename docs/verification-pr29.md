# Tool-call reasoning verification

## Live setup

- Windows, official Antigravity IDE **2.5.5** (VS Code 1.107.0).
- OpenRouter **`nvidia/nemotron-3.5-lightning:free`**, selected directly in the native IDE model picker.
- The production proxy and saved encrypted provider credentials; no substituted provider responses or MCP delegation.
- Two synthetic files in an isolated workspace. The first names the second file and provides a calculation rule; the model must use two separate native `view_file` calls and combine their results.
- Verification date: **2026-10-23**.

## Defect reproduced

At `9d01954`, the real model completed both file reads and returned the correct answer, but transport observation still found a history defect. The two tool-call responses contained 449 and 89 characters of reasoning. The IDE omitted those thought parts when sending subsequent history, so the next OpenRouter requests contained empty `reasoning_content` for those turns.

The earlier translator fix preserved reasoning already present in history. It could not recover reasoning omitted by the native IDE. A correct answer alone was therefore insufficient evidence that the underlying loss was fixed.

## Recovery behavior

The proxy retains reasoning for successfully completed OpenAI-format tool turns in bounded, temporary memory. Recovery requires the same stable conversation identity, configured model, provider endpoint and credentials, and an exact match for the complete tool-call group. Supplied thought parts take precedence. Recovery happens before context budgeting.

The cache is cleared when the service stops. Missing identity, expired entries, changed or incomplete tool calls, provider changes, and failed or cancelled responses do not recover cached reasoning. No thought text is written to disk by this recovery feature.

## Live result after the fix

A fresh native IDE conversation used changed fixture values and completed in about nine seconds:

1. The real remote model called native `view_file` for the first file, returning 422 characters of reasoning with that call.
2. After receiving the real IDE tool result, it called `view_file` for the second file, returning 501 characters of reasoning with that call.
3. It combined both files and answered exactly `PR29_B8E5D1 RESULT=910 CHECK=NOVA`, correctly calculating `53 × 17 + 9`.

All three OpenRouter requests returned HTTP 200. The first tool turn's reasoning matched its provider response exactly in both later requests; the second tool turn matched exactly in the final request: **3/3 replay comparisons passed**, using both character counts and SHA-256 fingerprints. Tool-call IDs and actual nonempty tool results remained paired. The native request supplied a stable `sessionId`; no `cascade_id` or `conversationId` was present in this run.

The final answer was verified in the actual IDE UI and by its response fingerprint. Test instrumentation observed transport metadata without altering request/response bytes or supplying model/tool output.

## Automated checks and cleanup

- Root suite: **1,537 passed, 2 skipped** (58 test files), including deployment dependency checks.
- Focused coverage: 24 cache tests and 30 HTTP proxy tests covering streamed/nonstreamed continuation, parallel/sequential tools, scope changes, expiry, capacity, reused IDs, failed streams and shutdown cleanup.
- TypeScript build and desktop → gateway → provider integration smoke test passed. Lint reported zero errors and 80 existing warnings.
- The isolated IDE and test service were closed, and the managed IDE endpoint setting was restored to its original absence. Saved encrypted provider credentials were retained.

## Scope

This verifies the tested provider/model and native IDE flow. It does not establish how every provider internally uses reasoning, and cached reasoning is not restored after restarting the proxy. Live observation records lengths and SHA-256 fingerprints, tool names and status codes, without saving provider credentials, tool contents or raw reasoning.
