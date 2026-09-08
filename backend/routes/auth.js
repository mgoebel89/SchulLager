'use strict';

// Anmelden, Abmelden, Passwort ändern, Ersteinrichtung.

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const auth = require('../auth');

module.exports = function createAuthRouter() {
  const r = express.Router();

  // Wer bin ich? Beantwortet auch die Frage, ob überhaupt schon jemand
  // eingerichtet ist — daran hängt der Ersteinrichtungs-Bildschirm.
  r.get('/ich', (req, res) => {
    res.json({
      benutzer: req.benutzer || null,
      eingerichtet: db.zaehleBenutzer() > 0,
    });
  });

  // Ersteinrichtung: der allererste Admin. Möglich NUR solange es keinen
  // einzigen Benutzer gibt — danach antwortet die Route mit 409. Damit braucht
  // der Installer kein Startpasswort auszugeben, und es gibt trotzdem kein
  // offenes Scheunentor: sobald ein Konto existiert, ist der Weg zu.
  r.post('/ersteinrichtung', (req, res) => {
    if (db.zaehleBenutzer() > 0) {
      return res.status(409).json({ error: 'Es gibt bereits Benutzer — bitte anmelden.' });
    }
    const { benutzername, name, passwort } = req.body || {};
    const fehler = pruefeNeuenBenutzer({ benutzername, name });
    if (fehler) return res.status(400).json({ error: fehler });
    const pwFehler = auth.pruefePasswort(passwort);
    if (pwFehler) return res.status(400).json({ error: pwFehler });

    const { passHash, passSalt } = auth.hashPasswort(passwort);
    const benutzer = db.insertBenutzer({
      id: crypto.randomUUID(),
      benutzername, name, rolle: 'admin',
      passHash, passSalt, mussWechseln: false,
    });
    const { token, gueltigBis } = auth.sitzungAnlegen(benutzer.id, req.headers['user-agent']);
    auth.cookieSetzen(req, res, token, gueltigBis);
    db.merkeLogin(benutzer.id);
    res.json({ benutzer });
  });

  r.post('/anmelden', (req, res) => {
    const { benutzername, passwort } = req.body || {};
    const nutzer = String(benutzername || '').trim().toLowerCase();
    // Nach Konto UND Herkunft bremsen: sonst sperrt ein Angreifer durch bloßes
    // Raten fremde Kollegen aus (oder umgeht die Sperre per Kontowechsel).
    const schluessel = `${req.ip}|${nutzer}`;
    if (!auth.versuchErlaubt(schluessel)) {
      return res.status(429).json({ error: 'Zu viele Fehlversuche. Bitte in einigen Minuten erneut versuchen.' });
    }

    const zeile = db.getBenutzerMitHash(nutzer);
    const okPasswort = auth.passwortStimmt(passwort, zeile);
    // Ein gesperrtes Konto bekommt dieselbe Antwort wie ein falsches Passwort —
    // sonst verrät die Meldung, welche Konten es gibt.
    if (!zeile || !zeile.aktiv || !okPasswort) {
      auth.versuchZaehlen(schluessel);
      return res.status(401).json({ error: 'Benutzername oder Passwort stimmt nicht.' });
    }
    auth.versucheZuruecksetzen(schluessel);

    const { token, gueltigBis } = auth.sitzungAnlegen(zeile.id, req.headers['user-agent']);
    auth.cookieSetzen(req, res, token, gueltigBis);
    db.merkeLogin(zeile.id);
    res.json({ benutzer: db.getBenutzer(zeile.id) });
  });

  r.post('/abmelden', (req, res) => {
    auth.sitzungBeenden(req.sitzungToken);
    auth.cookieLoeschen(req, res);
    res.json({ ok: true });
  });

  // Passwortwechsel. Bewusst NICHT hinter requireAuth: wer sein Startpasswort
  // ändern muss, wird von requireAuth gerade abgewiesen — er käme sonst nie
  // an die einzige Stelle, die ihn wieder freischaltet.
  r.post('/passwort', (req, res) => {
    if (!req.benutzer) return res.status(401).json({ error: 'Nicht angemeldet.' });
    const { alt, neu } = req.body || {};
    const zeile = db.getBenutzerMitHashById(req.benutzer.id);
    if (!auth.passwortStimmt(alt, zeile)) {
      return res.status(400).json({ error: 'Das bisherige Passwort stimmt nicht.' });
    }
    const fehler = auth.pruefePasswort(neu);
    if (fehler) return res.status(400).json({ error: fehler });
    if (String(alt) === String(neu)) {
      return res.status(400).json({ error: 'Das neue Passwort muss sich vom bisherigen unterscheiden.' });
    }

    const { passHash, passSalt } = auth.hashPasswort(neu);
    db.setzePasswort(req.benutzer.id, { passHash, passSalt, mussWechseln: false });

    // Alle Sitzungen dieses Kontos beenden — ein Passwortwechsel soll ein
    // mitgelesenes Gerät auch wirklich aussperren. Für das Gerät, an dem gerade
    // gewechselt wird, sofort eine frische Sitzung anlegen, damit niemand
    // ausgerechnet nach dem richtigen Handgriff auf der Anmeldeseite landet.
    db.deleteSitzungenVon(req.benutzer.id);
    const { token, gueltigBis } = auth.sitzungAnlegen(req.benutzer.id, req.headers['user-agent']);
    auth.cookieSetzen(req, res, token, gueltigBis);
    res.json({ benutzer: db.getBenutzer(req.benutzer.id) });
  });

  return r;
};

// Gemeinsame Prüfung für Ersteinrichtung und Benutzerverwaltung.
function pruefeNeuenBenutzer({ benutzername, name }) {
  const u = String(benutzername || '').trim();
  if (u.length < 3) return 'Der Benutzername muss mindestens 3 Zeichen haben.';
  if (!/^[a-zA-Z0-9._-]+$/.test(u)) return 'Der Benutzername darf nur Buchstaben, Ziffern, Punkt, Bindestrich und Unterstrich enthalten.';
  if (!String(name || '').trim()) return 'Bitte einen Anzeigenamen angeben.';
  if (db.getBenutzerMitHash(u)) return 'Diesen Benutzernamen gibt es bereits.';
  return null;
}

module.exports.pruefeNeuenBenutzer = pruefeNeuenBenutzer;
