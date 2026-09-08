# SchulLager — Lagerverwaltung der David-Roentgen-Schule

Lagerverwaltung für Baukomponenten und Schuldemonstratoren, als LXC-Container
für Proxmox. Gescannt und gebucht wird mit dem Handy oder Tablet — ein
Handscanner wird nicht gebraucht.

**Der Bestand liegt in Homebox.** Diese App ist eine Bedienoberfläche darauf und
legt bewusst keine eigene Kopie der Artikel an: der vorhandene Schulbestand
bleibt unangetastet, und die Homebox-Oberfläche bleibt parallel nutzbar. In der
eigenen Datenbank steht nur, was Homebox nicht kann — Benutzer, Ausleihen,
Defektmeldungen, Inventurläufe und Einstellungen.

## Installation

Auf dem **Proxmox-Host** als root:

```bash
bash -c "$(wget -qO- https://raw.githubusercontent.com/mgoebel89/SchulLager/master/deploy/proxmox-install.sh)"
```

Mit eigener Konfiguration:

```bash
CTID=230 HOSTNAME=schullager BRIDGE=vmbr0 IPV4=dhcp bash -c "$(wget -qO- https://raw.githubusercontent.com/mgoebel89/SchulLager/master/deploy/proxmox-install.sh)"
```

Das Skript legt einen unprivilegierten Debian-12-Container an, installiert
Node 20, nginx mit selbstsigniertem TLS und den Backend-Dienst.

**HTTPS ist Pflicht, nicht Kür:** die Handykamera arbeitet im Browser nur in
einem „secure context". Über `http://<IP>` bliebe der Scanner stumm. Das
selbstsignierte Zertifikat muss man je Gerät einmal bestätigen; ein richtiges
Zertifikat lässt sich später unter `/etc/ssl/schullager/` hinterlegen.

### Erste Schritte nach der Installation

1. Die Seite im Browser öffnen. Solange es kein Konto gibt, zeigt sie die
   **Ersteinrichtung** und legt den ersten Administrator an. Danach ist dieser
   Weg geschlossen.
2. **Einstellungen → Homebox**: Adresse, Benutzername und Passwort eintragen,
   Verbindung prüfen, gegebenenfalls die richtige **Sammlung** wählen.
3. **Benutzer**: Konten fürs Kollegium anlegen. Jedes bekommt ein Startpasswort,
   das beim ersten Anmelden geändert werden muss.

## Betrieb

| Aufgabe | Befehl (im Container oder per `pct exec <CTID> --`) |
|---|---|
| Aktualisieren | `update` |
| Sicherung sofort | `schullager-backup` |
| Einrichtung wiederholen | `schullager-setup` |
| Protokoll ansehen | `journalctl -u schullager-backend -f` |

Die nächtliche Sicherung (3:30 Uhr) legt Datenbank-Kopien unter
`/var/backups/schullager/` ab. **Sie enthält den Artikelbestand nicht** — der
liegt in Homebox und wird dort gesichert.

## Rechte

| | Gast (nicht angemeldet) | Lehrkraft | Administrator |
|---|---|---|---|
| Suchen, Artikel und Lagerort ansehen | ✓ | ✓ | ✓ |
| Buchen, anlegen, ausleihen, Etiketten | — | ✓ | ✓ |
| Benutzer, Homebox-Zugang, Einstellungen | — | — | ✓ |

Lesen ohne Anmeldung ist Absicht: wer den QR-Code an einem Gerät scannt, soll
sofort sehen, was es ist und wo es hingehört. Jede Buchung verlangt eine
Anmeldung. Die Rechte werden im Backend durchgesetzt; die Oberfläche blendet
lediglich aus, was ohnehin abgewiesen würde.

## Aufbau

```
deploy/     Installer, Container-Einrichtung, Update, Backup, nginx, systemd
backend/    Node/Express + SQLite
  db.js         eigene Daten (Benutzer, Ausleihen, Inventuren, Einstellungen)
  auth.js       Passwörter (scrypt), Sitzungen, Rollen
  homebox.js    Homebox-Client — hier steckt das meiste Fachwissen
  routes/       auth, benutzer, lager
app/        Vanilla-JS-Frontend, Namensraum `SL`
  src/models.js   u. a. `codeArt` — deutet gescannte Zeichenketten
  src/ui/scanner.js  Kamera-Scanner (nativ + ZXing)
  vendor/         ZXing als fertige Datei; der Container braucht kein Internet
```

### Was sich scannen lässt

| Sorte | Beispiel | Wirkung |
|---|---|---|
| Handelsbarcode | `4001234567890` | Artikel über das Homebox-Feld `Barcode` |
| Eigenes Artikel-Etikett | `A-1042` oder `https://…/#/a/A-1042` | Artikel über das Feld `Code` |
| Eigenes Ort-Etikett | `O-17` oder `https://…/#/o/O-17` | Lagerort mit Inhalt |
| Homebox-Etikett | Adresse mit Artikel-UUID | Artikel direkt |

Beim eigenen Etikett wird der **Host bewusst nicht geprüft**: die Schule
erreicht denselben Container mal über die IP, mal über einen Namen — ein
Hostvergleich würde eigene Etiketten verwerfen.

Stack und Designsprache folgen den Schwesterprojekten *Gemeindeverwaltung* und
*ImkereiApp*, damit sich die Anwendungen gleich anfühlen und Bausteine
wandern können.

## Ausbaustand

- [x] **Phase 0 — Fundament:** Installer, HTTPS, Benutzerverwaltung mit Rollen,
      erzwungener Passwortwechsel, Gast-Lesezugang, Homebox-Anbindung mit
      Sammlungsauswahl.
- [x] **Phase 1 — Suchen und Scannen:** Artikelsuche mit Lagerortfilter,
      Artikeldetail, Lagerortbaum, Kamera-Scanner (BarcodeDetector mit
      ZXing-Rückfall für iOS) und die QR-Kurzwege `#/a/<Kennung>` und
      `#/o/<Kennung>`.
- [ ] Phase 2 — Buchen (Entnahme/Rückgabe, Mindestbestand, Neuaufnahme per Scan)
- [ ] Phase 3 — Etiketten (drei Größen, PDF und Direktdruck auf Brother-Geräte)
- [ ] Phase 4 — Ausleihe (Person und Klasse, Rückgabedatum, Defektmeldung)
- [ ] Phase 5 — Inventur
- [ ] Phase 6 — Beschaffung und Dokumente

## Hinweise für die Weiterentwicklung

Homebox hat mehrere Eigenheiten, die schon einmal Zeit gekostet haben; sie sind
in `backend/homebox.js` an Ort und Stelle kommentiert. Die wichtigste: **die
Listenantwort ist eine Kurzfassung ohne Feldwerte.** Wer den Treffer eines
Feld-Filters über den Feldwert nachprüft, findet nie etwas — und legt
vorhandene Artikel ein zweites Mal an.
