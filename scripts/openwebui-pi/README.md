# OpenWebUI-pi LXC scripts

LXC create + update scripts for this fork's wheel, built on the
[community-scripts](https://community-scripts.org/scripts/openwebui) engine.
The engine functions come from `community-scripts/core` (MIT); only the two
script files in this directory are fork-specific, selected with the
`COMMUNITY_SCRIPTS_URL` override the engine documents for forks.

## Create

From the Proxmox VE host:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/LiveSparks/open-webui/dev/scripts/openwebui-pi/ct/openwebui-pi.sh)"
```

Defaults: 2 CPU, 2 GB RAM, 15 GB disk, Debian 12, unprivileged. Override any
`var_*` name before the command the same way community-scripts does.

## Update

Inside the container, run either:

```bash
openwebui-pi-update
```

or the create one-liner again — it detects the installation and calls the
same command. The command:

1. stops the service,
2. copies `/var/lib/open-webui` to `/var/backups/open-webui/data-<timestamp>`
   (the five most recent backups are kept).
3. reinstalls the tool with `uv tool install --force --python 3.11`,
4. starts the service and waits up to 120 s for `/health`.

Chats, users, API keys, configs, lessons, uploads, and the RAG vector store
all live under `DATA_DIR=/var/lib/open-webui` and the update never touches
that path. `/root/.webui_secret_key` (session keys) and
`/etc/openwebui-pi.env` (configuration) also survive every update.

## The agent engine

The install writes the engine envs into `/etc/openwebui-pi.env`; Open WebUI
starts the pi sidecar beside the server (`journalctl -u open-webui` shows
`agent sidecar healthy`). Only the comma-separated `AGENT_LOOP_MODEL_IDS` list
routes through the agent engine; every other model keeps OWUI's native loop.
Append ids as your connections gain models:

```bash
AGENT_LOOP_MODEL_IDS=glm-5.3-flash,grok-4.7
```

Then `systemctl restart open-webui`. If a chat seems not to take the engine,
check that the composer's model id (the `form_data['model']` value) appears
in that list verbatim.

## Pin a wheel

Updates install the `latest` release asset by default. To pin a version,
edit `PI_WHEEL_URL` in `/etc/openwebui-pi.env`:

```bash
PI_WHEEL_URL=https://github.com/LiveSparks/open-webui/releases/download/v0.12.3-pi.2/open_webui-0.12.3-py3-none-any.whl
```

## Rollback

Every tagged release keeps its wheel. To go back:

1. Point `PI_WHEEL_URL` at the previous release's URL.
2. Run `openwebui-pi-update`.
3. If the newer release ran a database migration, also restore a backup:
   `systemctl stop open-webui && rm -rf /var/lib/open-webui && cp -a /var/backups/open-webui/data-<timestamp> /var/lib/open-webui`

Reinstalling the same or an older wheel never runs a backward migration on
its own.

## Local model note

This wheel contains no torch, Ollama, or whisper machinery. Embeddings and
RAG are external-only.
