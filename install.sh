#!/usr/bin/env sh
# Usage: curl -fsSL https://evot.ai/install | sh
#
# POSIX sh compatible — do NOT use bash-specific syntax (e.g. [[ ]], pipefail,
# arrays, process substitution). This script is piped to 'sh' which may be
# dash on Ubuntu/WSL.
set -e

REPO="evotai/evot"
BINARY="evot"
INSTALL_DIR="${EVOT_INSTALL_DIR:-$HOME/.evotai/bin}"

# --- Output style ---
#
# herdr-style installer output: a brand logo header for humans, then green '>'
# step lines, yellow '!' warnings and red '✗' errors. Color stays unconditional
# (the TUI renders ANSI), but the logo is gated on stdout being a terminal:
# `curl | sh` keeps stdout on the tty, while the in-app updater (`/update`)
# captures stdout through a pipe and should get plain step lines only.

BRAND='\033[38;5;147m'  # periwinkle, sampled from the CLI wordmark (#b5bcf9)
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

log()   { printf "  ${GREEN}>${NC} %s\n" "$*"; }
warn()  { printf "  ${YELLOW}!${NC} %s\n" "$*"; }
error() { printf "  ${RED}✗${NC} %s\n" "$*" >&2; exit 1; }

# Same block wordmark as the CLI banner (cli/src/term/banner.ts), so the
# install and the first launch read as the same product.
show_banner() {
  [ -t 1 ] || return 0
  printf "${BRAND}%s${NC}\n" \
    ' ███████╗██╗   ██╗ ██████╗ ████████╗' \
    ' ██╔════╝██║   ██║██╔═══██╗╚══██╔══╝' \
    ' █████╗  ██║   ██║██║   ██║   ██║' \
    ' ██╔══╝  ╚██╗ ██╔╝██║   ██║   ██║' \
    ' ███████╗ ╚████╔╝ ╚██████╔╝   ██║' \
    ' ╚══════╝  ╚═══╝   ╚═════╝    ╚═╝'
  printf '  %s\n' 'evot installer · evot.ai · github.com/evotai/evot'
  echo ""
}

show_banner

# --- Download abstraction (curl with wget fallback) ---

DOWNLOADER=""
if command -v curl > /dev/null 2>&1; then
  DOWNLOADER="curl"
elif command -v wget > /dev/null 2>&1; then
  DOWNLOADER="wget"
else
  error "Either curl or wget is required but neither is installed"
fi

# Retries cover transient network faults. Resume (--continue) avoids restarting
# a multi-megabyte download from zero, but only helps when a partial exists and
# the host honours byte ranges; download_verified falls back to a clean fetch
# when it does not.
DOWNLOAD_ATTEMPTS=3

# Seconds to wait before the first retry; each attempt waits a multiple of it.
#
# Overridable so tests can exercise the retry paths without sleeping real
# seconds: three attempts otherwise cost a fixed 1s + 2s of pure waiting, which
# is most of their runtime and made them flaky against a 5s default timeout.
DOWNLOAD_RETRY_BASE_DELAY="${EVOT_DOWNLOAD_RETRY_BASE_DELAY:-1}"

# Progress reporting for the release asset.
#
# `-s` suppresses curl's transfer meter, so a ~40 MB download printed one line
# and then appeared frozen for however long the transfer took -- no bytes, no
# rate, no ETA, and no way for the user to tell a slow link from a hung one.
#
# The meter is enabled only when stderr is a terminal. Piping the installer into
# a log or a CI job would otherwise accumulate thousands of carriage-returned
# progress lines, so those keep the quiet behaviour. `-S` is retained in both
# cases so a hard error is still reported when the meter is off.
#
# curl's `-#` progress bar is used so the percentage is always visible. The
# same output is forwarded by `evot update`, which keeps direct installs and
# in-app updates visually consistent. wget only shows a meter under `-q` when
# --show-progress is passed, and that flag landed in wget 1.16, so it is probed
# rather than assumed.
if [ -t 2 ] || [ "${EVOT_INSTALL_PROGRESS:-}" = 1 ]; then
  # Use curl's progress-bar mode rather than its verbose transfer meter. It
  # gives both the standalone installer and the in-app updater a compact,
  # percentage-based progress signal that can be redrawn in place.
  CURL_QUIET=""
  CURL_PROGRESS="-#"
  WGET_PROGRESS="--show-progress"
  if [ "$DOWNLOADER" = "wget" ] \
    && ! wget --help 2>&1 | grep -q -- '--show-progress'; then
    WGET_PROGRESS=""
  fi
