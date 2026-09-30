#!/bin/bash
# ============================================================
#  VulnPen — All-in-one launcher
#  Configures, builds, and runs the entire stack.
#
#  Commands: start | config | dev | stop | logs | status | backup | help
#  Flags:    --quick / -q   Skip all configuration prompts
# ============================================================

set -euo pipefail

# ── Colors & formatting ───────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ── Paths ─────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_TOML="$SCRIPT_DIR/config.toml"
CONFIG_TOML_TMPL="$SCRIPT_DIR/config.toml.template"
DYNAMIC_ENV=""  # set by resolve_env_path
DYNAMIC_ENV_TMPL="$SCRIPT_DIR/backend/.env.template"
MODEL_REGISTRY_FILE="$SCRIPT_DIR/backend/model-registry.json"
FRONTEND_ENV="$SCRIPT_DIR/frontend/.env"
FRONTEND_TMPL="$SCRIPT_DIR/frontend/.env.template"
SSH_KEYS_DIR="$SCRIPT_DIR/ssh-keys"
COMPOSE_OVERRIDE="$SCRIPT_DIR/docker-compose.override.yml"

COMPOSE_CMD=""
DEPLOY_MODE=""
COMPOSE_FILE=""
IS_WSL=false
DOCKER_ROOTLESS=false
NEED_SSH_KEY_MOUNT=false
DEV_MODE=false
QUICK_MODE=false
STATE_FILE="$SCRIPT_DIR/.run-state"

resolve_env_path() {
    DYNAMIC_ENV="$SCRIPT_DIR/backend/.env"
}

save_run_state() {
    cat > "$STATE_FILE" <<EOF
DEPLOY_MODE=${DEPLOY_MODE:-}
COMPOSE_FILE=${COMPOSE_FILE:-}
DEV_MODE=${DEV_MODE:-false}
EOF
}

load_run_state() {
    if [[ -f "$STATE_FILE" ]]; then
        local saved_deploy saved_compose saved_dev
        saved_deploy=$(grep '^DEPLOY_MODE=' "$STATE_FILE" 2>/dev/null | cut -d'=' -f2-)
        saved_compose=$(grep '^COMPOSE_FILE=' "$STATE_FILE" 2>/dev/null | cut -d'=' -f2-)
        saved_dev=$(grep '^DEV_MODE=' "$STATE_FILE" 2>/dev/null | cut -d'=' -f2-)
        if [[ -n "$saved_compose" ]]; then
            DEPLOY_MODE="$saved_deploy"
            COMPOSE_FILE="$saved_compose"
            DEV_MODE="${saved_dev:-false}"
            return 0
        fi
    fi
    return 1
}

# ── Helpers ────────────────────────────────────────────────
print_banner() {
    echo
    echo -e "${BLUE}${BOLD}╔══════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}${BOLD}║           VulnPen  ·  Launcher           ║${NC}"
    echo -e "${BLUE}${BOLD}╚══════════════════════════════════════════╝${NC}"
    echo
}

show_commands() {
    echo -e "   ${BOLD}Commands:${NC}"
    echo -e "     ${CYAN}start${NC}        Guided start: choose normal or developer mode"
    echo -e "     ${CYAN}start -q${NC}     Quick start: skip prompts, use existing config"
    echo -e "     ${CYAN}config${NC}       Update tracing, exploit box, or developer server settings"
    echo -e "     ${CYAN}dev${NC}          Start directly in developer mode"
    echo -e "     ${CYAN}dev -q${NC}       Quick dev start: skip prompts"
    echo -e "     ${CYAN}stop${NC}         Stop all containers"
    echo -e "     ${CYAN}logs${NC}         Tail container logs"
    echo -e "     ${CYAN}status${NC}       Show container status"
    echo -e "     ${CYAN}backup${NC}       Back up databases, workspaces, and configuration"
    echo -e "     ${CYAN}help${NC}         Show full help"
    echo
}

info()    { echo -e " ${GREEN}[✓]${NC} $1"; }
warn()    { echo -e " ${YELLOW}[!]${NC} $1"; }
err()     { echo -e " ${RED}[✗]${NC} $1"; }
section() { echo; echo -e " ${CYAN}${BOLD}── $1 ──${NC}"; }
hint()    { echo -e "   ${DIM}$1${NC}"; }
prompt_input() { echo -en " ${CYAN}$1${NC} "; }

confirm() {
    local msg="$1" default="${2:-n}"
    if [[ "$default" == "y" ]]; then
        prompt_input "$msg [Y/n]:"
        read -r resp
        [[ -z "$resp" || "$resp" =~ ^[Yy] ]]
    else
        prompt_input "$msg [y/N]:"
        read -r resp
        [[ "$resp" =~ ^[Yy] ]]
    fi
}

