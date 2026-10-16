# Submission draft — not recorded or submitted

Draft based on the local Chrome/PDF receipt at source `47e59cb1f63e54a0bbaa0c42f502bb3b7494c3b2` (`.local/evidence/runner-release/ui-public-origin-47e59/receipt.json`), PR #11, and the current public README. Treat every field marked **Not verified** as unfinished. This draft is not a claim that the entry is eligible, hosted, or available to judges.

## Proposed Devpost fields

- **Title:** PaperPath — Keep a volunteer application and request in sync
- **Track:** Alexa+ is a candidate track only. **Eligibility and track fit are not verified.**
- **Source:** https://github.com/manishwvn/paperpath
- **Description:** PaperPath is a locally run practice simulator for a fictional community volunteer program. It helps a volunteer applicant keep a volunteer application and an availability and equipment request consistent. Users can review and correct facts, see evidence and unknown values, confirm a practice draft, and export two matching PDFs. The project uses a TypeScript/Express application with SQLite and an MCP client/server over Streamable HTTP. Local automated tests exercise MCP behavior with synthetic fixtures. In the verified browser journey, the inference provider was unavailable, so facts were entered through the manual correction controls. PaperPath is not connected to Amazon's gated Alexa+ service, does not accept arbitrary PDFs, and does not submit an application to an organization. Public hosting, external HTTPS access, and judge access have not been proven.
- **Setup:** Use Node 24.6.0. Run `npm ci`, `npm run build`, then `npm run dev`. The default app is loopback-only at `http://127.0.0.1:4317`. See the README for the optional exact HTTPS-origin allowlist; that setting requires a separately configured TLS reverse proxy and does not deploy the app.
- **Product feedback:** **Not prepared.** Add only genuine feedback obtained from a real reviewer; none is represented by this draft.
- **Video URL:** **Not recorded or published.**
- **Mini-challenges / additional tracks:** **Not selected or verified.**
- **Public demo and judge access:** **Not available yet.** No host or public deployment was verified.
- **Submission status:** **Not submitted.** Rules eligibility, signed-out access, required declarations, and final Devpost preflight remain open.

## Proposed 2:40 demo script

The script is a recording outline, not a recorded video. Use only fictional names, `.example.test` email addresses, and other synthetic facts. Keep the practice-only label visible.

| Time | Show and say |
|---|---|
| 0:00–0:15 | Show the PaperPath title and practice-only label. “PaperPath helps a fictional volunteer applicant keep two related forms consistent. It is a local simulator, not the Alexa+ service.” |
| 0:15–0:35 | Start a fresh practice case. Point out the explanation that case data is stored locally and provider analysis is separate. “I am using synthetic information.” |
| 0:35–1:10 | Enter or correct a sample name, `.example.test` email, availability, equipment answer, and motivation. Show each source appearing in the evidence and message history. |
| 1:10–1:35 | Compare the volunteer application and availability/equipment preview. Change availability once and show that the shared value appears in both forms. Leave any unavailable or conflicting value visibly unknown. |
| 1:35–1:55 | Read the practice confirmation notice, mark the facts reviewed, and confirm for practice. Show the draft status changing to “Confirmed for practice.” |
| 1:55–2:20 | Export the packet, open both PDFs, and point to the matching applicant, availability, and equipment answers. The current local receipt verifies one-page A4 PDFs with matching text and readable rendering. |
| 2:20–2:40 | Close with the actual verification boundary: “Tests cover the local MCP path with synthetic mocks. This run had no provider configured. Public hosting and judge access are still unfinished; this does not submit a real application.” |

Before using this script for submission, record the actual running app, inspect the finished video and duration, add verified public links, obtain genuine product feedback, check event rules and eligibility, and verify judge access from a signed-out browser. None of those steps is complete here.
