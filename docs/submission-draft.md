# Submission draft — not recorded or submitted

Draft based on the local Chrome/PDF journey at source `47e59cb1f63e54a0bbaa0c42f502bb3b7494c3b2`, PR #11, and the current public README. The detailed local receipt and synthetic runtime artifacts are not public deliverables. Treat every field marked **Not verified** as unfinished. This draft is not a claim that the entry is eligible, hosted, or available to judges.

## Proposed Devpost fields

- **Title:** PaperPath — Keep a volunteer application and request in sync
- **Track:** Alexa+ is a candidate track only. **Eligibility and track fit are not verified.**
- **Source:** https://github.com/manishwvn/paperpath
- **Description:** PaperPath is a locally run practice simulator for a fictional community volunteer program. It helps a volunteer applicant keep a volunteer application and an availability and equipment request consistent. Users can review and correct facts, see evidence and unknown values, confirm a practice draft, and export two matching PDFs. The project uses a TypeScript/Express application with SQLite and an MCP client/server over Streamable HTTP. Local automated tests exercise MCP behavior with synthetic fixtures. In the verified browser journey, the inference provider was unavailable, so facts were entered through the manual correction controls. PaperPath is not connected to Amazon's gated Alexa+ service, does not accept arbitrary PDFs, and does not submit an application to an organization. Public hosting and external HTTPS access have not been proven; the Alexa+ event FAQ says an always-on host is optional when the public repository runs locally and a demo video is provided. PaperPath's complete evaluator path and judge-access checks remain unfinished.
- **Setup:** Use Node 24.6.0. Run `npm ci`, `npm run build`, then `npm run dev`. The default app is loopback-only at `http://127.0.0.1:4317`. See the README for the optional exact HTTPS-origin allowlist; that setting requires a separately configured TLS reverse proxy and does not deploy the app.
- **Product feedback — entrant draft, not submitted:** The event asks the entrant for feedback on developer tools/APIs/SDKs used; it does not require an external reviewer. This draft reflects my own setup, integration, and documentation work. I did not use the Alexa+ Category SDK, CLI, or Web Simulator: the FAQ says preview access is limited to select partners and provides no hackathon application path. I have no runtime feedback on those gated tools. My documentation feedback is to put that access restriction at the top of affected guides and link a minimal public MCP-server-plus-simulator recipe; the discovery steps and workaround are in the friction log below.

  - `@modelcontextprotocol/sdk` 1.32.1: used for PaperPath's Streamable HTTP client/server. The providerless integration test completes synthetic proposal, correction, confirmation, export, and PDF downloads. No SDK defect surfaced in this path. A useful example would show the application-level authorization, Host/Origin checks, and one-time confirmation that surround the tool calls.
  - `@pdfme/generator` 6.2.4 (with the matching `@pdfme` schemas): used to generate the two practice PDFs. The current integration test checks PDF structure and corrected text; a prior synthetic Chrome run's rendered pages were visually reviewed separately. No blocking generator issue surfaced in these templates.
  - Chrome DevTools MCP: one attempt to open the local app in a named isolated context failed before navigation because its configured Chrome profile was already running. The error recommended starting an isolated browser process or selecting another user-data directory, neither of which is exposed by this tool's current call. Feedback: expose a first-class owned-profile option so local UI captures do not depend on closing a shared browser. This attempt opened no page and is not evidence of an app defect.
- **Friction log draft — documentation discovery, not a tool-run report:**
  - **Task:** Determine whether hackathon participants can use the Alexa+ Category SDK, MCP Toolkit, CLI, or Web Simulator preview tools.
  - **Steps:** Compare the individual Alexa+ add-on setup guidance with the event FAQ and rules.
  - **Expected:** A developer following an official setup guide can determine whether the required preview tools are available to hackathon participants and how to proceed.
  - **Observed:** The event FAQ says these preview tools are limited to select partners, there is no participant application path, and that this restriction is sometimes missing from individual setup guides. The FAQ and rules point participants to a self-hosted MCP server or Agent Skill, with a web-based simulator/front end as an accepted demonstration path. No gated preview tool was run, and no setup error was observed.
  - **Severity:** Moderate onboarding friction for the gated preview path; it does not block the documented self-hosted MCP/simulator path.
  - **Workaround:** Use PaperPath's own web simulator with its self-hosted MCP server over Streamable HTTP; provide clear local setup and evaluation steps.
  - **Actionable suggestion:** Put the select-partner access restriction at the top of each affected setup guide and provide a minimal public MCP-server-plus-simulator recipe for hackathon participants.
- **Video URL:** **Not recorded or published.**
- **Mini-challenges / additional tracks:** **Not selected or verified.**
- **Public demo and judge access:** **Not ready yet.** The official Alexa+ FAQ says hosting is not required when a public repository runs locally and a demo video is provided. PaperPath's public video, reproducible local evaluator path, and signed-out access checks remain unfinished; no host or public deployment is claimed.
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
| 2:20–2:40 | Close with the actual verification boundary: “Tests cover the local MCP path with synthetic mocks. This run had no provider configured. Hosting is optional for this Alexa+ event; the public video and judge-ready local instructions still need to be completed. This does not submit a real application.” |

Before using this script for submission, record the actual running app, inspect the finished video and duration, add verified public links, obtain genuine product feedback, check event rules and eligibility, and verify judge access from a signed-out browser. None of those steps is complete here.