escape_env_val() {
    local val="$1"
    printf '%s' "$val" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

set_env_var() {
    local file="$1" var="$2" val="$3"
    local tmp="${file}.tmp.$$"
    local escaped
    escaped=$(escape_env_val "$val")
    if grep -q "^${var}=" "$file" 2>/dev/null; then
        grep -v "^${var}=" "$file" > "$tmp"
        mv "$tmp" "$file"
    fi
    echo "${var}=\"${escaped}\"" >> "$file"
    chmod 600 "$file"
}

get_env() {
    local file="$1" var="$2"
    local raw
    raw=$(grep "^${var}=" "$file" 2>/dev/null | head -1 | cut -d'=' -f2- || true)
    if [[ "$raw" =~ ^\"(.*)\"$ ]]; then
        echo "${BASH_REMATCH[1]}" | sed 's/\\"/"/g; s/\\\\/\\/g'
    else
        echo "$raw"
    fi
}

set_toml_var() {
    local file="$1" key="$2" val="$3"
    if grep -q "^${key} " "$file" 2>/dev/null || grep -q "^${key}=" "$file" 2>/dev/null; then
        local tmp="${file}.tmp.$$"
        sed "s|^${key} *=.*|${key} = \"${val}\"|" "$file" > "$tmp"
        mv "$tmp" "$file"
    elif grep -q "^# *${key} " "$file" 2>/dev/null || grep -q "^# *${key}=" "$file" 2>/dev/null; then
        local tmp="${file}.tmp.$$"
        sed "s|^# *${key} *=.*|${key} = \"${val}\"|" "$file" > "$tmp"
        mv "$tmp" "$file"
    else
        echo "${key} = \"${val}\"" >> "$file"
    fi
    chmod 600 "$file"
}

get_toml_var() {
    local file="$1" key="$2"
    grep "^${key} " "$file" 2>/dev/null | head -1 \
        | sed 's/[^=]*= *//; s/ *#.*//; s/^"//; s/"$//' || true
}

mask_key() {
    local key="$1"
    if [[ ${#key} -le 8 ]]; then
        echo "****"
    else
        echo "${key:0:4}...${key: -4}"
    fi
}

# ── Prerequisites ─────────────────────────────────────────
check_prerequisites() {
    section "Checking Prerequisites"
    case "$(uname -s 2>/dev/null)" in
        MINGW*|MSYS*|CYGWIN*)
            err "Native Windows shells are not supported. Open this repository in WSL2 and run ./run.sh there."
            exit 1
            ;;
    esac
    if ! command -v docker &>/dev/null; then
        err "Docker is not installed. Install it from https://docs.docker.com/get-docker/"
        exit 1
    fi
    info "Docker: $(docker --version 2>/dev/null | head -1)"
    if ! docker compose version &>/dev/null 2>&1; then
        err "Docker Compose v2 is required. Install or update Docker Desktop / the Docker Compose plugin."
        exit 1
    fi
    COMPOSE_CMD="docker compose"
    info "Compose: $($COMPOSE_CMD version 2>/dev/null | head -1)"
    if ! docker info &>/dev/null 2>&1; then
        err "Docker daemon is not running."
        exit 1
    fi
    info "Docker daemon is running"

    local docker_major compose_major endpoint available_kb memory_value architecture
    docker_major=$(docker version --format '{{.Server.Version}}' 2>/dev/null | cut -d. -f1)
    compose_major=$(docker compose version --short 2>/dev/null | sed 's/^v//' | cut -d. -f1)
    if [[ ! "$docker_major" =~ ^[0-9]+$ ]] || (( docker_major < 20 )); then
        err "Docker Engine 20 or newer is required (found: ${docker_major:-unknown})."
        exit 1
    fi
    if [[ ! "$compose_major" =~ ^[0-9]+$ ]] || (( compose_major < 2 )); then
        err "Docker Compose v2 is required."
        exit 1
    fi

    endpoint="${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null | head -1 || true)}"
    if [[ "$endpoint" == tcp://* || "$endpoint" == ssh://* ]]; then
        err "The active Docker context is remote ($endpoint). Local bind mounts will not work. Switch to a local Docker context."
        exit 1
    fi

    available_kb=$(df -Pk "$SCRIPT_DIR" 2>/dev/null | awk 'NR==2 {print $4}')
    if [[ "$available_kb" =~ ^[0-9]+$ ]] && (( available_kb < 20971520 )); then
        warn "Less than 20 GB is free on the Docker workspace disk; the Kali image and browser downloads may run out of space."
    fi
    if [[ -r /proc/meminfo ]]; then
        memory_value=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
        if [[ "$memory_value" =~ ^[0-9]+$ ]] && (( memory_value < 8388608 )); then
            warn "Less than 8 GB of RAM is available. Limit concurrent agents and avoid the built-in Kali desktop."
        fi
    else
        memory_value=$(sysctl -n hw.memsize 2>/dev/null || echo 0)
        if [[ "$memory_value" =~ ^[0-9]+$ ]] && (( memory_value > 0 && memory_value < 8589934592 )); then
            warn "Less than 8 GB of RAM is available. Limit concurrent agents and avoid the built-in Kali desktop."
        fi
    fi
    architecture=$(uname -m)
    if [[ "$architecture" == "arm64" || "$architecture" == "aarch64" ]]; then
        warn "ARM64 detected. Core services are supported, but some Kali tools publish only x86_64 packages."
    fi
    if docker info --format '{{json .SecurityOptions}}' 2>/dev/null | grep -qi rootless; then
        DOCKER_ROOTLESS=true
        warn "Rootless Docker detected. OpenVPN and the privileged Kali container are unavailable."
    fi
    if [[ -n "${HTTP_PROXY:-}${HTTPS_PROXY:-}" ]]; then
        info "Proxy environment detected; Docker builds will inherit it."
    fi
}

check_selected_environment() {
    if [[ "$DOCKER_ROOTLESS" == true && ( "${DEPLOY_MODE:-}" == "kali" || "${DEPLOY_MODE:-}" == "dev-kali" ) ]]; then
        err "The built-in Kali container requires privileged Docker. Use core mode with an external SSH work host, or use non-rootless Docker."
        exit 1
    fi

    [[ -w "$SCRIPT_DIR" ]] || { err "The repository is not writable by the current user: $SCRIPT_DIR"; exit 1; }

    local existing_container existing_workdir
    existing_container=$(compose ps -q 2>/dev/null | head -1 || true)
    if [[ -n "$existing_container" ]]; then
        existing_workdir=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$existing_container" 2>/dev/null || true)
        if [[ -n "$existing_workdir" && "$existing_workdir" != "$SCRIPT_DIR" ]]; then
            err "This Compose project name is already used by another clone: $existing_workdir"
            hint "Stop that clone before starting this one."
            exit 1
        fi
    else
        local ports=(27017 6379)
        if [[ "${DEV_MODE:-false}" != true ]]; then
            ports+=(3000 8080 6080 9020)
        fi
        if [[ "${DEPLOY_MODE:-}" == "kali" || "${DEPLOY_MODE:-}" == "dev-kali" ]]; then
            ports+=(4242 4200 5901)
        fi
        local port listener
        for port in "${ports[@]}"; do
            listener=""
            if command -v lsof &>/dev/null; then
                listener=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | sed -n '2p' || true)
            elif command -v ss &>/dev/null; then
                listener=$(ss -ltnH 2>/dev/null | awk -v suffix=":$port" '$4 ~ suffix"$" {print; exit}' || true)
            fi
            if [[ -n "$listener" ]]; then
                err "Port $port is already in use: $listener"
                hint "Stop that process or change its port before starting VulnPen."
                exit 1
            fi
        done
    fi
}

check_pnpm() {
    if ! command -v pnpm &>/dev/null; then
        err "pnpm is not installed. Install it via: corepack enable && corepack prepare pnpm@latest --activate"
        exit 1
    fi
}

maybe_install_dev_browser_agent_browser() {
    if [[ "${QUICK_MODE:-false}" == true ]]; then
        hint "Quick mode: skipped optional Browser Agent browser install."
        hint "To enable Browser Agent locally later: cd backend && pnpm exec patchright install chromium"
        return
    fi

    section "Browser Agent Dependencies"
    hint "Developer mode runs Browser Agent on your local machine."
    hint "If you plan to use automatic browser capabilities, Patchright Chromium must be installed locally."

    if confirm "Will you use Browser Agent / automatic browser capabilities in developer mode?" "n"; then
        info "Installing Patchright Chromium for Browser Agent..."
        (cd "$SCRIPT_DIR/backend" && pnpm exec patchright install chromium)
        info "Patchright Chromium installed"
    else
        info "Skipped Browser Agent browser install"
        hint "You can install it later with: cd backend && pnpm exec patchright install chromium"
    fi
}

detect_wsl() {
    if grep -qi microsoft /proc/version 2>/dev/null; then
        IS_WSL=true
    fi
}

# ── Ensure config from templates (no prompts) ──────────────
ensure_config_defaults() {
    if [[ ! -f "$CONFIG_TOML_TMPL" ]]; then
        err "Template not found: $CONFIG_TOML_TMPL"
        exit 1
    fi

    if [[ ! -f "$CONFIG_TOML" ]]; then
        cp "$CONFIG_TOML_TMPL" "$CONFIG_TOML"
        info "Created config.toml from template"
    fi
    chmod 600 "$CONFIG_TOML"

    # Patch mongo/redis for the current mode
    local cur_mongo cur_redis
    cur_mongo=$(get_toml_var "$CONFIG_TOML" "mongo_uri")
    cur_redis=$(get_toml_var "$CONFIG_TOML" "redis_url")
    if [[ "${DEV_MODE:-false}" == true ]]; then
        # Dev mode: backend runs on host, uses localhost to reach containerized mongo/redis
        if [[ "$cur_mongo" == *"mongodb:"* && "$cur_mongo" != *"localhost"* ]]; then
            set_toml_var "$CONFIG_TOML" "mongo_uri" "mongodb://localhost:27017/vulnpen"
        fi
        if [[ "$cur_redis" == *"redis:"* && "$cur_redis" != *"localhost"* ]]; then
            set_toml_var "$CONFIG_TOML" "redis_url" "redis://localhost:6379"
        fi
    else
        # Normal mode: backend runs in container, uses Docker service names
        if [[ "$cur_mongo" == *"localhost"* ]]; then
            set_toml_var "$CONFIG_TOML" "mongo_uri" "mongodb://mongodb:27017/vulnpen"
        fi
        if [[ "$cur_redis" == *"localhost"* ]]; then
            set_toml_var "$CONFIG_TOML" "redis_url" "redis://redis:6379"
        fi
    fi

    # Ensure CORS defaults to frontend URL
    local frontend_url cors_cur
    frontend_url=$(get_toml_var "$CONFIG_TOML" "base_url_frontend")
    frontend_url="${frontend_url:-http://localhost:3000}"
    cors_cur=$(get_toml_var "$CONFIG_TOML" "cors_origins")
    if [[ -z "$cors_cur" ]]; then
        set_toml_var "$CONFIG_TOML" "cors_origins" "$frontend_url"
    fi

    # Ensure session secret
    local secret
    secret=$(get_toml_var "$CONFIG_TOML" "secret")
    if [[ -z "$secret" || "$secret" == "thisismysessionsecret!123" ]]; then
        local generated
        generated=$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | base64 | tr -d '/+=' | head -c 64)
        set_toml_var "$CONFIG_TOML" "secret" "$generated"
        info "Generated session secret"
    fi

    # Ensure [tracing] section
    if ! grep -q "^\[tracing\]" "$CONFIG_TOML" 2>/dev/null; then
        echo "" >> "$CONFIG_TOML"
        echo "[tracing]" >> "$CONFIG_TOML"
        echo "enabled = \"false\"" >> "$CONFIG_TOML"
        echo "public_key = \"\"" >> "$CONFIG_TOML"
        echo "secret_key = \"\"" >> "$CONFIG_TOML"
        echo "base_url = \"https://cloud.langfuse.com\"" >> "$CONFIG_TOML"
    fi
}

ensure_env_defaults() {
    if [[ ! -f "$DYNAMIC_ENV_TMPL" ]]; then
        err "Template not found: $DYNAMIC_ENV_TMPL"
        exit 1
    fi
    if [[ ! -s "$DYNAMIC_ENV" ]]; then
        cp "$DYNAMIC_ENV_TMPL" "$DYNAMIC_ENV"
        info "Created .env from template"
    fi
    if [[ ! -f "$MODEL_REGISTRY_FILE" ]]; then
        printf '{\n  "models": [],\n  "assignments": {\n    "racerModelIds": []\n  }\n}\n' > "$MODEL_REGISTRY_FILE"
        info "Created model-registry.json"
    fi
    chmod 600 "$DYNAMIC_ENV" "$MODEL_REGISTRY_FILE"

    local ssh_host ssh_port kali_password
    ssh_host=$(get_env "$DYNAMIC_ENV" "SSH_HOST")
    ssh_port=$(get_env "$DYNAMIC_ENV" "SSH_PORT")
    kali_password=$(get_env "$DYNAMIC_ENV" "KALI_ROOT_PASSWORD")
    if [[ -z "$kali_password" ]] && \
       { [[ "$ssh_host" == "kali" ]] || { [[ "$ssh_host" == "localhost" ]] && [[ "$ssh_port" == "4242" ]]; }; }; then
        kali_password=$(openssl rand -hex 24)
        set_env_var "$DYNAMIC_ENV" "KALI_ROOT_PASSWORD" "$kali_password"
        set_env_var "$DYNAMIC_ENV" "SSH_PASSWORD" "$kali_password"
        info "Generated Kali SSH password"
    fi
}

ensure_frontend_env() {
    if [[ ! -f "$FRONTEND_TMPL" ]]; then
        err "Template not found: $FRONTEND_TMPL"
        exit 1
    fi
    if [[ ! -f "$FRONTEND_ENV" ]]; then
        cp "$FRONTEND_TMPL" "$FRONTEND_ENV"
        info "Created frontend/.env from template"
    fi
    if [[ "$IS_WSL" == true ]]; then
        sed -i 's/127\.0\.0\.1/localhost/g' "$FRONTEND_ENV"
    fi
}

sync_compose_file_from_config() {
    [[ "${DEV_MODE:-false}" == true ]] && return
    local ssh_host
    ssh_host=$(get_env "$DYNAMIC_ENV" "SSH_HOST")
    if [[ "$ssh_host" == "kali" ]]; then
        set_normal_kali_mode
    fi
}

configure_dev_mode_choice() {
    DEV_MODE=true
    COMPOSE_FILE="docker-compose.dev.yml"
    DEPLOY_MODE="dev"
}

set_normal_mode() {
    DEV_MODE=false
    COMPOSE_FILE="docker-compose.yml"
    DEPLOY_MODE="core"
}

set_normal_kali_mode() {
    DEV_MODE=false
    COMPOSE_FILE="docker-compose.kali.yml"
    DEPLOY_MODE="kali"
}

select_mode_for_configuration() {
    section "Choose Configuration Target"
    echo
    echo -e "   ${BOLD}1)${NC} ${GREEN}Core Docker settings${NC}"
    echo -e "      ${DIM}Use this if VulnPen runs through Docker without provisioning Kali.${NC}"
    echo
    echo -e "   ${BOLD}2)${NC} ${GREEN}Full Docker + Kali settings${NC}"
    echo -e "      ${DIM}Use this if you provision the built-in Kali container in Docker.${NC}"
    echo
    echo -e "   ${BOLD}3)${NC} ${YELLOW}Developer mode settings${NC}"
    echo -e "      ${DIM}Use this if you run the frontend and backend manually.${NC}"
    echo
    prompt_input "Choose [1/2/3]:"
    read -r mode_choice

    case "$mode_choice" in
        2) set_normal_kali_mode ;;
        3) configure_dev_mode_choice ;;
        *) set_normal_mode ;;
    esac
}

detect_running_mode() {
    local has_kali has_backend
    has_kali=$(docker ps --filter "name=kali" --format '{{.Names}}' 2>/dev/null | head -1)
    has_backend=$(docker ps --filter "name=vulnpen-backend" --format '{{.Names}}' 2>/dev/null | head -1)

    if [[ -n "$has_kali" && -n "$has_backend" ]]; then
        set_normal_kali_mode
        info "Detected: Full Docker + Kali"
    elif [[ -n "$has_backend" ]]; then
        set_normal_mode
        info "Detected: Core Docker mode"
    elif [[ -n "$has_kali" ]]; then
        DEV_MODE=true
        COMPOSE_FILE="docker-compose.dev.yml"
        DEPLOY_MODE="dev"
        info "Detected: Developer mode (with Kali)"
    else
        # Nothing running — check for dev-mode infra (mongodb/redis only)
        local has_mongo
        has_mongo=$(docker ps --filter "name=vulnpen-mongodb" --format '{{.Names}}' 2>/dev/null | head -1)
        if [[ -n "$has_mongo" ]]; then
            DEV_MODE=true
            COMPOSE_FILE="docker-compose.dev.yml"
            DEPLOY_MODE="dev"
            info "Detected: Developer mode"
        else
            return 1
        fi
    fi
    return 0
}

select_mode_for_operations() {
    if detect_running_mode; then
        return
    fi

    section "Choose Which Environment To Manage"
    echo
    echo -e "   ${DIM}No running containers detected — please choose:${NC}"
    echo
    echo -e "   ${BOLD}1)${NC} ${GREEN}Core Docker mode${NC}"
    echo -e "   ${BOLD}2)${NC} ${GREEN}Full Docker + Kali${NC}"
    echo -e "   ${BOLD}3)${NC} ${YELLOW}Developer mode${NC}"
    echo
    prompt_input "Choose [1/2/3]:"
    read -r mode_choice

    case "$mode_choice" in
        2)
            set_normal_kali_mode
            ;;
        3)
            DEV_MODE=true
            COMPOSE_FILE="docker-compose.dev.yml"
            DEPLOY_MODE="dev"
            ;;
        *)
            set_normal_mode
            ;;
    esac
}

