'use strict';

// Datenhaltung der Lagerverwaltung.
//
// GRUNDREGEL DIESES PROJEKTS: Homebox ist die Wahrheit über den Bestand.
// Artikel, Mengen, Lagerorte, Fotos und Anhänge liegen dort und werden hier
// NICHT kopiert — eine zweite Kopie hieße Abgleich, und Abgleich heißt
// Konflikte. Diese Datenbank hält ausschließlich das, was Homebox nicht kann:
//
//   benutzer, sitzungen   — Nutzerverwaltung (das Schulnetz ist öffentlich)
//   ausleihen             — wer hat was seit wann, bis wann        (Phase 4)
//   defekte               — Gerät ist in Reparatur                 (Phase 4)
//   inventuren            — Zähl-Läufe mit Soll/Ist                (Phase 5)
//   bestellungen          — Beschaffung samt Wareneingang           (Phase 6)
//   settings              — App-Einstellungen und Zugangsdaten
//
// Fachdaten liegen wie in den Schwesterprojekten als EIN JSON-Payload je Zeile.
// Das hält Schemaänderungen billig: ein neues Feld braucht keine Migration.
// Benutzer und Sitzungen sind die Ausnahme — dort wird nach Spalten gesucht
// und verglichen, deshalb sind sie echte Spalten.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/schullager';
const DB_PATH = path.join(DATA_DIR, 'data.db');
const ATTACH_DIR = path.join(DATA_DIR, 'attachments');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(ATTACH_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Nutzerverwaltung --------------------------------------------------------
  -- benutzername wird kleingeschrieben gespeichert und verglichen: niemand
  -- soll sich am zweiten Tag fragen, ob er "MGoebel" oder "mgoebel" hieß.
  CREATE TABLE IF NOT EXISTS benutzer (
    id              TEXT PRIMARY KEY,
    benutzername    TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    rolle           TEXT NOT NULL,
    pass_hash       TEXT NOT NULL,
    pass_salt       TEXT NOT NULL,
    muss_wechseln   INTEGER NOT NULL DEFAULT 0,
    aktiv           INTEGER NOT NULL DEFAULT 1,
    erstellt_am     TEXT NOT NULL,
    letzter_login   TEXT
  );

  -- Sitzungen liegen serverseitig, damit Abmelden auch wirklich abmeldet.
  -- Gespeichert wird der HASH des Tokens: wer die Datei in die Hand bekommt,
  -- kann sich damit trotzdem nicht anmelden.
  CREATE TABLE IF NOT EXISTS sitzungen (
    token_hash   TEXT PRIMARY KEY,
    benutzer_id  TEXT NOT NULL,
    erstellt_am  TEXT NOT NULL,
    gueltig_bis  TEXT NOT NULL,
    user_agent   TEXT,
    FOREIGN KEY (benutzer_id) REFERENCES benutzer(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_sitzungen_benutzer ON sitzungen(benutzer_id);

  -- Fachdaten (ab Phase 4/5 gefüllt) ----------------------------------------
  CREATE TABLE IF NOT EXISTS ausleihen (
    id            TEXT PRIMARY KEY,
    payload       TEXT NOT NULL,
    last_modified TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ausleihen_modified ON ausleihen(last_modified);

  CREATE TABLE IF NOT EXISTS defekte (
    id            TEXT PRIMARY KEY,
    payload       TEXT NOT NULL,
    last_modified TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS inventuren (
    id            TEXT PRIMARY KEY,
    payload       TEXT NOT NULL,
    last_modified TEXT NOT NULL
  );

  -- Komponenten eines Demonstrators (SPS, HMI, Switch ...).
  --
  -- Sie liegen hier und nicht in Homebox, weil Homebox für Netzangaben keinen
  -- Begriff hat und der Bestand sonst mit hunderten Einzelteilen aufgebläht
  -- würde. Wo eine Komponente doch einzeln gezählt oder etikettiert werden
  -- soll, trägt sie zusätzlich die ID ihres Homebox-Artikels.
  --
  -- ACHTUNG: Im Payload steht auf Wunsch auch ein Gerätepasswort — im
  -- Klartext. Damit enthält jede Sicherung dieser Datenbank die Passwörter
  -- lesbar. Siehe deploy/backup.sh.
  CREATE TABLE IF NOT EXISTS komponenten (
    id            TEXT PRIMARY KEY,
    payload       TEXT NOT NULL,
    last_modified TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_komponenten_modified ON komponenten(last_modified);

  -- Bestellungen mit ihren Positionen und dem Wareneingang.
  --
  -- Positionen liegen IM Payload und nicht in einer eigenen Tabelle: eine
  -- Bestellung ist ein Beleg, der als Ganzes gelesen, geändert und gedruckt
  -- wird — nie einzeln nach Positionen durchsucht.
  --
  -- Artikelname, Bestellnummer und Preis werden MITGESCHRIEBEN, statt nur auf
  -- Homebox zu verweisen. Zwei Gründe: die Liste muss lesbar bleiben, wenn
  -- Homebox gerade nicht antwortet, und eine Abrechnung vom Mai darf sich
  -- nicht ändern, weil im Oktober zu einem anderen Preis nachgekauft wurde.
  CREATE TABLE IF NOT EXISTS bestellungen (
    id            TEXT PRIMARY KEY,
    payload       TEXT NOT NULL,
    last_modified TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bestellungen_modified ON bestellungen(last_modified);
`);

function nowIso() { return new Date().toISOString(); }

// --- Generischer Payload-Store -------------------------------------------
function makePayloadStore(table) {
  return {
    list() { return db.prepare(`SELECT payload FROM ${table}`).all().map(r => JSON.parse(r.payload)); },
    get(id) {
      const r = db.prepare(`SELECT payload FROM ${table} WHERE id = ?`).get(id);
      return r ? JSON.parse(r.payload) : null;
    },
    save(obj) {
      if (!obj || !obj.id) throw new Error(`${table}.id fehlt`);
      if (!obj.lastModifiedAt) obj.lastModifiedAt = nowIso();
      db.prepare(`
        INSERT INTO ${table} (id, payload, last_modified) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, last_modified = excluded.last_modified
      `).run(obj.id, JSON.stringify(obj), obj.lastModifiedAt);
      return obj;
    },
    delete(id) { db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id); },
  };
}

// --- Einstellungen --------------------------------------------------------
function getSettings() {
  const r = db.prepare("SELECT value FROM settings WHERE key = 'settings'").get();
  return r ? JSON.parse(r.value) : null;
}
function saveSettings(s) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('settings', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(JSON.stringify(s));
  return s;
}

// Zugangsdaten fremder Dienste liegen unter EIGENEN Schlüsseln, nie im
// allgemeinen Einstellungs-Blob: der geht per Snapshot ans Frontend. Homebox
// verlangt Benutzername und Passwort (dauerhafte Tokens kennt es nicht), das
// Passwort darf den Server also nie verlassen.
function makeConfigStore(key) {
  return {
    get() {
      const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return r ? JSON.parse(r.value) : null;
    },
    save(c) {
      db.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(key, JSON.stringify(c));
      return c;
    },
  };
}
const homeboxConfig = makeConfigStore('homebox');
const druckerConfig = makeConfigStore('drucker');
// Paperless: EIN Zugang für die ganze Schule, vom Admin gepflegt. Der Token
// ist ein Geheimnis wie das Homebox-Passwort und verlässt den Server nicht.
const paperlessConfig = makeConfigStore('paperless');

// --- Benutzer -------------------------------------------------------------
const BENUTZER_SPALTEN = `
  id, benutzername, name, rolle,
  muss_wechseln AS mussWechseln, aktiv,
  erstellt_am AS erstelltAm, letzter_login AS letzterLogin
`;

// SQLite kennt kein boolean — an der Grenze zum Frontend umwandeln, damit im
// Rest der App nicht ständig 0/1 gegen true/false geprüft werden muss.
function entschaerfen(r) {
  return { ...r, mussWechseln: !!r.mussWechseln, aktiv: !!r.aktiv };
}

function listBenutzer() {
  return db.prepare(`SELECT ${BENUTZER_SPALTEN} FROM benutzer ORDER BY name COLLATE NOCASE`).all()
    .map(entschaerfen);
}
function getBenutzer(id) {
  const r = db.prepare(`SELECT ${BENUTZER_SPALTEN} FROM benutzer WHERE id = ?`).get(id);
  return r ? entschaerfen(r) : null;
}
// Mit Hash — nur für die Anmeldung und den Passwortwechsel.
function getBenutzerMitHash(benutzername) {
  return db.prepare('SELECT * FROM benutzer WHERE benutzername = ?')
    .get(String(benutzername || '').trim().toLowerCase()) || null;
}
function getBenutzerMitHashById(id) {
  return db.prepare('SELECT * FROM benutzer WHERE id = ?').get(id) || null;
}
function zaehleBenutzer() {
  return db.prepare('SELECT COUNT(*) AS n FROM benutzer').get().n;
}
// Wie viele aktive Admins gäbe es noch, wenn `ausser` wegfiele? Damit sich der
// letzte Admin nicht selbst aussperrt.
function zaehleAdmins({ ausser } = {}) {
  return ausser
    ? db.prepare("SELECT COUNT(*) AS n FROM benutzer WHERE rolle = 'admin' AND aktiv = 1 AND id <> ?").get(ausser).n
    : db.prepare("SELECT COUNT(*) AS n FROM benutzer WHERE rolle = 'admin' AND aktiv = 1").get().n;
}

function insertBenutzer({ id, benutzername, name, rolle, passHash, passSalt, mussWechseln }) {
  db.prepare(`
    INSERT INTO benutzer (id, benutzername, name, rolle, pass_hash, pass_salt, muss_wechseln, aktiv, erstellt_am)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(id, String(benutzername).trim().toLowerCase(), name, rolle, passHash, passSalt, mussWechseln ? 1 : 0, nowIso());
  return getBenutzer(id);
}

function updateBenutzer(id, { name, rolle, aktiv }) {
  const b = getBenutzerMitHashById(id);
  if (!b) return null;
  db.prepare('UPDATE benutzer SET name = ?, rolle = ?, aktiv = ? WHERE id = ?').run(
    name !== undefined ? name : b.name,
    rolle !== undefined ? rolle : b.rolle,
    aktiv !== undefined ? (aktiv ? 1 : 0) : b.aktiv,
    id,
  );
  return getBenutzer(id);
}

function setzePasswort(id, { passHash, passSalt, mussWechseln }) {
  db.prepare('UPDATE benutzer SET pass_hash = ?, pass_salt = ?, muss_wechseln = ? WHERE id = ?')
    .run(passHash, passSalt, mussWechseln ? 1 : 0, id);
  return getBenutzer(id);
}

function merkeLogin(id) {
  db.prepare('UPDATE benutzer SET letzter_login = ? WHERE id = ?').run(nowIso(), id);
}

function deleteBenutzer(id) {
  db.prepare('DELETE FROM benutzer WHERE id = ?').run(id);   // Sitzungen fallen per CASCADE mit
}

// --- Sitzungen ------------------------------------------------------------
function insertSitzung({ tokenHash, benutzerId, gueltigBis, userAgent }) {
  db.prepare('INSERT INTO sitzungen (token_hash, benutzer_id, erstellt_am, gueltig_bis, user_agent) VALUES (?, ?, ?, ?, ?)')
    .run(tokenHash, benutzerId, nowIso(), gueltigBis, String(userAgent || '').slice(0, 200));
}
function getSitzung(tokenHash) {
  return db.prepare('SELECT token_hash AS tokenHash, benutzer_id AS benutzerId, gueltig_bis AS gueltigBis FROM sitzungen WHERE token_hash = ?')
    .get(tokenHash) || null;
}
function deleteSitzung(tokenHash) {
  db.prepare('DELETE FROM sitzungen WHERE token_hash = ?').run(tokenHash);
}
function deleteSitzungenVon(benutzerId) {
  db.prepare('DELETE FROM sitzungen WHERE benutzer_id = ?').run(benutzerId);
}
// Abgelaufene Sitzungen wegräumen. Läuft beim Start und danach stündlich —
// sonst wächst die Tabelle mit jedem Handy, das sich je angemeldet hat.
function raeumeSitzungen() {
  db.prepare('DELETE FROM sitzungen WHERE gueltig_bis < ?').run(nowIso());
}

// --- Fachdaten ------------------------------------------------------------
const ausleihenStore = makePayloadStore('ausleihen');
const defekteStore = makePayloadStore('defekte');
const inventurenStore = makePayloadStore('inventuren');
const komponentenStore = makePayloadStore('komponenten');
const bestellungenStore = makePayloadStore('bestellungen');

module.exports = {
  DATA_DIR, ATTACH_DIR,
  makePayloadStore,
  getSettings, saveSettings,
  getHomeboxConfig: homeboxConfig.get, saveHomeboxConfig: homeboxConfig.save,
  getDruckerConfig: druckerConfig.get, saveDruckerConfig: druckerConfig.save,
  getPaperlessConfig: paperlessConfig.get, savePaperlessConfig: paperlessConfig.save,
  listBenutzer, getBenutzer, getBenutzerMitHash, getBenutzerMitHashById,
  zaehleBenutzer, zaehleAdmins,
  insertBenutzer, updateBenutzer, setzePasswort, merkeLogin, deleteBenutzer,
  insertSitzung, getSitzung, deleteSitzung, deleteSitzungenVon, raeumeSitzungen,
  listAusleihen: ausleihenStore.list, getAusleihe: ausleihenStore.get,
  saveAusleihe: ausleihenStore.save, deleteAusleihe: ausleihenStore.delete,
  listDefekte: defekteStore.list, getDefekt: defekteStore.get,
  saveDefekt: defekteStore.save, deleteDefekt: defekteStore.delete,
  listInventuren: inventurenStore.list, getInventur: inventurenStore.get,
  saveInventur: inventurenStore.save, deleteInventur: inventurenStore.delete,
  listKomponenten: komponentenStore.list, getKomponente: komponentenStore.get,
  saveKomponente: komponentenStore.save, deleteKomponente: komponentenStore.delete,
  listBestellungen: bestellungenStore.list, getBestellung: bestellungenStore.get,
  saveBestellung: bestellungenStore.save, deleteBestellung: bestellungenStore.delete,
};
