#!/usr/bin/env bash

# Create (or update) an LXC with Open WebUI pi engine from the fork's wheel.
# Adapted from community-scripts/ProxmoxVE ct/openwebui.sh (MIT): the engine
# functions come from community-scripts/core, the ct/ and install/ script
# files come from this repo, selected by the COMMUNITY_SCRIPTS_URL override.
# See scripts/openwebui-pi/README.md.

COMMUNITY_SCRIPTS_URL="${COMMUNITY_SCRIPTS_URL:-https://raw.githubusercontent.com/LiveSparks/open-webui/dev/scripts/openwebui-pi}"
_cs_boot="${COMMUNITY_SCRIPTS_CORE_DIR:-$(dirname "${BASH_SOURCE[0]}")/../../core}/core/build.func"
# shellcheck disable=SC1090
source "$_cs_boot" 2>/dev/null || source <(curl -fsSL "${COMMUNITY_SCRIPTS_CORE_URL:-https://raw.githubusercontent.com/community-scripts/core/main}/core/build.func")

# NSAPP is APP lowercased with spaces removed; the install script is
# fetched as install/<NSAPP>-install.sh from COMMUNITY_SCRIPTS_URL.
APP="OpenWebUI-pi"
var_tags="${var_tags:-ai;agent}"
var_cpu="${var_cpu:-2}"
var_ram="${var_ram:-2048}"
var_disk="${var_disk:-15}"
var_os="${var_os:-debian}"
var_version="${var_version:-12}"
var_unprivileged="${var_unprivileged:-1}"

header_info "$APP"
variables
color
catch_errors

function update_script() {
  header_info
  check_container_storage
  check_container_resources

  if [[ ! -f /usr/bin/openwebui-pi-update ]]; then
    msg_error "No OpenWebUI-pi installation found inside this container"
    exit
  fi

  msg_info "Updating Open WebUI (pi engine)"
  /usr/bin/openwebui-pi-update
  msg_ok "Update request handled by openwebui-pi-update"
}

start
build_container
description

msg_ok "Completed successfully!\n"
echo -e "${INFO}${YW}Access it using the following URL:${CL}"
echo -e "${GATEWAY}${BGN}http://${IP}:8080${CL}"