else
  CURL_QUIET="-s"
  CURL_PROGRESS=""
  WGET_PROGRESS=""
fi

# Abort a transfer that has effectively stopped moving.
#
# --connect-timeout only bounds the connect phase. Reaching the release CDN can
# succeed at TCP+TLS and then deliver nothing, at which point curl has no
# deadline at all and waits indefinitely -- observed as a download sitting for
# well over a minute on a connection whose handshake completed in 0.2s. The
# retry loop below cannot help, because curl never returns.
#
# A floor of 1 KB/s sustained over 20s distinguishes a stalled transfer from a
# merely slow one: a 37 MB asset at that rate would need ~10 hours, so anything
# at or below it is not going to finish. Hitting the floor exits with curl's
# timeout status, which hands the attempt back to download_verified.
STALL_MIN_BYTES_PER_SEC=1024
STALL_WINDOW_SECONDS=20

# curl's exit code for "server won't resume", which is a permanent property of
# that host rather than a transient fault. wget has no distinct code for it, so
# it relies on the attempt-count fallback in download_verified instead.
CURL_NO_RESUME_EXIT=33

# Fetch one URL, once.
#
# Deliberately no in-tool retry (`curl --retry` / `wget --tries`): retry,
# backoff and resume are owned by download_verified, and nesting the two
# multiplies the worst case rather than bounding it. With a per-attempt stall
# limit, an inner retry of 2 turns a 20s bound into 60s, which the outer loop
# then triples again -- 3 minutes of apparent hang on a stalled host. One
# attempt per call keeps the ceiling at DOWNLOAD_ATTEMPTS * the stall window.
download() {
  _url="$1"; _output="$2"; _resume="${3:-yes}"
  if [ "$DOWNLOADER" = "curl" ]; then
    if [ "$_resume" = "yes" ]; then
      curl -fL $CURL_QUIET -S $CURL_PROGRESS --connect-timeout 20 \
        --speed-limit "$STALL_MIN_BYTES_PER_SEC" --speed-time "$STALL_WINDOW_SECONDS" \
        --continue-at - -o "$_output" "$_url"
    else
      curl -fL $CURL_QUIET -S $CURL_PROGRESS --connect-timeout 20 \
        --speed-limit "$STALL_MIN_BYTES_PER_SEC" --speed-time "$STALL_WINDOW_SECONDS" \
        -o "$_output" "$_url"
    fi
  else
    # wget's --timeout already covers reads as well as DNS and connect, so a
    # stalled transfer is bounded without an extra flag. Its progress output
    # follows the same percentage-based convention as curl's `-#` bar.
    if [ "$_resume" = "yes" ]; then
      wget -q $WGET_PROGRESS --tries=1 --timeout="$STALL_WINDOW_SECONDS" \
        --continue -O "$_output" "$_url"
    else
      wget -q $WGET_PROGRESS --tries=1 --timeout="$STALL_WINDOW_SECONDS" \
        -O "$_output" "$_url"
    fi
  fi
}

