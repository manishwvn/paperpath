# Submission draft — public demo linked; Devpost draft saved, not submitted

Draft based on the [PR #17 candidate](https://github.com/manishwvn/paperpath/pull/17) and saved Devpost draft. The public demo is [PaperPath: Community Help Desk — Current Provider Guard Demo](https://youtu.be/KOGpO7Dg23g). It shows a provider result rejected by the unsupported-fact guard, followed by manual synthetic correction, confirmation, and two PDF exports. No successful current live extraction is claimed. Treat every field marked **Not verified** as unfinished. This draft does not establish eligibility, maintained judge access, or submission readiness.

## Review candidate source and checkout

The default `main` branch is an older backend-only revision and does not contain the frontend evaluator journey. PR #17 is on `codex/core03-ui-clarification-proof`, based on PR #16. Its application source is `5b2205cf6e6ecd6693f453bfc101b24d800e2e63`. Commit `5560b843683cd7f1603d00240fb761c9611207a9` and [checks run 39347547108](https://github.com/manishwvn/paperpath/actions/runs/39347547108) are a historical test baseline; they do not include the later provider-failure matrix or this documentation revision. Use the PR's current Checks tab for latest exact-head validation. PR #17 test changes exercise production-route conflict and deterministic mock 429, 503, malformed-output, and elapsed-timeout preservation; they are not real-provider outage evidence. Current-source native Chrome proof covers CORE-03 clarification behavior with deterministic synthetic exact-loopback fixtures, not successful live provider extraction.

From a directory where `paperpath-review` does not already exist:

```sh
git clone --no-checkout https://github.com/manishwvn/paperpath.git paperpath-review
cd paperpath-review
git fetch origin refs/pull/17/head
git checkout --detach 5b2205cf6e6ecd6693f453bfc101b24d800e2e63
git rev-parse HEAD
```

The last command must print `5b2205cf6e6ecd6693f453bfc101b24d800e2e63`. This pins the application source; the PR's current head also carries tests and documentation and can advance. Use the current [local evaluator guide](evaluation.md) alongside that source checkout.

## Proposed Devpost fields

- **Title:** PaperPath — Keep a volunteer application and request in sync
- **Track:** Alexa+ is a candidate track only. **Eligibility and track fit are not verified.**
- **Source candidate:** [PR #17](https://github.com/manishwvn/paperpath/pull/17), branch `codex/core03-ui-clarification-proof`, with application source pinned at `5b2205cf6e6ecd6693f453bfc101b24d800e2e63`. The PR head contains later test and documentation changes; use its current Checks tab for exact-head validation. The default repository `main` is older backend-only code. PR #17 adds production-route conflict and deterministic mock 429, 503, malformed-output, and elapsed-timeout preservation tests. Separate current-source CORE-03 native browser proof uses deterministic synthetic exact-loopback fixtures.
- **Description:** PaperPath is a locally run practice simulator for a fictional community volunteer program. It helps an applicant keep a volunteer application and an availability/equipment request consistent. Users can review and correct facts, see evidence and unknown values, confirm a practice draft, and export two PDFs. The project uses TypeScript/Express, SQLite, and an MCP client/server over Streamable HTTP. The public demo, [PaperPath: Community Help Desk — Current Provider Guard Demo](https://youtu.be/KOGpO7Dg23g), shows one current Groq attempt rejected by the unsupported-fact guard, then manual synthetic correction, confirmation, and two PDF exports. No successful current extraction is claimed. Current-source native browser proof uses deterministic synthetic exact-loopback fixtures. A separate historical one-call live inference attempt was rejected by the unsupported-fact guard; it does not establish successful current extraction. PaperPath is not connected to Amazon's gated Alexa+ service, does not accept arbitrary PDFs, and does not submit an application to an organization. Public hosting is not claimed; event guidance makes always-on hosting optional when the repository runs locally and a demo video is provided. Maintained judge access, eligibility, and final submission preflight remain open.
- **Setup:** First use the pinned candidate checkout commands above; do not use the older default `main`. Use Node 24.6.0. Run `npm ci --ignore-scripts`, `npm run build`, then `env -u GROQ_API_KEY npm run dev` for the key-free evaluator path. The default app is loopback-only at `http://127.0.0.1:4317`. See the README for the optional exact HTTPS-origin allowlist; that setting requires a separately configured TLS reverse proxy and does not deploy the app.
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
- **Video URL:** [Public reviewed demo](https://youtu.be/KOGpO7Dg23g). Public title metadata returned HTTP 200 in a point-in-time oEmbed check. This does not guarantee continued playback or maintained judge access.
- **Mini-challenges / additional tracks:** **Not selected or verified.**
- **Public demo and judge access:** The reviewed demo has a public URL. Maintained judge access and signed-out access to the updated evaluator guide remain unverified. Hosting is optional under the event FAQ; no host or deployment is claimed.
- **Submission status:** **Not submitted.** Devpost remains a saved draft at 3/5 steps. Required eligibility declarations are recorded privately; their values are omitted from this public draft. Rules eligibility, signed-out access, and final Devpost preflight remain open. Final submission remains on hold pending explicit user approval.

## Proposed 2:40 demo script

This 2:40 script remains a proposed continuous recording outline, separate from the published guard demo. Use only fictional names, `.example.test` email addresses, and other synthetic facts. Keep the practice-only label visible.

| Time | Show and say |
|---|---|
| 0:00–0:15 | Show the PaperPath title and practice-only label. “PaperPath helps a fictional volunteer applicant keep two related forms consistent. It is a local simulator, not the Alexa+ service.” |
| 0:15–0:35 | Start a fresh practice case. Point out the explanation that case data is stored locally and provider analysis is separate. “I am using synthetic information.” |
| 0:35–1:10 | Enter or correct a sample name, `.example.test` email, availability, equipment answer, and motivation. Show each source appearing in the evidence and message history. |
| 1:10–1:35 | Compare the volunteer application and availability/equipment preview. Change availability once and show that the shared value appears in both forms. Leave any unavailable or conflicting value visibly unknown. |
| 1:35–1:55 | Read the practice confirmation notice, mark the facts reviewed, and confirm for practice. Show the draft status changing to “Confirmed for practice.” |
| 1:55–2:20 | Export the packet, open both PDFs, and point to the matching applicant, availability, and equipment answers. Check the PDFs for matching text and readable rendering; do not present an older receipt as a new execution. |
| 2:20–2:40 | Close with the actual verification boundary: “The current demo shows one unsupported Groq result; it does not show a successful current extraction. I manually corrected a synthetic value, confirmed the practice case, and exported both PDFs. Current-source browser clarification proof uses deterministic synthetic fixtures; it does not establish successful live extraction. This does not submit a real application.” |

The public demo is published and the known Devpost fields are saved; the draft remains at 3/5 steps and is not submitted. Required eligibility declarations are recorded privately; their values are omitted from this public draft. Maintained judge access and signed-out access to the updated public evaluator guide remain open. Final submission remains on hold pending explicit user approval.
