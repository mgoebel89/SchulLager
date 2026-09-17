'use strict';

// Netzwerkgeräte: was im Netz der Schule hängt — Profinet-Teilnehmer, Roboter
// und PCs.
//
// GRUNDENTSCHEIDUNG (mit Matthias, 2026-09-17): JEDES Netzwerkgerät ist ein
// eigener Homebox-Artikel. Ich hatte davon abgeraten (der Bestand wächst um
// jedes IO-Modul), Matthias hat anders entschieden — und der Gewinn ist
// erheblich: Wartung, Lagerort, Ausleihe und Etikett gelten damit ohne eine
// Zeile Zusatzbau, weil sie alle am Artikel hängen. Insbesondere greift die
// Defektmeldung (`defekt.artikelId`) sofort.
//
// Dieser Satz hier trägt deshalb NUR, was Homebox nicht kann: IP, MAC,
// Firmware- und Hardwarestand, Profinet-Gerätename, Zugangsdaten — und die
// Zuordnung zu Demonstratoren.
//
// ABGRENZUNG ZUR ALTEN TABELLE `komponenten`: dort steckt ein Gerät als reiner
// Eintrag UNTER einem Demonstrator und existiert in Homebox nicht. Die alte
// Tabelle bleibt unangetastet, bis der Übernahme-Assistent gelaufen ist —
// nichts wird still umgeschrieben.
//
// NAMENSFALLE: Die Einstellung `netzgeraetMarke` („Netzgerät") ist etwas
// ANDERES als die Klassen-Tags hier. Sie markiert ein ausleihbares Einzelgerät
// unter „Geräte". Die Klassen-Tags markieren Teilnehmer im Netz und erscheinen
// dort nicht.
//
// PASSWÖRTER: Auf Wunsch der Schule im Klartext. Jede Sicherung enthält sie
// lesbar — siehe deploy/backup.sh und README.

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const auth = require('../auth');

function nowIso() { return new Date().toISOString(); }
const text = (v) => String(v === null || v === undefined ? '' : v).trim();

