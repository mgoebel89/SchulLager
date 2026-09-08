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

module.exports = function createKomponentenRouter(broadcast) {
  const r = express.Router();
  r.use(auth.requireAuth);

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
