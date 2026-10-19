# Local evaluator walkthrough

PaperPath is a practice simulator, not Amazon Alexa+, and it does not submit an application. Use fictional values only. This walkthrough needs no Groq key or public host. The server stores its local runtime data under the ignored `.local/` directory.

## Check out the review candidate

The default `main` branch is currently an older backend-only revision and does not contain this frontend journey. The [PR #15 candidate](https://github.com/manishwvn/paperpath/pull/15), on `codex/core03-clarification`, is under review. These steps pin tested application source commit `5b2205cf6e6ecd6693f453bfc101b24d800e2e63`; a later documentation-only branch commit may move the PR head without changing this tested application source. This is a local review candidate, not a submission-ready release.

From a directory where `paperpath-review` does not already exist:

```sh
git clone --no-checkout https://github.com/manishwvn/paperpath.git paperpath-review
cd paperpath-review
git fetch origin refs/pull/15/head
git checkout --detach 5b2205cf6e6ecd6693f453bfc101b24d800e2e63
git rev-parse HEAD
```

The last command must print `5b2205cf6e6ecd6693f453bfc101b24d800e2e63`. Fetching the PR makes its history available; the detached checkout selects the pinned application source even if the PR head advances.

## Start the app without inference

After the pinned checkout above, use Node 24.6.0. In the `paperpath-review` directory:

```sh
npm ci
npm run build
env -u GROQ_API_KEY npm run dev
```

Open <http://127.0.0.1:4317>. Keep the server terminal open while using the app. This key-free path uses the manual correction controls and sends no message for provider analysis.

## Create and correct a synthetic case

1. Select **Start new case**.
2. In **Correct a fact**, choose each field and apply these fictional values:

   | Field | Value |
   |---|---|
   | Name | Nora Grey |
   | Email | nora@example.test |
   | Availability | Thursdays |
   | Equipment | Needed |
   | Motivation | I want to help the community. |

3. Change **Availability** to `Wednesdays` and apply the shared availability correction. Confirm the packet review shows `Wednesdays` in both the volunteer application and the availability/equipment request previews.
4. Check the review confirmation box and select **Confirm facts for practice**. The status should change from draft to confirmed for practice.
5. Select **Export packet summary**. The two download links should become available for the current confirmed revision.
6. Download both PDFs and open them. Check that each contains Nora Grey, `Wednesdays`, and the equipment answer; the application and request should have their respective titles. The PDF status is `Applicant-confirmed`.

Stop the local server with Ctrl+C when finished. Do not use real applicant information or treat these PDFs as a submitted application.

## What this guide verifies

The synthetic integration test in [`tests/journey.test.ts`](../tests/journey.test.ts) exercises the local HTTP and MCP path, applies the corrected shared value, confirms the packet, generates both PDFs, downloads them, and checks their PDF structure and extracted text. The test uses no provider call. PR #16 adds a schema-valid unsupported candidate case through the production route, local MCP, and domain validator; it verifies the sanitized response and that the case remains unchanged and pending. This does not prove browser-visible clarification behavior or the full missing/conflict/unsupported journey. A scoped PR #14 receipt verifies keyboard/focus behavior for the correction flow, but full keyboard walkthrough and screen-reader announcement behavior remain unverified. Browser layout, visual PDF rendering, public hosting, and judge access also need separate evidence.
