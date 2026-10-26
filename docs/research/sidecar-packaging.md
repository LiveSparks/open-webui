# How the sidecar gets packaged into Open WebUI and started in every deployment

Research for the wayfinder map (Open WebUI × pi agent engine), answering [issue #26](https://github.com/LiveSparks/open-webui/issues/26). The session-lifecycle decision ([issue #9](https://github.com/LiveSparks/open-webui/issues/9), resolution comment) already fixed the shape. One backend-owned Node process, bundled in the Open WebUI image, pi dependencies pinned exactly, spawned by the FastAPI lifespan with a startup version handshake. It did not decide how the packaging happens. This doc records the facts about today's build in this repo at 0.12.3 and proposes the smallest packaging change. Build facts cite paths and line numbers in this repo. Proposal paragraphs are labeled.

## How the image is built today

Two Docker stages do the work (`Dockerfile`). Neither is a fork. The image builds from one Dockerfile with build args for the variants.

- **Frontend stage.** `FROM --platform=$BUILDPLATFORM node:22-alpine3.20 AS build` (line 28). It runs `npm ci --force` from the root `package.json` and `package-lock.json` (line 44), then `npm run build`, which is vite build (`package.json` scripts, `"build": "npm run pyodide:fetch && vite build"`) and produces the static frontend into `/app/build` (line 49).
- **Runtime stage.** `FROM python:3.11-slim-bookworm AS base` (line 59). It installs curl and jq always, plus git, build tools, pandoc, ffmpeg and friends only in non-slim variants (lines 115 onward), installs Python deps through uv mounted from `ghcr.io/astral-sh/uv:0.12.10` (line 158), and optionally the Ollama binary (`USE_OLLAMA`, lines 177 to 180).
- **What survives into the final image.** The runtime stage copies the built frontend (`COPY --from=build /app/build /app/build`, line 206), `CHANGELOG.md` and the root `package.json` (lines 207 and 208), and `backend/` (line 211). No Node binary is installed or copied in any runtime path. Node exists only in the build stage. The final image cannot execute Node today. The copied root `package.json` is not dead weight; the backend reads it for `VERSION` (`backend/open_webui/env.py` line 147, 151) and `FRONTEND_BUILD_DIR` defaults to `/app/build` (`backend/open_webui/env.py` line 254).
- **Entrypoint.** `CMD [ "bash", "start.sh" ]` (line 234). `backend/start.sh` handles the secret key, optional Playwright install, optional bundled Ollama serve, and the HuggingFace Space bootstrap keyed on `SPACE_ID` (line 68), then execs uvicorn with `--workers "$UVICORN_WORKERS"` defaulting to 1 (lines 99 to 110). The one-process deployment the issue 9 resolution relied on is this default.
- **CI.** `.github/workflows/docker.yaml` builds amd64 and arm64 and five variants (main, cuda, cuda126, ollama, slim; lines 23 to 54) from this one Dockerfile, pushed to `ghcr.io/open-webui/open-webui`. Before building it rewrites the Dockerfile with awk, injecting `NODE_OPTIONS` after any line starting `FROM --platform=$BUILDPLATFORM node:` (lines 79 to 90). A new stage with a different FROM shape is untouched by that awk, but a second Node stage with heap needs cannot inherit that patch automatically.
- **Compose and Make.** `Makefile` is only thin wrappers around docker compose (install, start, update). `docker-compose.yaml` builds the image from the Dockerfile (lines 12 to 14, tag default `ghcr.io/open-webui/open-webui:main` line 15) and runs one open-webui container plus an ollama container, with a named volume at `/app/backend/data` (line 18). No second container.
- **Kubernetes.** Nothing in this repo (`.dockerignore` even lists a legacy `kubernetes` path). Upstream's chart at `open-webui/helm-charts` (`charts/open-webui/values.yaml` lines 197 to 204) deploys the same `ghcr.io/open-webui/open-webui` image. Whatever the Dockerfile gains, Helm users get through the published tag.
- **HuggingFace Spaces.** `backend/start.sh` handles `SPACE_ID` (line 68), so the same Dockerfile is the Spaces surface too.
- **pip install.** `.github/workflows/release-pypi.yml` runs `python -m build` (line 37). Hatchling builds the wheel from `backend/` (`pyproject.toml` line 184 `sources = ["backend"]`) and force-includes the prebuilt frontend as `open_webui/frontend` (line 196). The wheel build itself needs npm, because the custom hook runs `npm install` plus `npm run build` (`hatch_build.py` lines 18 to 27). The wheel ships no Node runtime either.

Net. Today Node appears only where the frontend is compiled. Both the Docker image and the wheel contain only its output, static files, and no JavaScript runtime.

## How the sidecar would be built and pinned

Proposal.

- **Where its manifest lives.** A new top-level `sidecar/` directory with its own `package.json` and a committed `package-lock.json`. The root lockfile is the frontend's dev tree and every root dependency is a caret range (`package.json` dependencies start at line 60), so it cannot pin the sidecar. A separate manifest keeps pi's pins independent of the frontend's dependency churn.
- **What pi ships.** `@earendil-works/pi-coding-agent` is at 1.0.4 and declares `engines.node >= 22.19.0` (its `package.json`, name/version and engines fields). It ships compiled JavaScript only. Its `files` list is `["dist", "docs", "examples", ...]` and `main`/`exports` all point into `dist`, so no TypeScript is installed and no build step exists at install time.
- **Pinning, two layers.** Pi's own `@earendil-works/*` dependencies are declared with caret ranges (its `package.json` dependencies, e.g. `"@earendil-works/pi-ai": "^1.0.4"`), so the sidecar's `package.json` must pin them exactly, without any range prefix, for example `"@earendil-works/pi-coding-agent": "1.0.4"`, and its committed lockfile resolves everything transitively. `npm ci` installs exactly the lockfile and fails when the manifest and the lockfile disagree, so a Docker build with `npm ci` is itself the enforcement. A caret resolved fresh would otherwise drift inside pi's own tree.
- **Compiled, not TypeScript.** The sidecar compiles TypeScript to `dist/` during the image build with `tsc`. Node 22 can strip types at runtime, but that is experimental in this line and buys nothing over a seconds-long compile. The sidecar also reports its loaded pi version at the handshake, so the shipped artifact must be the same one that was pinned.
- **Size, measured on this machine.** An installed pi-coding-agent with its `node_modules` is 166MB total, its `dist` alone 21MB (`du -sh`). The Node 22 binary is about 120MB. Production install should use `npm ci --omit=dev`.

## How the backend finds and starts the sidecar

The issue 9 resolution says the Python side spawns the sidecar in the FastAPI lifespan (`backend/open_webui/main.py` line 366, today the lifespan starts no long-lived child), polls `/healthz`, restarts with capped backoff, and refuses a sidecar whose pinned pi version mismatches at the startup handshake. Concrete homes for each piece, as proposal.

- **Config constants.** A small module `backend/open_webui/agent/sidecar.py` reading env vars, following the convention in `env.py`. Names and defaults:
  - `AGENT_SIDECAR_ENTRYPOINT`, default the packaged entry next to the Python package (`open_webui/sidecar/dist/index.js`).
  - `AGENT_SIDECAR_NODE`, default `node` resolved on `PATH`.
  - `AGENT_SIDECAR_PORT`, default unset. The backend picks a free loopback port at spawn and hands it over, so no deployment shape needs to plan a port.
  - `DATA_DIR` is simply inherited by the child, which makes the session subfolder from decision 4 work in every shape with no new wiring.
- **Version handshake, one source of truth.** The pinned pi version lives in `sidecar/package.json`, which the image and the wheel both carry. The backend reads that file at startup and expects exactly that version. The sidecar's `/healthz` reports the pi-coding-agent version it actually loaded. A mismatch means the bundle is stale or swapped, and the backend refuses per the resolution.
- **Image consumers need nothing.** docker run, docker compose, the Helm chart, and HF Spaces all consume the published image, so the Dockerfile change reaches every container shape at once. Sessions persist through the existing `DATA_DIR` volume (`docker-compose.yaml` line 18).
- **pip install is the one gap.** A bare host `pip install open-webui` gets the sidecar files in the wheel but has no Node runtime. The backend should gate at lifespan, probing `node --version` once, and disable agent features with a clear log when no Node at or above 22.19 exists.

## The smallest packaging change

Recommendation. One new Docker build stage, a few COPY lines in the runtime stage, and one hook extension for the wheel. No fork of the runtime stage logic, no variant-specific changes, no new container in compose.

```dockerfile
# sidecar: build the pinned pi app and supply a glibc-compatible runtime
FROM node:22-bookworm-slim AS sidecar
WORKDIR /sidecar
COPY sidecar/package.json sidecar/package-lock.json ./
RUN npm ci --omit=dev
COPY sidecar/ ./
RUN npm run build

# in the existing runtime stage, after the existing COPY lines:
COPY --from=sidecar /usr/local/bin/node /usr/local/bin/node
COPY --from=sidecar /sidecar/dist /app/sidecar/dist
COPY --from=sidecar /sidecar/package.json /app/sidecar/package.json
COPY --from=sidecar /sidecar/node_modules /app/sidecar/node_modules
```

Why this shape:

- The runtime Node cannot come from the existing frontend stage. That stage is alpine (musl) and the runtime stage is Debian (glibc), so its binaries would not execute there. The sidecar stage is `node:22-bookworm-slim` for glibc compatibility, which is why two Node base images appear in the Dockerfile.
- The sidecar needs `node` on PATH and nothing else from the Node image at runtime, so only the binary plus the sidecar's own files are copied. npm is not needed in the final image.
- Base images should be pinned by digest, since the promise here is exact versions and the float tag moves with patch releases.
- Multi-arch comes free. `node:22-bookworm-slim` is a multi-arch image, buildx resolves it per target, and the arm64 build runs on the native arm runner (`docker.yaml` matrix).
- One thing to verify per variant. The Node binary needs `libstdc++`. Non-slim variants install `build-essential` so it is present; the slim variant may not have it. A quick `ldd /usr/local/bin/node` against a built slim image decides, and one conditional `apt-get install libstdc++6` line covers it if missing.
- `.dockerignore` needs `sidecar/node_modules` added, so a developer's local install does not bloat the build context (the root `node_modules` exclusion covers only the root directory).

For the wheel, the hook already builds the frontend in `hatch_build.py`; extend it to run `npm ci --omit=dev` and `npm run build` in `sidecar/`, then add force-include entries mapping `sidecar/dist` and `sidecar/node_modules` to `open_webui/sidecar/` next to the existing `build = "open_webui/frontend"` mapping (`pyproject.toml` line 196). npm's `.bin` symlinks are the known fragile point; Node resolves packages by directory, not through `.bin`, so copies of the symlinks are harmless, but if hatchling chokes on the tree the fallback is bundling the sidecar to a single file with esbuild so only `dist` ships. That fallback should be verified before it is relied on, since pi's code may contain dynamic imports that a bundler must be taught about.

For local development, `backend/dev.sh` runs uvicorn directly, and the `AGENT_SIDECAR_*` overrides let the backend spawn a sidecar built once by hand from `sidecar/`.

### Tradeoffs

| Fork | Choice | Why | Rejected alternative |
| --- | --- | --- | --- |
| Where the runtime Node comes from | Copy the binary from a glibc node stage | No external apt repo or repo key in the image, works in every variant | NodeSource apt repo, which adds a third-party repo and key to every variant's build |
| What the wheel carries | dist plus node_modules | Same artifact as the image, no second build system | esbuild single-file bundle, smaller wheel but unverified against pi's dynamic imports |
| Node runtime on pip hosts | Gate on the host's node | Smallest change, no 120MB platform-specific payload in the wheel | Ship per-platform node binaries, which multiplies the wheel matrix for one feature |

One flagged default under the autonomy grant. The pip-host gate is a product call as well as a technical one, since it means the agent feature is absent (not degraded) on a bare pip install. The alternative, shipping node binaries in wheels, roughly doubles the release matrix for a feature that phase 1 decided to ship inside the image. I chose the gate and recorded it here so the driving human can override it in one sentence.

## Sources

- Docker image build: `Dockerfile` (stages at lines 28 and 59, runtime COPYs at 206 to 211, CMD at 234)
- Entrypoint and uvicorn launch: `backend/start.sh` (SPACE_ID at 68, workers at 99 to 110)
- CI image build and Dockerfile rewrite: `.github/workflows/docker.yaml` (matrix 23 to 54, awk 79 to 90, build-push at 125)
- pip wheel: `.github/workflows/release-pypi.yml` (line 37), `pyproject.toml` (lines 184, 196), `hatch_build.py` (lines 18 to 27)
- Version and frontend-dir reads: `backend/open_webui/env.py` (lines 147, 151, 254)
- Compose shape: `docker-compose.yaml` (lines 12 to 18), `Makefile`
- Kubernetes image source: https://github.com/open-webui/helm-charts (`charts/open-webui/values.yaml` lines 197 to 204)
- pi package facts: `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/package.json` (version, engines, files, exports, caret-ranged deps), sizes via `du -sh` on the installed package and `/opt/node22/bin/node`
- Decisions this builds on: issue 9 resolution comment, `gh issue view 9 --repo LiveSparks/open-webui`
