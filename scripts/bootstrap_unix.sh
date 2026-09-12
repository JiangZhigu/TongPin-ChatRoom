#!/bin/sh
# Sourced by install.sh. Keep the bootstrap independent of Python and Bash.

tp_note() { printf '%s\n' "$*" >&2; }
tp_fail() { tp_note "Installation stopped: $*"; return 1; }
tp_has_command() { command -v "$1" >/dev/null 2>&1; }
tp_os_release_file() {
    if [ -f /etc/os-release ]; then printf '%s\n' /etc/os-release
    else printf '%s\n' /usr/lib/os-release; fi
}

tp_detect_platform() {
    TP_OS=$(uname -s) || return
    TP_ARCH=$(uname -m) || return
    TP_ID=unknown
    TP_VERSION=unknown
    TP_LIKE=
    case "$TP_ARCH" in x86_64|amd64|aarch64|arm64) ;;
        *) tp_fail "Unsupported architecture: $TP_ARCH (requires x86_64 or arm64)."; return 1 ;; esac
    case "$TP_OS" in
        Darwin)
            TP_ID=macos
            if tp_has_command sw_vers; then TP_VERSION=$(sw_vers -productVersion); fi
            ;;
        Linux)
            tp_release=$(tp_os_release_file)
            if [ -r "$tp_release" ]; then
                # os-release is data. Never source it or evaluate its contents.
                while IFS='=' read -r tp_key tp_value || [ -n "$tp_key" ]; do
                    case "$tp_key" in ID|ID_LIKE|VERSION_ID) ;; *) continue ;; esac
                    tp_value=${tp_value#\"}; tp_value=${tp_value%\"}
                    tp_value=${tp_value#\'}; tp_value=${tp_value%\'}
                    case "$tp_value" in *[!a-zA-Z0-9._\ -]*)
                        tp_fail "Invalid $tp_key in os-release."; return 1 ;; esac
                    case "$tp_key" in
                        ID) TP_ID=$tp_value ;;
                        ID_LIKE) TP_LIKE=$tp_value ;;
                        VERSION_ID) TP_VERSION=$tp_value ;;
                    esac
                done < "$tp_release"
            fi
            ;;
        *) tp_fail "Unsupported system: $TP_OS. On Windows use install.cmd."; return 1 ;;
    esac
    tp_note "Detected: $TP_OS $TP_ID $TP_VERSION ($TP_ARCH)"
}

tp_find_python() {
    for tp_python in "$TP_ROOT/.venv/bin/python" "${TP_EXTRA_PYTHON:-}" \
        python3.12 python3 python python3.13 python3.14 python3.11 python3.10 python3.9 python3.8 \
        /opt/homebrew/opt/python@3.12/bin/python3.12 \
        /usr/local/opt/python@3.12/bin/python3.12 /opt/local/bin/python3.12; do
        [ -n "$tp_python" ] || continue
        if tp_has_command "$tp_python" && \
            "$tp_python" -c 'import sys,ssl,zipfile; sys.exit(0 if sys.version_info >= (3,8) else 1)' >/dev/null 2>&1; then
            TP_PYTHON=$tp_python
            return 0
        fi
    done
    TP_PYTHON=
    return 1
}

tp_find_brew() {
    for tp_brew in brew /opt/homebrew/bin/brew /usr/local/bin/brew; do
        if tp_has_command "$tp_brew"; then TP_MANAGER=$tp_brew; return 0; fi
    done
    return 1
}

