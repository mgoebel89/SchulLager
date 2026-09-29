'use strict';

// Etiketten (Phase 3).
//
// DIE APP DRUCKT NICHT SELBST. Matthias hat in P-touch Editor Vorlagen
// gebaut, die eine CSV-Datei als Datenbank einbinden und ihre Platzhalter
// daraus füllen (entschieden 2026-09-28). Dieser Router liefert genau diese
// CSV — gedruckt wird am Windows-PC aus P-touch.
//
// Die SPALTEN SIND DER VERTRAG mit der Vorlage. Sie stehen deshalb nur hier,
// an einer Stelle; wer sie umbenennt, muss die Vorlage in P-touch neu
// verknüpfen.
//
// Der QR-Inhalt ist `https://<SchulLager>/a/<Homebox-Asset-ID>`: die
// Handykamera öffnet damit das SchulLager, Homebox' eigener Scanner (der den
// Host verwirft und nur den Pfad nimmt) den Homebox-Artikel. Siehe homebox.js.
//
// Rechte: alles nur angemeldet, dann aber für jeden (so entschieden).

const express = require('express');
const db = require('../db');
const auth = require('../auth');

const SPALTEN_ARTIKEL = ['Bezeichnung', 'Hersteller', 'Tag', 'Lagerort', 'EAN', 'QR'];
const SPALTEN_ORT = ['Bezeichnung', 'Lagerort', 'QR'];

// Diese Tags steuern die App (Geräteart, Netzklasse) und sagen auf einem
// Etikett nichts. Sie werden weggelassen, alle anderen mit Komma verbunden.
// Die Namen kommen aus den Einstellungen; die Vorgaben hier müssen denen in
// app/src/models.js entsprechen.
const INTERNE_TAGS = {
  demonstratorMarke: 'Demonstrator',
  netzgeraetMarke: 'Netzgerät',
  profinetMarke: 'Profinet-Teilnehmer',
  roboterMarke: 'Roboter',
  pcMarke: 'PC',
};

const TRENNER = { komma: ',', semikolon: ';', tab: '\t' };

function nowIso() { return new Date().toISOString(); }

function einstellungen() {
  const s = db.getSettings() || {};
  return {
    adresse: String(s.etikettAdresse || '').trim(),
    trenner: TRENNER[s.etikettTrenner] ? s.etikettTrenner : 'komma',
    kodierung: s.etikettKodierung === 'cp1252' ? 'cp1252' : 'utf8bom',
    interne: new Set(Object.entries(INTERNE_TAGS)
      .map(([k, vorgabe]) => String(s[k] || vorgabe).trim().toLowerCase())),
  };
}

// „192.168.5.30" → „https://192.168.5.30". Ein Schema darf man mitgeben, muss
// aber nicht — die Adresse wird auf jedes Etikett gedruckt, ein vergessenes
// https:// wäre dort nicht mehr zu korrigieren.
function basisAdresse(roh) {
  const a = String(roh || '').trim().replace(/\/+$/, '');
  if (!a) return '';
  return /^https?:\/\//i.test(a) ? a : `https://${a}`;
}

// --- CSV ------------------------------------------------------------------
function csvZelle(wert, trenner) {
  const t = String(wert == null ? '' : wert).replace(/\r?\n/g, ' ');
  return (t.includes(trenner) || t.includes('"') || /^\s|\s$/.test(t))
    ? `"${t.replace(/"/g, '""')}"`
    : t;
}

function csvText(spalten, zeilen, trennerName) {
  const tr = TRENNER[trennerName] || ',';
  const kopf = spalten.map(s => csvZelle(s, tr)).join(tr);
  const rumpf = zeilen.map(z => spalten.map(s => csvZelle(z[s], tr)).join(tr));
  // CRLF: P-touch ist ein Windows-Programm.
  return [kopf, ...rumpf].join('\r\n') + '\r\n';
}

// Windows-1252 für den Fall, dass P-touch UTF-8 nicht versteht. `latin1` aus
// Node reicht NICHT: 0x80–0x9F sind in Windows-1252 belegt (€, „, ›, –), in
// Latin-1 aber Steuerzeichen.
const CP1252 = {
  0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86,
  0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C,
  0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95,
  0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B,
  0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F,
};

function kodieren(text, kodierung) {
  if (kodierung !== 'cp1252') {
    // BOM, damit Windows-Programme die Datei als UTF-8 erkennen.
    return Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text, 'utf8')]);
  }
  const bytes = [];
  for (const z of text) {
    const c = z.codePointAt(0);
    if (c < 0x80 || (c >= 0xA0 && c <= 0xFF)) bytes.push(c);
    else if (CP1252[c]) bytes.push(CP1252[c]);
    else bytes.push(0x3F);   // „?" — nicht darstellbar
  }
  return Buffer.from(bytes);
}