# Download, verify checksum, and unpack, retried as a unit.
#
# Resume is only attempted when a partial is actually on disk, so a first
# download never pays for it. Three failure modes are distinguished:
#   - server refuses byte ranges: discard the partial, retry without resume
#   - transfer died mid-flight: keep the partial, next attempt resumes it
#   - payload is complete but bad (checksum or extraction): discard it, since
#     resuming corrupt bytes would fail identically forever
download_verified() {
  _url="$1"; _output="$2"; _sha_url="$3"; _extract_to="$4"
  _attempt=1
  while : ; do
    if [ -s "$_output" ]; then _resume=yes; else _resume=no; fi
    # `|| _status=$?` keeps the failure inside a list: a bare call that returns
    # non-zero would abort the whole script under `set -e`.
    _status=0
    download "$_url" "$_output" "$_resume" || _status=$?

    if [ "$_status" -eq 0 ]; then
      # A failed tar can leave valid-looking partial files behind. Recreate the
      # extraction root before every attempt so only the archive that just
      # passed checksum verification can supply the installed artifacts.
      if verify_checksum "$_output" "$_sha_url" \
        && rm -rf "$_extract_to" \
        && mkdir -p "$_extract_to" \
        && tar -xzf "$_output" -C "$_extract_to"; then
        return 0
      fi
      rm -f "$_output"
    elif [ "$_resume" = yes ] && { [ "$_status" -eq "$CURL_NO_RESUME_EXIT" ] || [ "$_attempt" -ge 2 ]; }; then
      # Either the host said it cannot resume, or resume was tried once and did
      # not help. Drop the partial so the next attempt starts clean instead of
      # replaying the same rejection.
      rm -f "$_output"
    fi

    if [ "$_attempt" -ge "$DOWNLOAD_ATTEMPTS" ]; then
      return 1
    fi
    warn "download failed, retrying ($((_attempt + 1))/${DOWNLOAD_ATTEMPTS})..."
    sleep "$(awk "BEGIN{print $_attempt * $DOWNLOAD_RETRY_BASE_DELAY}")"
    _attempt=$((_attempt + 1))
  done
}

# Fetch a small response to stdout (version JSON, checksum).
#
# Unlike download(), this has no outer retry loop wrapping it, so the in-tool
# retry stays. --max-time is safe because the payload is small and bounded, and
# it is what stops a stalled read from hanging the install before the download
# even starts. Worst case is 3 attempts * 20s plus backoff.
fetch() {
  _url="$1"
  if [ "$DOWNLOADER" = "curl" ]; then
    curl -fsSL --retry 2 --retry-delay 1 --connect-timeout 20 --max-time 20 "$_url"
  else
    wget -q --tries=3 --timeout=20 -O- "$_url"
  fi
}

# --- Platform detection ---

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  *)      error "Unsupported OS: $OS" ;;
esac

case "$ARCH" in
  x86_64|amd64)  arch="x86_64" ;;
  aarch64|arm64)  arch="aarch64" ;;
  *)              error "Unsupported architecture: $ARCH" ;;
esac

log "detected ${os}/${arch}"

case "${os}-${arch}" in
  linux-x86_64)
    TARGET="x86_64-unknown-linux-gnu"
    BINDING="evot-napi.linux-x64-gnu.node"
    ;;
  linux-aarch64)
    TARGET="aarch64-unknown-linux-gnu"
    BINDING="evot-napi.linux-arm64-gnu.node"
    ;;
  darwin-x86_64)
    TARGET="x86_64-apple-darwin"
    BINDING="evot-napi.darwin-x64.node"
    ;;
  darwin-aarch64)
    TARGET="aarch64-apple-darwin"
    BINDING="evot-napi.darwin-arm64.node"
    ;;
esac

# --- Version resolution ---
# Prefer auto.evot.ai's proxy: the server has a stable egress IP and can
# attach a token, so it survives GitHub API rate limits that bite anonymous
# curl users. Fall back to the GitHub API directly if the proxy is unreachable.

if [ -n "${EVOT_INSTALL_VERSION:-}" ]; then
  TAG="$EVOT_INSTALL_VERSION"
else
  log "fetching latest version..."
  TAG="$(fetch "https://auto.evot.ai/install/latest" 2>/dev/null || true)"
  case "$TAG" in
    v[0-9]*) ;;
    *)
      TAG="$(fetch "https://api.github.com/repos/${REPO}/releases/latest" \
        | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p')"
      ;;
  esac
fi

[ -z "$TAG" ] && error "Failed to determine latest version. GitHub API rate limit?"
VERSION="${TAG#v}"

ASSET="${BINARY}-v${VERSION}-${TARGET}.tar.gz"
URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"
SHA_URL="${URL}.sha256"

# A pre-staged archive from the CLI's background downloader. The download step
# is skipped, but checksum verification and every other validation still run:
# the file came from the same release CDN, yet it travelled through a second
# process before arriving here.
STAGED_ASSET="${EVOT_INSTALL_ASSET:-}"

