# ADR 0008: Self-hosted LXC install and update scripts on the community-scripts engine

Date: 2026-11-04. In chat, in the close-out session.

## Context

ADR 0007 fixed the install shape: one bare-metal wheel on a Proxmox LXC,
`uv tool install` + `open-webui serve`. The operator publishes the wheels to
this fork's Releases and asked that the install and the upgrade path be
scripted, using the community-scripts openwebui script as the template, so
that each bug-fix deploy is a single command that cannot lose data.

## Decision

- The wheels are published as release assets; new releases reuse the asset
  name `open_webui-0.12.3-py3-none-any.whl` so `releases/latest/download/`
  always resolves to the newest one. Each release is a rollback channel.
- The scripts live in this repo at `scripts/openwebui-pi/`:
  `ct/openwebui-pi.sh` (host-side create + update entry) and
  `install/openwebui-pi-install.sh` (inside-container phase). They run the
  engine functions from `community-scripts/core` and set
  `COMMUNITY_SCRIPTS_URL` to this repo's raw URL, which the engine documents
  as its fork mechanism. Upstream fixes to the engine flow in for free.
- The update path is one command, `/usr/bin/openwebui-pi-update`, written by
  the install phase and also reachable by re-running the create one-liner.
  It stops the service, backs up `DATA_DIR` (keeping the five most recent
  copies), reinstalls the wheel with `--force`, restarts, and waits for
  `/health`. It never writes into `DATA_DIR`.
- Defaults pinned to the verified tree: Python 3.11, Debian 12, release
  `v0.12.3-pi.2`.

## Alternatives

- Submitting through community-scripts.org/generator: rejected. The
  generator catalogs shared community apps in their repo; this wheel is a
  personal fork with a fork-specific release channel, and upstreaming it
  would commit our upgrade cadence to their review process.
- Copying the engine functions into the repo: rejected. The engine repo is
  MIT, actively fixed, and already forks cleanly; vendoring would orphan
  those fixes.
- Pinning every wheel URL in a repo-side script: rejected for the default
  path. Pins belong in the persisted config
  (`/etc/openwebui-pi.env`), where an operator can set them once and the
  update command reads them locally.

## Consequences

Updates are one command on the target machine, data is preserved by the
`DATA_DIR` split plus backups rather than by care, and the account of record
for any future install behavior sits in these two files. A failure inside
the update leaves both the previous wheel (reinstallable by tag) and the
data backup on disk, so the failure modes converge to a documented two-step
rollback.
