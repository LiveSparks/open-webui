# ADR 0007: The fork ships a wheel install for bare metal, with no local-model machinery

Date: 2026-10-27. Decided by the operator in chat across the PR2 session.

## Context

This fork deploys the pi agent engine, adopted via the packaging work in PR2 ([PR 30](https://github.com/LiveSparks/open-webui/pull/30)). The install shape question and the build contents question both needed a ruling, and the deployment host is a plain Proxmox LXC, not a Kubernetes cluster or a fleet.

Three facts constrained the decision:

- The operator installs personal instances with the community-scripts Proxmox pattern: a container, `uv tool install` from a wheel, and a systemd unit running the packaged `open-webui serve` command.
- The upstream wheel and image carry torch-driven local RAG embedding, reranking, and whisper tooling they never use, and the build pulled the full CUDA wheel set through `accelerate` and `sentence-transformers` regardless of `USE_CUDA`.
- Keeping the runtime local-model-free while the packaging ships it anyway leaves the install lying about what it does.

## Decision

- The ONE deployment install shape is the bare-metal wheel: `uv tool install` from this fork's wheel, launched by the packaged `open-webui serve` console script. The Docker image and compose stack remain in the repo for upstream purposes and are proven by tests, but they are not acceptance criteria; new units verify against the wheel path first.
- The wheel and image never install torch, torchvision, torchaudio, Ollama, whisper, or sentence-transformers, and never pre-warm local model weights. Dependency entry points (`backend/requirements.txt`, `pyproject.toml`) prune `accelerate`, `sentence-transformers`, `faster-whisper`, and `onnxruntime`.
- RAG embeddings and providers are external-only. The default local embedding engine is dangling by design and falls back to a request-time error with instructions; moving the default to an external provider is the backend PR (PR4) that owns the RAG wiring.
- The agent sidecar starts from the packaged launcher, not only from the image's shell entry point. One launch contract lives in `open_webui.utils.sidecar_launch`; `start.sh` and `serve` both call it, with the shell path owning a detached child and the server path owning an exit hook.

## Consequences

Deployment stays self-modifiable on the target machine: no image layers sit between the installer and the config it wants to change. The health of any future unit is judged on the wheel shape, so lanes that boot containers become secondary evidence. Local knowledge retrieval degrades rather than crashing until PR4 redirects the default, and the plan records that gap explicitly. Upstream syncs stay cheap because the only structural packaging change is the prune plus the launcher hook, both documented here.