# --- Download & verify ---

TMP="$(mktemp -d)"
PACKAGE_DIR="$TMP/package"
BINARY_STAGE=""
BINDING_STAGE=""
BINARY_BACKUP=""
BINDING_BACKUP=""
STATE_STAGE=""
STATE_BACKUP=""
STATE_PATH=""
TRANSACTION_ACTIVE=no
HAD_BINARY=no
HAD_BINDING=no
HAD_STATE=no

# Restore the previous install after any failure that occurs once replacement
# starts. The executable is restored last, so an observable binary always has
# its corresponding binding and bookkeeping in place.
rollback_install() {
  [ "$TRANSACTION_ACTIVE" = yes ] || return 0

  if [ "$HAD_BINDING" = yes ] && [ -f "$BINDING_BACKUP" ]; then
    mv -f "$BINDING_BACKUP" "$LIB_DIR/$BINDING" || true
    BINDING_BACKUP=""
  else
    rm -f "$LIB_DIR/$BINDING" || true
  fi

  if [ "$HAD_STATE" = yes ] && [ -f "$STATE_BACKUP" ]; then
    mv -f "$STATE_BACKUP" "$STATE_PATH" || true
    STATE_BACKUP=""
  else
    [ -z "$STATE_PATH" ] || rm -f "$STATE_PATH" || true
  fi

  if [ "$HAD_BINARY" = yes ] && [ -f "$BINARY_BACKUP" ]; then
    mv -f "$BINARY_BACKUP" "$INSTALL_DIR/$BINARY" || true
    BINARY_BACKUP=""
  else
    rm -f "$INSTALL_DIR/$BINARY" || true
  fi

  TRANSACTION_ACTIVE=no
}

cleanup() {
  rollback_install
  rm -rf "$TMP"
  [ -z "$BINARY_STAGE" ] || rm -f "$BINARY_STAGE"
  [ -z "$BINDING_STAGE" ] || rm -f "$BINDING_STAGE"
  [ -z "$BINARY_BACKUP" ] || rm -f "$BINARY_BACKUP"
  [ -z "$BINDING_BACKUP" ] || rm -f "$BINDING_BACKUP"
  [ -z "$STATE_STAGE" ] || rm -f "$STATE_STAGE"
  [ -z "$STATE_BACKUP" ] || rm -f "$STATE_BACKUP"
}
trap cleanup 0
trap 'exit 1' HUP INT TERM

# SHA256 verification (best-effort: skip if .sha256 file not published, which
# is the case for releases cut before checksums were added).
verify_checksum() {
  _file="$1"; _sha_url="$2"
  _expected="$(fetch "$_sha_url" 2>/dev/null || true)"
  [ -n "$_expected" ] || return 0
  _expected="$(echo "$_expected" | awk '{print $1}')"

  if command -v sha256sum > /dev/null 2>&1; then
    _actual="$(sha256sum "$_file" | awk '{print $1}')"
  elif command -v shasum > /dev/null 2>&1; then
    _actual="$(shasum -a 256 "$_file" | awk '{print $1}')"
  else
    return 0
  fi

  if [ "$_actual" != "$_expected" ]; then
    warn "checksum mismatch (expected $_expected, got $_actual)"
    return 1
  fi
  log "checksum verified"
}

# Checksum verification against a local sidecar instead of a fetched one.
# A missing sidecar is still tolerated (older releases published none), but a
# present sidecar that disagrees is fatal.
verify_checksum_from_file() {
  _file="$1"; _sha_path="$2"
  [ -s "$_sha_path" ] || return 0
  _expected="$(awk '{print $1}' "$_sha_path")"
  [ -n "$_expected" ] || return 0

  if command -v sha256sum > /dev/null 2>&1; then
    _actual="$(sha256sum "$_file" | awk '{print $1}')"
  elif command -v shasum > /dev/null 2>&1; then
    _actual="$(shasum -a 256 "$_file" | awk '{print $1}')"
  else
    return 0
  fi

  if [ "$_actual" != "$_expected" ]; then
    warn "checksum mismatch for staged archive (expected $_expected, got $_actual)"
    return 1
  fi
  log "checksum verified"
}

