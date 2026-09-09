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

### Geräte: Demonstratoren und einzelne Netzgeräte

Ausleihbar sind **Geräte**, erkannt an einem von zwei Homebox-Tags:

| | Tag (Vorgabe) | typisch |
|---|---|---|
| **Demonstrator** | `Demonstrator` | Trainer aus mehreren Komponenten |
| **Netzgerät** | `Netzgerät` | einzelnes SPS-Board, das nur im Netz hängt |

Beide sind eigene Artikel in Homebox, stehen in einem Raum, sind ausleihbar und
können Netzangaben tragen. Der Unterschied ist die Einordnung — ein nacktes
SPS-Board ist kein Demonstrator. Der Menüpunkt **Geräte** zeigt beide, oben
umschaltbar. Beim Anlegen eines Netzgeräts öffnet sich direkt die Eingabe der
Netzangaben.

### Inventur

Gezählt wird ein Lagerort nach dem anderen: Sollbestand steht da, „stimmt" ist
ein Griff, eine abweichende Zahl kostet zwei. Artikel lassen sich auch scannen
und einzeln zählen.

**Zählen verändert den Bestand nicht.** Erst der ausdrückliche Schritt
*Bestände übernehmen* schreibt nach Homebox — und dann **absolut**, denn genau
dafür ist eine Inventur da. So kann man in Ruhe zählen, Abweichungen klären und
erst danach buchen.

Der **Sollbestand wird beim ersten Anzeigen mitgeschrieben**. Sonst verschöbe
sich das Ziel während des Zählens: bucht jemand am anderen Ende der Schule eine
Entnahme, stimmte plötzlich die abgehakte Position nicht mehr, und niemand
könnte sagen, warum.

Es kann immer nur **eine** Inventur offen sein — sonst zählen zwei Leute
dasselbe Regal in verschiedene Läufe.

### CSV-Import für Komponenten

Unter *Netzübersicht → CSV-Import*: Beispieldatei herunterladen, ausfüllen,
einlesen. Semikolon und Komma werden beide erkannt, ebenso die von Excel
geschriebene Bytemarke. Vor dem Schreiben zeigt eine **Vorschau** die
Spaltenzuordnung — eine verrutschte Spalte fällt so auf, bevor achtzig
Datensätze in der Datenbank stehen. Das Gerät wird über Bezeichnung oder
Kennung (`A-…`) gefunden; bei zwei gleichnamigen Geräten verlangt der Import
die Kennung, statt zu raten.

### Netzangaben und Komponenten (Profinet)

Bei einem Demonstrator beschreiben die Einträge seine Einbauten, bei einem
Netzgerät das Gerät selbst. Erfasst werden
**Profinet-Gerätename (NameOfStation)**, IP, Subnetz, MAC, Hersteller,
Bestellnummer, Seriennummer, UUID, Firmware und Steckplatz.

Der Gerätename steht bewusst an erster Stelle: In Profinet ist **nicht die IP**
der führende Bezeichner, sondern der DCP-Name — über ihn findet die Steuerung
das Gerät, und beim Gerätetausch ist genau er neu zu vergeben.

Die **Netzübersicht** listet alle Netzgeräte nach IP und meldet doppelt
vergebene IPs, MACs und Gerätenamen. Beim Speichern wird ebenfalls gewarnt,
aber nicht blockiert: manchmal ist die Dopplung gewollt, manchmal ist sie genau
der Fehler, den man sucht. MAC-Adressen werden vor dem Vergleich vereinheitlicht
(`00-1B-…`, `001b…` und `00:1b:…` sind dasselbe Gerät).

### Wartung

Der Menüpunkt **Wartung** listet alle offenen Defektmeldungen — **die älteste
zuoberst**, denn das ist die, die vergessen wurde. Von dort aus wird auch
repariert gemeldet, mit optionaler Notiz, was gemacht wurde. Beim nächsten
Ausfall desselben Geräts ist genau das die Frage.

Die Karte **„Häufig defekt"** zeigt Geräte mit mindestens drei Meldungen in den
letzten zwölf Monaten. Diese Frage beantwortet keine Einzelmeldung, sondern nur
die Zusammenschau — und sie entscheidet zwischen Reparatur und Ersatz.

Ist ein defektes Gerät gerade verliehen, steht das an der Meldung: Das ist der
Fall, in dem man zum Hörer greift.

