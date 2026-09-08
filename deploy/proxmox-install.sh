#!/usr/bin/env bash
# Lagerverwaltung — Proxmox-LXC-Installer
# Auf dem Proxmox-Host ausführen (als root). Legt einen unprivilegierten Debian-LXC an
# und installiert die App. Konfiguration über Environment-Variablen — Defaults siehe unten.
#
# Schnellaufruf (auf dem Proxmox-Host):
#   bash -c "$(wget -qO- https://raw.githubusercontent.com/mgoebel89/SchulLager/master/deploy/proxmox-install.sh)"
#
# Mit Konfiguration:
#   CTID=220 HOSTNAME=schullager BRIDGE=vmbr0 IPV4=dhcp \
#     bash -c "$(wget -qO- https://raw.githubusercontent.com/mgoebel89/SchulLager/master/deploy/proxmox-install.sh)"

set -euo pipefail

# -------- Defaults (per Env überschreibbar) --------
: "${CTID:=}"                              # leer = nächste freie ID
: "${HOSTNAME:=schullager}"
: "${STORAGE:=local-lvm}"                  # Storage für das Container-Volume
: "${TEMPLATE_STORAGE:=local}"             # Storage, in dem die Templates liegen
: "${DISK_GB:=6}"                          # Bestand liegt in Homebox, hier nur DB + Etiketten
: "${MEMORY_MB:=512}"
: "${SWAP_MB:=512}"
: "${CORES:=1}"
: "${BRIDGE:=vmbr0}"
: "${IPV4:=dhcp}"                          # z. B. 192.168.1.60/24  (mit GATEWAY)
: "${GATEWAY:=}"                           # nur bei statischer IP nötig
: "${UNPRIVILEGED:=1}"
: "${PASSWORD:=}"                          # leer = zufälliges Passwort wird gesetzt + ausgegeben
: "${REPO_URL:=https://github.com/mgoebel89/SchulLager.git}"   # öffentliches Repo, kein Token nötig
: "${REPO_BRANCH:=master}"
: "${HTTP_PORT:=80}"                       # leitet nur auf HTTPS um
: "${HTTPS_PORT:=443}"