select_launch_mode() {
    section "Choose How To Run"
    echo
    echo -e "   ${BOLD}1)${NC} ${GREEN}Normal mode${NC}"
    echo -e "      ${DIM}Best for most people. VulnPen starts the application for you${NC}"
    echo -e "      ${DIM}using Docker with guided questions for the required setup.${NC}"
    echo
    echo -e "   ${BOLD}2)${NC} ${YELLOW}Developer mode${NC}"
    echo -e "      ${DIM}Best for advanced users. Docker starts only the supporting services${NC}"
    echo -e "      ${DIM}(like MongoDB and Redis), and you run the frontend/backend manually.${NC}"
    echo
    prompt_input "Choose [1/2]:"
    read -r mode_choice

    case "$mode_choice" in
        2)
            configure_dev_mode_choice
            ;;
        *)
            set_normal_mode
            info "Selected normal mode"
            ;;
    esac
}

# ── Smart configuration (skip if already configured) ──────

is_model_configured() {
    local legacy_presets legacy_key
    if [[ -f "$MODEL_REGISTRY_FILE" ]] && grep -q '"models"[[:space:]]*:[[:space:]]*\[[[:space:]]*{' "$MODEL_REGISTRY_FILE"; then
        return 0
    fi
    legacy_presets=$(get_env "$DYNAMIC_ENV" "MODEL_PRESETS_JSON")
    legacy_key=$(get_env "$DYNAMIC_ENV" "ORCHESTRATOR_API_KEY")
    [[ -n "$legacy_presets" && "$legacy_presets" != "[]" ]] || [[ -n "$legacy_key" ]]
}

is_langfuse_configured() {
    local enabled
    enabled=$(get_toml_var "$CONFIG_TOML" "enabled")
    [[ "$enabled" == "true" ]]
}

is_exploit_box_configured() {
    local host
    host=$(get_env "$DYNAMIC_ENV" "SSH_HOST")
    [[ -n "$host" ]]
}

