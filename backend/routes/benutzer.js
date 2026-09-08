'use strict';

// Benutzerverwaltung — nur für Admins.
//
// Kollegen bekommen ihr Konto vom Admin angelegt (so entschieden), inklusive
// Startpasswort. `mussWechseln` zwingt beim ersten Anmelden zum Wechsel; bis
// dahin lässt requireAuth niemanden an die Fachdaten.

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const auth = require('../auth');
const { pruefeNeuenBenutzer } = require('./auth');

module.exports = function createBenutzerRouter() {
  const r = express.Router();
  r.use(auth.requireRolle('admin'));

  r.get('/', (_req, res) => res.json(db.listBenutzer()));

  r.post('/', (req, res) => {
    const { benutzername, name, rolle, passwort } = req.body || {};
    const fehler = pruefeNeuenBenutzer({ benutzername, name });
    if (fehler) return res.status(400).json({ error: fehler });
    if (!auth.ROLLEN.includes(rolle)) return res.status(400).json({ error: 'Unbekannte Rolle.' });
    const pwFehler = auth.pruefePasswort(passwort);
    if (pwFehler) return res.status(400).json({ error: `Startpasswort: ${pwFehler}` });

    const { passHash, passSalt } = auth.hashPasswort(passwort);
    const benutzer = db.insertBenutzer({
      id: crypto.randomUUID(),
      benutzername, name, rolle,
      passHash, passSalt,
      mussWechseln: true,     // das vom Admin vergebene Kennwort ist ein Startwert
    });
    res.json(benutzer);
  });

  r.put('/:id', (req, res) => {
    const ziel = db.getBenutzer(req.params.id);
    if (!ziel) return res.status(404).json({ error: 'Benutzer nicht gefunden.' });
    const { name, rolle, aktiv } = req.body || {};
    if (rolle !== undefined && !auth.ROLLEN.includes(rolle)) {
      return res.status(400).json({ error: 'Unbekannte Rolle.' });
    }
    if (name !== undefined && !String(name).trim()) {
      return res.status(400).json({ error: 'Bitte einen Anzeigenamen angeben.' });
    }

    // Der letzte aktive Admin darf sich weder degradieren noch sperren — sonst
    // kommt niemand mehr an die Benutzerverwaltung, und es hilft nur noch ein
    // Eingriff in der SQLite-Datei.
    const verliertAdmin = (rolle !== undefined && rolle !== 'admin') || aktiv === false;
    if (ziel.rolle === 'admin' && ziel.aktiv && verliertAdmin && db.zaehleAdmins({ ausser: ziel.id }) === 0) {
      return res.status(400).json({ error: 'Das ist der letzte Administrator — bitte zuerst einen weiteren anlegen.' });
    }

    const neu = db.updateBenutzer(req.params.id, { name, rolle, aktiv });
    // Gesperrte Konten sofort abmelden, nicht erst beim Ablauf der Sitzung.
    if (aktiv === false) db.deleteSitzungenVon(req.params.id);
    res.json(neu);
  });

  // Passwort zurücksetzen (vergessen). Der Nutzer muss es danach wieder ändern,
  // und alle seine Sitzungen werden beendet.
  r.post('/:id/passwort', (req, res) => {
    const ziel = db.getBenutzer(req.params.id);
    if (!ziel) return res.status(404).json({ error: 'Benutzer nicht gefunden.' });
    const fehler = auth.pruefePasswort(req.body && req.body.passwort);
    if (fehler) return res.status(400).json({ error: fehler });

    const { passHash, passSalt } = auth.hashPasswort(req.body.passwort);
    db.setzePasswort(ziel.id, { passHash, passSalt, mussWechseln: true });
    db.deleteSitzungenVon(ziel.id);
    res.json(db.getBenutzer(ziel.id));
  });

  r.delete('/:id', (req, res) => {
    const ziel = db.getBenutzer(req.params.id);
    if (!ziel) return res.status(404).json({ error: 'Benutzer nicht gefunden.' });
    if (ziel.id === req.benutzer.id) {
      return res.status(400).json({ error: 'Das eigene Konto lässt sich nicht löschen.' });
    }
    if (ziel.rolle === 'admin' && ziel.aktiv && db.zaehleAdmins({ ausser: ziel.id }) === 0) {
      return res.status(400).json({ error: 'Das ist der letzte Administrator — bitte zuerst einen weiteren anlegen.' });
    }
    db.deleteBenutzer(ziel.id);
    res.json({ ok: true });
  });

  return r;
};