# Install from a staged archive when one was provided, otherwise download.
#
# The staged path still verifies the checksum — against the sidecar file that
# travelled with the archive rather than a fresh fetch of SHA_URL, since the
# point of staging is to skip the network. Any other failure (bad tar, missing
# binary) falls through to a normal download so the install can still succeed.
if [ -n "$STAGED_ASSET" ] && [ -f "$STAGED_ASSET" ]; then
  STAGED_SHA="$STAGED_ASSET.sha256"
  cp -f "$STAGED_ASSET" "$TMP/$ASSET"
  if verify_checksum_from_file "$TMP/$ASSET" "$STAGED_SHA" \
    && rm -rf "$PACKAGE_DIR" \
    && mkdir -p "$PACKAGE_DIR" \
    && tar -xzf "$TMP/$ASSET" -C "$PACKAGE_DIR"; then
    log "using pre-downloaded ${ASSET}"
  else
    warn "staged archive failed verification; downloading instead"
    rm -rf "$PACKAGE_DIR"
    rm -f "$TMP/$ASSET"
    STAGED_ASSET=""
  fi
fi

if [ -z "$STAGED_ASSET" ]; then
  log "downloading v${VERSION}..."
  download_verified "$URL" "$TMP/$ASSET" "$SHA_URL" "$PACKAGE_DIR" \
    || error "Failed to download and verify ${ASSET} after ${DOWNLOAD_ATTEMPTS} attempts"
fi

# --- Validate package ---

[ -f "$PACKAGE_DIR/bin/$BINARY" ] || error "Release archive does not contain bin/$BINARY"
[ -f "$PACKAGE_DIR/lib/$BINDING" ] || error "Release archive does not contain lib/$BINDING for $TARGET"
chmod +x "$PACKAGE_DIR/bin/$BINARY"

# Clear download attributes before the candidate is executed. The signature
# itself is refreshed later, in place at the destination — see the re-sign step
# after the artifacts are moved.
if [ "$os" = "darwin" ]; then
  xattr -cr "$PACKAGE_DIR/bin/$BINARY" 2>/dev/null || true
  if [ -d "$PACKAGE_DIR/lib" ]; then
    xattr -cr "$PACKAGE_DIR/lib" 2>/dev/null || true
  fi
fi

CANDIDATE_VERSION="$(EVOT_HOME="$PACKAGE_DIR" "$PACKAGE_DIR/bin/$BINARY" --version 2>&1)" \
  || error "Downloaded evot failed to start: $CANDIDATE_VERSION"
[ "$CANDIDATE_VERSION" = "evot v$VERSION" ] \
  || error "Downloaded version mismatch (expected evot v$VERSION, got $CANDIDATE_VERSION)"

# Stage-only API marker checked by hosts before executing an old release script.
# EVOT_INSTALLER_STAGE_API=1

# Stage-only uses the identical download, checksum and candidate validation
# path above, but never touches the live installation.
if [ -n "${EVOT_STAGE_DIR:-}" ]; then
  mkdir -p "$EVOT_STAGE_DIR"
  cp "$TMP/$ASSET" "$EVOT_STAGE_DIR/.$ASSET.new.$$"
  mv -f "$EVOT_STAGE_DIR/.$ASSET.new.$$" "$EVOT_STAGE_DIR/$ASSET"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$EVOT_STAGE_DIR/$ASSET" > "$EVOT_STAGE_DIR/$ASSET.sha256"
  else
    shasum -a 256 "$EVOT_STAGE_DIR/$ASSET" > "$EVOT_STAGE_DIR/$ASSET.sha256"
  fi
  log "staged v$VERSION"
  exit 0
fi

# --- Install ---

mkdir -p "$INSTALL_DIR"
case "$(basename "$INSTALL_DIR")" in
  bin) EVOT_HOME_DIR="$(dirname "$INSTALL_DIR")" ;;
  *)   EVOT_HOME_DIR="$INSTALL_DIR" ;;
esac
LIB_DIR="$EVOT_HOME_DIR/lib"
mkdir -p "$LIB_DIR"

