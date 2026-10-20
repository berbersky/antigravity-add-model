# Fleet and context indicator verification

Verified on Windows on **2026-10-20**, using the real Antigravity **2.23.1**
standalone desktop runtime. This is separate from the VS Code-based IDE 2.5.5
adapter described in [IDE setup](ide.md).

The installed addon was tested in an isolated copy with a separate profile.
Isolation changed filesystem paths and suppressed protocol registration; the
native renderer, language server, conversation storage and compaction remained
intact. The package check verified 1,125 files against the installed addon.
Generation and quota responses came from a deterministic loopback provider.

## Native application results

| Check | Observed result |
| --- | --- |
| Send a custom-model message through the native composer | Streamed response displayed; one context ring beside the model selector, estimating `~851` visible transcript tokens. |
| Change the selected model | Configured context limit changed from `128,000` to `32,000`, without duplicating the ring. |
| Open a new conversation | Usage became unavailable (`?`); the previous conversation's estimate was not reused. |
| Reopen the conversation and run the native `/compact` command | Native checkpoint completed with a 277-character summary. `modelSummarizationFailed` and `usedFallbackSummary` were both false; the visible transcript estimate became `~253`. |
| Inspect one account assigned to two projects | Separate cards retained project A's `80%` and project B's `0%` Gemini quotas, alongside their Claude quotas and provider-reported plan labels. |
| Disable one of two accounts in a model pool | The selected account became disabled; the other account and owning model remained enabled in saved configuration. |
| Fully quit and reopen the application | All isolated application processes and the proxy listener exited. The saved conversation reopened with its checkpoint and one `~253` ring using the restored model's configured `128,000` limit. |
| Send another message in the reopened conversation | A new provider request completed and its response appeared in the native UI. Native execution returned to idle, the checkpoint remained successful, and the estimate increased to `~1,233`. |

The ring estimates the **visible transcript**, not the native language server's
full context usage. Hidden instructions, tool definitions and images are
excluded, so actual usage can be higher. It does not overwrite model limits or
native checkpoint settings.

## Automated checks

- Root suite: **1,492 passed, 0 failed, 2 skipped**.
- Gateway suite: **242 passed, 0 failed**.
- TypeScript and gateway builds, integration smoke, deployment script syntax,
  and whitespace checks passed.
- ESLint: **0 errors**, 80 warnings.

Regression coverage includes scoped quota caches, structured quota errors,
bounded cooldowns, exact-model native failover, account mutation serialization,
credential preservation, stale context responses, composer replacement,
checkpoint parsing, ambiguous model selection and preload isolation.

The native test establishes application integration and persistence with local
fixtures. It does not establish live Google quota exhaustion, entitlement for
multiple Google accounts, paid-provider behavior or compatibility with every
future application version. Native failover remains opt-in and uses a matching
Cloud Code pool; it does not reinterpret native requests as public Gemini API
requests.
