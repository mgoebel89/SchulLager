'use strict';

// Anmeldung, Sitzungen, Rollen.
//
// Anders als bei Imkerei und Gemeindeverwaltung steht dieser Container in einem
// ÖFFENTLICHEN Schulnetz. Es gibt hier also echte Nutzerverwaltung statt eines
// PIN-Umschalters.
//
// Bewusste Entscheidungen:
//
// * Passwort-Hash mit `crypto.scrypt` — Bordmittel von Node. bcrypt/argon2
//   wären ebenbürtig, brauchen aber eine native Erweiterung, die beim
//   npm install im LXC übersetzt werden müsste. better-sqlite3 ist schon eine
//   solche Abhängigkeit; eine zweite wollen wir uns nicht einhandeln.
// * Sitzungstoken im HttpOnly-Cookie, der HASH davon in der Datenbank. Ein
//   gestohlenes Backup gibt damit keine gültige Sitzung her.
// * Lange Laufzeit (30 Tage). Wer mit dem Handy im Lager steht, soll scannen
//   und nicht tippen. Abmelden verwirft die Sitzung serverseitig.

const crypto = require('crypto');
const db = require('./db');

const COOKIE = 'sl_sitzung';
const SITZUNG_TAGE = 30;
const SCRYPT_LEN = 64;

const ROLLEN = ['admin', 'lehrkraft'];

// --- Passwörter -----------------------------------------------------------
function hashPasswort(passwort, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(passwort), s, SCRYPT_LEN).toString('hex');
  return { passHash: hash, passSalt: s };
}

// Vergleich in konstanter Zeit. Bei ungleicher Länge würde timingSafeEqual
// werfen, deshalb vorher prüfen.
function passwortStimmt(passwort, benutzerZeile) {
  if (!benutzerZeile || !benutzerZeile.pass_hash || !benutzerZeile.pass_salt) return false;
  const { passHash } = hashPasswort(passwort, benutzerZeile.pass_salt);
  const a = Buffer.from(passHash, 'hex');
  const b = Buffer.from(benutzerZeile.pass_hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Mindestanforderung bewusst schlicht: acht Zeichen. Komplexitätsregeln
// erzeugen erfahrungsgemäß Zettel am Monitor, keine besseren Passwörter.
function pruefePasswort(passwort) {
  const p = String(passwort || '');
  if (p.length < 8) return 'Das Passwort muss mindestens 8 Zeichen haben.';
  return null;
}

// --- Sitzungen ------------------------------------------------------------
function tokenHashen(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function sitzungAnlegen(benutzerId, userAgent) {
  const token = crypto.randomBytes(32).toString('base64url');
  const gueltigBis = new Date(Date.now() + SITZUNG_TAGE * 86400000).toISOString();
  db.insertSitzung({ tokenHash: tokenHashen(token), benutzerId, gueltigBis, userAgent });
  return { token, gueltigBis };
}

function sitzungBeenden(token) {
  if (token) db.deleteSitzung(tokenHashen(token));
}

// Liefert den Benutzer zur Sitzung — oder null. Abgelaufene Sitzungen werden
// gleich entfernt; ein gesperrter Benutzer gilt sofort als abgemeldet, ohne
// dass jemand seine Sitzungen von Hand löschen müsste.
function benutzerZuToken(token) {
  if (!token) return null;
  const s = db.getSitzung(tokenHashen(token));
  if (!s) return null;
  if (new Date(s.gueltigBis).getTime() < Date.now()) {
    db.deleteSitzung(s.tokenHash);
    return null;
  }
  const b = db.getBenutzer(s.benutzerId);
  if (!b || !b.aktiv) return null;
  return b;
}

// --- Cookie ---------------------------------------------------------------
// `Secure` nur setzen, wenn die Verbindung wirklich verschlüsselt ist: im
// Container läuft alles über nginx mit TLS, beim lokalen Test aber über
// http://localhost — dort würde ein Secure-Cookie schlicht verworfen und die
// Anmeldung wirkte kaputt. nginx meldet das Schema über X-Forwarded-Proto.
function istSicher(req) {
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function cookieSetzen(req, res, token, gueltigBis) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: istSicher(req),
    expires: new Date(gueltigBis),
    path: '/',
  });
}

function cookieLoeschen(req, res) {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: istSicher(req), path: '/' });
}

// --- Middleware -----------------------------------------------------------
// Hängt req.benutzer an, wenn eine gültige Sitzung besteht. Läuft für JEDE
// Anfrage, auch für die öffentlichen — die Oberfläche soll ja wissen, ob
// jemand angemeldet ist.
function sitzungLesen(req, _res, next) {
  const token = req.cookies ? req.cookies[COOKIE] : '';
  req.sitzungToken = token || '';
  req.benutzer = benutzerZuToken(token);
  next();
}

function requireAuth(req, res, next) {
  if (!req.benutzer) return res.status(401).json({ error: 'Nicht angemeldet.' });
  // Wer sein Startpasswort noch nicht gewechselt hat, kommt nur an den
  // Passwortwechsel — sonst bliebe das vom Admin vergebene Kennwort ewig gültig.
  if (req.benutzer.mussWechseln) {
    return res.status(403).json({ error: 'Bitte zuerst das Passwort ändern.', code: 'passwort-wechseln' });
  }
  next();
}

function requireRolle(rolle) {
  return (req, res, next) => {
    if (!req.benutzer) return res.status(401).json({ error: 'Nicht angemeldet.' });
    if (req.benutzer.mussWechseln) {
      return res.status(403).json({ error: 'Bitte zuerst das Passwort ändern.', code: 'passwort-wechseln' });
    }
    if (req.benutzer.rolle !== rolle) return res.status(403).json({ error: 'Dafür fehlt die Berechtigung.' });
    next();
  };
}

// --- Anmeldeversuche bremsen ---------------------------------------------
// Kein externes Paket: eine Map im Speicher genügt für ein Kollegium. Nach
// einem Neustart ist die Sperre weg — das ist hier kein Problem, denn der
// Angreifer kann den Neustart nicht auslösen.
const versuche = new Map();
const MAX_VERSUCHE = 10;
const FENSTER_MS = 15 * 60 * 1000;

function versuchErlaubt(schluessel) {
  const e = versuche.get(schluessel);
  if (!e) return true;
  if (Date.now() - e.seit > FENSTER_MS) { versuche.delete(schluessel); return true; }
  return e.n < MAX_VERSUCHE;
}
function versuchZaehlen(schluessel) {
  const e = versuche.get(schluessel);
  if (!e || Date.now() - e.seit > FENSTER_MS) versuche.set(schluessel, { n: 1, seit: Date.now() });
  else e.n += 1;
}
function versucheZuruecksetzen(schluessel) {
  versuche.delete(schluessel);
}

module.exports = {
  COOKIE, ROLLEN, SITZUNG_TAGE,
  hashPasswort, passwortStimmt, pruefePasswort,
  sitzungAnlegen, sitzungBeenden, benutzerZuToken,
  cookieSetzen, cookieLoeschen,
  sitzungLesen, requireAuth, requireRolle,
  versuchErlaubt, versuchZaehlen, versucheZuruecksetzen,
};