# Stage the exact target pair and its bookkeeping on their destination
# filesystems. A release archive may contain other support files, but only the
# binding selected by the runtime loader is version-coupled to this executable.
BINARY_STAGE="$INSTALL_DIR/.evot.new.$$"
BINDING_STAGE="$LIB_DIR/.${BINDING}.new.$$"
BINARY_BACKUP="$INSTALL_DIR/.evot.old.$$"
BINDING_BACKUP="$LIB_DIR/.${BINDING}.old.$$"
STATE_PATH="$EVOT_HOME_DIR/install-state.json"
STATE_STAGE="$EVOT_HOME_DIR/.install-state.json.$$"
STATE_BACKUP="$EVOT_HOME_DIR/.install-state.old.$$"
cp "$PACKAGE_DIR/bin/$BINARY" "$BINARY_STAGE"
cp "$PACKAGE_DIR/lib/$BINDING" "$BINDING_STAGE"
chmod +x "$BINARY_STAGE"
cat > "$STATE_STAGE" <<EOF
{
  "version": "$VERSION",
  "target": "$TARGET",
  "lib": ["$BINDING"],
  "installed_at": $(date -u +%s)000
}
EOF

if [ "$os" = "darwin" ]; then
  xattr -cr "$BINARY_STAGE" 2>/dev/null || true
  xattr -cr "$BINDING_STAGE" 2>/dev/null || true
  codesign --verify --strict "$BINARY_STAGE" >/dev/null 2>&1 \
    || error "Downloaded evot has an invalid macOS signature"
  codesign --verify --strict "$BINDING_STAGE" >/dev/null 2>&1 \
    || error "Downloaded $BINDING has an invalid macOS signature"
fi

# Copy backups before replacing any artifact. If backup creation fails, the
# installed set is still untouched. Once replacement begins, the EXIT trap
# restores all three files on every error path, including failed startup or
# metadata commit.
if [ -f "$INSTALL_DIR/$BINARY" ]; then
  cp -p "$INSTALL_DIR/$BINARY" "$BINARY_BACKUP"
  HAD_BINARY=yes
fi
if [ -f "$LIB_DIR/$BINDING" ]; then
  cp -p "$LIB_DIR/$BINDING" "$BINDING_BACKUP"
  HAD_BINDING=yes
fi
if [ -f "$STATE_PATH" ]; then
  cp -p "$STATE_PATH" "$STATE_BACKUP"
  HAD_STATE=yes
fi

TRANSACTION_ACTIVE=yes
mv -f "$BINDING_STAGE" "$LIB_DIR/$BINDING"
BINDING_STAGE=""
mv -f "$BINARY_STAGE" "$INSTALL_DIR/$BINARY"
BINARY_STAGE=""

# Re-sign at the destination, after the renames.
#
# macOS caches a code-signature blob per path and keys its validity to the
# file's mtime. When a path has already hosted a differently-signed build --
# `make install` then `curl | sh`, or any two releases -- the cached blob can
# outlive the file it described. The kernel then compares the stale blob
# against the new bytes, finds cs_mtime != mtime, marks the mapped page
# tainted, and SIGKILLs the process on its first page fault. The victim is
# usually the .node binding, because it is mapped after the executable has
# already started, which is why this surfaced as a working `--version` during
# install and an instant `Killed: 9` afterwards.
#
# Signing the staged copies cannot prevent this: a stage is a different path,
# so it never refreshes the cache entry for the destination. Only signing the
# final path does, which is why this runs here and not before the renames.
if [ "$os" = "darwin" ]; then
  codesign --force --sign - "$LIB_DIR/$BINDING" >/dev/null 2>&1 \
    || error "Failed to sign $BINDING"
  codesign --force --sign - "$INSTALL_DIR/$BINARY" >/dev/null 2>&1 \
    || error "Failed to sign $BINARY"
  codesign --verify --strict "$LIB_DIR/$BINDING" >/dev/null 2>&1 \
    || error "Installed $BINDING has an invalid macOS signature"
  codesign --verify --strict "$INSTALL_DIR/$BINARY" >/dev/null 2>&1 \
    || error "Installed $BINARY has an invalid macOS signature"
fi