show_current_config_summary() {
    section "Current Configuration"
    echo

    # Models
    if [[ -f "$MODEL_REGISTRY_FILE" ]] && grep -q '"models"[[:space:]]*:[[:space:]]*\[[[:space:]]*{' "$MODEL_REGISTRY_FILE"; then
        echo -e "   ${GREEN}●${NC} Models: ${BOLD}configured${NC}  ${DIM}profile: backend/model-registry.json${NC}"
    elif [[ -n "$(get_env "$DYNAMIC_ENV" "MODEL_PRESETS_JSON")" && "$(get_env "$DYNAMIC_ENV" "MODEL_PRESETS_JSON")" != "[]" ]]; then
        echo -e "   ${GREEN}●${NC} Models: ${BOLD}env config detected${NC}  ${DIM}will migrate on backend start${NC}"
    elif [[ -n "$(get_env "$DYNAMIC_ENV" "ORCHESTRATOR_API_KEY")" ]]; then
        echo -e "   ${GREEN}●${NC} Models: ${BOLD}legacy config detected${NC}  ${DIM}will migrate on backend start${NC}"
    else
        echo -e "   ${RED}●${NC} Models: ${BOLD}not configured${NC}  ${YELLOW}← required${NC}"
    fi

    # Langfuse
    local langfuse_on
    langfuse_on=$(get_toml_var "$CONFIG_TOML" "enabled")
    if [[ "$langfuse_on" == "true" ]]; then
        echo -e "   ${GREEN}●${NC} Langfuse Tracing: enabled"
    else
        echo -e "   ${DIM}○${NC} Langfuse Tracing: disabled  ${DIM}(optional)${NC}"
    fi

    # Exploit box
    local ssh_host ssh_user
    ssh_host=$(get_env "$DYNAMIC_ENV" "SSH_HOST")
    ssh_user=$(get_env "$DYNAMIC_ENV" "SSH_USERNAME")
    if [[ -n "$ssh_host" ]]; then
        echo -e "   ${GREEN}●${NC} Exploit Box: ${ssh_user:-root}@${ssh_host}"
    else
        echo -e "   ${DIM}○${NC} Exploit Box: not set  ${DIM}(optional)${NC}"
    fi

    echo
}

configure_required_startup_smart() {
    ensure_env_defaults

    if is_model_configured; then
        show_current_config_summary
        if confirm "Keep current configuration and start?" "y"; then
            info "Using existing configuration"
            sync_compose_file_from_config
            return
        fi
        echo
    fi

    if ! is_model_configured; then
        warn "No model is configured yet."
        hint "Start VulnPen, then open Settings -> Models to add a model preset and assign the orchestrator."
    fi

    if ! is_langfuse_configured; then
        echo
        hint "Langfuse provides LLM call tracing & observability. (optional, requires restart to change)"
        if confirm "Configure Langfuse tracing now?" "n"; then
            configure_langfuse
        else
            info "Skipped — configure anytime via ./run.sh config (requires restart)"
        fi
    fi

    # Exploit box — prompt if not configured, or offer reconfiguration
    if ! is_exploit_box_configured; then
        echo
        configure_exploit_box
    else
        if confirm "Reconfigure exploit box?" "n"; then
            configure_exploit_box
        else
            info "Keeping current exploit box config"
        fi
    fi

    # Ensure compose file matches the configured SSH target
    sync_compose_file_from_config
}

configure_static_full() {
    section "Static Configuration (Developer Mode)"
    hint "These settings require a process restart to take effect."
    ensure_config_defaults
    ensure_frontend_env

    local cur val frontend_url default_mongo default_redis generated_secret frontend_backend_uri frontend_deployment

    section "Server Settings"
    cur=$(get_toml_var "$CONFIG_TOML" "base_url_frontend")
    prompt_input "Frontend URL [${cur:-http://localhost:3000}]:"
    read -r val
    if [[ -n "$val" ]]; then
        set_toml_var "$CONFIG_TOML" "base_url_frontend" "$val"
        frontend_url="$val"
    else
        frontend_url="${cur:-http://localhost:3000}"
    fi

    cur=$(get_toml_var "$CONFIG_TOML" "port")
    prompt_input "Backend port [${cur:-8080}]:"
    read -r val
    [[ -n "$val" ]] && set_toml_var "$CONFIG_TOML" "port" "$val"

    cur=$(get_toml_var "$CONFIG_TOML" "deployment")
    prompt_input "Deployment [LOCAL/PROD] [${cur:-LOCAL}]:"
    read -r val
    [[ -n "$val" ]] && set_toml_var "$CONFIG_TOML" "deployment" "$val"

    frontend_backend_uri=$(get_env "$FRONTEND_ENV" "NEXT_PUBLIC_BACKEND_URI")
    prompt_input "Backend URL for the frontend [${frontend_backend_uri:-http://localhost:8080}]:"
    read -r val
    if [[ -n "$val" ]]; then
        set_env_var "$FRONTEND_ENV" "NEXT_PUBLIC_BACKEND_URI" "$val"
    elif [[ -z "$frontend_backend_uri" ]]; then
        set_env_var "$FRONTEND_ENV" "NEXT_PUBLIC_BACKEND_URI" "http://localhost:8080"
    fi

    frontend_deployment=$(get_env "$FRONTEND_ENV" "NEXT_PUBLIC_DEPLOYMENT")
    prompt_input "Frontend deployment mode [LOCAL/PRODUCTION] [${frontend_deployment:-LOCAL}]:"
    read -r val
    if [[ -n "$val" ]]; then
        set_env_var "$FRONTEND_ENV" "NEXT_PUBLIC_DEPLOYMENT" "$val"
    elif [[ -z "$frontend_deployment" ]]; then
        set_env_var "$FRONTEND_ENV" "NEXT_PUBLIC_DEPLOYMENT" "LOCAL"
    fi

    cur=$(get_toml_var "$CONFIG_TOML" "cors_origins")
    prompt_input "CORS origins [${frontend_url}]:"
    read -r val
    if [[ -n "$val" ]]; then
        set_toml_var "$CONFIG_TOML" "cors_origins" "$val"
    else
        set_toml_var "$CONFIG_TOML" "cors_origins" "$frontend_url"
    fi

    section "Database"
    hint "One-time setup. Change only if using external MongoDB/Redis."
    default_mongo="mongodb://localhost:27017/vulnpen"
    default_redis="redis://localhost:6379"

    cur=$(get_toml_var "$CONFIG_TOML" "mongo_uri")
    prompt_input "MongoDB URI [${cur:-$default_mongo}]:"
    read -r val
    if [[ -n "$val" ]]; then
        set_toml_var "$CONFIG_TOML" "mongo_uri" "$val"
    elif [[ -z "$cur" ]]; then
        set_toml_var "$CONFIG_TOML" "mongo_uri" "$default_mongo"
    fi

    cur=$(get_toml_var "$CONFIG_TOML" "mongo_database")
    prompt_input "MongoDB database [${cur:-vulnpen}]:"
    read -r val
    [[ -n "$val" ]] && set_toml_var "$CONFIG_TOML" "mongo_database" "$val"

    cur=$(get_toml_var "$CONFIG_TOML" "redis_url")
    prompt_input "Redis URL [${cur:-$default_redis}]:"
    read -r val
    if [[ -n "$val" ]]; then
        set_toml_var "$CONFIG_TOML" "redis_url" "$val"
    elif [[ -z "$cur" ]]; then
        set_toml_var "$CONFIG_TOML" "redis_url" "$default_redis"
    fi

    info "Developer-mode static config updated"
}

# ── Config options ─────────────────────────────────────────

