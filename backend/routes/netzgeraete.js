'use strict';

// Netzwerkgeräte: was im Netz der Schule hängt — Profinet-Teilnehmer, Roboter
// und PCs.
//
// GRUNDENTSCHEIDUNG (mit Matthias, 2026-09-17): JEDES Netzwerkgerät ist ein
// eigener Homebox-Artikel. Ich hatte davon abgeraten (der Bestand wächst um
// jedes IO-Modul), Matthias hat anders entschieden — und der Gewinn ist
// erheblich: Wartung, Lagerort, Ausleihe und Etikett gelten damit ohne eine
// Zeile Zusatzbau, weil sie alle am Artikel hängen. Insbesondere greift die
// Defektmeldung (`defekt.artikelId`) sofort.
//
// Dieser Satz hier trägt deshalb NUR, was Homebox nicht kann: IP, MAC,
// Firmware- und Hardwarestand, Profinet-Gerätename, Zugangsdaten — und die
// Zuordnung zu Demonstratoren.
//
// ABGRENZUNG ZUR ALTEN TABELLE `komponenten`: dort steckt ein Gerät als reiner
// Eintrag UNTER einem Demonstrator und existiert in Homebox nicht. Die alte
// Tabelle bleibt unangetastet, bis der Übernahme-Assistent gelaufen ist —
// nichts wird still umgeschrieben.
//
// NAMENSFALLE: Die Einstellung `netzgeraetMarke` („Netzgerät") ist etwas
// ANDERES als die Klassen-Tags hier. Sie markiert ein ausleihbares Einzelgerät
// unter „Geräte". Die Klassen-Tags markieren Teilnehmer im Netz und erscheinen
// dort nicht.
//
// PASSWÖRTER: Auf Wunsch der Schule im Klartext. Jede Sicherung enthält sie
// lesbar — siehe deploy/backup.sh und README.

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const auth = require('../auth');

function nowIso() { return new Date().toISOString(); }
const text = (v) => String(v === null || v === undefined ? '' : v).trim();

