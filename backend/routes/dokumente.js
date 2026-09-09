'use strict';

// Paperless-Proxy.
//
// Wie beim Homebox-Router gilt: das Frontend spricht NIE direkt mit Paperless.
// Der API-Token bleibt auf dem Server, der Browser sieht nur diese Endpunkte.
//
// Rechte: einrichten nur Admin, lesen und hochladen jeder Angemeldete. Belege
// enthalten Preise und Lieferantennamen — für Gäste ist hier nichts frei.

const express = require('express');
const multer = require('multer');
const paperless = require('../paperless');
const auth = require('../auth');

// 20 MB: ein abfotografierter Lieferschein ist klein, eine eingescannte
// mehrseitige Rechnung kann größer sein.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function weiter(res, e) {
  const status = e && e.status ? e.status : 500;
  res.status(status).json({ error: (e && e.message) || 'Unbekannter Fehler' });
}
const fang = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch(e => weiter(res, e));

module.exports = function createDokumenteRouter() {
  const r = express.Router();

  // --- Einrichtung (Admin) ------------------------------------------------
  r.get('/config', auth.requireRolle('admin'), (_req, res) => res.json(paperless.publicConfig()));
  r.put('/config', auth.requireRolle('admin'), (req, res) => res.json(paperless.setConfig(req.body || {})));
  r.get('/stammlisten', auth.requireRolle('admin'), fang(async (_req, res) => {
    res.json(await paperless.stammlisten());
  }));
  r.get('/test', auth.requireRolle('admin'), fang(async (_req, res) => res.json(await paperless.test())));

  // --- Zustand ------------------------------------------------------------
  // Damit die Oberfläche „Paperless ist nicht eingerichtet" sagen kann, statt
  // den Upload-Knopf anzubieten, der dann mit 503 scheitert.
  r.get('/health', auth.requireAuth, (_req, res) => {
    res.json({ eingerichtet: paperless.isConfigured() });
  });

  // --- Einzeldokument -----------------------------------------------------
  r.get('/:id(\\d+)', auth.requireAuth, fang(async (req, res) => {
    res.json(await paperless.dokument(req.params.id));
  }));

  // Vorschau/Original durchreichen. `art` entscheidet, was Paperless liefert.
  r.get('/:id(\\d+)/datei', auth.requireAuth, fang(async (req, res) => {
    const { daten, mimetype } = await paperless.datei(req.params.id, String(req.query.art || 'preview'));
    res.setHeader('Content-Type', mimetype);
    // inline, nicht attachment: der Beleg soll sich im Browser ansehen lassen,
    // ohne dass jedes Nachschauen eine Datei im Download-Ordner hinterlässt.
    res.setHeader('Content-Disposition', 'inline');
    res.send(daten);
  }));

  // --- Upload -------------------------------------------------------------
  // Antwortet mit der Task-UUID. Die Dokument-Nummer gibt es erst, wenn
  // Paperless die Datei verarbeitet hat — siehe /task/:id.
  r.post('/', auth.requireAuth, upload.single('datei'), fang(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Es kam keine Datei an.' });
    const taskId = await paperless.hochladen({
      daten: req.file.buffer,
      dateiname: req.file.originalname || 'beleg.pdf',
      mimetype: req.file.mimetype,
      titel: (req.body && req.body.titel) || '',
      erstellt: (req.body && req.body.erstellt) || '',
      typId: Number((req.body && req.body.typId) || 0),
    });
    res.json({ taskId });
  }));

  r.get('/task/:taskId', auth.requireAuth, fang(async (req, res) => {
    res.json(await paperless.taskStatus(req.params.taskId));
  }));

  return r;
};