configure_claude_oauth() {
    section "Claude OAuth (PKCE)"
    if ! command -v openssl &>/dev/null; then
        err "openssl is required for OAuth PKCE."
        return 1
    fi
    local client_id="9d1c250a-e61b-44d9-88ed-5944d1962f5e"
    local auth_url="https://claude.ai/oauth/authorize"
    local token_url="https://console.anthropic.com/v1/oauth/token"
    local redirect_uri="https://console.anthropic.com/oauth/code/callback"
    local scopes="org:create_api_key user:profile user:inference"
    local code_verifier
    code_verifier=$(openssl rand 32 | openssl base64 -A | tr '+/' '-_' | tr -d '=')
    local code_challenge
    code_challenge=$(printf '%s' "$code_verifier" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
    local state
    state=$(openssl rand -hex 16)
    local auth_params="code=true&client_id=${client_id}&response_type=code"
    auth_params+="&redirect_uri=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${redirect_uri}', safe=''))" 2>/dev/null || echo "${redirect_uri}")"
    auth_params+="&scope=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${scopes}', safe=''))" 2>/dev/null || echo "${scopes// /+}")"
    auth_params+="&code_challenge=${code_challenge}&code_challenge_method=S256&state=${state}"
    echo
    info "Open this URL to authorize Claude:"
    echo -e "   ${CYAN}${auth_url}?${auth_params}${NC}"
    echo
    prompt_input "Paste the authorization code:"
    read -r auth_code
    auth_code="${auth_code%%#*}"
    if [[ -z "$auth_code" ]]; then
        err "No authorization code provided"
        return 1
    fi
    local token_response
    token_response=$(curl -s -X POST "$token_url" -H "Content-Type: application/x-www-form-urlencoded" \
        -d "code=${auth_code}" -d "state=${state}" -d "grant_type=authorization_code" \
        -d "client_id=${client_id}" -d "redirect_uri=${redirect_uri}" -d "code_verifier=${code_verifier}")
    local access_token refresh_token expires_in
    if command -v python3 &>/dev/null; then
        access_token=$(echo "$token_response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('access_token',''))" 2>/dev/null || true)
        refresh_token=$(echo "$token_response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('refresh_token',''))" 2>/dev/null || true)
        expires_in=$(echo "$token_response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('expires_in',3600))" 2>/dev/null || echo "3600")
    elif command -v jq &>/dev/null; then
        access_token=$(echo "$token_response" | jq -r '.access_token // empty')
        refresh_token=$(echo "$token_response" | jq -r '.refresh_token // empty')
        expires_in=$(echo "$token_response" | jq -r '.expires_in // 3600')
    else
        err "python3 or jq required to parse token response."
        return 1
    fi
    if [[ -z "$access_token" ]]; then
        err "Failed to get access token"
        return 1
    fi
    local expires_at=$(( $(date +%s) + ${expires_in:-3600} ))
    set_env_var "$DYNAMIC_ENV" "ANTHROPIC_OAUTH_ACCESS_TOKEN"  "$access_token"
    set_env_var "$DYNAMIC_ENV" "ANTHROPIC_OAUTH_REFRESH_TOKEN" "$refresh_token"
    set_env_var "$DYNAMIC_ENV" "ANTHROPIC_OAUTH_EXPIRES_AT"    "$expires_at"
    info "Claude account connected via OAuth"
}

configure_langfuse() {
    section "Langfuse Tracing"
    hint "Requires a container restart to take effect. Change via ./run.sh config."
    ensure_config_defaults
    echo
    echo -e "   ${DIM}Langfuse provides LLM observability. Get keys at https://cloud.langfuse.com${NC}"
    echo
    if confirm "Enable Langfuse tracing?" "n"; then
        set_toml_var "$CONFIG_TOML" "enabled" "true"
        cur=$(get_toml_var "$CONFIG_TOML" "public_key")
        prompt_input "Langfuse Public Key (pk-lf-...) [${cur:-not set}]:"
        read -r val
        [[ -n "$val" ]] && set_toml_var "$CONFIG_TOML" "public_key" "$val"
        cur=$(get_toml_var "$CONFIG_TOML" "secret_key")
        prompt_input "Langfuse Secret Key (sk-lf-...) [${cur:-not set}]:"
        read -rs val; echo
        [[ -n "$val" ]] && set_toml_var "$CONFIG_TOML" "secret_key" "$val"
        cur=$(get_toml_var "$CONFIG_TOML" "base_url")
        prompt_input "Langfuse Base URL [${cur:-https://cloud.langfuse.com}]:"
        read -r val
        [[ -n "$val" ]] && set_toml_var "$CONFIG_TOML" "base_url" "$val"
        info "Langfuse tracing enabled"
    else
        set_toml_var "$CONFIG_TOML" "enabled" "false"
        info "Langfuse tracing disabled"
    fi
}

configure_exploit_box() {
    section "Exploit Box Connection"
    hint "The exploit box is the SSH target where pentesting commands run. You can change this later via Settings UI."
    ensure_env_defaults
    echo
    echo -e "   ${BOLD}1)${NC} Kali VM exploit box spin up  ${DIM}(first build can take 15-30+ min)${NC}"
    echo -e "   ${BOLD}2)${NC} Connect to external exploit box (any VM via SSH, including your local computer)"
    echo -e "   ${BOLD}3)${NC} ${RED}No exploit box${NC}  ${RED}(reduces VulnPen functionality significantly)${NC}"
    prompt_input "Choose [1/2/3]:"
    read -r ssh_choice

    case "$ssh_choice" in
        1)
            configure_docker_kali
            ;;
        2)
            configure_connect_external_exploit_box
            ;;
        3)
            echo
            warn "No exploit box selected — VulnPen will have reduced functionality (no terminal, shells, or command execution on a target)."
            clear_exploit_box_config
            ;;
        *)
            warn "Invalid choice. Select 1, 2, or 3."
            configure_exploit_box
            ;;
    esac
}

clear_exploit_box_config() {
    if [[ "${DEV_MODE:-false}" == true ]]; then
        DEPLOY_MODE="dev"
    else
        set_normal_mode
    fi
    set_env_var "$DYNAMIC_ENV" "SSH_HOST" ""
    set_env_var "$DYNAMIC_ENV" "SSH_PORT" "22"
    set_env_var "$DYNAMIC_ENV" "SSH_USERNAME" ""
    set_env_var "$DYNAMIC_ENV" "SSH_PASSWORD" ""
    set_env_var "$DYNAMIC_ENV" "SSH_PRIVATE_KEY" ""
    set_env_var "$DYNAMIC_ENV" "SSH_PRIVATE_KEY_PASSPHRASE" ""
}

configure_connect_external_exploit_box() {
    local default_host default_port default_user cur_host cur_port cur_user
    if [[ "${DEV_MODE:-false}" == true ]]; then
        DEPLOY_MODE="dev"
        default_host="localhost"
    else
        set_normal_mode
        default_host="host.docker.internal"
    fi
    default_port="22"
    default_user="$(id -un 2>/dev/null || whoami 2>/dev/null || echo "root")"

    cur_host=$(get_env "$DYNAMIC_ENV" "SSH_HOST")
    cur_port=$(get_env "$DYNAMIC_ENV" "SSH_PORT")
    cur_user=$(get_env "$DYNAMIC_ENV" "SSH_USERNAME")
    if [[ -n "$cur_host" ]]; then
        case "$cur_host" in
            localhost|host.docker.internal|kali) ;;
            *) default_host="$cur_host"; default_port="${cur_port:-22}"; default_user="${cur_user:-$default_user}" ;;
        esac
    fi

    echo
    hint "Enter host (use ${default_host} for your local machine, or any VM IP/hostname for remote)"
    configure_external_ssh "$default_host" "$default_port" "$default_user"
}

configure_docker_kali() {
    echo
    warn "The Kali image is large. The first build may take 15-30+ minutes depending"
    warn "on your internet speed and hardware. Subsequent starts reuse the cached image."
    echo
    if [[ "${DEV_MODE:-false}" == true ]]; then
        DEPLOY_MODE="dev-kali"
        info "Provisioning Kali in Docker for developer mode"
        set_env_var "$DYNAMIC_ENV" "SSH_HOST" "localhost"
        set_env_var "$DYNAMIC_ENV" "SSH_PORT" "4242"
    else
        set_normal_kali_mode
        info "Provisioning Kali in the full Docker stack"
        set_env_var "$DYNAMIC_ENV" "SSH_HOST" "kali"
        set_env_var "$DYNAMIC_ENV" "SSH_PORT" "22"
    fi
    set_env_var "$DYNAMIC_ENV" "SSH_USERNAME" "root"
    local kali_password
    kali_password=$(get_env "$DYNAMIC_ENV" "KALI_ROOT_PASSWORD")
    if [[ -z "$kali_password" ]]; then
        kali_password=$(openssl rand -hex 24)
        set_env_var "$DYNAMIC_ENV" "KALI_ROOT_PASSWORD" "$kali_password"
    fi
    set_env_var "$DYNAMIC_ENV" "SSH_PASSWORD" "$kali_password"
    set_env_var "$DYNAMIC_ENV" "SSH_PRIVATE_KEY" ""
    set_env_var "$DYNAMIC_ENV" "SSH_PRIVATE_KEY_PASSPHRASE" ""
    info "Exploit box configured"
}

