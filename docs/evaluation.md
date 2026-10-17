# Local evaluator walkthrough

PaperPath is a practice simulator, not Amazon Alexa+, and it does not submit an application. Use fictional values only. This walkthrough needs no Groq key or public host. The server stores its local runtime data under the ignored `.local/` directory.

## Start the app without inference

Use Node 24.6.0. In a terminal at the repository root:

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

The synthetic integration test in [`tests/journey.test.ts`](../tests/journey.test.ts) exercises the local HTTP and MCP path, applies the corrected shared value, confirms the packet, generates both PDFs, downloads them, and checks their PDF structure and extracted text. The test uses no provider call. It does not assess browser layout, visual PDF rendering, public hosting, or judge access; those need separate evidence.
