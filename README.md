# PaperPath

PaperPath is a practice simulator that helps a fictional community volunteer applicant keep a volunteer application and an availability and equipment request consistent. It uses an MCP client and server over Streamable HTTP. It is not connected to Amazon's gated Alexa+ service, does not accept arbitrary PDFs, and does not submit applications to an organization.

The application is in active development. The [public demo video](https://youtu.be/KOGpO7Dg23g) shows a provider result rejected by the unsupported-fact guard, followed by a manual synthetic correction, confirmation, and two PDF exports. No successful current live extraction is claimed. PaperPath is an Alexa+ simulator, not an Alexa+ integration. Original code and demonstration templates are MIT licensed.

## Check out the review candidate

The default `main` branch is an older backend-only revision and does not contain this frontend walkthrough. The [PR #17 candidate](https://github.com/manishwvn/paperpath/pull/17), on `codex/core03-ui-clarification-proof` and based on PR #16, is under review. Its application source is `5b2205cf6e6ecd6693f453bfc101b24d800e2e63`. Commit `5560b843683cd7f1603d00240fb761c9611207a9` and [checks run 39347547108](https://github.com/manishwvn/paperpath/actions/runs/39347547108) are a historical test baseline; they do not include the later provider-failure matrix or this documentation revision. See the PR's current Checks tab for validation of the latest revision. This candidate is not a release or submission-readiness claim.

From a directory where `paperpath-review` does not already exist:

```sh
git clone --no-checkout https://github.com/manishwvn/paperpath.git paperpath-review
cd paperpath-review
git fetch origin refs/pull/17/head
git checkout --detach 5b2205cf6e6ecd6693f453bfc101b24d800e2e63
git rev-parse HEAD
```

The last command must print `5b2205cf6e6ecd6693f453bfc101b24d800e2e63`. This pins the application source used by the current review candidate. The PR head also contains tests and documentation; use its Checks tab for the latest exact-head results because that head can advance.

## Run locally

After the pinned checkout above, use Node 24.6.0. From the `paperpath-review` directory, install the locked dependencies, build the frontend, and start the server:

```sh
npm ci --ignore-scripts
npm run build
env -u GROQ_API_KEY npm run dev
```

The default server is available at `http://127.0.0.1:4317` and `http://localhost:4317`. Local case data and runtime artifacts use ignored `.local/`; never commit credentials, case data, or runtime artifacts.

## Optional public-origin allowlist

`PAPERPATH_PUBLIC_ORIGINS` accepts a JSON array of exact, canonical HTTPS origins. For example, when an external TLS reverse proxy is configured:

```sh
PAPERPATH_PUBLIC_ORIGINS='["https://paperpath.example.org"]' npm run dev
```

Leave it unset (or set it to `[]`) for the loopback-only HTTP defaults. Invalid or noncanonical values fail startup before runtime files are created. Public origins must not reuse the reserved `localhost` or `127.0.0.1` authority on the server port.

This setting is an allowlist, not a TLS server or deployment. The app continues listening on loopback; a separately configured TLS reverse proxy must forward traffic to that listener. The app checks the exact Host authority and Origin pairing, keeps browser CSRF checks, ignores forwarded authority headers, and sets `Secure` on session cookies for configured public origins. Public HTTPS operation and eligible hosting have not been proven. Event guidance permits local evaluation with a public repository and demo video, so an always-on host is optional. Point-in-time video metadata does not establish continued playback or maintained judge access.

## Verify

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

The app can still be used for manual fact corrections and PDF exports when the optional inference provider is unavailable. Text sent for provider analysis leaves the local app; do not enter real applicant data in this practice simulator. See [`docs/contracts.md`](docs/contracts.md) for the application contract and verification limits.

Current-source native Chrome proof covers CORE-03 clarification behavior using deterministic synthetic fixtures restricted to the exact loopback app and MCP origins. That browser proof does not establish successful live provider extraction. A separate historical one-call inference attempt was rejected by the unsupported-fact guard. Full keyboard and screen-reader verification, maintained judge access, eligibility, and final submission preflight remain open.

For a key-free, synthetic walkthrough from case creation through confirmation and both PDF downloads, follow the [local evaluator guide](docs/evaluation.md).