INSTALLED_VERSION="$(EVOT_HOME="$EVOT_HOME_DIR" "$INSTALL_DIR/$BINARY" --version 2>&1)" \
  || error "Installed evot failed to start: $INSTALLED_VERSION"
[ "$INSTALLED_VERSION" = "evot v$VERSION" ] \
  || error "Installed version mismatch (expected evot v$VERSION, got $INSTALLED_VERSION)"

# Commit bookkeeping only after the new pair proves runnable. A failed rename
# remains inside the rollback window and restores the previous complete set.
mv -f "$STATE_STAGE" "$STATE_PATH"
STATE_STAGE=""

TRANSACTION_ACTIVE=no
rm -f "$BINARY_BACKUP" "$BINDING_BACKUP" "$STATE_BACKUP"
BINARY_BACKUP=""
BINDING_BACKUP=""
STATE_BACKUP=""

log "installed ${BINARY} to ${INSTALL_DIR}/${BINARY}"

# --- PATH setup ---
# A child process cannot change the calling terminal's PATH. Persist the
# setting for future shells and print the exact command for the current one.
# EVOT_NO_MODIFY_PATH=1 leaves shell configuration under the caller's control.

add_path_to_profile() {
  if grep -Fqx -- "$PATH_LINE" "$1" 2>/dev/null; then
    return 0
  fi
  if (mkdir -p "$(dirname "$1")" && printf '\n# evot\n%s\n' "$PATH_LINE" >> "$1"); then
    log "configured PATH in $1"
  else
    warn "could not configure $1; add the command below manually"
    return 1
  fi
}

case ":$PATH:" in
  *":$INSTALL_DIR:"*)
    # Ready only when the shell will actually run the binary just written.
    # `command -v` could otherwise find an older evot elsewhere on PATH and
    # promise a 'ready' that starts the previous install.
    echo ""
    log "ready. run 'evot' to get started."
    echo ""
    ;;
  *)
    SHELL_NAME="$(basename "${SHELL:-/bin/sh}")"
    # Single-quote literal paths, including spaces, dollar signs and quotes.
    QUOTED_INSTALL_DIR="'$(printf '%s' "$INSTALL_DIR" | sed "s/'/'\\\\''/g")'"
    PATH_LINE="export PATH=$QUOTED_INSTALL_DIR:\"\$PATH\""
    case "$SHELL_NAME" in
      zsh)  RC="${ZDOTDIR:-$HOME}/.zshrc" ;;
      bash) RC="$HOME/.bashrc" ;;
      fish)
        RC="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/evot.fish"
        # Unlike POSIX sh, fish interprets escaped backslashes in single quotes.
        QUOTED_INSTALL_DIR="'$(printf '%s' "$INSTALL_DIR" | sed 's/\\/\\\\/g' | sed "s/'/'\\\\''/g")'"
        PATH_LINE="contains -- $QUOTED_INSTALL_DIR \$PATH; or set -gx PATH $QUOTED_INSTALL_DIR \$PATH"
        ;;
      *) RC="$HOME/.profile" ;;
    esac

    echo ""
    PATH_CONFIGURED=no
    if [ "${EVOT_NO_MODIFY_PATH:-0}" = 1 ]; then
      warn "skipped shell configuration (EVOT_NO_MODIFY_PATH=1)"
    elif add_path_to_profile "$RC"; then
      PATH_CONFIGURED=yes
      # Login bash reads the first existing login profile, not .bashrc.
      if [ "$SHELL_NAME" = bash ]; then
        LOGIN_RC="$HOME/.profile"
        for PROFILE in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
          if [ -f "$PROFILE" ]; then
            LOGIN_RC="$PROFILE"
            break
          fi
        done
        if ! add_path_to_profile "$LOGIN_RC"; then
          RC="$LOGIN_RC"
          PATH_CONFIGURED=no
        fi
      fi
    fi

    if [ "$PATH_CONFIGURED" = yes ]; then
      log "open a new terminal, or run this command in the current terminal:"
    else
      warn "${INSTALL_DIR} is not in your PATH"
      printf '  Add this command to %s and run it in the current terminal:\n' "$RC"
    fi
    printf '\n    %s\n\n' "$PATH_LINE"
    printf '  Then log in:\n\n    evot login\n\n'
    ;;
esac