tp_select_manager() {
    TP_FAMILY=
    TP_MANAGER=
    TP_PACKAGE=python3
    if [ "$TP_OS" = Darwin ]; then
        if tp_find_brew; then TP_FAMILY=brew
        elif tp_has_command /opt/local/bin/port; then
            TP_FAMILY=port; TP_MANAGER=/opt/local/bin/port
        else TP_FAMILY=brew-bootstrap; fi
        return 0
    fi
    # Prefer the concrete distribution ID, then its declared parent families.
    for tp_family in "$TP_ID" $TP_LIKE; do
        case "$tp_family" in
            ubuntu|debian|linuxmint|pop|kali|raspbian|neon)
                TP_FAMILY=apt; TP_MANAGER=apt-get; break ;;
            fedora|rhel|centos|rocky|almalinux|ol|amzn)
                TP_FAMILY=rpm
                if tp_has_command dnf; then TP_MANAGER=dnf; else TP_MANAGER=yum; fi
                case "$tp_family:$TP_VERSION" in
                    rhel:8*|centos:8*|rocky:8*|almalinux:8*|ol:8*) TP_PACKAGE=python3.12 ;;
                    rhel:7*|centos:7*|ol:7*)
                        tp_fail 'This older RPM release does not provide a supported bootstrap Python in its normal repositories.'; return 1 ;;
                esac
                break ;;
            arch|manjaro|endeavouros)
                TP_FAMILY=pacman; TP_MANAGER=pacman; TP_PACKAGE=python; break ;;
            opensuse*|suse|sles)
                TP_FAMILY=zypper; TP_MANAGER=zypper; TP_PACKAGE=python311; break ;;
            alpine)
                TP_FAMILY=apk; TP_MANAGER=apk; break ;;
        esac
    done
    if [ -z "$TP_MANAGER" ]; then
        tp_fail "Unknown distribution '$TP_ID'. Install Python 3.8+ manually, then rerun install.sh."; return 1
    fi
    if ! tp_has_command "$TP_MANAGER"; then
        tp_fail "Expected package manager '$TP_MANAGER' is unavailable. Install Python 3.8+ manually."; return 1
    fi
}

tp_privileged() {
    if [ "$(id -u)" = 0 ]; then "$@"
    elif tp_has_command sudo; then sudo "$@"
    elif tp_has_command doas; then doas "$@"
    else tp_fail 'Package installation requires root, sudo or doas. No package command was run.'; fi
}

tp_plan() {
    case "$TP_FAMILY" in
        apt) tp_note 'Plan: apt-get update; apt-get install -y python3 ca-certificates' ;;
        rpm) tp_note "Plan: $TP_MANAGER install -y $TP_PACKAGE ca-certificates" ;;
        pacman) tp_note 'Plan: pacman -S --needed --noconfirm python ca-certificates (no full system upgrade)' ;;
        zypper) tp_note "Plan: zypper --non-interactive install $TP_PACKAGE ca-certificates" ;;
        apk) tp_note 'Plan: apk add --no-cache python3 ca-certificates' ;;
        brew) tp_note "Plan: $TP_MANAGER install python@3.12" ;;
        port) tp_note 'Plan: /opt/local/bin/port install python312' ;;
        brew-bootstrap)
            tp_note 'Plan: install official Homebrew after SHA-256 verification, then brew install python@3.12.'
            tp_note 'Homebrew may require your administrator password and Apple Command Line Tools.' ;;
    esac
}

tp_install_brew() {
    if [ "$(id -u)" = 0 ]; then
        tp_fail 'Homebrew must run as a normal macOS user. Rerun install.sh without sudo.'; return 1
    fi
    for tp_tool in curl shasum mktemp sudo; do
        if ! tp_has_command "$tp_tool"; then
            tp_fail "Homebrew bootstrap requires $tp_tool. See https://docs.brew.sh/Installation"; return 1
        fi
    done
    for tp_directory in "$TP_ROOT/.codex" "$TP_ROOT/.codex/cache" "$TP_ROOT/.codex/cache/installers"; do
        if [ -L "$tp_directory" ]; then tp_fail "Refusing linked installer directory: $tp_directory"; return 1; fi
    done
    mkdir -p "$TP_ROOT/.codex/cache/installers" || return
    tp_installer=$(mktemp "$TP_ROOT/.codex/cache/installers/homebrew.XXXXXX") || return
    tp_url=https://raw.githubusercontent.com/Homebrew/install/8949852f785a3bacaba2a979d0790337950b0a4a/install.sh
    if ! curl --fail --location --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 180 \
        --output "$tp_installer" "$tp_url"; then
        tp_fail 'Homebrew installer download failed. No installer was executed.'; return 1
    fi
    tp_digest=$(shasum -a 256 "$tp_installer") || return
    tp_digest=${tp_digest%% *}
    if [ "$tp_digest" != 25548e1da7930c1563dbbe2cb05834a4131c4da09234540b6fdac812fda3c287 ]; then
        tp_fail 'Homebrew installer SHA-256 mismatch. No installer was executed.'; return 1
    fi
    # Authentication is handled by sudo; never capture a password or retry a cancellation.
    sudo -v || return
    (unset INTERACTIVE; NONINTERACTIVE=1 /bin/bash "$tp_installer") || return
    tp_find_brew || { tp_fail 'Homebrew completed but brew was not found.'; return 1; }
}