log()  { printf '\033[1;34m[*]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[✓]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; }

require_root() {
  if [[ $EUID -ne 0 ]]; then err "Bitte als root auf dem Proxmox-Host ausführen."; exit 1; fi
}
require_cmd() { command -v "$1" >/dev/null 2>&1 || { err "Befehl fehlt: $1"; exit 1; }; }

require_root
require_cmd pct
require_cmd pveam

# -------- CTID bestimmen --------
if [[ -z "$CTID" ]]; then
  CTID=$(pvesh get /cluster/nextid)
fi
if pct status "$CTID" >/dev/null 2>&1; then
  err "Container $CTID existiert bereits."
  exit 1
fi

# -------- Template sicherstellen --------
log "Suche Debian-12-Template…"
pveam update >/dev/null
TEMPLATE_NAME=$(pveam available --section system | awk '/debian-12-standard/ {print $2}' | sort -V | tail -n1)
if [[ -z "$TEMPLATE_NAME" ]]; then
  err "Kein debian-12-standard-Template verfügbar."
  exit 1
fi

TEMPLATE_PATH="/var/lib/vz/template/cache/${TEMPLATE_NAME}"
if [[ ! -f "$TEMPLATE_PATH" ]]; then
  log "Lade Template ${TEMPLATE_NAME} (${TEMPLATE_STORAGE})…"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE_NAME"
fi
TEMPLATE_REF="${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE_NAME}"

# -------- Passwort --------
if [[ -z "$PASSWORD" ]]; then
  PASSWORD=$(tr -dc 'A-Za-z0-9!@%_+-' </dev/urandom | head -c 16 || true)
  GENERATED_PW=1
else
  GENERATED_PW=0
fi

# -------- Netzwerk --------
NET_OPTS="name=eth0,bridge=${BRIDGE}"
if [[ "$IPV4" == "dhcp" ]]; then
  NET_OPTS="${NET_OPTS},ip=dhcp"
else
  if [[ -z "$GATEWAY" ]]; then
    err "Bei statischer IPV4 muss GATEWAY gesetzt sein."
    exit 1
  fi
  NET_OPTS="${NET_OPTS},ip=${IPV4},gw=${GATEWAY}"
fi

log "Erzeuge LXC ${CTID} (${HOSTNAME})…"
pct create "$CTID" "$TEMPLATE_REF" \
  --hostname "$HOSTNAME" \
  --cores "$CORES" \
  --memory "$MEMORY_MB" \
  --swap "$SWAP_MB" \
  --rootfs "${STORAGE}:${DISK_GB}" \
  --net0 "$NET_OPTS" \
  --features nesting=1 \
  --unprivileged "$UNPRIVILEGED" \
  --password "$PASSWORD" \
  --onboot 1 \
  --start 0

ok  "Container angelegt."
log "Starte Container…"
pct start "$CTID"

# Warte bis Netz da ist
log "Warte auf Netzwerk im Container…"
for i in {1..30}; do
  if pct exec "$CTID" -- bash -lc 'getent hosts deb.debian.org >/dev/null 2>&1 || ping -c1 -W1 1.1.1.1 >/dev/null 2>&1'; then
    break
  fi
  sleep 1
done

# HTTPS-Redirect braucht den Port nur, wenn er vom Standard abweicht.
if [[ "$HTTPS_PORT" == "443" ]]; then HTTPS_SUFFIX=""; else HTTPS_SUFFIX=":${HTTPS_PORT}"; fi

# -------- Setup im Container --------
# Die eigentliche Einrichtung steckt in container-setup.sh. Sie hier nicht als
# gequotete Zeichenkette zu wiederholen, spart das fehleranfällige Escaping und
# macht sie im Container einzeln wiederholbar (`schullager-setup`).
log "Hole Repository in den Container…"
pct exec "$CTID" -- bash -lc "
  set -euo pipefail
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq git ca-certificates curl >/dev/null
  if [ ! -d /opt/schullager/.git ]; then
    git clone --depth=1 --branch '${REPO_BRANCH}' '${REPO_URL}' /opt/schullager
  fi
"

log "Richte App + Backend im Container ein (das dauert einige Minuten)…"
if ! pct exec "$CTID" -- env \
      REPO_URL="$REPO_URL" REPO_BRANCH="$REPO_BRANCH" \
      HTTP_PORT="$HTTP_PORT" HTTPS_PORT="$HTTPS_PORT" CERT_HOST="$HOSTNAME" \
      bash /opt/schullager/deploy/container-setup.sh; then
  err "Die Einrichtung im Container ist fehlgeschlagen (Meldungen oben)."
  err "Der Container $CTID bleibt bestehen. Nach dem Beheben erneut versuchen mit:"
  err "    pct exec $CTID -- schullager-setup"
  exit 1
fi

# IP ermitteln
CT_IP=$(pct exec "$CTID" -- bash -lc "hostname -I | awk '{print \$1}'" || true)

ok "Fertig."
echo
echo "─────────────────────────────────────────────"
echo "  Container-ID : $CTID"
echo "  Hostname     : $HOSTNAME"
echo "  IP           : ${CT_IP:-(noch nicht verfügbar)}"
echo "  URL          : https://${CT_IP:-<IP>}${HTTPS_SUFFIX}"
if [[ "$GENERATED_PW" -eq 1 ]]; then
  echo "  root-Passwort: $PASSWORD"
fi
echo
echo "  Nächster Schritt — Ersteinrichtung:"
echo "    Die Seite im Browser öffnen. Solange es noch kein Konto gibt, fragt sie"
echo "    nach dem ersten Administrator. Danach ist dieser Weg zu, und weitere"
echo "    Konten legt der Administrator in der App an."
echo "    Anschließend unter Einstellungen → Homebox den Zugang eintragen."
echo
echo "  Hinweis zum Zertifikat:"
echo "    Das Zertifikat ist selbstsigniert — beim ersten Aufruf zeigt der Browser"
echo "    eine Warnung. Einmal bestätigen, danach ist Ruhe. HTTPS ist nötig, damit"
echo "    Barcode-Scan und Kamera-Fotos am Handy überhaupt funktionieren."
echo
echo "  Update später einspielen:"
echo "    • in der Container-Konsole:  update"
echo "    • vom Proxmox-Host:          pct exec $CTID -- bash /opt/schullager/deploy/update.sh"
echo "      (der Kurzbefehl 'update' setzt voraus, dass /usr/local/bin im"
echo "       Suchpfad liegt — über den vollen Pfad geht es immer)"
echo
echo "  Einrichtung wiederholen (falls etwas hakt):"
echo "    pct exec $CTID -- schullager-setup"
echo "─────────────────────────────────────────────"