// Netzangaben vergleichbar machen. Ohne das gälten „00:1B:1B:AA:BB:CC" und
// „00-1b-1b-aa-bb-cc" als zwei verschiedene Geräte, und die Warnung vor
// Doppelbelegungen liefe ins Leere.
function macNormal(mac) {
  const roh = String(mac || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  if (roh.length !== 12) return String(mac || '').trim().toLowerCase();
  return roh.match(/.{2}/g).join(':');
}
const ipNormal = (ip) => String(ip || '').trim();
const nameNormal = (n) => String(n || '').trim().toLowerCase();

const KLASSEN = ['profinet', 'roboter', 'pc'];

// Welche Felder eine Klasse trägt. Muss mit NETZ_FELDER in app/src/models.js
// übereinstimmen — die Maske zeigt, was hier ankommt.
//
// Warum nicht überall alle Felder? Ein Roboter hängt im normalen Schulnetz und
// hat weder Profinet-Gerätenamen noch Steckplatz; ein PC hat nur Bezeichnung
// und IP. Fremde Felder werden beim Speichern VERWORFEN, nicht durchgereicht:
// sonst steht am PC eine Firmware, die niemand je gepflegt hat.
const FELDER = {
  profinet: [
    'profinetName', 'ip', 'subnetz', 'mac', 'hersteller', 'typ',
    'bestellnummer', 'seriennummer', 'uuid', 'firmware', 'steckplatz',
    'benutzername', 'passwort', 'notiz',
  ],
  roboter: [
    'hersteller', 'typ', 'steuerungsName', 'seriennummer', 'ip', 'mac',
    'firmware', 'hardwarestand', 'notiz',
  ],
  pc: ['ip', 'notiz'],
};

function klasseVon(v) { return KLASSEN.includes(text(v)) ? text(v) : 'profinet'; }

function ausEingabe(body, klasse) {
  const out = {};
  for (const f of FELDER[klasse]) out[f] = text((body || {})[f]);
  if (out.mac) out.mac = macNormal(out.mac);
  return out;
}

// Ein Gerät kann zu keinem, einem oder mehreren Demonstratoren gehören — der
// Programmier-PC dient drei Stationen, der Roboter wandert zwischen ihnen.
function demoIds(v, alt) {
  if (v === undefined) return alt || [];
  const liste = Array.isArray(v) ? v : [v];
  return [...new Set(liste.map(text).filter(Boolean))];
}

// Doppelte IP, MAC, Profinet- oder Steuerungsname sind im Betrieb der häufigste
// Ärger und im Schaltschrank mühsam zu finden. Gewarnt wird über ALLE Klassen
// hinweg — genau deshalb gehören die PCs mit in diese Liste. Blockiert wird
// nicht: manchmal ist die Dopplung gewollt (Ersatzgerät im Schrank) oder
// gerade der Fehler, den man dokumentieren will.
function konflikteFinden(neu, eigeneId) {
  const treffer = [];
  for (const g of db.listNetzgeraete()) {
    if (g.id === eigeneId) continue;
    if (neu.ip && ipNormal(g.ip) === ipNormal(neu.ip)) treffer.push({ feld: 'IP-Adresse', wert: neu.ip, g });
    if (neu.mac && macNormal(g.mac) === macNormal(neu.mac)) treffer.push({ feld: 'MAC-Adresse', wert: neu.mac, g });
    if (neu.profinetName && nameNormal(g.profinetName) === nameNormal(neu.profinetName)) {
      treffer.push({ feld: 'Profinet-Gerätename', wert: neu.profinetName, g });
    }
    if (neu.steuerungsName && nameNormal(g.steuerungsName) === nameNormal(neu.steuerungsName)) {
      treffer.push({ feld: 'Steuerungsname', wert: neu.steuerungsName, g });
    }
  }
  return treffer.map(t => ({
    feld: t.feld,
    wert: t.wert,
    geraetId: t.g.id,
    geraetName: t.g.artikelName,
    klasse: t.g.klasse,
  }));
}

module.exports = function createNetzgeraeteRouter(broadcast, homebox) {
  const r = express.Router();
  // Ganzer Router hinter der Anmeldung: hier stehen Zugangsdaten und die
  // Netzstruktur der Schule. Gäste dürfen Artikel sehen, das hier nicht.
  r.use(auth.requireAuth);

  function weiter(res, e) {
    res.status((e && e.status) || 500).json({ error: (e && e.message) || 'Unbekannter Fehler' });
  }
  const fang = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch(e => weiter(res, e));

  // --- Lesen --------------------------------------------------------------
  r.get('/', (req, res) => {
    let liste = db.listNetzgeraete();
    if (req.query.klasse) liste = liste.filter(g => g.klasse === text(req.query.klasse));
    if (req.query.demonstratorId) {
      liste = liste.filter(g => (g.demonstratorIds || []).includes(text(req.query.demonstratorId)));
    }
    liste.sort((a, b) => String(a.artikelName).localeCompare(String(b.artikelName), 'de'));
    res.json(liste);
  });

  // Netzübersicht: alles mit Netzangaben, samt Doppelbelegungen. Beantwortet
  // „welche IP ist noch frei?" ohne Zettelwirtschaft.
  r.get('/netz', (_req, res) => {
    const alle = db.listNetzgeraete().filter(g => g.ip || g.mac || g.profinetName || g.steuerungsName);
    const zaehlen = (werte) => {
      const map = new Map();
      for (const w of werte) {
        if (!w.wert) continue;
        if (!map.has(w.wert)) map.set(w.wert, []);
        map.get(w.wert).push(w.geraet);
      }
      return [...map.entries()].filter(([, g]) => g.length > 1)
        .map(([wert, geraete]) => ({ wert, geraete }));
    };
    const kurz = (g) => ({ id: g.id, name: g.artikelName, klasse: g.klasse, artikelId: g.artikelId });
    res.json({
      geraete: alle.map(g => ({ ...g, passwort: g.passwort ? '•••' : '' })),
      doppelteIp: zaehlen(alle.map(g => ({ wert: ipNormal(g.ip), geraet: kurz(g) }))),
      doppelteMac: zaehlen(alle.map(g => ({ wert: macNormal(g.mac), geraet: kurz(g) }))),
      doppelteNamen: zaehlen(alle.map(g => ({
        wert: nameNormal(g.profinetName || g.steuerungsName), geraet: kurz(g),
      }))),
    });
  });

  r.get('/:id', (req, res) => {
    const g = db.getNetzgeraet(req.params.id);
    if (!g) return res.status(404).json({ error: 'Gerät nicht gefunden.' });
    res.json(g);
  });

  // --- Anlegen ------------------------------------------------------------
  // Zwei Wege in EINER Route, weil es für den Nutzer eine Handlung ist:
  //   * `artikelId` mitgegeben → vorhandener Artikel wird verknüpft.
  //   * sonst → die App legt den Artikel in Homebox an.
  // Der zweite Weg ist der Regelfall; der erste verhindert Doubletten, wenn
  // das Gerät im Bestand schon steht (typisch beim Roboter).
  r.post('/', fang(async (req, res) => {
    const body = req.body || {};
    const klasse = klasseVon(body.klasse);
    const name = text(body.name);
    let artikel = null;

    if (text(body.artikelId)) {
      artikel = await homebox.holen(text(body.artikelId));
      if (!artikel) return res.status(404).json({ error: 'Der angegebene Artikel ist in Homebox nicht zu finden.' });
      // Ein Artikel darf nur EIN Netzgerät sein — sonst stünden zwei IPs am
      // selben Gerät und niemand wüsste, welche gilt.
      const da = db.listNetzgeraete().find(g => g.artikelId === artikel.id);
      if (da) {
        return res.status(409).json({
          error: `„${artikel.name}" ist bereits als Netzwerkgerät erfasst.`,
          geraetId: da.id,
        });
      }
    } else {
      if (!name) return res.status(400).json({ error: 'Es fehlt die Bezeichnung.' });
      const settings = db.getSettings() || {};
      const markeName = klasse === 'roboter' ? settings.roboterMarke
        : klasse === 'pc' ? settings.pcMarke : settings.profinetMarke;
      const marke = await homebox.markeSicherstellen(markeName || klasse);
      artikel = await homebox.anlegen({
        name,
        // Ein Netzwerkgerät ist ein Einzelstück. Die Mengenfrage stellt sich
        // nicht, und eine 0 würde es in der Nachbestell-Liste auftauchen lassen.
        menge: 1,
        ortId: text(body.ortId) || undefined,
        beschreibung: text(body.beschreibung) || undefined,
        hersteller: text(body.hersteller) || undefined,
        markenIds: [marke.id],
      });
      // FALLE aus diesem Projekt: Homebox verwirft unbekannte Felder still.
      // Nach dem Schreiben nachsehen, ob das Gewünschte auch eingetreten ist.
      if (!artikel || !artikel.id) {
        return res.status(502).json({ error: 'Homebox hat keinen Artikel angelegt.' });
      }
    }

    const daten = ausEingabe(body, klasse);
    const g = {
      id: crypto.randomUUID(),
      artikelId: artikel.id,
      // Name und Kennung werden MITGESCHRIEBEN, nicht nur verwiesen: die Liste
      // muss lesbar bleiben, wenn Homebox gerade nicht antwortet.
      artikelName: artikel.name || name,
      artikelCode: artikel.code || '',
      klasse,
      demonstratorIds: demoIds(body.demonstratorIds, []),
      ...daten,
      erstelltAm: nowIso(),
      erstelltVon: req.benutzer.name,
      lastModifiedAt: nowIso(),
      // Woher der Satz stammt, wenn er aus der alten Komponententabelle kommt.
      ausKomponenteId: text(body.ausKomponenteId),
      schemaVersion: 1,
    };
    db.saveNetzgeraet(g);
    broadcast({ type: 'netzgeraet:save', geraet: g, origin: req.header('x-client-id') || '' });
    res.json({ geraet: g, konflikte: konflikteFinden(daten, g.id) });
  }));

  // --- Ändern -------------------------------------------------------------
  r.put('/:id', fang(async (req, res) => {
    const g = db.getNetzgeraet(req.params.id);
    if (!g) return res.status(404).json({ error: 'Gerät nicht gefunden.' });
    const body = req.body || {};
    // Die Klasse zu wechseln ist erlaubt (ein Gerät war falsch einsortiert),
    // aber sie entscheidet über die Felder: erst danach einlesen.
    const klasse = body.klasse !== undefined ? klasseVon(body.klasse) : g.klasse;
    const daten = ausEingabe({ ...g, ...body }, klasse);

    // Der Name gehört dem ARTIKEL. Wer ihn hier ändert, ändert ihn dort —
    // sonst hätte dasselbe Gerät zwei Namen.
    const neuerName = text(body.name);
    if (neuerName && neuerName !== g.artikelName) {
      await homebox.aktualisieren(g.artikelId, { name: neuerName });
      g.artikelName = neuerName;
    }
    // Klassenwechsel heißt auch: anderer Tag in Homebox.
    if (klasse !== g.klasse) {
      const settings = db.getSettings() || {};
      const markeName = klasse === 'roboter' ? settings.roboterMarke
        : klasse === 'pc' ? settings.pcMarke : settings.profinetMarke;
      const marke = await homebox.markeSicherstellen(markeName || klasse);
      const artikel = await homebox.holen(g.artikelId).catch(() => null);
      const alteIds = ((artikel && artikel.marken) || []).map(m => m.id);
      const alteNamen = [settings.profinetMarke, settings.roboterMarke, settings.pcMarke]
        .map(n => String(n || '').trim().toLowerCase());
      const behalten = ((artikel && artikel.marken) || [])
        .filter(m => !alteNamen.includes(String(m.name || '').trim().toLowerCase()))
        .map(m => m.id);
      if (alteIds.length || behalten.length) {
        await homebox.aktualisieren(g.artikelId, { markenIds: [...new Set([...behalten, marke.id])] });
      }
    }

    Object.assign(g, daten);
    g.klasse = klasse;
    g.demonstratorIds = demoIds(body.demonstratorIds, g.demonstratorIds);
    g.lastModifiedAt = nowIso();
    db.saveNetzgeraet(g);
    broadcast({ type: 'netzgeraet:save', geraet: g, origin: req.header('x-client-id') || '' });
    res.json({ geraet: g, konflikte: konflikteFinden(daten, g.id) });
  }));

  // --- Entfernen ----------------------------------------------------------
  // `?artikel=1` löscht den Homebox-Artikel mit. Das ist ein echter
  // Datenverlust — daran hängt die Defekthistorie —, deshalb muss es
  // ausdrücklich verlangt werden und die Oberfläche fragt vorher nach.
  r.delete('/:id', fang(async (req, res) => {
    const g = db.getNetzgeraet(req.params.id);
    if (!g) return res.status(404).json({ error: 'Gerät nicht gefunden.' });
    let artikelGeloescht = false;
    if (req.query.artikel === '1') {
      await homebox.artikelLoeschen(g.artikelId);
      artikelGeloescht = true;
    }
    db.deleteNetzgeraet(g.id);
    broadcast({ type: 'netzgeraet:delete', id: g.id, origin: req.header('x-client-id') || '' });
    res.json({ ok: true, artikelGeloescht });
  }));

  return r;
};
