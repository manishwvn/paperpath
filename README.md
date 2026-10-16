# PaperPath

PaperPath is a practice simulator that helps a fictional community volunteer applicant keep a volunteer application and an availability and equipment request consistent. It uses an MCP client and server over Streamable HTTP. It is not connected to Amazon's gated Alexa+ service, does not accept arbitrary PDFs, and does not submit applications to an organization.

The application is in active development. Public-origin configuration is covered by PR #11 and its CI check, but public HTTPS operation, eligible hosting, and judge access have not been proven. Local Chrome and PDF checks used synthetic facts with the provider disabled. Original code and demonstration templates are MIT licensed.

## Run locally

Use Node 24.6.0. From this directory, install the locked dependencies, build the frontend, and start the server:

```sh
npm ci
npm run build
npm run dev
```

The default server is available at `http://127.0.0.1:4317` and `http://localhost:4317`. Local case data and runtime artifacts use ignored `.local/`; never commit credentials, case data, or runtime artifacts.

## Optional public-origin allowlist

`PAPERPATH_PUBLIC_ORIGINS` accepts a JSON array of exact, canonical HTTPS origins. For example, when an external TLS reverse proxy is configured:

```sh
PAPERPATH_PUBLIC_ORIGINS='["https://paperpath.example.org"]' npm run dev
```

Leave it unset (or set it to `[]`) for the loopback-only HTTP defaults. Invalid or noncanonical values fail startup before runtime files are created. Public origins must not reuse the reserved `localhost` or `127.0.0.1` authority on the server port.

This setting is an allowlist, not a TLS server or deployment. The app continues listening on loopback; a separately configured TLS reverse proxy must forward traffic to that listener. The app checks the exact Host authority and Origin pairing, keeps browser CSRF checks, ignores forwarded authority headers, and sets `Secure` on session cookies for configured public origins. Public proxy and judge-access behavior have not been exercised.

## Verify

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

The app can still be used for manual fact corrections and PDF exports when the optional inference provider is unavailable. Text sent for provider analysis leaves the local app; do not enter real applicant data in this practice simulator. See [`docs/contracts.md`](docs/contracts.md) for the application contract and verification limits.
