#!/usr/bin/env bash
# Sichert die SQLite-Datenbank der Lagerverwaltung (Benutzer, Ausleihen,
# Inventuren, Einstellungen).
# Läuft täglich per cron (siehe proxmox-install.sh) und lässt sich jederzeit
# von Hand aufrufen:  schullager-backup
#
# WICHTIG: Der ARTIKELBESTAND ist hier NICHT drin — der liegt in Homebox und
# wird dort gesichert.
#
# ACHTUNG: Diese Sicherung enthält die an den Komponenten hinterlegten
# GERÄTEPASSWÖRTER im Klartext (so entschieden) — und seit Phase 6 außerdem den
# PAPERLESS-TOKEN und das Homebox-Passwort aus der settings-Tabelle. Die Dateien
# gehören deshalb nicht auf eine offene Freigabe. Diese Sicherung allein stellt also kein Lager wieder her.

set -euo pipefail

DATA_DIR="${DATA_DIR:-/var/lib/schullager}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/schullager}"
KEEP_DAYS="${KEEP_DAYS:-30}"

mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)

# Konsistente DB-Kopie (WAL-sicher) über die SQLite-Backup-API
if [[ -f "$DATA_DIR/data.db" ]]; then
  sqlite3 "$DATA_DIR/data.db" ".backup '$BACKUP_DIR/data-$STAMP.db'"
  gzip -f "$BACKUP_DIR/data-$STAMP.db"
fi

# Fotos/Anhänge
if [[ -d "$DATA_DIR/attachments" ]]; then
  tar -czf "$BACKUP_DIR/attachments-$STAMP.tar.gz" -C "$DATA_DIR" attachments
fi

# Alte Sicherungen aufräumen
find "$BACKUP_DIR" -type f -name '*.gz' -mtime "+$KEEP_DAYS" -delete

echo "Backup abgeschlossen: $BACKUP_DIR (Stand $STAMP)"