**Defekt-Historie:** Behobene Meldungen verschwinden nicht, sondern bleiben am
Gerät stehen — mit dem, was repariert wurde.

> **Gerätepasswörter werden im Klartext gespeichert** (so entschieden). Sie sind
> nur angemeldet sichtbar und in der Oberfläche maskiert — aber **jede nächtliche
> Sicherung enthält sie lesbar**. Die Sicherungsdateien gehören deshalb nicht auf
> eine offene Freigabe.

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

### Beschaffung: bestellen, prüfen, einlagern

Der Weg einer Lieferung durch die App:

1. **Bestellen.** Unter *Bestellungen → + Neue Bestellung* Lieferant, Datum und
   Bestellnummer eintragen. Positionen kommen aus dem Bestand, aus der
   Nachbestell-Liste (Menge bis zum Mindestbestand vorbelegt) oder als **freie
   Position** — etwas, das es im Lager noch nicht gibt. Für die Verwaltung
   fällt eine *Bestellanforderung als PDF* ab.

   Ob die erfassten Preise **netto oder brutto** sind, entscheidet jede
   Bestellung für sich — der eine Lieferant weist es so aus, der andere anders.
   Die App zeigt deshalb **jede Summe mit beiden Werten** und schreibt an keine
   Zahl nur „€".

1a. **Angebote und die 3000-€-Grenze.** Ab einem Bestellwert von 3000 € **brutto**
   verlangt die Schule drei Vergleichsangebote (Schwelle, Anzahl und
   Steuersatz stehen in *Einstellungen → Allgemein*). Die holt man **vor** der
   Bestellung ein, deshalb kann ein Vorgang als **Anfrage** beginnen: Positionen
   stehen fest, der Lieferant nicht.

   Zu jedem Angebot werden Lieferant, Summe (netto oder brutto), Nummer und
   Datum erfasst; das Angebots-PDF geht nach Paperless. Die App rechnet alle
   Angebote auf brutto um, kennzeichnet das **günstigste** und sagt, wie viele
   noch fehlen. **Beauftragen** macht aus der Anfrage die Bestellung und setzt
   den Lieferanten aus dem gewählten Angebot. Wird nicht das günstigste
   beauftragt, verlangt die App eine **Begründung** — genau danach fragt die
   Verwaltung später, und im Nachhinein weiß es niemand mehr.

   Gewarnt wird, blockiert nicht: es gibt begründete Ausnahmen (Alleinanbieter,
   Ersatzteil zum vorhandenen Gerät), die eine Software nicht kennen kann. Die
   Bestellanforderung führt die Angebote mit auf, samt Hinweis, wenn welche
   fehlen.

   **Achtung, der Grenzfall:** 2.994 € netto liegen *unter* 3000 — brutto sind
   es 3.562,86 € und damit *darüber*. Genau deshalb rechnet die Prüfung immer
   am Bruttowert.

2. **Wareneingang.** Lieferschein daneben, Bestellung öffnen, *Wareneingang*.
   Die bestellten Positionen sind die führende Liste; ein Scan zählt die
   passende Zeile hoch. Gescannt wird **auf zwei Wegen**: mit der Kamera wie im
   übrigen Lager, oder über das Eingabefeld, in das ein USB-Handscanner wie
   eine Tastatur hineintippt (Abschluss mit Enter). Mengen lassen sich auch
   direkt eintragen — bei hundert Widerständen scannt niemand hundertmal.

   * **Unbekannter Code** → die App fragt, zu welcher Position er gehört, und
     merkt ihn am Artikel. Beim nächsten Mal wird er sofort erkannt; das Lager
     lernt sich beim Arbeiten selbst ein.
   * **Freie Position** → *Artikel …* ordnet einen vorhandenen Artikel zu oder
     legt den neuen gleich hier an (mit Bestand 0; die gelieferte Menge bucht
     unmittelbar danach der Wareneingang).
   * **Kein Lagerort hinterlegt** → wird sofort gefragt, sobald die Zeile das
     erste Mal hochgeht — egal ob durch Scan oder durch Tippen.
   * Teillieferung und Überlieferung werden eingetragen, nicht verboten.

   Gebucht wird **relativ**, wie überall in dieser App.

3. **Einlagern.** Direkt nach dem Buchen öffnet sich die Liste, **nach Raum →
   Schrank → Fach gruppiert**: einmal den Weg abgehen und abhaken. Positionen
   ohne Lagerort stehen am Ende und lassen sich von dort aus zuweisen.

