# PaperPath

### Tell us once. Get two forms that agree.

PaperPath is a local practice simulator for preparing a fictional volunteer application and matching availability-and-equipment request. Review the facts, correct a shared value once, confirm the packet for practice, and download two PDFs. It does not submit anything to an organization.

PaperPath simulates an Alexa+ conversation using a local MCP client and server over Streamable HTTP (protocol version 2025-11-25). It is not connected to Alexa+ or Amazon, has no Amazon endorsement, and is not an official application service.

## Review candidate

This walkthrough targets the review branch **codex/review-ready-20261022**. The application source used for the current checks is **5d60eed**; the documentation update may advance the branch without changing that app source. In a fresh clone, use the review branch shown for this candidate, not an older default-branch checkout. Check the latest pull-request checks before relying on past results.

The app source at **5d60eed** passed a clean dependency install, 59 tests, typecheck, lint, and build. The current review candidate also completed a synthetic HTTP-to-MCP journey that corrected a shared value, confirmed the packet, downloaded two matching PDFs, and rejected the old download links after a later correction. This test used synthetic facts and did not call Groq. These checks do not establish production readiness.

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

The [public 65-second video](https://youtu.be/KOGpO7Dg23g) is an older edited walkthrough from a separate fictional case. Its provider suggestion was rejected by the unsupported-fact guard; the video then shows manual recovery, practice confirmation, and two PDF exports. It does not show the current review UI or prove successful live extraction.

## Run the checks

~~~sh
npm test
npm run typecheck
npm run lint
npm run build
~~~

See [application contracts](docs/contracts.md) for the source-evidence rules and protocol details. No successful current live-provider extraction is claimed.
