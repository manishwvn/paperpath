# PaperPath: local evaluator guide

PaperPath is a practice simulator for a fictional volunteer packet. It creates a volunteer application and matching availability-and-equipment request. It does not submit a real application and is not connected to Alexa+, Amazon, or an agency.

This guide targets the open [PR #18 review candidate](https://github.com/manishwvn/paperpath/pull/18), branch **codex/review-ready-20261022**. Its current application source is [`d53bf3b`](https://github.com/manishwvn/paperpath/commit/d53bf3b30ee4e35c452a3173032bcbef2e052d20); documentation-only commits may advance the PR head. Check out the review branch and use the latest PR checks for the exact head.

The only published video is the [older 65-second walkthrough](https://youtu.be/KOGpO7Dg23g), from an older UI and a separate synthetic case. It shows a provider suggestion rejected by the unsupported-fact guard, followed by manual correction, practice confirmation, and two PDFs. No new public demo cut has been published. The linked video does not show this candidate’s System/Light/Dark control or a successful live AI extraction.

## Start the key-free app

Use Node.js 24.6.0. In a fresh clone of the review branch:

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

Open <http://127.0.0.1:4317> and leave the server running while you use the app. The key-free command makes no Groq request. By default, case data and exports are written under the ignored **.local/** directory. Use fictional values only.

If your shell does not support **env -u**, remove **GROQ_API_KEY** from that shell’s environment before running **npm run dev**.

## Review one packet manually

1. In **Appearance**, choose **System**, **Light**, or **Dark**. System follows the operating-system appearance; Light and Dark set an explicit choice.
2. Select **Start practice packet**.
3. Expand **Correct a fact**. Use the field menu and **Save correction** control to enter these synthetic values:

   | Field | Practice value |
   |---|---|
   | Name | Nora Grey |
   | Email | nora@example.test |
   | Availability | Thursdays |
   | Equipment | Needed |
   | Motivation (optional) | I want to help the community. |

   Name, Email, Availability, and Equipment are required before the packet can be confirmed. Motivation is optional.
4. Change Availability to **Wednesdays**. Check that the shared availability value and both form previews now say **Wednesdays**.
5. Review the packet and any evidence or open questions. Unknown or conflicting values stay visible; correct them before confirmation.
6. Check **I have reviewed…** and select **Confirm facts for practice**. The status should indicate practice confirmation. This does not submit or send the packet.
7. Select **Prepare downloads**, then download both the application and availability request PDFs. Check that each has Nora Grey, Wednesdays, the equipment answer, and its own form title.

If you change a fact after preparing exports, the old download links are rejected because they refer to an earlier revision. Review and reconfirm the current packet, then prepare new downloads. A PDF already saved on your device cannot be recalled.

## What this walkthrough proves

The application source commit **d53bf3b** passed GitHub Actions run [39987467060](https://github.com/manishwvn/paperpath/actions/runs/39987467060): dependency installation, tests, typecheck, lint, and build. The synthetic HTTP-to-MCP journey in **tests/journey.test.ts** creates a case, applies a corrected shared value, confirms the packet, downloads both revision-bound PDFs, and checks that a later correction makes those old download links stale. It uses synthetic values and does not call Groq. Check the PR for validation of its latest head.

The app’s browser talks to the local HTTP server. For packet operations, that server uses its local Streamable HTTP MCP client/server endpoint and domain validation before storing the case and creating PDFs. Groq is optional. The command in this guide disables it, and all edits above use manual correction.

## Privacy and recovery boundaries

Do not enter real applicant data. Case data stays in the local runtime directory, which is **.local/** by default. If you configure Groq and send a narrative for analysis, that text is sent to Groq; retention behavior has not been verified. This guide makes no provider call.

If the app reports that a message may still be pending, keep the original text and do not send it again. Resume retrieves the latest saved case but cannot establish whether an earlier provider request is still running. Review the current facts and continue with manual correction if needed.

The only published video is an older, separate case; no new public demo cut has been published, and the existing video is not a recording of this candidate. Current-source native-browser screenshot, keyboard, and narrow-layout review are not recorded. This local review does not establish an always-on service, production readiness, Alexa/Amazon certification, event eligibility, or approval to publish or submit. Final release and submission remain subject to human review and explicit approval.

## Checks

~~~sh
npm test
npm run typecheck
npm run lint
npm run build
~~~

For the rules that keep source quotes, corrections, confirmation, and exports connected, see [the application contracts](contracts.md).