tp_install_system_python() {
    tp_plan
    tp_note 'Installing a system bootstrap Python. Package-manager changes may require administrator authentication.'
    case "$TP_FAMILY" in
        apt)
            tp_privileged "$TP_MANAGER" update || return
            tp_privileged "$TP_MANAGER" install -y python3 ca-certificates || return ;;
        rpm) tp_privileged "$TP_MANAGER" install -y "$TP_PACKAGE" ca-certificates || return ;;
        pacman) tp_privileged "$TP_MANAGER" -S --needed --noconfirm python ca-certificates || return ;;
        zypper) tp_privileged "$TP_MANAGER" --non-interactive install "$TP_PACKAGE" ca-certificates || return ;;
        apk) tp_privileged "$TP_MANAGER" add --no-cache python3 ca-certificates || return ;;
        port) tp_privileged "$TP_MANAGER" install python312 || return ;;
        brew|brew-bootstrap)
            if [ "$TP_FAMILY" = brew-bootstrap ]; then tp_install_brew || return; fi
            if [ "$(id -u)" = 0 ]; then tp_fail 'Run the Homebrew installation as a normal macOS user.'; return 1; fi
            "$TP_MANAGER" install python@3.12 || return
            tp_prefix=$("$TP_MANAGER" --prefix python@3.12) || return
            TP_EXTRA_PYTHON=$tp_prefix/bin/python3.12 ;;
    esac
    hash -r 2>/dev/null || :
    if ! tp_find_python; then
        tp_fail 'The package command finished but no working Python 3.8+ with SSL was found. Inspect its output before retrying.'
        return 1
    fi
}

tp_install() {
    tp_dry_run=0
    tp_has_build=0
    for tp_argument in "$@"; do
        case "$tp_argument" in
            --dry-run) tp_dry_run=1 ;;
            --build) tp_has_build=1 ;;
            --dev|--bootstrap-tools|--download-python) ;;
            --help|-h)
                printf '%s\n' 'Usage: sh install.sh [--dry-run] [--dev] [--build]' \
                    'Detects the OS and reuses Python >=3.8, or installs it with the system package manager.' \
                    'Then prepares project Python 3.12.13 and locked dependencies. First installation needs internet.' \
                    '--dry-run prints the plan without downloads or package installation.'
                return 0 ;;
            *) tp_fail "Unknown installer option: $tp_argument"; return 2 ;;
        esac
    done
    if [ ! -f "$TP_ROOT/.python-version" ] || [ ! -f "$TP_ROOT/scripts/bootstrap_runtime.py" ]; then
        tp_fail 'Incomplete release: project version or runtime bootstrap is missing.'; return 1
    fi
    for tp_directory in "$TP_ROOT" "$TP_ROOT/.venv" "$TP_ROOT/.codex" "$TP_ROOT/.codex/cache" \
        "$TP_ROOT/.codex/cache/uv" "$TP_ROOT/.codex/python" "$TP_ROOT/.codex/tools"; do
        tp_ancestor=$tp_directory
        while [ -n "$tp_ancestor" ]; do
            if [ -L "$tp_ancestor" ]; then
                tp_fail "Installation paths cannot traverse a symlink: $tp_ancestor"; return 1
            fi
            tp_parent=${tp_ancestor%/*}
            [ "$tp_parent" != "$tp_ancestor" ] || break
            tp_ancestor=$tp_parent
        done
    done
    if [ "$tp_has_build" = 0 ] && [ ! -f "$TP_ROOT/apps/web/dist/index.html" ]; then
        tp_fail 'Frontend build is missing. Use a prebuilt ZIP, or install.sh --dev --build with Node/npm.'; return 1
    fi
    tp_detect_platform || return
    if tp_find_python; then
        tp_note "Reusing bootstrap Python: $TP_PYTHON"
    else
        tp_select_manager || return
        if [ "$tp_dry_run" = 1 ]; then tp_plan
        else tp_install_system_python || return; fi
    fi
    if [ "$tp_dry_run" = 1 ]; then
        tp_note 'Dry run complete. Project runtime: Python 3.12.13; project .venv and cache; no changes made.'
        return 0
    fi
    "$TP_PYTHON" "$TP_ROOT/scripts/bootstrap_runtime.py" "$@" || return
    tp_note 'Installation complete. See INSTALL-PYTHON.zh-CN.md for account setup and startup.'
}
