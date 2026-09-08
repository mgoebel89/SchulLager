'use strict';

// Komponenten eines Demonstrators.
//
// Viele Schuldemonstratoren bestehen aus mehreren Geräten; die im Profinet
// hängenden (meist SPS-Baugruppen) müssen dem Demonstrator fest zugeordnet
// bleiben. Homebox kennt für Netzangaben keinen Begriff, deshalb liegen sie
// hier. Wo eine Komponente doch einzeln gezählt oder etikettiert werden soll,
// trägt sie zusätzlich die ID ihres Homebox-Artikels (`artikelId`).
//
// PASSWÖRTER: Auf Wunsch der Schule im Klartext. Der ganze Router verlangt
// eine Anmeldung, aber die Sicherung der Datenbank enthält sie damit lesbar —
// siehe deploy/backup.sh und README.

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const auth = require('../auth');

function nowIso() { return new Date().toISOString(); }

// Netzangaben so ablegen, dass sie vergleichbar sind. Ohne das gälten
// „00:1B:1B:AA:BB:CC" und „00-1b-1b-aa-bb-cc" als zwei verschiedene Geräte,
// und die Doppelbelegungs-Warnung liefe ins Leere.
function macNormal(mac) {
  const roh = String(mac || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  if (roh.length !== 12) return String(mac || '').trim().toLowerCase();
  return roh.match(/.{2}/g).join(':');
}
function ipNormal(ip) { return String(ip || '').trim(); }
function nameNormal(n) { return String(n || '').trim().toLowerCase(); }

const FELDER = [
  'name', 'typ', 'hersteller', 'bestellnummer', 'seriennummer', 'uuid',
  'profinetName', 'ip', 'subnetz', 'mac', 'firmware', 'steckplatz',
  'benutzername', 'passwort', 'notiz', 'artikelId',
];

function ausEingabe(body) {
  const out = {};
  for (const f of FELDER) out[f] = String((body || {})[f] || '').trim();
  out.mac = out.mac ? macNormal(out.mac) : '';
  return out;
}

// Doppelte IP, MAC oder Profinet-Name sind im Betrieb der häufigste Ärger —
// und im Schaltschrank mühsam zu finden. Deshalb wird beim Speichern gewarnt,
// aber NICHT blockiert: manchmal ist die Dopplung gewollt (Ersatzgerät im
// Schrank) oder gerade der Fehler, den man dokumentieren will.
function konflikteFinden(neu, eigeneId) {
  const treffer = [];
  for (const k of db.listKomponenten()) {
    if (k.id === eigeneId) continue;
    if (neu.ip && ipNormal(k.ip) === ipNormal(neu.ip)) treffer.push({ feld: 'IP-Adresse', wert: neu.ip, komponente: k });
    if (neu.mac && macNormal(k.mac) === macNormal(neu.mac)) treffer.push({ feld: 'MAC-Adresse', wert: neu.mac, komponente: k });
    if (neu.profinetName && nameNormal(k.profinetName) === nameNormal(neu.profinetName)) {
      treffer.push({ feld: 'Profinet-Gerätename', wert: neu.profinetName, komponente: k });
    }
  }
  return treffer.map(t => ({
    feld: t.feld,
    wert: t.wert,
    komponenteId: t.komponente.id,
    komponenteName: t.komponente.name,
    demonstratorId: t.komponente.demonstratorId,
    demonstratorName: t.komponente.demonstratorName,
  }));
}

// --- CSV-Import -----------------------------------------------------------
// Die Spaltenliste steht HIER und nur hier. Die Vorlage zum Herunterladen wird
// daraus erzeugt, und der Import liest daraus — so können Vorlage und Einleser
// nicht auseinanderlaufen.
const IMPORT_SPALTEN = [
  { schluessel: 'geraet', label: 'Geraet', pflicht: true, hinweis: 'Bezeichnung oder Kennung (A-1042) des Demonstrators/Netzgeräts' },
  { schluessel: 'name', label: 'Bezeichnung', pflicht: true, hinweis: 'z. B. SPS Hauptsteuerung' },
  { schluessel: 'typ', label: 'Art', hinweis: 'SPS, HMI / Panel, IO-Modul, Switch …' },
  { schluessel: 'profinetName', label: 'ProfinetName', hinweis: 'NameOfStation, z. B. sps-hydraulik-01' },
  { schluessel: 'ip', label: 'IP', hinweis: '192.168.0.10' },
  { schluessel: 'subnetz', label: 'Subnetz', hinweis: '255.255.255.0' },
  { schluessel: 'mac', label: 'MAC', hinweis: '00:1B:1B:AA:BB:CC' },
  { schluessel: 'hersteller', label: 'Hersteller' },
  { schluessel: 'bestellnummer', label: 'Bestellnummer', hinweis: 'z. B. 6ES7214-1AG40-0XB0' },
  { schluessel: 'seriennummer', label: 'Seriennummer' },
  { schluessel: 'uuid', label: 'UUID' },
  { schluessel: 'firmware', label: 'Firmware' },
  { schluessel: 'steckplatz', label: 'Steckplatz' },
  { schluessel: 'benutzername', label: 'Benutzername' },
  { schluessel: 'passwort', label: 'Passwort' },
  { schluessel: 'notiz', label: 'Notiz' },
];

const BEISPIEL_ZEILEN = [
  {
    geraet: 'Hydraulik-Trainer', name: 'SPS Hauptsteuerung', typ: 'SPS',
    profinetName: 'sps-hydraulik-01', ip: '192.168.0.10', subnetz: '255.255.255.0',
    mac: '00:1B:1B:AA:BB:CC', hersteller: 'Siemens', bestellnummer: '6ES7214-1AG40-0XB0',
    seriennummer: 'S-12345', uuid: '', firmware: 'V4.5', steckplatz: 'Rack 0, Slot 1',
    benutzername: '', passwort: '', notiz: 'Hauptsteuerung des Trainers',
  },
  {
    geraet: 'A-1042', name: 'Bedienpanel', typ: 'HMI / Panel',
    profinetName: 'hmi-hydraulik-01', ip: '192.168.0.11', subnetz: '255.255.255.0',
    mac: '', hersteller: 'Siemens', bestellnummer: '6AV2123-2GB03-0AX0',
    seriennummer: '', uuid: '', firmware: '', steckplatz: '',
    benutzername: 'admin', passwort: '', notiz: 'Kennung statt Name ist auch erlaubt',
  },
];

// Excel unter Windows erwartet Semikolon und eine BOM — ohne die stehen Umlaute
// als Buchstabensalat da, und ohne Semikolon landet alles in einer Spalte.
function csvZeile(werte) {
  return werte.map(w => {
    const t = String(w ?? '');
    return /[";\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }).join(';');
}

function vorlageCsv() {
  const zeilen = [csvZeile(IMPORT_SPALTEN.map(s => s.label))];
  for (const b of BEISPIEL_ZEILEN) zeilen.push(csvZeile(IMPORT_SPALTEN.map(s => b[s.schluessel] || '')));
  return '﻿' + zeilen.join('\r\n') + '\r\n';
}

module.exports = function createKomponentenRouter(broadcast, homebox) {
  const r = express.Router();
  r.use(auth.requireAuth);

  // Spaltenbeschreibung fürs Frontend (Zuordnung und Hilfetexte).
  r.get('/spalten', (_req, res) => res.json(IMPORT_SPALTEN));

  // Beispieldatei. Wer sie ausfüllt, hat eine gültige Importdatei.
  r.get('/vorlage.csv', (_req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="komponenten-vorlage.csv"');
    res.send(vorlageCsv());
  });

  // Import. Die Zeilen kommen bereits zerlegt aus dem Browser — das Zerlegen
  // von CSV gehört dorthin, wo die Datei liegt. Hier passiert das, was nur der
  // Server kann: Geräte auflösen, prüfen, anlegen.
  //
  // Jede Zeile wird EINZELN beurteilt und einzeln gemeldet. Ein Abbruch beim
  // ersten Fehler wäre bei 80 Zeilen die schlechteste aller Antworten.
  r.post('/import', async (req, res) => {
    const zeilen = Array.isArray((req.body || {}).zeilen) ? req.body.zeilen : null;
    if (!zeilen) return res.status(400).json({ error: 'Es kamen keine Zeilen an.' });
    if (zeilen.length > 500) return res.status(400).json({ error: 'Höchstens 500 Zeilen auf einmal.' });

    // Geräte einmal auflösen und merken: 80 Zeilen für denselben Demonstrator
    // sollen nicht 80 Homebox-Abfragen auslösen.
    const geraeteCache = new Map();
    async function geraetFinden(bezeichnung) {
      const b = String(bezeichnung || '').trim();
      if (!b) return null;
      const key = b.toLowerCase();
      if (geraeteCache.has(key)) return geraeteCache.get(key);

      let treffer = null;
      // Sieht es aus wie eine Kennung, zuerst danach suchen — das ist eindeutig.
      if (/^A-\d+$/i.test(b)) {
        treffer = await homebox.beiCode(b).catch(() => null);
      }
      if (!treffer) {
        const { artikel } = await homebox.suchen({ q: b, proSeite: 25 }).catch(() => ({ artikel: [] }));
        const genau = artikel.filter(a => String(a.name).trim().toLowerCase() === key);
        // Mehrdeutig ist schlimmer als nicht gefunden: bei zwei gleichnamigen
        // Geräten darf nicht geraten werden, an welches die SPS gehört.
        if (genau.length === 1) treffer = genau[0];
        else if (genau.length > 1) treffer = { mehrdeutig: true };
      }
      geraeteCache.set(key, treffer);
      return treffer;
    }

    const ergebnisse = [];
    for (let i = 0; i < zeilen.length; i++) {
      const z = zeilen[i] || {};
      const nummer = i + 1;
      const daten = ausEingabe(z);

      if (!String(z.geraet || '').trim()) {
        ergebnisse.push({ zeile: nummer, ok: false, fehler: 'Spalte „Geraet" ist leer.' });
        continue;
      }
      if (!daten.name) {
        ergebnisse.push({ zeile: nummer, ok: false, fehler: 'Spalte „Bezeichnung" ist leer.' });
        continue;
      }

      let geraet;
      try {
        geraet = await geraetFinden(z.geraet);
      } catch (e) {
        ergebnisse.push({ zeile: nummer, ok: false, fehler: `Gerät nicht abrufbar: ${e.message}` });
        continue;
      }
      if (!geraet) {
        ergebnisse.push({ zeile: nummer, ok: false, fehler: `Kein Gerät mit „${z.geraet}" gefunden.` });
        continue;
      }
      if (geraet.mehrdeutig) {
        ergebnisse.push({ zeile: nummer, ok: false, fehler: `„${z.geraet}" passt auf mehrere Artikel — bitte die Kennung (A-…) angeben.` });
        continue;
      }

      const k = {
        id: crypto.randomUUID(),
        demonstratorId: geraet.id,
        demonstratorName: geraet.name || '',
        ...daten,
        erstelltAm: nowIso(),
        schemaVersion: 1,
      };
      db.saveKomponente(k);
      ergebnisse.push({
        zeile: nummer, ok: true, id: k.id, name: k.name,
        geraetName: geraet.name || '',
        konflikte: konflikteFinden(daten, k.id),
      });
    }

    const angelegt = ergebnisse.filter(e => e.ok).length;
    if (angelegt) broadcast({ type: 'komponente:import', anzahl: angelegt, origin: req.header('x-client-id') || '' });
    res.json({ angelegt, fehler: ergebnisse.length - angelegt, ergebnisse });
  });

  // Alle Komponenten oder die eines Demonstrators.
  r.get('/', (req, res) => {
    let liste = db.listKomponenten();
    if (req.query.demonstratorId) liste = liste.filter(k => k.demonstratorId === req.query.demonstratorId);
    liste.sort((a, b) => String(a.name).localeCompare(String(b.name), 'de'));
    res.json(liste);
  });

  // Netzübersicht: alle Komponenten mit Netzangaben, samt Doppelbelegungen.
  // Beantwortet die Frage „welche IP ist noch frei?" ohne Zettelwirtschaft.
  r.get('/netz', (_req, res) => {
    const alle = db.listKomponenten().filter(k => k.ip || k.mac || k.profinetName);
    const zaehlen = (werte) => {
      const m = new Map();
      for (const w of werte) if (w) m.set(w, (m.get(w) || 0) + 1);
      return m;
    };
    const ips = zaehlen(alle.map(k => ipNormal(k.ip)));
    const macs = zaehlen(alle.map(k => macNormal(k.mac)));
    const namen = zaehlen(alle.map(k => nameNormal(k.profinetName)));

    const liste = alle.map(k => ({
      ...k,
      doppelt: {
        ip: !!(k.ip && ips.get(ipNormal(k.ip)) > 1),
        mac: !!(k.mac && macs.get(macNormal(k.mac)) > 1),
        profinetName: !!(k.profinetName && namen.get(nameNormal(k.profinetName)) > 1),
      },
    }));
    // Nach IP sortieren, numerisch je Oktett — sonst steht .10 vor .9.
    liste.sort((a, b) => ipSchluessel(a.ip).localeCompare(ipSchluessel(b.ip)));
    res.json(liste);
  });

  r.post('/', (req, res) => {
    const { demonstratorId, demonstratorName } = req.body || {};
    if (!demonstratorId) return res.status(400).json({ error: 'Es fehlt der Demonstrator.' });
    const daten = ausEingabe(req.body);
    if (!daten.name) return res.status(400).json({ error: 'Bitte eine Bezeichnung angeben.' });

    const k = {
      id: crypto.randomUUID(),
      demonstratorId,
      // Wie bei den Ausleihen mitgeschrieben: die Netzübersicht muss auch dann
      // lesbar sein, wenn Homebox gerade nicht antwortet.
      demonstratorName: String(demonstratorName || '').trim(),
      ...daten,
      erstelltAm: nowIso(),
      schemaVersion: 1,
    };
    db.saveKomponente(k);
    broadcast({ type: 'komponente:save', komponente: k, origin: req.header('x-client-id') || '' });
    res.json({ komponente: k, konflikte: konflikteFinden(daten, k.id) });
  });

  r.put('/:id', (req, res) => {
    const alt = db.getKomponente(req.params.id);
    if (!alt) return res.status(404).json({ error: 'Komponente nicht gefunden.' });
    const daten = ausEingabe({ ...alt, ...(req.body || {}) });
    if (!daten.name) return res.status(400).json({ error: 'Bitte eine Bezeichnung angeben.' });

    const k = { ...alt, ...daten, lastModifiedAt: nowIso() };
    db.saveKomponente(k);
    broadcast({ type: 'komponente:save', komponente: k, origin: req.header('x-client-id') || '' });
    res.json({ komponente: k, konflikte: konflikteFinden(daten, k.id) });
  });

  r.delete('/:id', (req, res) => {
    const k = db.getKomponente(req.params.id);
    if (!k) return res.status(404).json({ error: 'Komponente nicht gefunden.' });
    db.deleteKomponente(k.id);
    broadcast({ type: 'komponente:delete', id: k.id, origin: req.header('x-client-id') || '' });
    res.json({ ok: true });
  });

  return r;
};

// IPv4 auf eine sortierbare Zeichenkette bringen (192.168.1.9 → 192.168.001.009).
// Reine Textsortierung stellte sonst .10 vor .9.
function ipSchluessel(ip) {
  const teile = String(ip || '').trim().split('.');
  if (teile.length !== 4) return 'zzz' + String(ip || '');
  return teile.map(t => String(parseInt(t, 10) || 0).padStart(3, '0')).join('.');
}
