# PaperPath implementation contract

PaperPath is an openly labelled Alexa+ simulator for a fictional community volunteer packet. The one required journey is: create a case, provide facts, inspect exact evidence, resolve missing/conflicting values, correct availability once, review both mapped forms, confirm personal facts, export current PDFs, restart and resume. No arbitrary forms, signatures, agency submission, authentication provider or hosted service is included.

## Reuse and architecture

Reuse the capability-proved official MCP TypeScript SDK 1.32.1 (Streamable HTTP, 2025-11-25) and pdfme generator/schemas 6.2.4. Export static PDFs with a visible checkbox; do not claim interactive AcroForms. Reuse Express from the official SDK example. One loopback Node process serves a Vite-built vanilla TypeScript interface. Native HTML forms versus React/Vite versus pdfme Form were considered: native controls need no component library and preserve keyboard/label semantics; React adds a layer without a component reuse need; pdfme Form's keyboard/state integration has not been proved. Vite supplies maintained TypeScript bundling, not a generic app starter.

Persistence uses Node 24.6.0's built-in `node:sqlite` with prepared statements and explicit transactions. The official API supports the required operations without an install-time native build. Compared with better-sqlite3, this avoids another native binary/install hook; compared with JSON files, SQLite supplies atomic multi-record revisions and idempotency. Node labels this API active development; the exact runtime is pinned and its behavior requires restart/concurrency tests. No SQLite extensions are enabled.

Custom work owns canonical facts, evidence spans, conflicts, optimistic revisions, idempotency, ownership and export validity. These invariants are absent from the reused protocol and PDF components.

## Domain and HTTP invariants

- Fields: `name`, `email`, `availability`, `equipment` (boolean), and optional `motivation`. Required fields remain unknown until supported by a source. A string proposal must occur verbatim within its evidence quote; boolean equipment proposals need an explicit matching statement. Evidence offsets are computed/validated against immutable source text, never trusted from a model.
- New differing proposals create a visible conflict. Only an explicit applicant correction resolves it. Model extraction cannot confirm a packet or silently replace existing facts.
- Mutations include owner, expected revision and idempotency key. Transactions reject stale revisions. Reusing an idempotency key with different input is rejected. Corrections invalidate prior confirmation/export eligibility. Audit history retains old and new evidence.
- Confirmation is a trusted browser action, distinct from machine validation and automated code review. The inference adapter is allowlisted to `propose_facts` only. The server binds confirmation to a one-time UI approval; source text cannot generate approval.
- Export manifests bind case revision, source hashes and template/mapping versions. Every PDF identifies revision, time and draft/confirmed status. Downloads recheck ownership/current revision. Previously downloaded files cannot be recalled.
- Loopback binding, exact Host/Origin checks, body limits, a persistent HttpOnly/SameSite browser session and browser CSRF credential separate from server-only MCP credentials are mandatory. No arbitrary filesystem paths or URLs are accepted. Credentials, runtime data and raw logs are ignored.
- Every demonstrated application action reaches domain code through an actual SDK MCP client/server call. REST serves browser state and current artifacts. Missing Groq key, malformed output, timeout and 429 preserve case state; bounded retries never substitute a paid provider.

## Interface direction

Treat the two forms as a packet on a community help desk: one conversation area beside a continuous readable review sheet, with an evidence drawer and a visible availability correction affecting both forms. Palette: paper white #FFFFFF, desk blue #E8F0F7, ink #16354A, action blue #1555AA, success teal #12605C, warning #87501C. Use a locally available humanist sans stack for controls and Georgia for the packet title only. Left-align content, generous field spacing, no decorative metrics or generic dashboard card grid. Strong visible focus, accessible contrast, reduced motion and a single-column narrow layout are required.

## Gates

Component probe passed; application gates have not. Bootstrap requires locked clean install, health check, build/typecheck/lint/test commands. Vertical slice requires genuine free Groq inference through MCP plus persistence/correction/current PDFs. Release requires the plan's complete engineering and judging matrix, clean checkout, independent Sol review and a genuine under-three-minute demo. Bee remains deferred. Do not publish or submit until release evidence passes.
