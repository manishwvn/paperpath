# Local evaluator walkthrough

PaperPath is a practice simulator, not Amazon Alexa+, and it does not submit an application. Use fictional values only. This walkthrough needs no Groq key or public host. The server stores its local runtime data under the ignored `.local/` directory.

The [public demo video](https://youtu.be/KOGpO7Dg23g) shows a provider result rejected by the unsupported-fact guard, then manual synthetic correction, confirmation, and two PDF exports. No successful current live extraction is claimed.

## Check out the review candidate

The default `main` branch is an older backend-only revision and does not contain this frontend journey. The [PR #17 candidate](https://github.com/manishwvn/paperpath/pull/17), on `codex/core03-ui-clarification-proof` and based on PR #16, is under review. Its application source is `5b2205cf6e6ecd6693f453bfc101b24d800e2e63`. Commit `5560b843683cd7f1603d00240fb761c9611207a9` and [checks run 39347547108](https://github.com/manishwvn/paperpath/actions/runs/39347547108) are a historical test baseline; they do not include later provider-failure tests or this documentation revision. See the PR's current Checks tab for validation of the latest revision. This is a local review candidate, not a submission-ready release.

From a directory where `paperpath-review` does not already exist:

```sh
git clone --no-checkout https://github.com/manishwvn/paperpath.git paperpath-review
cd paperpath-review
git fetch origin refs/pull/17/head
git checkout --detach 5b2205cf6e6ecd6693f453bfc101b24d800e2e63
git rev-parse HEAD
```

The last command must print `5b2205cf6e6ecd6693f453bfc101b24d800e2e63`. This pins the application source used by the current review candidate. The PR head also contains tests and documentation; use its Checks tab for the latest exact-head results because that head can advance.

## Start the app without inference

After the pinned checkout above, use Node 24.6.0. In the `paperpath-review` directory:

```sh
npm ci --ignore-scripts
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

## Verification and limits

The synthetic integration test in [`tests/journey.test.ts`](../tests/journey.test.ts) exercises the local HTTP and MCP path, applies a corrected shared value, confirms the packet, generates both PDFs, downloads them, and checks their structure and extracted text without a provider call. PR #16 adds a schema-valid unsupported candidate through the production route, local MCP, and domain validator, checking the sanitized response and unchanged pending case. PR #17 adds production-route tests for a Store conflict, blocked confirmation/export, and mocked provider 429, 503, malformed-output, and elapsed-timeout outcomes. Those failure cases use deterministic loopback mocks and assert retained pending state/token with no retry; they are not evidence from a real provider outage.

Current-source native Chrome proof covers CORE-03 clarification behavior using deterministic synthetic fixtures restricted to the exact loopback app and MCP origins. This proves fixture-driven browser behavior; it does not prove successful live provider extraction. A separate historical one-call live inference attempt was rejected by the unsupported-fact guard. The manual walkthrough above lets an evaluator inspect the shared correction, confirmation, and PDF downloads without credentials; it does not reproduce the fixture-driven clarification scenarios.

Full keyboard and screen-reader verification remains open. Public HTTPS operation and eligible hosting are unproven; an always-on host is optional under event guidance when the repository runs locally and a demo video is provided. Public video metadata was checked at a point in time and does not guarantee continued playback or maintained judge access. Eligibility and final submission preflight remain open.