// --- Merkliste --------------------------------------------------------------
function eintrag(id) {
  return db.getEtikett(id) || { id, typ: 'artikel', name: '', vorgemerkt: false };
}

module.exports = function createEtikettenRouter(broadcast, homebox) {
  const r = express.Router();
  r.use(auth.requireAuth);

  const fang = (fn) => (req, res) => Promise.resolve(fn(req, res))
    .catch(e => res.status((e && e.status) || 500).json({ error: (e && e.message) || 'Fehler' }));
  const senden = (req, liste) => broadcast({ type: 'etiketten:save', eintraege: liste, origin: req.header('x-client-id') || '' });

  // Alles, was die App über Etiketten weiß: Merkliste und zuletzt gedruckt.
  r.get('/', (_req, res) => res.json(db.listEtiketten()));

  // Spalten fürs Anzeigen in der Oberfläche (was P-touch erwartet).
  r.get('/spalten', (_req, res) => res.json({ artikel: SPALTEN_ARTIKEL, ort: SPALTEN_ORT }));

  // Auswahlliste der Artikel, gefiltert nach Suchbegriff, Lagerort (samt
  // Unterorten) und Tag. Der Merker „zuletzt gedruckt" fügt die Oberfläche an.
  r.get('/artikel', fang(async (req, res) => {
    const ortId = String(req.query.ortId || '');
    let ortIds = [];
    if (ortId) {
      const alle = await homebox.orte();
      // Den ganzen Teilbaum nehmen: wer „Schrank 4" wählt, meint auch die Fächer.
      const kinder = new Map();
      for (const o of alle) {
        if (!kinder.has(o.elternId)) kinder.set(o.elternId, []);
        kinder.get(o.elternId).push(o.id);
      }
      const offen = [ortId];
      while (offen.length) {
        const id = offen.pop();
        if (ortIds.includes(id)) continue;
        ortIds.push(id);
        offen.push(...(kinder.get(id) || []));
      }
    }
    res.json(await homebox.etikettenArtikel({
      q: String(req.query.q || ''),
      ortIds,
      markeId: String(req.query.markeId || ''),
    }));
  }));

  // Vormerken — von der Artikelseite, dem Lagerort und dem Wareneingang aus.
  // Die Merkliste ist GEMEINSAM für alle (so entschieden): Kollegen merken
  // vor, gedruckt wird in einem Rutsch.
  r.post('/vormerken', (req, res) => {
    const liste = Array.isArray((req.body || {}).eintraege) ? req.body.eintraege : [];
    const gespeichert = [];
    for (const e of liste) {
      if (!e || !e.id) continue;
      const alt = eintrag(e.id);
      gespeichert.push(db.saveEtikett({
        ...alt,
        typ: e.typ === 'ort' ? 'ort' : 'artikel',
        name: String(e.name || alt.name || ''),
        vorgemerkt: true,
        vorgemerktAm: nowIso(),
        vorgemerktVon: req.benutzer.name,
        lastModifiedAt: nowIso(),
      }));
    }
    senden(req, gespeichert);
    res.json(gespeichert);
  });

  r.delete('/vormerken/:id', (req, res) => {
    const alt = db.getEtikett(req.params.id);
    if (!alt) return res.json(null);
    const neu = db.saveEtikett({ ...alt, vorgemerkt: false, lastModifiedAt: nowIso() });
    senden(req, [neu]);
    res.json(neu);
  });

  // --- Export ---------------------------------------------------------------
  // Liefert die CSV als base64 im JSON — so kommen Anmerkungen (nachgezogene
  // Asset-IDs, Rückfälle) im selben Aufruf mit. Den Dateinamen setzt die
  // Oberfläche, weil nur sie das LOKALE Datum kennt (der Container läuft in UTC).
  r.post('/export', fang(async (req, res) => {
    const { typ, ids } = req.body || {};
    const auswahl = Array.isArray(ids) ? [...new Set(ids.filter(Boolean).map(String))] : [];
    if (!auswahl.length) return res.status(400).json({ error: 'Es ist nichts ausgewählt.' });

    const s = einstellungen();
    const basis = basisAdresse(s.adresse);
    if (!basis) {
      return res.status(400).json({
        error: 'Die Adresse für den QR-Code fehlt (Einstellungen → Etiketten). Sie wird auf jedes Etikett gedruckt.',
      });
    }

    const anmerkungen = [];
    let nachgezogen = 0;
    const orte = await homebox.orte();
    const ortNachId = new Map(orte.map(o => [o.id, o]));
    const pfad = (id) => {
      const teile = [];
      const gesehen = new Set();
      let o = ortNachId.get(id);
      while (o && !gesehen.has(o.id)) {
        gesehen.add(o.id);
        teile.unshift(o.name);
        o = o.elternId ? ortNachId.get(o.elternId) : null;
      }
      // Schrägstrich statt „›" wie in der App: P-touch zeigte das Zeichen
      // nicht richtig an (Rückmeldung Matthias, 2026-09-29). Ein ASCII-Zeichen
      // übersteht jeden Zeichensatz und jede Schrift.
      return teile.join(' / ');
    };

    let zeilen = [];
    let namen = new Map();
    if (typ === 'ort') {
      let gewaehlt = auswahl.map(id => ortNachId.get(id)).filter(Boolean);
      if (gewaehlt.some(o => !o.assetId)) {
        nachgezogen = await homebox.assetIdsSicherstellen();
        const neu = new Map((await homebox.orte()).map(o => [o.id, o]));
        gewaehlt = gewaehlt.map(o => neu.get(o.id) || o);
      }
      for (const o of gewaehlt) {
        const aid = homebox.assetNorm(o.assetId);
        if (!aid) anmerkungen.push(`„${o.name}" hat keine Asset-ID — der QR führt nur ins SchulLager, nicht nach Homebox.`);
        zeilen.push({
          Bezeichnung: o.name,
          Lagerort: pfad(o.id),
          QR: aid ? `${basis}/a/${aid}` : `${basis}/#/orte?id=${encodeURIComponent(o.id)}`,
        });
        namen.set(o.id, o.name);
      }
    } else {
      let details = (await homebox.detailsNachladen(auswahl.map(id => ({ id })))).filter(Boolean);
      if (details.some(a => !a.assetId)) {
        nachgezogen = await homebox.assetIdsSicherstellen();
        const ohne = details.filter(a => !a.assetId);
        const neu = new Map((await homebox.detailsNachladen(ohne)).filter(Boolean).map(a => [a.id, a]));
        details = details.map(a => neu.get(a.id) || a);
      }
      const fehlend = auswahl.length - details.length;
      if (fehlend > 0) anmerkungen.push(`${fehlend} Artikel ließ${fehlend === 1 ? '' : 'en'} sich nicht laden und fehl${fehlend === 1 ? 't' : 'en'} in der Datei.`);
      for (const a of details) {
        const aid = homebox.assetNorm(a.assetId);
        if (!aid) anmerkungen.push(`„${a.name}" hat keine Asset-ID — der QR führt nur ins SchulLager, nicht nach Homebox.`);
        zeilen.push({
          Bezeichnung: a.name,
          Hersteller: a.hersteller,
          Tag: (a.marken || []).map(m => m.name)
            .filter(n => n && !s.interne.has(String(n).trim().toLowerCase())).join(', '),
          Lagerort: pfad(a.ortId) || a.ortName || '',
          EAN: a.barcode,
          QR: aid ? `${basis}/a/${aid}` : `${basis}/#/artikel?id=${encodeURIComponent(a.id)}`,
        });
        namen.set(a.id, a.name);
      }
      zeilen.sort((x, y) => String(x.Bezeichnung).localeCompare(String(y.Bezeichnung), 'de'));
    }

    if (!zeilen.length) return res.status(404).json({ error: 'Keiner der gewählten Einträge ließ sich laden.' });

    const text = csvText(typ === 'ort' ? SPALTEN_ORT : SPALTEN_ARTIKEL, zeilen, s.trenner);
    const inhalt = kodieren(text, s.kodierung).toString('base64');

    // Als gedruckt vermerken und von der Merkliste nehmen (so entschieden).
    // Druckt P-touch dann doch nicht, findet man sie über „heute exportiert".
    const jetzt = nowIso();
    const gespeichert = [];
    for (const [id, name] of namen) {
      gespeichert.push(db.saveEtikett({
        ...eintrag(id),
        typ: typ === 'ort' ? 'ort' : 'artikel',
        name,
        vorgemerkt: false,
        gedrucktAm: jetzt,
        gedrucktVon: req.benutzer.name,
        lastModifiedAt: jetzt,
      }));
    }
    senden(req, gespeichert);

    res.json({ inhalt, anzahl: zeilen.length, nachgezogen, anmerkungen, kodierung: s.kodierung, trenner: s.trenner });
  }));

  return r;
};

// Für die Prüfung ohne laufenden Server.
module.exports._intern = { csvText, csvZelle, kodieren, basisAdresse, SPALTEN_ARTIKEL, SPALTEN_ORT };
