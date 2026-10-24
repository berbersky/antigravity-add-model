# Automatic artifact metadata correction

Verified on **2026-10-24** using the official Windows **Antigravity IDE 2.5.5**
(VS Code 1.107.0), the production proxy and the saved real OpenRouter model
**`nvidia/nemotron-3.5-lightning:free`**. The test used an isolated IDE profile and
synthetic workspace files. Provider responses and native tool results were not
replaced or simulated.

## Failure and correction

An earlier live test reproduced a model sending `ArtifactMetadata` when creating
a normal workspace file. The native IDE treated the call as an artifact write
and rejected the path. Manually instructing the model to omit the optional field
worked, but should not be required for ordinary use.

The proxy now recognizes the current native workspace mapping, artifact directory
and optional metadata schema. It removes misplaced metadata only for known file
tools targeting a confirmed workspace path outside the artifact directory.
It preserves file paths, contents, overwrite flags, call IDs and genuine artifact
metadata. Missing or conflicting context, custom/conditional schemas, malformed
metadata, and ambiguous paths do not trigger correction. Native file validation
and permissions remain in effect.

Normalization runs before tool calls enter the reasoning replay cache. History
therefore matches the arguments actually delivered to the IDE.

## Live scenarios

1. **Ordinary workspace task, without metadata advice.** The model read a fixture,
   calculated `43 × 17 + 6 = 737`, created `result.txt`, and read it back. It then
   changed an existing file from `Status: PENDING` to `Status: VERIFIED` with
   `replace_file_content` and read that change back. Disk contents matched.
   This model response already omitted metadata, so this scenario verifies normal
   behavior rather than proving the correction branch executed.
2. **Genuine artifact.** The model created `artifact-verification.md` in the
   conversation's native artifact directory and read it back. The provider's
   metadata and complete tool arguments reached the IDE unchanged; the artifact
   appeared in the native chat.
3. **Explicit regression reproduction.** A test prompt deliberately requested
   an ordinary workspace write with the erroneous `ArtifactMetadata`, and told
   the model to stop on error rather than retry. Transport observation confirmed
   the real provider sent the field. The proxy removed it while preserving the
   target path. The IDE created `corrected.txt` on the first attempt, read back
   `DEP_ARTIFACT_AUTO_CORRECTED RESULT=737 CHECK=ORBIT`, and completed the turn.
   No follow-up warning or manual correction was sent.

All **13 provider requests** returned HTTP 200. All **10 tool calls** were
delivered with matching identifiers. Native history contained **zero invalid
artifact path errors**. **69/69 reasoning replay comparisons** matched their
original provider response by length and SHA-256, including both later appearances
of the automatically corrected call.

Observation retained metadata, hashes and statuses, not credentials, raw reasoning
or tool contents. Final contents were independently checked on disk. The isolated
IDE and proxy were closed afterward, and the managed endpoint setting restored.

## Automated checks and scope

- 49 focused tests cover native context/schema recognition, Windows/POSIX/UNC
  paths, boundaries, ambiguous paths, genuine artifacts and immutable responses.
- 21 HTTP regressions cover OpenAI, Anthropic and Google formats, streaming,
  nonstreaming, JSON fallback, request isolation and reasoning recovery after a
  corrected call.
- Full root suite: **1,607 passed, two existing skips** across 59 files. Both
  builds and the desktop → gateway → provider integration check passed. Lint:
  zero errors and 80 existing warnings.

The live checks establish this model/provider and IDE version. Other providers
are covered by controlled HTTP tests, not by live remote requests in this run.
