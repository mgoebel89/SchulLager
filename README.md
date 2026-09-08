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

In der **Container-Konsole**:

| Aufgabe | Befehl |
|---|---|
| Aktualisieren | `update` |
| Sicherung sofort | `schullager-backup` |
| Einrichtung wiederholen | `schullager-setup` |
| Protokoll ansehen | `journalctl -u schullager-backend -f` |

Vom **Proxmox-Host** besser über den vollen Pfad — die Kurzbefehle liegen in
`/usr/local/bin`, das bei `pct exec` nicht zwingend im Suchpfad steht:

```bash
pct exec <CTID> -- bash /opt/schullager/deploy/update.sh
pct exec <CTID> -- bash /opt/schullager/deploy/container-setup.sh
```

Die nächtliche Sicherung (3:30 Uhr) legt Datenbank-Kopien unter
`/var/backups/schullager/` ab. **Sie enthält den Artikelbestand nicht** — der
liegt in Homebox und wird dort gesichert.

## Rechte

| | Gast (nicht angemeldet) | Lehrkraft | Administrator |
|---|---|---|---|
| Suchen, Artikel und Lagerort ansehen | ✓ | ✓ | ✓ |
| Buchen, anlegen, umlagern, Nachbestell-Liste | — | ✓ | ✓ |
| Ausleihe und Defektmeldungen sehen und buchen | — | ✓ | ✓ |
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

### Buchen

Entnahme und Rückgabe laufen **relativ** (`delta`), nicht absolut. Das ist
Absicht: stehen zwei Leute gleichzeitig am Regal, addieren sich ihre Buchungen,
statt dass die letzte die erste überschreibt.

Der **Mindestbestand** ist ein benutzerdefiniertes Feld in Homebox. Danach
rechnen kann Homebox nicht — die Nachbestell-Liste geht deshalb serverseitig
einmal durch den Bestand und hält das Ergebnis 60 Sekunden vor. Jeder
Schreibvorgang verwirft diesen Merker, damit eine Entnahme sofort auftaucht.

### Demonstratoren und Verbrauchsmaterial

Die Schule lagert zweierlei, und beides wird anders herausgegeben:

| | erkannt an | Vorgang | Bestand |
|---|---|---|---|
| **Demonstrator** | Homebox-Tag (Vorgabe `Demonstrator`) | **Ausleihe** mit Frist und Rückgabe | bleibt unverändert |
| **Verbrauchsmaterial** | alles ohne diesen Tag | **Ausgabe** an eine Klasse, keine Rückgabe | wird abgebucht |

Der Tag wird **in Homebox** angelegt und dort den Geräten zugewiesen — auch
mehreren auf einmal. Welcher Tag gilt, steht unter Einstellungen → Allgemein.
Bewusst kein eigenes Feld: ein Tag ist in Homebox' Oberfläche sichtbar und
bequem zu vergeben.

Demonstratoren haben einen eigenen Menüpunkt. Dort zählt anderes als in der
Artikelsuche — ob das Gerät da ist und ob es heil ist, nicht wie viele Stück
im Fach liegen.

### Ausleihe

Eine Ausleihe **verändert den Bestand nicht**. Ein Demonstrator, der im
Unterricht steht, gehört weiterhin zum Inventar — er ist nur nicht im Schrank.
Verbrauchsmaterial wird stattdessen *entnommen*, und das senkt den Bestand sehr
wohl. Zwei Wege, zwei Bedeutungen; würden beide am Bestand rechnen, könnte
nach einem halben Jahr niemand mehr sagen, was die Zahl bedeutet.

Ausleihen und Defektmeldungen liegen in der **eigenen Datenbank** — Homebox
kennt keinen Begriff dafür. Wer was hat, ist eine Personenangabe und deshalb
auch zum Lesen nur angemeldet einsehbar. Die Klassenliste wird unter
Einstellungen → Allgemein gepflegt.

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
- [x] **Phase 2 — Buchen:** Entnahme und Rückgabe mit Stückzahl, Bearbeiten,
      Umlagern, Foto an den Artikel, Neuaufnahme per Scan und die
      Nachbestell-Liste.
- [x] **Phase 4 — Ausleihe:** Geräte an Lehrkraft und Klasse, Rückgabedatum mit
      Fristampel, Überfälligkeitsliste, Defektmeldungen.
- [ ] Phase 5 — Inventur
- [ ] Phase 6 — Beschaffung und Dokumente
- [ ] Phase 3 — Etiketten (ans Ende geschoben; braucht die genauen
      Brother-Modelle)

## Hinweise für die Weiterentwicklung

Homebox hat mehrere Eigenheiten, die schon einmal Zeit gekostet haben; sie sind
in `backend/homebox.js` an Ort und Stelle kommentiert. Die wichtigste: **die
Listenantwort ist eine Kurzfassung ohne Feldwerte.** Wer den Treffer eines
Feld-Filters über den Feldwert nachprüft, findet nie etwas — und legt
vorhandene Artikel ein zweites Mal an.