configure_external_ssh() {
    local default_host="${1:-}"
    local default_port="${2:-22}"
    local default_user="${3:-root}"
    local ssh_host=""

    echo
    if [[ -n "$default_host" ]]; then
        prompt_input "Exploit box host [${default_host}]:"
        read -r ssh_host
        ssh_host="${ssh_host:-$default_host}"
    else
        while [[ -z "$ssh_host" ]]; do
            prompt_input "Exploit box host:"
            read -r ssh_host
            [[ -z "$ssh_host" ]] && warn "Host is required"
        done
    fi

    prompt_input "SSH Port [${default_port}]:"
    read -r ssh_port
    ssh_port="${ssh_port:-$default_port}"
    prompt_input "SSH Username [${default_user}]:"
    read -r ssh_user
    ssh_user="${ssh_user:-$default_user}"
    set_env_var "$DYNAMIC_ENV" "SSH_HOST" "$ssh_host"
    set_env_var "$DYNAMIC_ENV" "SSH_PORT" "$ssh_port"
    set_env_var "$DYNAMIC_ENV" "SSH_USERNAME" "$ssh_user"
    echo
    echo -e "   ${BOLD}1)${NC} Password   ${BOLD}2)${NC} Private key"
    prompt_input "Auth [1/2]:"
    read -r auth
    case "$auth" in
        2)
            prompt_input "Path to private key:"
            read -r key_path
            [[ ! -f "$key_path" ]] && { err "File not found: $key_path"; exit 1; }
            if [[ "${DEV_MODE:-false}" == true ]]; then
                local resolved_path="$(cd "$(dirname "$key_path")" && pwd)/$(basename "$key_path")"
                set_env_var "$DYNAMIC_ENV" "SSH_PASSWORD" ""
                set_env_var "$DYNAMIC_ENV" "SSH_PRIVATE_KEY" "$resolved_path"
                set_env_var "$DYNAMIC_ENV" "SSH_PRIVATE_KEY_PASSPHRASE" ""
            else
                mkdir -p "$SSH_KEYS_DIR"
                local key_name="$(basename "$key_path")"
                cp "$key_path" "$SSH_KEYS_DIR/$key_name"
                chmod 600 "$SSH_KEYS_DIR/$key_name"
                set_env_var "$DYNAMIC_ENV" "SSH_PASSWORD" ""
                set_env_var "$DYNAMIC_ENV" "SSH_PRIVATE_KEY" "/ssh-keys/$key_name"
                prompt_input "Passphrase (Enter if none):"
                read -rs passphrase; echo
                set_env_var "$DYNAMIC_ENV" "SSH_PRIVATE_KEY_PASSPHRASE" "$passphrase"
                NEED_SSH_KEY_MOUNT=true
            fi
            ;;
        *)
            prompt_input "SSH Password:"
            read -rs ssh_pass; echo
            set_env_var "$DYNAMIC_ENV" "SSH_PASSWORD" "$ssh_pass"
            set_env_var "$DYNAMIC_ENV" "SSH_PRIVATE_KEY" ""
            set_env_var "$DYNAMIC_ENV" "SSH_PRIVATE_KEY_PASSPHRASE" ""
            ;;
    esac
    info "Exploit box configured"
}

# ── Rebuild prompt (normal Docker mode only) ─────────────
prompt_rebuild_normal() {
    echo
    section "Rebuild Containers?"
    hint "Rebuild if you've pulled updates or changed code. Skip for a normal restart."
    echo
    echo -e "   ${BOLD}1)${NC} No rebuild  ${DIM}(default — fastest start)${NC}"
    echo -e "   ${BOLD}2)${NC} Rebuild backend"
    echo
    prompt_input "Choose [1/2, Enter = 1]:"
    read -r rebuild_choice

    case "$rebuild_choice" in
        2)
            info "Rebuilding backend..."
            compose build backend
            ;;
        *)
            info "Skipping rebuild"
            ;;
    esac
}

# ── Compose wrapper ───────────────────────────────────────
compose() {
    local args=()
    [[ -n "${COMPOSE_FILE:-}" ]] && args+=(-f "$COMPOSE_FILE")
    # Skip override in dev mode: docker-compose.dev.yml has no backend service,
    # and the override only customizes backend. Merging would create an invalid
    # backend service with no image/build.
    if [[ "${DEV_MODE:-false}" != true ]] && [[ -f "$COMPOSE_OVERRIDE" ]]; then
        args+=(-f "$COMPOSE_OVERRIDE")
    fi
    $COMPOSE_CMD "${args[@]}" "$@"
}

ensure_compose_override() {
    local needs_key_mount=false
    local needs_agent_mount=false
    local needs_ca_mount=false
    local host_ssh_dir="${HOST_SSH_DIR:-$HOME/.ssh}"
    local host_key_dir="${HOST_SSH_KEYS_DIR:-$HOME/keys}"
    local codex_auth_file="${CODEX_AUTH_FILE:-$HOME/.codex/auth.json}"
    local needs_host_ssh_mount=false
    local needs_host_key_mount=false
    local needs_codex_auth_mount=false

    if [[ "$NEED_SSH_KEY_MOUNT" == true ]] || \
       { [[ -d "$SSH_KEYS_DIR" ]] && [[ -n "$(ls -A "$SSH_KEYS_DIR" 2>/dev/null)" ]]; }; then
        needs_key_mount=true
    fi

    [[ -n "${SSH_AUTH_SOCK:-}" && -S "${SSH_AUTH_SOCK:-}" ]] && needs_agent_mount=true
    [[ -n "${NODE_EXTRA_CA_CERTS:-}" && -f "${NODE_EXTRA_CA_CERTS:-}" ]] && needs_ca_mount=true
    [[ -d "$host_ssh_dir" ]] && needs_host_ssh_mount=true
    [[ -d "$host_key_dir" ]] && needs_host_key_mount=true
    [[ -f "$codex_auth_file" ]] && needs_codex_auth_mount=true

    if [[ "$needs_key_mount" == true || "$needs_agent_mount" == true || "$needs_ca_mount" == true || "$needs_host_ssh_mount" == true || "$needs_host_key_mount" == true || "$needs_codex_auth_mount" == true ]]; then
        {
            echo "services:"
            echo "  backend:"
            if [[ "$needs_key_mount" == true || "$needs_agent_mount" == true || "$needs_ca_mount" == true || "$needs_host_ssh_mount" == true || "$needs_host_key_mount" == true || "$needs_codex_auth_mount" == true ]]; then
                echo "    volumes:"
            fi
            if [[ "$needs_key_mount" == true ]]; then
                echo "      - ./ssh-keys:/ssh-keys:ro"
            fi
            if [[ "$needs_agent_mount" == true ]]; then
                echo "      - \"${SSH_AUTH_SOCK}:/ssh-agent\""
            fi
            if [[ "$needs_ca_mount" == true ]]; then
                echo "      - \"${NODE_EXTRA_CA_CERTS}:/etc/vulnpen/custom-ca.pem:ro\""
            fi
            if [[ "$needs_host_ssh_mount" == true ]]; then
                echo "      - \"${host_ssh_dir}:/root/.ssh:ro\""
            fi
            if [[ "$needs_host_key_mount" == true ]]; then
                echo "      - \"${host_key_dir}:/root/keys:ro\""
            fi
            if [[ "$needs_codex_auth_mount" == true ]]; then
                echo "      - \"${codex_auth_file}:/root/.codex/auth.json\""
            fi
            if [[ "$needs_agent_mount" == true || "$needs_ca_mount" == true ]]; then
                echo "    environment:"
            fi
            if [[ "$needs_agent_mount" == true ]]; then
                echo "      SSH_AUTH_SOCK: /ssh-agent"
            fi
            if [[ "$needs_ca_mount" == true ]]; then
                echo "      NODE_EXTRA_CA_CERTS: /etc/vulnpen/custom-ca.pem"
            fi
        } > "$COMPOSE_OVERRIDE"
    else
        rm -f "$COMPOSE_OVERRIDE"
    fi
}

