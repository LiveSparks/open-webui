#!/usr/bin/env bash

# Inside-container phase for the OpenWebUI-pi LXC. Sourced with the engine's
# lxc/install.func prepended through FUNCTIONS_FILE_PATH.
# Adapted from community-scripts/ProxmoxVE install/openwebui-install.sh (MIT).

# shellcheck disable=SC1090
source /dev/stdin <<<"$FUNCTIONS_FILE_PATH"
color
verb_ip6
catch_errors
setting_up_container
network_check
update_os

msg_info "Installing dependencies"
$STD apt install -y ca-certificates curl
msg_ok "Installed dependencies"

msg_info "Installing Node 22 (the packaged sidecar runtime)"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
$STD apt install -y nodejs
msg_ok "Installed Node $(node --version)"

PYTHON_VERSION="3.11" setup_uv

PI_WHEEL_URL="${PI_WHEEL_URL:-https://github.com/LiveSparks/open-webui/releases/latest/download/open_webui-0.12.3-py3-none-any.whl}"
OWUI_PORT="${OWUI_PORT:-8080}"

msg_info "Installing Open WebUI wheel"
installed=0
for attempt in 1 2; do
  $STD uv tool install --python 3.11 "$PI_WHEEL_URL" && { installed=1; break; }
  msg_warn "Open WebUI install attempt $attempt failed, retrying..."
  sleep 10
done
((installed)) || $STD uv tool install --python 3.11 "$PI_WHEEL_URL"
msg_ok "Installed Open WebUI wheel"

msg_info "Creating data and backup directories"
mkdir -p /var/lib/open-webui /var/backups/open-webui /var/lib/open-webui/pi-agent /var/lib/open-webui/pi_sessions
msg_ok "Created data and backup directories"

msg_info "Writing /etc/openwebui-pi.env"
cat <<EOF >/etc/openwebui-pi.env
PI_WHEEL_URL=${PI_WHEEL_URL}
OWUI_PORT=${OWUI_PORT}
# The agent engine: the wheel's launcher gates on these (sidecar_launch.py).
AGENT_SIDECAR_PORT=8930
AGENT_SIDECAR_AGENT_DIR=/var/lib/open-webui/pi-agent
AGENT_SIDECAR_MODEL=opencode-go/glm-5.3-flash
AGENT_SESSIONS=/var/lib/open-webui/pi_sessions
# The tool-bridge binding must be loopback (the sidecar refuses any other
# host); an external access address must not become the minted URL.
AGENT_LOOPBACK_URL=http://127.0.0.1:${OWUI_PORT}/loopback/mcp
# Comma-separated model ids that route through the agent engine; the rest
# keep OWUI's native loop. Extend as connections gain models.
AGENT_LOOP_MODEL_IDS=glm-5.3-flash
EOF
msg_ok "Wrote /etc/openwebui-pi.env"

msg_info "Creating agent engine directories"
mkdir -p /var/lib/open-webui/pi-agent /var/lib/open-webui/pi_sessions
msg_ok "Created agent engine directories"

msg_info "Installing openwebui-pi-update command"
cat <<'EOS' >/usr/bin/openwebui-pi-update
#!/usr/bin/env bash
# Upgrade the wheel, keep the data. Backs up DATA_DIR, force-reinstalls the
# tool from $PI_WHEEL_URL, restarts, waits for /health.
set -euo pipefail
. /etc/openwebui-pi.env

systemctl stop open-webui
ts=$(date +%F-%H%M%S)
backup="/var/backups/open-webui/data-$ts"
mkdir -p "$backup"
cp -a /var/lib/open-webui/. "$backup/"

# Keep the five most recent backups.
ls -1t /var/backups/open-webui | tail -n +6 | while read -r old; do
  rm -rf "/var/backups/open-webui/$old"
done

echo "Stopped service; data backed up to $backup"
echo "Installing wheel from $PI_WHEEL_URL"
uv tool install --force --python 3.11 "$PI_WHEEL_URL"
systemctl start open-webui

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${OWUI_PORT}/health" >/dev/null 2>&1; then
    echo "Open WebUI is updated and healthy. Backup: $backup"
    exit 0
  fi
  sleep 2
done
echo "Open WebUI did not report healthy within 120s. Check: journalctl -u open-webui" >&2
echo "Rollback: restore $backup after reinstalling the previous wheel." >&2
exit 1
EOS
chmod +x /usr/bin/openwebui-pi-update
msg_ok "Installed openwebui-pi-update command"

msg_info "Creating open-webui service"
cat <<EOF >/etc/systemd/system/open-webui.service
[Unit]
Description=Open WebUI (pi engine)
After=network.target

[Service]
Type=simple
Environment=DATA_DIR=/var/lib/open-webui
EnvironmentFile=/etc/openwebui-pi.env
ExecStart=/root/.local/bin/open-webui serve
WorkingDirectory=/root
Restart=on-failure
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF
systemctl enable -q --now open-webui
msg_ok "Created open-webui service"

motd_ssh
customize
cleanup_lxc
