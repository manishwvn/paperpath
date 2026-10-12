# PaperPath

PaperPath is an Alexa+ simulator that helps a fictional community volunteer applicant keep a two-form packet consistent. It uses an actual MCP client/server over Streamable HTTP. It is not connected to Amazon's gated Alexa+ service and does not submit applications to an organization.

Implementation is in progress. The isolated component proof has passed; the application and release gates have not. Original code and authored demonstration templates are MIT licensed.

Use Node 24.6.0. Dependencies will be pinned in the committed package lock. Local credentials, case data and runtime artifacts belong in ignored `.local/`; never commit them.

The application contract and current verification boundary are documented in `docs/contracts.md`. Commands and a complete runnable demonstration will be added only when verified.