4. **Belege.** Lieferschein abfotografieren oder Rechnungs-PDF wählen — beides
   geht nach **Paperless** und wird am Vorgang vermerkt. Paperless verarbeitet
   den Upload asynchron (OCR); bis die Dokumentnummer feststeht, steht am Beleg
   „wird verarbeitet…". Die App trägt sie beim nächsten Öffnen nach.

5. **Rechnung.** Wochen später: Rechnungsnummer, Datum und Einzelpreise
   nachtragen. Auf Wunsch wandern Kaufpreis, Kaufdatum und Lieferant an die
   Artikel in Homebox. **Der Preis der Position bleibt, wo er ist** — eine
   Abrechnung vom Mai darf sich nicht ändern, weil im Oktober teurer
   nachgekauft wurde.

Rücksendungen und Reklamationen sind bewusst kein eigener Zustand, sondern eine
Bemerkung am Vorgang: ein seltener Fall braucht keinen Apparat.

### Paperless einrichten

*Einstellungen → Paperless.* Adresse der Instanz und ein API-Token (in Paperless
unter „Mein Profil"). Anders als im Unterrichtstool gilt der Zugang für die
**ganze Schule** und nicht je Lehrkraft — das Lager hat ein Paperless.

Danach lassen sich **Upload-Tag**, **Ablagepfad** und die Dokumenttypen für
Lieferschein und Rechnung aus den in Paperless vorhandenen Listen wählen. Jeder
Beleg aus dieser App bekommt Tag und Pfad automatisch, damit die Lagerbelege
dort auffindbar bleiben. Die App legt in Paperless nichts an und löscht dort
nichts: Löst man eine Verknüpfung, bleibt das Dokument erhalten.

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
- [x] **Erweiterungen aus dem Betrieb:** Demonstratoren und Lagerorte aus der
      Weboberfläche anlegen, Hersteller-Vorschläge, Anschaffungskosten,
      Profinet-Komponenten mit Netzübersicht, Ausgaben-PDF nach Gruppen.
- [x] **Phase 5 — Inventur:** Zähl-Läufe Regal für Regal, Sollwert-Schnappschuss,
      Abweichungsliste, Übernahme der gezählten Bestände und Protokoll-PDF.
- [x] **CSV-Import** für Komponenten samt Beispieldatei.
- [x] **Phase 6 — Beschaffung und Dokumente:** Bestellungen mit Positionen und
      Bestellanforderung als PDF, Angebote mit Vergabeentscheidung ab der
      3000-€-Grenze, Wareneingang gegen den Lieferschein (Kamera ODER
      Handscanner, unbekannte Codes werden angelernt), Einlagern-Liste nach
      Lagerort, Rechnung mit Preisnachtrag, Belegablage in Paperless.
- [ ] Phase 3 — Etiketten (ans Ende geschoben; braucht die genauen
      Brother-Modelle)

## Hinweise für die Weiterentwicklung

Homebox hat mehrere Eigenheiten, die schon Zeit gekostet haben; sie sind in
`backend/homebox.js` an Ort und Stelle kommentiert.

**Die Listenantwort ist eine Kurzfassung ohne Feldwerte.** Wer den Treffer eines
Feld-Filters über den Feldwert nachprüft, findet nie etwas — und legt vorhandene
Artikel ein zweites Mal an.

**Unbekannte Felder und Filter werden stillschweigend verworfen.** Ein
Filterparameter, den der Server nicht kennt, liefert *alles* zurück; ein
unbekanntes Feld im POST wird ignoriert, der Datensatz aber angelegt. Deshalb
gilt in diesem Projekt: **nach jedem Schreibvorgang mit unsicherem Feld
nachsehen, ob das Gewünschte auch eingetreten ist.** Genau das hat den
Lagerort-Fehler aufgedeckt.

**Ein Lagerort ist kein Flag, sondern ein Typ.** In der Entities-API ist ein
Lagerort eine Entität mit einer `entityTypeId`, deren Typ `isLocation: true`
trägt (`/v1/entity-types`). `/v1/locations` gibt es nicht mehr, und
`isLocation` im Anlege-Aufruf bewirkt nichts.

Bei Zweifeln über die API lohnt der Blick in den Quelltext:
`raw.githubusercontent.com/sysadminsmedia/homebox` — deutlich verlässlicher als
Ausprobieren.
