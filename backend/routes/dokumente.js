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
  r.get('/test', auth.requireRolle('admin'), fang(async (_req, res) => res.json(await paperless.test())));

  // --- Stammlisten (jede Lehrkraft) ---------------------------------------
  // Nicht mehr nur für die Einstellungen: das Upload-Fenster braucht Tags,
  // Korrespondenten, Ablagepfade und Typen zur Auswahl. Wer Belege ablegen
  // darf, muss die Listen sehen.
  r.get('/stammlisten', auth.requireAuth, fang(async (_req, res) => {
    res.json(await paperless.stammlisten());
  }));

  // Neuen Tag / Korrespondenten anlegen. Bewusst für jede Lehrkraft: ein
  // Angebot von einem noch unbekannten Lieferanten soll nicht am Recht
  // scheitern. Gibt es den Namen schon, kommt der vorhandene Eintrag zurück
  // (`vorhanden: true`) statt einer zweiten Karteikarte.
  r.post('/tags', auth.requireAuth, fang(async (req, res) => {
    res.json(await paperless.tagAnlegen((req.body || {}).name));
  }));
  r.post('/korrespondenten', auth.requireAuth, fang(async (req, res) => {
    res.json(await paperless.korrespondentAnlegen((req.body || {}).name));
  }));

  // Suche über den Titel — der Rettungsweg für Belege, deren Vorgangsnummer
  // Paperless nicht mehr kennt.
  r.get('/suche', auth.requireAuth, fang(async (req, res) => {
    res.json(await paperless.dokumenteSuchen(String(req.query.titel || '')));
  }));

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

  // Angaben eines abgelegten Belegs nachbessern (Titel, Tags, Korrespondent …).
  r.patch('/:id(\\d+)', auth.requireAuth, fang(async (req, res) => {
    res.json(await paperless.dokumentAendern(req.params.id, req.body || {}));
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
    const b = req.body || {};
    // Über multipart kommt alles als Zeichenkette an. `tagIds` reist als
    // kommagetrennte Liste; FEHLT das Feld, bleibt es null — dann greift der
    // Tag aus den Einstellungen. Ein leerer String heißt dagegen „bewusst ohne
    // Tag". Der Unterschied geht verloren, wenn man einfach split() aufruft.
    const tagIds = b.tagIds === undefined || b.tagIds === null
      ? null
      : String(b.tagIds).split(',').map(x => Number(x.trim())).filter(Boolean);
    const taskId = await paperless.hochladen({
      daten: req.file.buffer,
      dateiname: req.file.originalname || 'beleg.pdf',
      mimetype: req.file.mimetype,
      titel: b.titel || '',
      erstellt: b.erstellt || '',
      typId: Number(b.typId || 0),
      korrespondentId: Number(b.korrespondentId || 0),
      ablagepfadId: b.ablagepfadId === undefined ? null : Number(b.ablagepfadId || 0),
      tagIds,
    });
    res.json({ taskId });
  }));

  r.get('/task/:taskId', auth.requireAuth, fang(async (req, res) => {
    res.json(await paperless.taskStatus(req.params.taskId));
  }));

  return r;
};
