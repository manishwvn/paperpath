# PaperPath

### Tell us once. Get two forms that agree.

PaperPath is a local practice simulator for preparing a fictional volunteer application and matching availability-and-equipment request. Review the facts, correct a shared value once, confirm the packet for practice, and download two PDFs. It does not submit anything to an organization.

PaperPath simulates an Alexa+ conversation using a local MCP client and server over Streamable HTTP (protocol version 2025-11-25). It is not connected to Alexa+ or Amazon, has no Amazon endorsement, and is not an official application service.

## Review candidate

This walkthrough targets the open [PR #18 review candidate](https://github.com/manishwvn/paperpath/pull/18), branch **codex/review-ready-20261022**. Its current application source is [`d53bf3b`](https://github.com/manishwvn/paperpath/commit/d53bf3b30ee4e35c452a3173032bcbef2e052d20); the PR head may advance with documentation-only commits. In a fresh clone, check out the review branch and use the latest PR checks for the exact head.

The app source at **d53bf3b** passed GitHub Actions run [39987467060](https://github.com/manishwvn/paperpath/actions/runs/39987467060): dependency installation, tests, typecheck, lint, and build. The test suite includes a synthetic HTTP-to-MCP journey that corrects a shared value, confirms the packet, downloads two matching PDFs, and rejects old download links after a later correction. It uses synthetic facts and makes no Groq request. These checks do not establish production readiness.

## Run locally

Requirements: Node.js 24.6.0. From a fresh checkout of the review branch:

~~~sh
git clone https://github.com/manishwvn/paperpath.git
cd paperpath
git fetch origin
git switch --track origin/codex/review-ready-20261022
node --version
npm ci
npm run build
env -u GROQ_API_KEY npm run dev
~~~

The server listens on <http://127.0.0.1:4317> by default. Open that address in your browser. The final command starts PaperPath with inference disabled, so this walkthrough makes no provider request. If your shell does not support **env -u**, unset **GROQ_API_KEY** before starting the server.

By default, local case data and generated exports are stored under the ignored **.local/** directory. Do not use real applicant details.

## Use the practice desk

Choose **System**, **Light**, or **Dark** from the Appearance control. System follows your operating-system setting.

1. Select **Start practice packet**.
2. Open **Correct a fact** and enter fictional values for Name, Email, Availability, and Equipment. Motivation is optional.
3. Review the two form previews. Change Availability once and check that both forms show the same value. Unknown or conflicting facts remain visible for review.
4. Check the review box and select **Confirm facts for practice**. This is a practice confirmation, not an application submission.
5. Select **Prepare downloads**, then download the application PDF and availability-request PDF.

For a longer step-by-step walkthrough with sample values and recovery notes, see the [local evaluator guide](docs/evaluation.md).

## Privacy and limits

- Case data and exports stay in the local runtime directory. If you enable Groq inference, text you send for analysis is sent to Groq. Provider retention has not been verified. The evaluator path above disables inference.
- If a message is reported as pending, keep its text and do not send it again. Resume shows the latest saved case, but cannot determine whether an earlier provider request is still in flight. Review the saved facts and use manual correction when needed.
- Exports are tied to a packet revision. A later correction invalidates the previous download links; prepare a new export after reviewing and reconfirming the updated packet. A PDF already downloaded to your device cannot be recalled.
- The current candidate is a local review build. It has not been deployed or submitted; an eligible host, Alexa/Amazon certification, and event eligibility are not established.

The only published video is the [older 65-second walkthrough](https://youtu.be/KOGpO7Dg23g) from a separate fictional case. Its provider suggestion was rejected by the unsupported-fact guard; the video then shows manual recovery, practice confirmation, and two PDF exports. No new public demo cut has been published. The linked video does not show the current review UI or prove successful live extraction.

## Run the checks

~~~sh
npm test
npm run typecheck
npm run lint
npm run build
~~~

See [application contracts](docs/contracts.md) for the source-evidence rules and protocol details. No successful current live-provider extraction is claimed.
