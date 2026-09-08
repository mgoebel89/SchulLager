'use strict';

// Inventur: Regal für Regal zählen, Abweichungen festhalten, am Ende die
// gezählten Bestände übernehmen.
//
// Der Zähl-Lauf liegt in UNSERER Datenbank. Homebox kennt keinen Begriff für
// „gerade wird gezählt" — und das ist auch gut so: Während der Inventur soll
// der Bestand ja gerade NICHT verändert werden, sondern erst am Schluss, in
// einem Schritt, den jemand bewusst auslöst.
//
// WICHTIG — der Sollbestand wird beim ersten Anzeigen MITGESCHRIEBEN
// (Schnappschuss). Sonst verschiebt sich das Ziel, während man zählt: bucht
// jemand am anderen Ende der Schule eine Entnahme, stimmte plötzlich die
// abgehakte Position nicht mehr, und niemand könnte sagen, warum.

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const auth = require('../auth');

function nowIso() { return new Date().toISOString(); }

module.exports = function createInventurRouter(broadcast, homebox) {
  const r = express.Router();
  r.use(auth.requireAuth);

  r.get('/', (_req, res) => {
    const liste = db.listInventuren()
      .map(i => ({ ...i, positionen: undefined, anzahlPositionen: Object.keys(i.positionen || {}).length }))
      .sort((a, b) => String(b.gestartetAm).localeCompare(String(a.gestartetAm)));
    res.json(liste);
  });

  r.get('/:id', (req, res) => {
    const i = db.getInventur(req.params.id);
    if (!i) return res.status(404).json({ error: 'Inventur nicht gefunden.' });
    res.json(i);
  });

  r.post('/', (req, res) => {
    const { titel, ortId, ortName } = req.body || {};
    // Mehrere offene Läufe wären ein Rezept für doppelt gezählte Regale.
    const offen = db.listInventuren().find(i => !i.abgeschlossenAm);
    if (offen) {
      return res.status(409).json({
        error: `Es läuft bereits eine Inventur („${offen.titel}", begonnen am ${String(offen.gestartetAm).slice(0, 10)}). Bitte erst abschließen oder abbrechen.`,
        id: offen.id,
      });
    }
    const i = {
      id: crypto.randomUUID(),
      titel: String(titel || '').trim() || `Inventur ${new Date().getFullYear()}`,
      // Ohne Ort: der ganze Bestand. Mit Ort: nur dieser Ort und alles darunter.
      ortId: String(ortId || '').trim(),
      ortName: String(ortName || '').trim(),
      gestartetAm: nowIso(),
      gestartetVon: req.benutzer.name,
      abgeschlossenAm: '',
      abgeschlossenVon: '',
      uebernommenAm: '',
      positionen: {},
      schemaVersion: 1,
    };
    db.saveInventur(i);
    broadcast({ type: 'inventur:save', id: i.id, origin: req.header('x-client-id') || '' });
    res.json(i);
  });

  // Eine Position zählen. `soll` kommt vom Client mit, weil nur er den Artikel
  // gerade in der Hand hatte — beim ERSTEN Mal wird er festgehalten, danach
  // nicht mehr überschrieben.
  r.post('/:id/position', (req, res) => {
    const i = db.getInventur(req.params.id);
    if (!i) return res.status(404).json({ error: 'Inventur nicht gefunden.' });
    if (i.abgeschlossenAm) return res.status(409).json({ error: 'Diese Inventur ist bereits abgeschlossen.' });

    const { artikelId, artikelName, ortName, soll, ist, notiz } = req.body || {};
    if (!artikelId) return res.status(400).json({ error: 'Es fehlt der Artikel.' });

    const vorher = i.positionen[artikelId];
    i.positionen[artikelId] = {
      artikelId,
      artikelName: String(artikelName || (vorher && vorher.artikelName) || '').trim(),
      ortName: String(ortName || (vorher && vorher.ortName) || '').trim(),
      // Schnappschuss: einmal gesetzt, bleibt er.
      soll: vorher && vorher.soll != null ? vorher.soll : (Number(soll) || 0),
      ist: ist === null || ist === undefined || ist === '' ? null : Math.max(0, Number(ist) || 0),
      notiz: String(notiz || '').trim(),
      gezaehltAm: nowIso(),
      gezaehltVon: req.benutzer.name,
    };
    i.lastModifiedAt = nowIso();
    db.saveInventur(i);
    broadcast({ type: 'inventur:position', id: i.id, artikelId, origin: req.header('x-client-id') || '' });
    res.json(i.positionen[artikelId]);
  });

  r.delete('/:id/position/:artikelId', (req, res) => {
    const i = db.getInventur(req.params.id);
    if (!i) return res.status(404).json({ error: 'Inventur nicht gefunden.' });
    if (i.abgeschlossenAm) return res.status(409).json({ error: 'Diese Inventur ist bereits abgeschlossen.' });
    delete i.positionen[req.params.artikelId];
    i.lastModifiedAt = nowIso();
    db.saveInventur(i);
    res.json({ ok: true });
  });

  r.post('/:id/abschliessen', (req, res) => {
    const i = db.getInventur(req.params.id);
    if (!i) return res.status(404).json({ error: 'Inventur nicht gefunden.' });
    if (i.abgeschlossenAm) return res.status(409).json({ error: 'Diese Inventur ist bereits abgeschlossen.' });
    i.abgeschlossenAm = nowIso();
    i.abgeschlossenVon = req.benutzer.name;
    i.lastModifiedAt = nowIso();
    db.saveInventur(i);
    broadcast({ type: 'inventur:save', id: i.id, origin: req.header('x-client-id') || '' });
    res.json(i);
  });

  // Gezählte Bestände nach Homebox schreiben. Bewusst ein EIGENER Schritt und
  // nicht Teil des Abschlusses: Zählen und Buchen sind zwei Entscheidungen.
  // Wer eine Abweichung erst klären will, schließt ab und übernimmt später.
  //
  // Geschrieben wird ABSOLUT (die gezählte Menge ist die Wahrheit) — anders als
  // im Alltag, wo relativ gebucht wird. Genau dafür ist eine Inventur da.
  r.post('/:id/uebernehmen', async (req, res) => {
    const i = db.getInventur(req.params.id);
    if (!i) return res.status(404).json({ error: 'Inventur nicht gefunden.' });
    if (!i.abgeschlossenAm) return res.status(409).json({ error: 'Bitte die Inventur zuerst abschließen.' });
    if (i.uebernommenAm) return res.status(409).json({ error: 'Die Bestände wurden bereits übernommen.' });

    const abweichungen = Object.values(i.positionen)
      .filter(p => p.ist != null && p.ist !== p.soll);

    const ergebnisse = [];
    for (const p of abweichungen) {
      try {
        await homebox.bestandAendern(p.artikelId, { menge: p.ist });
        ergebnisse.push({ artikelId: p.artikelId, artikelName: p.artikelName, ok: true, neu: p.ist });
      } catch (e) {
        // Einzelne Fehlschläge dürfen den Rest nicht aufhalten — und sie
        // müssen benannt werden, sonst hielte man den Bestand für berichtigt.
        ergebnisse.push({ artikelId: p.artikelId, artikelName: p.artikelName, ok: false, fehler: e.message });
      }
    }

    const fehler = ergebnisse.filter(e => !e.ok).length;
    // Nur als übernommen markieren, wenn wirklich alles durchging. Sonst bleibt
    // der Weg offen, es nach dem Beheben erneut zu versuchen.
    if (!fehler) {
      i.uebernommenAm = nowIso();
      i.uebernommenVon = req.benutzer.name;
      i.lastModifiedAt = nowIso();
      db.saveInventur(i);
    }
    res.json({ uebernommen: ergebnisse.length - fehler, fehler, ergebnisse });
  });

  // Abbrechen = löschen. Eine abgebrochene Zählung hat keinen Wert, und sie
  // stehen zu lassen hieße, die Liste der Läufe mit Ruinen zu füllen.
  r.delete('/:id', auth.requireRolle('admin'), (req, res) => {
    const i = db.getInventur(req.params.id);
    if (!i) return res.status(404).json({ error: 'Inventur nicht gefunden.' });
    db.deleteInventur(i.id);
    broadcast({ type: 'inventur:delete', id: i.id, origin: req.header('x-client-id') || '' });
    res.json({ ok: true });
  });

  return r;
};
