'use strict';

// Ausleihe und Defektmeldungen.
//
// Beides liegt in UNSERER Datenbank, nicht in Homebox: Homebox kennt keinen
// Begriff für „ist gerade bei jemandem". Der Artikel selbst bleibt dort
// unverändert stehen.
//
// WICHTIGE ENTSCHEIDUNG: Eine Ausleihe verändert den Bestand NICHT.
// Ein Demonstrator, der bei einer Kollegin im Unterricht steht, gehört
// weiterhin zum Inventar — er ist nur gerade nicht im Schrank. Wer
// Verbrauchsmaterial dauerhaft entnimmt, benutzt dafür die Entnahme, die den
// Bestand sehr wohl senkt. Würden beide Wege am Bestand rechnen, wäre nach
// einem halben Jahr niemand mehr in der Lage zu sagen, was die Zahl bedeutet.
//
// Alles hier verlangt eine Anmeldung — auch das Lesen. Wer was ausgeliehen
// hat, ist eine Personenangabe und gehört nicht ins offene Schulnetz.

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const auth = require('../auth');

function nowIso() { return new Date().toISOString(); }

module.exports = function createAusleiheRouter(broadcast) {
  const r = express.Router();
  r.use(auth.requireAuth);

  // --- Ausleihen und Ausgaben ---------------------------------------------
  // ZWEI VORGÄNGE, EINE TABELLE, unterschieden durch `art`:
  //
  //   ausleihe   Schuldemonstrator geht an eine Lehrkraft und kommt zurück.
  //              Hat eine Frist, wird zurückgebucht, taucht in der
  //              Überfälligkeitsliste auf. Der Bestand bleibt unverändert.
  //   ausgabe    Verbrauchsmaterial geht an eine Klasse und kommt NICHT zurück
  //              (Widerstände, die verlötet werden). Die Menge ist bereits über
  //              die Entnahme vom Bestand abgebucht; dieser Eintrag ist reine
  //              Dokumentation — wer hat wann wie viel wofür bekommen.
  //
  // Sie in einer Tabelle zu führen, hält die Geschichte eines Artikels an einer
  // Stelle. Getrennt würde man beim Nachschauen immer beide durchsehen müssen.
  r.get('/', (req, res) => {
    const alle = db.listAusleihen();
    const art = req.query.art || '';
    let liste = art ? alle.filter(a => (a.art || 'ausleihe') === art) : alle;
    // Voreinstellung sind die offenen Ausleihen: das ist die Frage, die im
    // Alltag gestellt wird („wer hat das Ding?"). Ausgaben sind nie offen —
    // sie werden nur zurückgegeben, wenn man sie ausdrücklich anfordert.
    if (req.query.alle !== '1') {
      liste = liste.filter(a => (a.art || 'ausleihe') === 'ausleihe' && !a.zurueckAm);
    }
    // Ausleihen nach Frist (das Dringendste zuerst), Ausgaben nach Datum.
    liste.sort((a, b) => String(a.faelligAm || a.ausgeliehenAm || '9999')
      .localeCompare(String(b.faelligAm || b.ausgeliehenAm || '9999')));
    res.json(liste);
  });

  r.post('/', (req, res) => {
    const { artikelId, artikelName, artikelCode, menge, klasse, faelligAm, notiz, preis } = req.body || {};
    const art = (req.body && req.body.art) === 'ausgabe' ? 'ausgabe' : 'ausleihe';
    if (!artikelId) return res.status(400).json({ error: 'Es fehlt der Artikel.' });

    // Ein Gerät kann nicht zweimal gleichzeitig verliehen sein. Das ist keine
    // Formalität: sonst zeigt die Liste zwei Entleiher für dasselbe Stück, und
    // niemand weiß, wer es wirklich hat.
    //
    // Für Ausgaben gilt das NICHT: dieselbe Sorte Widerstände kann am selben
    // Tag an drei Klassen gehen.
    if (art === 'ausleihe') {
      const laeuft = db.listAusleihen()
        .find(a => a.artikelId === artikelId && (a.art || 'ausleihe') === 'ausleihe' && !a.zurueckAm);
      if (laeuft) {
        return res.status(409).json({
          error: `Der Artikel ist bereits an ${laeuft.benutzerName} ausgeliehen (seit ${String(laeuft.ausgeliehenAm).slice(0, 10)}).`,
        });
      }
    }

    const eintrag = {
      id: crypto.randomUUID(),
      art,
      artikelId,
      // Bezeichnung und Kennung werden MITGESCHRIEBEN, nicht nur verwiesen:
      // die Ausleihliste muss auch dann lesbar bleiben, wenn Homebox gerade
      // nicht antwortet oder der Artikel dort umbenannt wurde.
      artikelName: String(artikelName || '').trim(),
      artikelCode: String(artikelCode || '').trim(),
      menge: Math.max(1, parseInt(menge, 10) || 1),
      // Preis zum Zeitpunkt der Ausgabe MITSCHREIBEN, nicht später nachschlagen:
      // eine Abrechnung vom Mai darf sich nicht ändern, weil im Oktober neu
      // eingekauft wurde.
      preis: (preis === null || preis === undefined || preis === '') ? null : Number(preis),
      benutzerId: req.benutzer.id,
      benutzerName: req.benutzer.name,
      klasse: String(klasse || '').trim(),
      notiz: String(notiz || '').trim(),
      ausgeliehenAm: nowIso(),
      // Eine Ausgabe hat keine Frist — sie kommt ja nicht zurück.
      faelligAm: art === 'ausleihe' ? (faelligAm || '') : '',
      zurueckAm: '',
      zurueckVon: '',
      erstelltAm: nowIso(),
      schemaVersion: 1,
    };
    db.saveAusleihe(eintrag);
    broadcast({ type: 'ausleihe:save', ausleihe: eintrag, origin: req.header('x-client-id') || '' });
    res.json(eintrag);
  });

  r.post('/:id/rueckgabe', (req, res) => {
    const a = db.getAusleihe(req.params.id);
    if (!a) return res.status(404).json({ error: 'Ausleihe nicht gefunden.' });
    if (a.zurueckAm) return res.status(409).json({ error: 'Diese Ausleihe ist schon zurückgebucht.' });
    if ((a.art || 'ausleihe') === 'ausgabe') {
      return res.status(409).json({ error: 'Das war eine Ausgabe — sie kommt nicht zurück. Eingegangenes Material bitte als Zugang buchen.' });
    }

    // Zurücknehmen darf jeder Angemeldete, nicht nur der Entleiher: das Gerät
    // steht im Zweifel wieder im Schrank, und wer es einräumt, ist selten der,
    // der es geholt hat.
    a.zurueckAm = nowIso();
    a.zurueckVon = req.benutzer.name;
    a.lastModifiedAt = nowIso();
    db.saveAusleihe(a);
    broadcast({ type: 'ausleihe:save', ausleihe: a, origin: req.header('x-client-id') || '' });
    res.json(a);
  });

  // Löschen ist die Korrektur für Fehleingaben — die Rückgabe ist der normale
  // Weg. Deshalb Admins vorbehalten.
  r.delete('/:id', auth.requireRolle('admin'), (req, res) => {
    const a = db.getAusleihe(req.params.id);
    if (!a) return res.status(404).json({ error: 'Ausleihe nicht gefunden.' });
    db.deleteAusleihe(a.id);
    broadcast({ type: 'ausleihe:delete', id: a.id, origin: req.header('x-client-id') || '' });
    res.json({ ok: true });
  });

  // --- Defektmeldungen ----------------------------------------------------
  r.get('/defekte', (req, res) => {
    const alle = db.listDefekte();
    const liste = req.query.alle === '1' ? alle : alle.filter(d => !d.behobenAm);
    liste.sort((a, b) => String(b.gemeldetAm).localeCompare(String(a.gemeldetAm)));
    res.json(liste);
  });

  r.post('/defekte', (req, res) => {
    const { artikelId, artikelName, notiz } = req.body || {};
    if (!artikelId) return res.status(400).json({ error: 'Es fehlt der Artikel.' });
    if (!String(notiz || '').trim()) {
      return res.status(400).json({ error: 'Bitte beschreiben, was defekt ist — ohne Beschreibung hilft die Meldung niemandem.' });
    }
    const d = {
      id: crypto.randomUUID(),
      artikelId,
      artikelName: String(artikelName || '').trim(),
      notiz: String(notiz).trim(),
      gemeldetVon: req.benutzer.name,
      gemeldetAm: nowIso(),
      behobenAm: '',
      behobenVon: '',
      schemaVersion: 1,
    };
    db.saveDefekt(d);
    broadcast({ type: 'defekt:save', defekt: d, origin: req.header('x-client-id') || '' });
    res.json(d);
  });

  r.post('/defekte/:id/behoben', (req, res) => {
    const d = db.getDefekt(req.params.id);
    if (!d) return res.status(404).json({ error: 'Meldung nicht gefunden.' });
    d.behobenAm = nowIso();
    d.behobenVon = req.benutzer.name;
    d.lastModifiedAt = nowIso();
    db.saveDefekt(d);
    broadcast({ type: 'defekt:save', defekt: d, origin: req.header('x-client-id') || '' });
    res.json(d);
  });

  return r;
};