# ── Launch (Docker mode) ──────────────────────────────────
launch() {
    local build_flag="${1:-}"

    if [[ -z "${COMPOSE_FILE:-}" ]]; then
        set_normal_mode
    fi

    check_selected_environment

    if [[ "${DEV_MODE:-false}" == true ]]; then
        launch_dev "$build_flag"
        return
    fi

    section "Launching VulnPen"

    if ! command -v curl &>/dev/null; then
        err "curl is required to verify that VulnPen is ready."
        exit 1
    fi

    ensure_compose_override
    save_run_state

    # Ensure backend/.env exists before compose up (bind-mounted into container)
    if [[ ! -f "$DYNAMIC_ENV" ]]; then
        cp "$DYNAMIC_ENV_TMPL" "$DYNAMIC_ENV"
        info "Created .env from template"
    fi

    info "Compose file: $COMPOSE_FILE"

    if [[ "$build_flag" == "--build" ]]; then
        warn "Building images — may take a while on first run..."
    fi

    echo
    compose up ${build_flag} -d
    echo

    info "Waiting for the application to become ready..."
    local ready=false attempt
    for attempt in {1..60}; do
        if curl --fail --silent --max-time 2 http://127.0.0.1:8080/api/healthcheck >/dev/null; then
            ready=true
            break
        fi
        sleep 2
    done
    if [[ "$ready" != true ]]; then
        err "VulnPen did not become ready within 2 minutes."
        compose ps
        compose logs --tail=80 backend
        exit 1
    fi

    section "VulnPen is Running"
    echo
    local frontend_url backend_url
    frontend_url=$(get_toml_var "$CONFIG_TOML" "base_url_frontend" 2>/dev/null)
    backend_url=$(get_env "$FRONTEND_ENV" "NEXT_PUBLIC_BACKEND_URI")
    frontend_url="${frontend_url:-http://localhost:3000}"
    backend_url="${backend_url:-http://localhost:8080}"
    echo -e "   ${GREEN}Frontend${NC}   ${frontend_url}"
    echo -e "   ${GREEN}Backend${NC}    ${backend_url}"
    echo -e "   ${GREEN}MongoDB${NC}    localhost:27017"
    echo -e "   ${GREEN}Redis${NC}      localhost:6379"

    if [[ "${DEPLOY_MODE:-}" == "kali" ]]; then
        echo
        echo -e "   ${GREEN}Kali SSH${NC}   ssh root@localhost -p 4242"
        echo -e "   ${GREEN}Kali shell${NC} http://localhost:4200"
    fi

    echo
    hint "Config files: config.toml (restart-required) | backend/.env + backend/model-registry.json (Settings UI)"
    hint "Additional features (Burp, Browser Agent, VNC) can be configured in the Settings UI."
    echo
    info "Commands: $0 stop | $0 logs | $0 status | $0 config"
}

# ── Launch dev mode ───────────────────────────────────────
launch_dev() {
    local build_flag="${1:-}"

    section "Launching Developer Mode"

    check_pnpm

    info "Installing dependencies (backend + frontend)..."
    (cd "$SCRIPT_DIR/backend" && pnpm install)
    (cd "$SCRIPT_DIR/frontend" && pnpm install)
    info "Dependencies installed"

    maybe_install_dev_browser_agent_browser

    local dev_services="mongodb redis"
    [[ "${DEPLOY_MODE:-}" == "dev-kali" ]] && dev_services="mongodb redis kali"

    info "Starting infrastructure: ${BOLD}${dev_services}${NC}"
    echo
    compose up ${build_flag} -d ${dev_services}
    echo

    info "Waiting for MongoDB and Redis..."
    local infra_ready=false attempt
    for attempt in {1..30}; do
        if compose exec -T mongodb mongosh --quiet --eval 'db.runCommand({ ping: 1 }).ok' 2>/dev/null | grep -q 1 && \
           compose exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; then
            infra_ready=true
            break
        fi
        sleep 2
    done
    if [[ "$infra_ready" != true ]]; then
        err "MongoDB or Redis did not become ready within one minute."
        compose ps
        compose logs --tail=80 mongodb redis
        exit 1
    fi

    section "Developer Mode — Infrastructure Running"
    echo
    echo -e "   ${GREEN}MongoDB${NC}    localhost:27017"
    echo -e "   ${GREEN}Redis${NC}      localhost:6379"
    [[ "${DEPLOY_MODE:-}" == "dev-kali" ]] && echo -e "   ${GREEN}Kali SSH${NC}   ssh root@localhost -p 4242"

    echo
    section "Start Frontend & Backend Manually"
    echo
    echo -e "   ${CYAN}Backend${NC} (two terminals):"
    echo -e "     ${DIM}cd backend && pnpm run watch${NC}   ${DIM}# Terminal 1${NC}"
    echo -e "     ${DIM}cd backend && pnpm run dev${NC}      ${DIM}# Terminal 2${NC}"
    echo
    echo -e "   ${CYAN}Frontend:${NC}"
    echo -e "     ${DIM}cd frontend && pnpm run dev${NC}"
    echo
    local frontend_url backend_url
    frontend_url=$(get_toml_var "$CONFIG_TOML" "base_url_frontend" 2>/dev/null)
    backend_url=$(get_env "$FRONTEND_ENV" "NEXT_PUBLIC_BACKEND_URI")
    echo -e "   ${CYAN}Endpoints:${NC} Frontend ${frontend_url:-http://localhost:3000} | Backend ${backend_url:-http://localhost:8080}"
    echo
    hint "Config files: config.toml (restart-required) | backend/.env + backend/model-registry.json (Settings UI)"
    hint "Additional features (Burp, Browser Agent, VNC) can be configured in the Settings UI."
    echo
}

# ── Commands ───────────────────────────────────────────────
cmd_start() {
    check_prerequisites
    detect_wsl

    if [[ "$QUICK_MODE" == true ]]; then
        if ! load_run_state; then
            set_normal_mode
        fi
        info "Mode: ${DEPLOY_MODE:-core} (from previous run)"
    else
        select_launch_mode
    fi

    resolve_env_path
    ensure_config_defaults
    ensure_env_defaults
    ensure_frontend_env

    if [[ "$QUICK_MODE" == true ]]; then
        if is_model_configured; then
            show_current_config_summary
            info "Quick start — using existing configuration"
        else
            warn "No model is configured yet."
            hint "Start VulnPen, then open Settings -> Models to add a model preset and assign the orchestrator."
        fi
    elif [[ "${DEV_MODE:-false}" == true ]]; then
        configure_static_full
        configure_required_startup_smart
    else
        configure_required_startup_smart
    fi

    if [[ -d "$SSH_KEYS_DIR" ]] && [[ -n "$(ls -A "$SSH_KEYS_DIR" 2>/dev/null)" ]]; then
        NEED_SSH_KEY_MOUNT=true
    fi

    if [[ "$QUICK_MODE" != true && "${DEV_MODE:-false}" != true ]]; then
        prompt_rebuild_normal
    fi

    launch
}

cmd_config() {
    check_prerequisites
    detect_wsl
    select_mode_for_configuration

    resolve_env_path
    ensure_config_defaults
    ensure_env_defaults
    ensure_frontend_env

    section "Configuration"
    echo
    echo -e "   ${BOLD}1)${NC} Langfuse tracing          ${DIM}(requires container restart)${NC}"
    echo -e "   ${BOLD}2)${NC} Exploit box               ${DIM}(changeable at runtime via Settings UI)${NC}"
    echo -e "   ${BOLD}3)${NC} All of the above"
    if [[ "${DEV_MODE:-false}" == true ]]; then
        echo -e "   ${BOLD}5)${NC} Server / Database / CORS  ${DIM}(requires process restart)${NC}"
    fi
    echo
    local max_choice=3
    [[ "${DEV_MODE:-false}" == true ]] && max_choice=5
    prompt_input "Choose [1-${max_choice}]:"
    read -r choice

    case "$choice" in
        1) configure_langfuse ;;
        2) configure_exploit_box ;;
        3)
            configure_langfuse
            configure_exploit_box
            ;;
        5)
            if [[ "${DEV_MODE:-false}" == true ]]; then
                configure_static_full
            else
                warn "No configuration changed"
            fi
            ;;
        *)
            warn "No configuration changed"
            ;;
    esac

    echo
    if [[ "${DEV_MODE:-false}" != true ]]; then
        if confirm "Restart containers to apply changes?" "y"; then
            ensure_compose_override
            compose restart
            info "Containers restarted"
        else
            hint "Runtime-editable settings (Models, SSH) take effect without restart."
            hint "Langfuse & server settings require a restart: ./run.sh stop && ./run.sh start"
        fi
    else
        info "Config saved."
        hint "Runtime-editable settings take effect immediately. Restart backend for static config changes."
    fi
}