// Netzangaben vergleichbar machen. Ohne das gälten „00:1B:1B:AA:BB:CC" und
// „00-1b-1b-aa-bb-cc" als zwei verschiedene Geräte, und die Warnung vor
// Doppelbelegungen liefe ins Leere.
function macNormal(mac) {
  const roh = String(mac || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  if (roh.length !== 12) return String(mac || '').trim().toLowerCase();
  return roh.match(/.{2}/g).join(':');
}
const ipNormal = (ip) => String(ip || '').trim();
const nameNormal = (n) => String(n || '').trim().toLowerCase();

const KLASSEN = ['profinet', 'roboter', 'pc'];

// Welche Felder eine Klasse trägt. Muss mit NETZ_FELDER in app/src/models.js
// übereinstimmen — die Maske zeigt, was hier ankommt.
//
// Warum nicht überall alle Felder? Ein Roboter hängt im normalen Schulnetz und
// hat weder Profinet-Gerätenamen noch Steckplatz; ein PC hat nur Bezeichnung
// und IP. Fremde Felder werden beim Speichern VERWORFEN, nicht durchgereicht:
// sonst steht am PC eine Firmware, die niemand je gepflegt hat.
const FELDER = {
  profinet: [
    'profinetName', 'ip', 'subnetz', 'mac', 'hersteller', 'typ',
    'bestellnummer', 'seriennummer', 'uuid', 'firmware', 'steckplatz',
    'benutzername', 'passwort', 'notiz',
  ],
  roboter: [
    'hersteller', 'typ', 'steuerungsName', 'seriennummer', 'ip', 'mac',
    'firmware', 'hardwarestand', 'notiz',
  ],
  pc: ['ip', 'notiz'],
};

function klasseVon(v) { return KLASSEN.includes(text(v)) ? text(v) : 'profinet'; }

function ausEingabe(body, klasse) {
  const out = {};
  for (const f of FELDER[klasse]) out[f] = text((body || {})[f]);
  if (out.mac) out.mac = macNormal(out.mac);
  return out;
}

// Ein Gerät kann zu keinem, einem oder mehreren Demonstratoren gehören — der
// Programmier-PC dient drei Stationen, der Roboter wandert zwischen ihnen.
function demoIds(v, alt) {
  if (v === undefined) return alt || [];
  const liste = Array.isArray(v) ? v : [v];
  return [...new Set(liste.map(text).filter(Boolean))];
}

// Doppelte IP, MAC, Profinet- oder Steuerungsname sind im Betrieb der häufigste
// Ärger und im Schaltschrank mühsam zu finden. Gewarnt wird über ALLE Klassen
// hinweg — genau deshalb gehören die PCs mit in diese Liste. Blockiert wird
// nicht: manchmal ist die Dopplung gewollt (Ersatzgerät im Schrank) oder
// gerade der Fehler, den man dokumentieren will.
function konflikteFinden(neu, eigeneId) {
  const treffer = [];
  for (const g of db.listNetzgeraete()) {
    if (g.id === eigeneId) continue;
    if (neu.ip && ipNormal(g.ip) === ipNormal(neu.ip)) treffer.push({ feld: 'IP-Adresse', wert: neu.ip, g });
    if (neu.mac && macNormal(g.mac) === macNormal(neu.mac)) treffer.push({ feld: 'MAC-Adresse', wert: neu.mac, g });
    if (neu.profinetName && nameNormal(g.profinetName) === nameNormal(neu.profinetName)) {
      treffer.push({ feld: 'Profinet-Gerätename', wert: neu.profinetName, g });
    }
    if (neu.steuerungsName && nameNormal(g.steuerungsName) === nameNormal(neu.steuerungsName)) {
      treffer.push({ feld: 'Steuerungsname', wert: neu.steuerungsName, g });
    }
  }
  return treffer.map(t => ({
    feld: t.feld,
    wert: t.wert,
    geraetId: t.g.id,
    geraetName: t.g.artikelName,
    klasse: t.g.klasse,
  }));
}

// --- CSV-Import -----------------------------------------------------------
// Die Spaltenliste steht HIER und nur hier. Vorlage und Einleser entstehen
// beide daraus — so können sie nicht auseinanderlaufen.
//
// Gegenüber der alten Komponenten-Vorlage neu: `art` (die Klasse),
// `hardwarestand`, `steuerungsName` und `artikel`. Und `geraet` ist NICHT mehr
// Pflicht: ein Roboter oder ein PC gehört zu keinem Demonstrator.
const IMPORT_SPALTEN = [
  { schluessel: 'name', label: 'Bezeichnung', pflicht: true, hinweis: 'z. B. SPS Hauptsteuerung — wird zugleich der Artikelname im Lager' },
  { schluessel: 'art', label: 'Art', hinweis: 'Profinet (Vorgabe), Roboter oder PC' },
  { schluessel: 'geraet', label: 'Demonstrator', hinweis: 'Bezeichnung oder Kennung (A-1042); leer lassen, wenn das Gerät für sich steht' },
  { schluessel: 'artikel', label: 'VorhandenerArtikel', hinweis: 'Kennung oder genaue Bezeichnung eines Artikels, der schon im Lager steht — sonst wird einer angelegt' },
  { schluessel: 'typ', label: 'Typ', hinweis: 'SPS, HMI / Panel, IO-Modul, Knickarm …' },
  { schluessel: 'profinetName', label: 'ProfinetName', hinweis: 'NameOfStation, z. B. sps-hydraulik-01' },
  { schluessel: 'steuerungsName', label: 'Steuerungsname', hinweis: 'nur beim Roboter: Name der Steuerung im Schulnetz' },
  { schluessel: 'ip', label: 'IP', hinweis: '192.168.0.10' },
  { schluessel: 'subnetz', label: 'Subnetz', hinweis: '255.255.255.0' },
  { schluessel: 'mac', label: 'MAC', hinweis: '00:1B:1B:AA:BB:CC' },
  { schluessel: 'hersteller', label: 'Hersteller' },
  { schluessel: 'bestellnummer', label: 'Bestellnummer', hinweis: 'z. B. 6ES7214-1AG40-0XB0' },
  { schluessel: 'seriennummer', label: 'Seriennummer' },
  { schluessel: 'uuid', label: 'UUID' },
  { schluessel: 'firmware', label: 'Firmwarestand' },
  { schluessel: 'hardwarestand', label: 'Hardwarestand', hinweis: 'nur beim Roboter, z. B. A4' },
  { schluessel: 'steckplatz', label: 'Steckplatz' },
  { schluessel: 'benutzername', label: 'Benutzername' },
  { schluessel: 'passwort', label: 'Passwort' },
  { schluessel: 'notiz', label: 'Notiz' },
];

const BEISPIEL_ZEILEN = [
  {
    name: 'SPS Hauptsteuerung', art: 'Profinet', geraet: 'Hydraulik-Trainer', artikel: '',
    typ: 'SPS', profinetName: 'sps-hydraulik-01', ip: '192.168.0.10', subnetz: '255.255.255.0',
    mac: '00:1B:1B:AA:BB:CC', hersteller: 'Siemens', bestellnummer: '6ES7214-1AG40-0XB0',
    seriennummer: 'S-12345', uuid: '', firmware: 'V4.5', steckplatz: 'Rack 0, Slot 1',
    notiz: 'Hauptsteuerung des Trainers',
  },
  {
    name: 'KR 3 R540', art: 'Roboter', geraet: '', artikel: 'A-1042',
    typ: 'Knickarm', steuerungsName: 'kuka-labor-1', ip: '10.0.5.20',
    hersteller: 'KUKA', seriennummer: '12345', firmware: '8.6', hardwarestand: 'A4',
    notiz: 'Artikel steht schon im Lager — wird verknuepft statt angelegt',
  },
  {
    name: 'PC Labor 3 Platz 1', art: 'PC', geraet: '', artikel: '', ip: '10.0.5.21',
    notiz: 'Ein PC braucht nur Bezeichnung und IP',
  },
];

// Excel unter Windows erwartet Semikolon und eine BOM — ohne die stehen Umlaute
// als Buchstabensalat da, und ohne Semikolon landet alles in einer Spalte.
function csvZeile(werte) {
  return werte.map(w => {
    const t = String(w === null || w === undefined ? '' : w);
    return /[";\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }).join(';');
}

function vorlageCsv() {
  const zeilen = [csvZeile(IMPORT_SPALTEN.map(s => s.label))];
  for (const b of BEISPIEL_ZEILEN) zeilen.push(csvZeile(IMPORT_SPALTEN.map(s => b[s.schluessel] || '')));
  // BOM voran und CRLF als Zeilenende: sonst zeigt Excel unter Windows
  // Buchstabensalat statt Umlauten.
  return '\ufeff' + zeilen.join('\r\n') + '\r\n';
}

// „Profinet", „roboter", „PC" → die interne Klasse. Unbekanntes wird zu
// Profinet, weil das der Regelfall ist — gemeldet wird es trotzdem.
function klasseAusText(v) {
  const t = text(v).toLowerCase();
  if (!t) return { klasse: 'profinet', geraten: false };
  if (t.startsWith('rob')) return { klasse: 'roboter', geraten: false };
  if (t === 'pc' || t.startsWith('rech')) return { klasse: 'pc', geraten: false };
  if (t.startsWith('pro')) return { klasse: 'profinet', geraten: false };
  return { klasse: 'profinet', geraten: true };
}

module.exports = function createNetzgeraeteRouter(broadcast, homebox) {
  const r = express.Router();
  // Ganzer Router hinter der Anmeldung: hier stehen Zugangsdaten und die
  // Netzstruktur der Schule. Gäste dürfen Artikel sehen, das hier nicht.
  r.use(auth.requireAuth);

  function weiter(res, e) {
    res.status((e && e.status) || 500).json({ error: (e && e.message) || 'Unbekannter Fehler' });
  }
  const fang = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch(e => weiter(res, e));

  // --- CSV-Import ---------------------------------------------------------
  r.get('/spalten', (_req, res) => res.json(IMPORT_SPALTEN));

  r.get('/vorlage.csv', (_req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="netzwerkgeraete-vorlage.csv"');
    res.send(vorlageCsv());
  });

  // Die Zeilen kommen bereits zerlegt aus dem Browser — CSV zu zerlegen gehört
  // dorthin, wo die Datei liegt. Hier passiert, was nur der Server kann:
  // Artikel auflösen, anlegen, Tags setzen.
  //
  // Jede Zeile wird EINZELN beurteilt und einzeln gemeldet. Ein Abbruch beim
  // ersten Fehler wäre bei 80 Zeilen die schlechteste aller Antworten.
  r.post('/import', fang(async (req, res) => {
    const zeilen = Array.isArray((req.body || {}).zeilen) ? req.body.zeilen : null;
    if (!zeilen) return res.status(400).json({ error: 'Es kamen keine Zeilen an.' });
    if (zeilen.length > 500) return res.status(400).json({ error: 'Höchstens 500 Zeilen auf einmal.' });

    const settings = db.getSettings() || {};
    // Artikel und Tags einmal auflösen und merken: 80 Zeilen für denselben
    // Demonstrator sollen nicht 80 Homebox-Abfragen auslösen.
    const artikelCache = new Map();
    const markenCache = new Map();

    async function markeFuer(klasse) {
      if (markenCache.has(klasse)) return markenCache.get(klasse);
      const name = klasse === 'roboter' ? settings.roboterMarke
        : klasse === 'pc' ? settings.pcMarke : settings.profinetMarke;
      const m = await homebox.markeSicherstellen(name || klasse);
      markenCache.set(klasse, m);
      return m;
    }

    // Einen Artikel über Kennung oder genauen Namen finden. Mehrdeutig ist
    // schlimmer als nicht gefunden: bei zwei gleichnamigen Artikeln darf nicht
    // geraten werden, an welchen die SPS gehört.
    async function artikelFinden(bezeichnung) {
      const b = text(bezeichnung);
      if (!b) return null;
      const key = b.toLowerCase();
      if (artikelCache.has(key)) return artikelCache.get(key);
      let treffer = null;
      if (/^A-\d+$/i.test(b)) treffer = await homebox.beiCode(b).catch(() => null);
      if (!treffer) {
        const { artikel } = await homebox.suchen({ q: b, proSeite: 25 }).catch(() => ({ artikel: [] }));
        const genau = artikel.filter(a => String(a.name).trim().toLowerCase() === key);
        if (genau.length === 1) treffer = genau[0];
        else if (genau.length > 1) treffer = { mehrdeutig: true };
      }
      artikelCache.set(key, treffer);
      return treffer;
    }

    const ergebnisse = [];
    for (let i = 0; i < zeilen.length; i++) {
      const z = zeilen[i] || {};
      const nummer = i + 1;
      const name = text(z.name);
      const melden = (fehler) => ergebnisse.push({ zeile: nummer, ok: false, name, fehler });

      if (!name) { melden('Spalte „Bezeichnung" ist leer.'); continue; }

      const { klasse, geraten } = klasseAusText(z.art);
      const hinweise = geraten ? [`Art „${text(z.art)}" nicht erkannt — als Profinet-Teilnehmer angelegt.`] : [];

      // Schon als Netzwerkgerät erfasst? Dann nicht ein zweites Mal.
      const schonDa = db.listNetzgeraete().find(g =>
        String(g.artikelName || '').trim().toLowerCase() === name.toLowerCase());
      if (schonDa) { melden(`„${name}" ist bereits als Netzwerkgerät erfasst.`); continue; }

      // Demonstrator auflösen (freiwillig).
      let demoIdsZeile = [];
      if (text(z.geraet)) {
        const demo = await artikelFinden(z.geraet);
        if (!demo) { melden(`Kein Gerät mit „${text(z.geraet)}" gefunden.`); continue; }
        if (demo.mehrdeutig) { melden(`„${text(z.geraet)}" passt auf mehrere Artikel — bitte die Kennung (A-…) angeben.`); continue; }
        demoIdsZeile = [demo.id];
      }

      // Vorhandenen Artikel verknüpfen oder einen anlegen. Verknüpft wird NUR,
      // wenn die Zeile es ausdrücklich sagt: ein zufällig gleichnamiger Artikel
      // bekäme sonst still die Netzangaben eines anderen Geräts.
      let artikel = null;
      try {
        if (text(z.artikel)) {
          artikel = await artikelFinden(z.artikel);
          if (!artikel) { melden(`Kein Artikel mit „${text(z.artikel)}" gefunden.`); continue; }
          if (artikel.mehrdeutig) { melden(`„${text(z.artikel)}" passt auf mehrere Artikel — bitte die Kennung (A-…) angeben.`); continue; }
          if (db.listNetzgeraete().some(g => g.artikelId === artikel.id)) {
            melden(`Der Artikel „${artikel.name}" ist schon ein Netzwerkgerät.`); continue;
          }
        } else {
          const marke = await markeFuer(klasse);
          // Ohne eigenen Ort erbt das Gerät den des Demonstrators — dort steht
          // es ja auch physisch.
          let ortId;
          if (demoIdsZeile.length) {
            const demo = await homebox.holen(demoIdsZeile[0]).catch(() => null);
            if (demo && demo.ortId) ortId = demo.ortId;
          }
          artikel = await homebox.anlegen({
            name,
            menge: 1,                       // Einzelstück
            ortId,
            hersteller: text(z.hersteller) || undefined,
            markenIds: [marke.id],
          });
          if (!artikel || !artikel.id) { melden('Homebox hat keinen Artikel angelegt.'); continue; }
        }
      } catch (e) {
        melden(`Artikel nicht anlegbar: ${e.message}`); continue;
      }

      const daten = ausEingabe(z, klasse);
      // Felder, die diese Klasse nicht kennt, sind kein Fehler — aber sie
      // verschwinden, und das soll dranstehen.
      const verworfen = Object.keys(z).filter(f =>
        FELDER[klasse].indexOf(f) === -1
        && ['name', 'art', 'geraet', 'artikel'].indexOf(f) === -1
        && text(z[f]));
      if (verworfen.length) hinweise.push(`Nicht übernommen (gehört nicht zu dieser Art): ${verworfen.join(', ')}.`);

      const g = {
        id: crypto.randomUUID(),
        artikelId: artikel.id,
        artikelName: artikel.name || name,
        artikelCode: artikel.code || '',
        klasse,
        demonstratorIds: demoIdsZeile,
        ...daten,
        erstelltAm: nowIso(),
        erstelltVon: req.benutzer.name,
        lastModifiedAt: nowIso(),
        ausKomponenteId: '',
        schemaVersion: 1,
      };
      db.saveNetzgeraet(g);
      ergebnisse.push({
        zeile: nummer, ok: true, id: g.id, name: g.artikelName,
        klasse, hinweise,
        konflikte: konflikteFinden(daten, g.id),
      });
    }

    const angelegt = ergebnisse.filter(e => e.ok).length;
    if (angelegt) broadcast({ type: 'netzgeraet:import', anzahl: angelegt, origin: req.header('x-client-id') || '' });
    res.json({ angelegt, fehler: ergebnisse.length - angelegt, ergebnisse });
  }));

  // --- Lesen --------------------------------------------------------------
  r.get('/', (req, res) => {
    let liste = db.listNetzgeraete();
    if (req.query.klasse) liste = liste.filter(g => g.klasse === text(req.query.klasse));
    if (req.query.demonstratorId) {
      liste = liste.filter(g => (g.demonstratorIds || []).includes(text(req.query.demonstratorId)));
    }
    liste.sort((a, b) => String(a.artikelName).localeCompare(String(b.artikelName), 'de'));
    res.json(liste);
  });

  // Netzübersicht: alles mit Netzangaben, samt Doppelbelegungen. Beantwortet
  // „welche IP ist noch frei?" ohne Zettelwirtschaft.
  r.get('/netz', (_req, res) => {
    const alle = db.listNetzgeraete().filter(g => g.ip || g.mac || g.profinetName || g.steuerungsName);
    const zaehlen = (werte) => {
      const map = new Map();
      for (const w of werte) {
        if (!w.wert) continue;
        if (!map.has(w.wert)) map.set(w.wert, []);
        map.get(w.wert).push(w.geraet);
      }
      return [...map.entries()].filter(([, g]) => g.length > 1)
        .map(([wert, geraete]) => ({ wert, geraete }));
    };
    const kurz = (g) => ({ id: g.id, name: g.artikelName, klasse: g.klasse, artikelId: g.artikelId });
    res.json({
      geraete: alle.map(g => ({ ...g, passwort: g.passwort ? '•••' : '' })),
      doppelteIp: zaehlen(alle.map(g => ({ wert: ipNormal(g.ip), geraet: kurz(g) }))),
      doppelteMac: zaehlen(alle.map(g => ({ wert: macNormal(g.mac), geraet: kurz(g) }))),
      doppelteNamen: zaehlen(alle.map(g => ({
        wert: nameNormal(g.profinetName || g.steuerungsName), geraet: kurz(g),
      }))),
    });
  });

  r.get('/:id', (req, res) => {
    const g = db.getNetzgeraet(req.params.id);
    if (!g) return res.status(404).json({ error: 'Gerät nicht gefunden.' });
    res.json(g);
  });

  // --- Anlegen ------------------------------------------------------------
  // Zwei Wege in EINER Route, weil es für den Nutzer eine Handlung ist:
  //   * `artikelId` mitgegeben → vorhandener Artikel wird verknüpft.
  //   * sonst → die App legt den Artikel in Homebox an.
  // Der zweite Weg ist der Regelfall; der erste verhindert Doubletten, wenn
  // das Gerät im Bestand schon steht (typisch beim Roboter).
  r.post('/', fang(async (req, res) => {
    const body = req.body || {};
    const klasse = klasseVon(body.klasse);
    const name = text(body.name);
    let artikel = null;

    if (text(body.artikelId)) {
      artikel = await homebox.holen(text(body.artikelId));
      if (!artikel) return res.status(404).json({ error: 'Der angegebene Artikel ist in Homebox nicht zu finden.' });
      // Ein Artikel darf nur EIN Netzgerät sein — sonst stünden zwei IPs am
      // selben Gerät und niemand wüsste, welche gilt.
      const da = db.listNetzgeraete().find(g => g.artikelId === artikel.id);
      if (da) {
        return res.status(409).json({
          error: `„${artikel.name}" ist bereits als Netzwerkgerät erfasst.`,
          geraetId: da.id,
        });
      }
    } else {
      if (!name) return res.status(400).json({ error: 'Es fehlt die Bezeichnung.' });
      const settings = db.getSettings() || {};
      const markeName = klasse === 'roboter' ? settings.roboterMarke
        : klasse === 'pc' ? settings.pcMarke : settings.profinetMarke;
      const marke = await homebox.markeSicherstellen(markeName || klasse);
      artikel = await homebox.anlegen({
        name,
        // Ein Netzwerkgerät ist ein Einzelstück. Die Mengenfrage stellt sich
        // nicht, und eine 0 würde es in der Nachbestell-Liste auftauchen lassen.
        menge: 1,
        ortId: text(body.ortId) || undefined,
        beschreibung: text(body.beschreibung) || undefined,
        hersteller: text(body.hersteller) || undefined,
        markenIds: [marke.id],
      });
      // FALLE aus diesem Projekt: Homebox verwirft unbekannte Felder still.
      // Nach dem Schreiben nachsehen, ob das Gewünschte auch eingetreten ist.
      if (!artikel || !artikel.id) {
        return res.status(502).json({ error: 'Homebox hat keinen Artikel angelegt.' });
      }
    }

    const daten = ausEingabe(body, klasse);
    const g = {
      id: crypto.randomUUID(),
      artikelId: artikel.id,
      // Name und Kennung werden MITGESCHRIEBEN, nicht nur verwiesen: die Liste
      // muss lesbar bleiben, wenn Homebox gerade nicht antwortet.
      artikelName: artikel.name || name,
      artikelCode: artikel.code || '',
      klasse,
      demonstratorIds: demoIds(body.demonstratorIds, []),
      ...daten,
      erstelltAm: nowIso(),
      erstelltVon: req.benutzer.name,
      lastModifiedAt: nowIso(),
      // Woher der Satz stammt, wenn er aus der alten Komponententabelle kommt.
      ausKomponenteId: text(body.ausKomponenteId),
      schemaVersion: 1,
    };
    db.saveNetzgeraet(g);
    broadcast({ type: 'netzgeraet:save', geraet: g, origin: req.header('x-client-id') || '' });
    res.json({ geraet: g, konflikte: konflikteFinden(daten, g.id) });
  }));

  // --- Ändern -------------------------------------------------------------
  r.put('/:id', fang(async (req, res) => {
    const g = db.getNetzgeraet(req.params.id);
    if (!g) return res.status(404).json({ error: 'Gerät nicht gefunden.' });
    const body = req.body || {};
    // Die Klasse zu wechseln ist erlaubt (ein Gerät war falsch einsortiert),
    // aber sie entscheidet über die Felder: erst danach einlesen.
    const klasse = body.klasse !== undefined ? klasseVon(body.klasse) : g.klasse;
    const daten = ausEingabe({ ...g, ...body }, klasse);

    // Der Name gehört dem ARTIKEL. Wer ihn hier ändert, ändert ihn dort —
    // sonst hätte dasselbe Gerät zwei Namen.
    const neuerName = text(body.name);
    if (neuerName && neuerName !== g.artikelName) {
      await homebox.aktualisieren(g.artikelId, { name: neuerName });
      g.artikelName = neuerName;
    }
    // Klassenwechsel heißt auch: anderer Tag in Homebox.
    if (klasse !== g.klasse) {
      const settings = db.getSettings() || {};
      const markeName = klasse === 'roboter' ? settings.roboterMarke
        : klasse === 'pc' ? settings.pcMarke : settings.profinetMarke;
      const marke = await homebox.markeSicherstellen(markeName || klasse);
      const artikel = await homebox.holen(g.artikelId).catch(() => null);
      const alteIds = ((artikel && artikel.marken) || []).map(m => m.id);
      const alteNamen = [settings.profinetMarke, settings.roboterMarke, settings.pcMarke]
        .map(n => String(n || '').trim().toLowerCase());
      const behalten = ((artikel && artikel.marken) || [])
        .filter(m => !alteNamen.includes(String(m.name || '').trim().toLowerCase()))
        .map(m => m.id);
      if (alteIds.length || behalten.length) {
        await homebox.aktualisieren(g.artikelId, { markenIds: [...new Set([...behalten, marke.id])] });
      }
    }

    Object.assign(g, daten);
    g.klasse = klasse;
    g.demonstratorIds = demoIds(body.demonstratorIds, g.demonstratorIds);
    g.lastModifiedAt = nowIso();
    db.saveNetzgeraet(g);
    broadcast({ type: 'netzgeraet:save', geraet: g, origin: req.header('x-client-id') || '' });
    res.json({ geraet: g, konflikte: konflikteFinden(daten, g.id) });
  }));

  // --- Entfernen ----------------------------------------------------------
  // `?artikel=1` löscht den Homebox-Artikel mit. Das ist ein echter
  // Datenverlust — daran hängt die Defekthistorie —, deshalb muss es
  // ausdrücklich verlangt werden und die Oberfläche fragt vorher nach.
  r.delete('/:id', fang(async (req, res) => {
    const g = db.getNetzgeraet(req.params.id);
    if (!g) return res.status(404).json({ error: 'Gerät nicht gefunden.' });
    let artikelGeloescht = false;
    if (req.query.artikel === '1') {
      await homebox.artikelLoeschen(g.artikelId);
      artikelGeloescht = true;
    }
    db.deleteNetzgeraet(g.id);
    broadcast({ type: 'netzgeraet:delete', id: g.id, origin: req.header('x-client-id') || '' });
    res.json({ ok: true, artikelGeloescht });
  }));

  return r;
};
