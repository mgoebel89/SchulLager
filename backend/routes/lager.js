'use strict';

// Homebox-Proxy.
//
// Das Frontend spricht NIE direkt mit Homebox — die Zugangsdaten (Homebox
// kennt keine dauerhaften Tokens, also Benutzername und Passwort) bleiben
// serverseitig.
//
// Zugriffsrechte in diesem Router:
//   lesen        ohne Anmeldung erlaubt (so entschieden: wer den QR am Gerät
//                scannt, soll sofort Bezeichnung, Ort und Bestand sehen)
//   schreiben    nur angemeldet
//   einrichten   nur Admin
//
// Wichtig bei der Reihenfolge: `/:id` steht ganz unten. Stünde es weiter oben,
// würde „orte" als Artikel-ID gelesen.

const express = require('express');
const homebox = require('../homebox');
const auth = require('../auth');

// Homebox-Fehler tragen einen sinnvollen Status (503 nicht eingerichtet,
// 502 nicht erreichbar, 403 falsche Sammlung). Den durchreichen, statt alles
// zu 500 zu verschlucken — die Oberfläche unterscheidet daran ihre Hinweise.
function weiter(res, e) {
  const status = e && e.status ? e.status : 500;
  res.status(status).json({ error: (e && e.message) || 'Unbekannter Fehler' });
}
const fang = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch(e => weiter(res, e));

module.exports = function createLagerRouter() {
  const r = express.Router();

  // --- Einrichtung (Admin) ------------------------------------------------
  r.get('/config', auth.requireRolle('admin'), (_req, res) => res.json(homebox.publicConfig()));
  r.put('/config', auth.requireRolle('admin'), (req, res) => res.json(homebox.setConfig(req.body || {})));
  r.get('/sammlungen', auth.requireRolle('admin'), fang(async (_req, res) => {
    res.json(await homebox.sammlungen());
  }));

  // --- Zustand ------------------------------------------------------------
  // Auch für Gäste: die Oberfläche muss sagen können „Homebox antwortet nicht",
  // statt einfach ein leeres Lager anzuzeigen.
  r.get('/health', fang(async (_req, res) => {
    if (!homebox.isConfigured()) {
      return res.json({ ok: false, eingerichtet: false, hinweis: 'Homebox ist noch nicht eingerichtet.' });
    }
    res.json({ ...(await homebox.health()), eingerichtet: true });
  }));

  // --- Lesen (ohne Anmeldung) ---------------------------------------------
  r.get('/', fang(async (req, res) => {
    res.json(await homebox.suchen({
      q: req.query.q || '',
      ortId: req.query.ortId || '',
      seite: parseInt(req.query.seite || '1', 10),
      proSeite: Math.min(parseInt(req.query.proSeite || '25', 10), 100),
    }));
  }));

  r.get('/orte', fang(async (_req, res) => res.json(await homebox.orte())));
  r.get('/orte/:id', fang(async (req, res) => {
    const o = await homebox.ortHolen(req.params.id);
    if (!o) return res.status(404).json({ error: 'Lagerort nicht gefunden.' });
    res.json(o);
  }));
  r.get('/marken', fang(async (_req, res) => res.json(await homebox.marken())));

  r.get('/barcode/:code', fang(async (req, res) => {
    const a = await homebox.beiBarcode(req.params.code);
    if (!a) return res.status(404).json({ error: 'Kein Artikel mit diesem Barcode.' });
    res.json(a);
  }));

  // Kurzkennung aus dem QR-Etikett dieser App.
  r.get('/code/:code', fang(async (req, res) => {
    const a = await homebox.beiCode(req.params.code);
    if (!a) return res.status(404).json({ error: 'Kein Artikel mit dieser Kennung.' });
    res.json(a);
  }));

  // --- Schreiben (angemeldet) ---------------------------------------------
  r.post('/', auth.requireAuth, fang(async (req, res) => res.json(await homebox.anlegen(req.body || {}))));

  r.put('/:id', auth.requireAuth, fang(async (req, res) => {
    res.json(await homebox.aktualisieren(req.params.id, req.body || {}));
  }));

  r.post('/:id/bestand', auth.requireAuth, fang(async (req, res) => {
    const { delta, menge } = req.body || {};
    if (delta == null && menge == null) {
      return res.status(400).json({ error: 'Es fehlt delta oder menge.' });
    }
    res.json(await homebox.bestandAendern(req.params.id, { delta, menge }));
  }));

  // --- Artikel-Detail (ohne Anmeldung) — MUSS unten stehen ----------------
  r.get('/:id', fang(async (req, res) => {
    const a = await homebox.holen(req.params.id);
    if (!a) return res.status(404).json({ error: 'Artikel nicht gefunden.' });
    res.json(a);
  }));

  return r;
};