cmd_dev() {
    check_prerequisites
    detect_wsl

    configure_dev_mode_choice

    resolve_env_path
    ensure_config_defaults
    ensure_env_defaults
    ensure_frontend_env

    if [[ "$QUICK_MODE" == true ]]; then
        if is_model_configured; then
            show_current_config_summary
            info "Quick start — using existing configuration"
        else
            warn "No model is configured yet."
            hint "Start VulnPen, then open Settings -> Models to add a model preset and assign the orchestrator."
        fi
    else
        configure_static_full
        configure_required_startup_smart
    fi

    if [[ -d "$SSH_KEYS_DIR" ]] && [[ -n "$(ls -A "$SSH_KEYS_DIR" 2>/dev/null)" ]]; then
        NEED_SSH_KEY_MOUNT=true
    fi

    if [[ "$(get_env "$DYNAMIC_ENV" "SSH_HOST")" == "localhost" ]] && \
       [[ "$(get_env "$DYNAMIC_ENV" "SSH_PORT")" == "4242" ]]; then
        DEPLOY_MODE="dev-kali"
    fi

    launch
}

cmd_stop() {
    check_prerequisites
    select_mode_for_operations
    section "Stopping VulnPen"
    compose down
    info "All containers stopped"
}

cmd_logs() {
    check_prerequisites
    select_mode_for_operations
    compose logs -f "${@}"
}

format_status_icon() {
    local status="$1"
    case "$status" in
        *Up*)       echo -e "${GREEN}●${NC}" ;;
        *healthy*)  echo -e "${GREEN}●${NC}" ;;
        *running*)  echo -e "${GREEN}●${NC}" ;;
        *exited*|*dead*) echo -e "${RED}●${NC}" ;;
        *restarting*) echo -e "${YELLOW}●${NC}" ;;
        *) echo -e "${DIM}○${NC}" ;;
    esac
}

format_uptime() {
    local status="$1"
    echo "$status" | sed 's/Up //' | sed 's/ (healthy)//' | sed 's/About /~/'
}

cmd_status() {
    check_prerequisites
    select_mode_for_operations

    local ps_output
    ps_output=$(compose ps --format '{{.Name}}|{{.Service}}|{{.Status}}|{{.Ports}}' 2>/dev/null)

    if [[ -z "$ps_output" ]]; then
        warn "No containers found for this environment."
        return
    fi

    section "Container Status"
    echo

    while IFS='|' read -r name service status ports; do
        local icon uptime port_summary
        icon=$(format_status_icon "$status")
        uptime=$(format_uptime "$status")

        port_summary=""
        if [[ -n "$ports" ]]; then
            port_summary=$(echo "$ports" | tr ',' '\n' | sed -nE 's/.*(0\.0\.0\.0|127\.0\.0\.1):([0-9]+)->.*/\2/p' | sort -n | paste -sd', ' -)
        fi

        printf "   %b  ${BOLD}%-12s${NC} %-20s" "$icon" "$service" "$uptime"
        if [[ -n "$port_summary" ]]; then
            echo -e "  ${DIM}ports: ${port_summary}${NC}"
        else
            echo
        fi
    done <<< "$ps_output"

    echo

    if [[ "${DEPLOY_MODE:-}" == "kali" || "${DEPLOY_MODE:-}" == "dev-kali" ]]; then
        section "Quick Access"
        echo
        echo -e "   ${GREEN}Frontend${NC}   http://localhost:3000"
        echo -e "   ${GREEN}Backend${NC}    http://localhost:8080"
        echo -e "   ${GREEN}Kali SSH${NC}   ssh root@localhost -p 4242"
        echo -e "   ${GREEN}Kali shell${NC} http://localhost:4200"
        echo
    else
        section "Quick Access"
        echo
        echo -e "   ${GREEN}Frontend${NC}   http://localhost:3000"
        echo -e "   ${GREEN}Backend${NC}    http://localhost:8080"
        echo
    fi
}

cmd_backup() {
    check_prerequisites
    select_mode_for_operations

    if [[ -z "$(compose ps -q mongodb 2>/dev/null)" || -z "$(compose ps -q redis 2>/dev/null)" ]]; then
        err "MongoDB and Redis must be running before a backup can be created."
        hint "Start the selected environment, then run ./run.sh backup again."
        exit 1
    fi

    local timestamp backup_dir
    timestamp=$(date +%Y%m%d-%H%M%S)
    backup_dir="$SCRIPT_DIR/backups/$timestamp"
    umask 077
    mkdir -p "$backup_dir"

    section "Backing Up VulnPen"
    info "Exporting MongoDB..."
    compose exec -T mongodb mongodump --quiet --archive > "$backup_dir/mongodb.archive"

    info "Saving Redis..."
    local redis_save
    redis_save=$(compose exec -T redis redis-cli --raw SAVE)
    if [[ "$redis_save" != *"OK"* ]]; then
        err "Redis backup failed: $redis_save"
        exit 1
    fi
    docker cp "$(compose ps -q redis):/data/dump.rdb" "$backup_dir/redis.rdb" >/dev/null

    local config_files=()
    local candidate
    for candidate in config.toml backend/.env backend/model-registry.json frontend/.env .run-state ssh-keys; do
        [[ -e "$SCRIPT_DIR/$candidate" ]] && config_files+=("$candidate")
    done
    if (( ${#config_files[@]} > 0 )); then
        info "Archiving configuration..."
        tar -czf "$backup_dir/configuration.tar.gz" -C "$SCRIPT_DIR" "${config_files[@]}"
    fi

    if [[ -d "$SCRIPT_DIR/kali-data" ]]; then
        info "Archiving Kali workspaces..."
        tar -czf "$backup_dir/kali-data.tar.gz" -C "$SCRIPT_DIR" kali-data
    fi

    if compose config --services | grep -qx backend && [[ -n "$(compose ps -q backend 2>/dev/null)" ]]; then
        info "Archiving backend workspaces..."
        compose exec -T backend tar -czf - -C /srv/data . > "$backup_dir/backend-data.tar.gz"
    fi

    info "Backup created: $backup_dir"
    warn "The backup contains credentials. Keep it encrypted and do not commit or share it."
}

cmd_help() {
    print_banner
    echo "Usage: $0 [command] [flags]"
    echo
    show_commands
    echo -e " ${BOLD}Flags:${NC}"
    echo -e "   ${CYAN}--quick, -q${NC}   Skip all configuration prompts and use existing config."
    echo -e "                Ideal for subsequent starts after initial setup."
    echo
    echo "Default behavior:"
    echo "  - \`$0\` / \`$0 start\`: guided start with smart prompts (skips already-configured items)"
    echo "  - \`$0 start -q\`: instant start using existing config (no prompts at all)"
    echo "  - Normal mode: guided setup, best for most users"
    echo "  - Developer mode: advanced setup, run frontend/backend manually"
    echo
    echo -e " ${BOLD}Configuration Layers:${NC}"
    echo -e "   ${CYAN}config.toml${NC}    Static settings (server, DB, session, Langfuse)."
    echo -e "                  Changes require a restart."
    echo -e "   ${CYAN}backend/.env${NC}   Dynamic scalar settings (SSH, VNC, Burp, Magnitude)."
    echo -e "   ${CYAN}backend/model-registry.json${NC}   Model presets and assignments."
    echo -e "                  Changes take effect immediately (editable via Settings UI)."
    echo -e "   ${CYAN}frontend/.env${NC}  Frontend build settings (NEXT_PUBLIC_*)."
    echo -e "                  Changes require a frontend rebuild."
    echo
}

# ── Main ──────────────────────────────────────────────────
main() {
    cd "$SCRIPT_DIR"

    # Parse global flags
    local args=()
    for arg in "$@"; do
        case "$arg" in
            --quick|-q) QUICK_MODE=true ;;
            *) args+=("$arg") ;;
        esac
    done
    set -- "${args[@]+"${args[@]}"}"

    print_banner
    show_commands

    case "${1:-start}" in
        start)   cmd_start ;;
        config)  cmd_config ;;
        dev)     cmd_dev ;;
        stop)    cmd_stop ;;
        logs)    shift; cmd_logs "$@" ;;
        status)  cmd_status ;;
        backup)  cmd_backup ;;
        -h|--help|help) cmd_help; return ;;
        *)
            err "Unknown command: $1"
            echo "Run $0 help for usage."
            exit 1
            ;;
    esac
}

main "$@"
