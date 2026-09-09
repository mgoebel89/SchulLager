'use strict';

// Beschaffung: bestellen, Wareneingang prüfen, einlagern, Rechnung zuordnen.
//
// GRENZE ZU HOMEBOX. Der Vorgang liegt hier, der Bestand liegt dort. Eine
// Bestellung ist eine Absicht — Homebox kennt dafür keinen Begriff, und das ist
// richtig so: was bestellt ist, ist noch nicht im Schrank. Erst der
// Wareneingang bucht, und zwar RELATIV (delta), damit zwei gleichzeitige
// Buchungen am selben Regal sich addieren statt sich zu überschreiben.
//
// REIHENFOLGE BEIM EINGANG: erst nach Homebox buchen, dann protokollieren.
// Andersherum stünde nach einem Fehlschlag ein Wareneingang im Protokoll, den
// es nie gab — dieselbe Regel wie bei den Materialausgaben.
//
// PREISE WERDEN MITGESCHRIEBEN. Der Preis der Position gehört zu DIESER
// Lieferung. Wird im Oktober teurer nachgekauft, darf sich die Abrechnung vom
// Mai nicht rückwirkend ändern.

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const auth = require('../auth');

function nowIso() { return new Date().toISOString(); }
function heuteIso() {
  // Aus den LOKALEN Komponenten. `toISOString()` rechnet nach UTC um und
  // schiebt in unserer Zeitzone jeden Abend auf den Vortag.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const text = (v) => String(v === null || v === undefined ? '' : v).trim();
const zahl = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// Eine Position aus dem Formular säubern. `artikelId` leer heißt: FREIE
// Position — der Artikel existiert im Lager noch nicht. Er entsteht erst beim
// Wareneingang, damit eine stornierte Bestellung keine leeren Artikel
// hinterlässt.
function normPosition(p, alt = null) {
  return {
    id: text(p.id) || (alt && alt.id) || crypto.randomUUID(),
    artikelId: p.artikelId !== undefined ? text(p.artikelId) : (alt ? alt.artikelId : ''),
    artikelName: text(p.artikelName) || (alt ? alt.artikelName : ''),
    artikelCode: p.artikelCode !== undefined ? text(p.artikelCode) : (alt ? alt.artikelCode : ''),
    bestellnummer: p.bestellnummer !== undefined ? text(p.bestellnummer) : (alt ? alt.bestellnummer : ''),
    menge: Math.max(0, Number(p.menge) || 0),
    preis: p.preis === '' || p.preis === null || p.preis === undefined
      ? (alt ? alt.preis : null)
      : Number(p.preis),
    notiz: p.notiz !== undefined ? text(p.notiz) : (alt ? alt.notiz : ''),
    // Vom Wareneingang gepflegt, nie aus dem Bestellformular.
    geliefert: alt ? alt.geliefert : 0,
    eingelagert: alt ? !!alt.eingelagert : false,
    ortId: alt ? alt.ortId : '',
    ortName: alt ? alt.ortName : '',
  };
}

// Zustand aus den Positionen ableiten statt ihn zu speichern: gespeicherte
// Zustände laufen früher oder später gegen die Daten, aus denen sie stammen.
// `storniert` und `erledigt` sind die Ausnahme — die sind eine Entscheidung
// und keine Rechnung.
function zustandBerechnen(b) {
  if (b.storniertAm) return 'storniert';
  if (b.erledigtAm) return 'erledigt';
  const pos = b.positionen || [];
  if (!pos.length) return 'offen';
  const geliefert = pos.reduce((s, p) => s + (p.geliefert || 0), 0);
  if (!geliefert) return 'offen';
  return pos.every(p => (p.geliefert || 0) >= p.menge) ? 'vollstaendig' : 'teilweise';
}

function anreichern(b) {
  const pos = b.positionen || [];
  return {
    ...b,
    zustand: zustandBerechnen(b),
    summe: pos.reduce((s, p) => s + (p.preis != null ? p.preis * p.menge : 0), 0),
    offenePositionen: pos.filter(p => (p.geliefert || 0) < p.menge).length,
    einzulagern: pos.filter(p => (p.geliefert || 0) > 0 && !p.eingelagert).length,
  };
}

module.exports = function createBestellungenRouter(broadcast, homebox, paperless) {
  const r = express.Router();
  // Ganzer Router hinter der Anmeldung: hier stehen Preise, Lieferanten und
  // Rechnungsnummern. Lesen darf jede Lehrkraft (so entschieden), Gäste nicht.
  r.use(auth.requireAuth);

  function holen(req, res) {
    const b = db.getBestellung(req.params.id);
    if (!b) { res.status(404).json({ error: 'Bestellung nicht gefunden.' }); return null; }
    return b;
  }
  function sichern(b, req, typ = 'bestellung:save') {
    b.lastModifiedAt = nowIso();
    db.saveBestellung(b);
    broadcast({ type: typ, id: b.id, origin: req.header('x-client-id') || '' });
    return anreichern(b);
  }

  // --- Liste --------------------------------------------------------------
  // Ohne Positionen: die Übersicht braucht nur Kopf und Kennzahlen, und eine
  // Bestellung mit 60 Zeilen soll die Liste nicht aufblähen.
  r.get('/', (_req, res) => {
    const liste = db.listBestellungen().map(b => {
      const a = anreichern(b);
      return {
        ...a,
        positionen: undefined,
        anzahlPositionen: (b.positionen || []).length,
        belege: (b.belege || []).map(x => ({ art: x.art, dokumentId: x.dokumentId })),
      };
    }).sort((a, b) => String(b.bestelltAm || '').localeCompare(String(a.bestelltAm || ''))
      || String(b.angelegtAm).localeCompare(String(a.angelegtAm)));
    res.json(liste);
  });

  // Lieferanten-Vorschläge für den Bestellkopf.
  r.get('/lieferanten', async (_req, res) => {
    try {
      res.json(await homebox.lieferanten());
    } catch (e) {
      // Kein Grund, das Formular scheitern zu lassen — Vorschläge sind Komfort.
      res.json([]);
    }
  });

  // --- Einzelvorgang ------------------------------------------------------
  // Beim Lesen werden schwebende Paperless-Uploads aufgelöst: der Upload ist
  // asynchron (OCR), die Dokument-Nummer gibt es erst hinterher. Das hier ist
  // der Ort, an dem sie nachgetragen wird — ohne dass jemand pollen muss.
  r.get('/:id', async (req, res) => {
    const b = holen(req, res);
    if (!b) return;
    let geaendert = false;
    for (const beleg of b.belege || []) {
      if (beleg.dokumentId || !beleg.taskId || beleg.fehler) continue;
      try {
        const t = await paperless.taskStatus(beleg.taskId);
        if (t.dokumentId) { beleg.dokumentId = t.dokumentId; geaendert = true; }
        else if (t.fehler) { beleg.fehler = t.fehler; geaendert = true; }
      } catch (_) {
        // Paperless gerade nicht erreichbar: der Beleg bleibt schwebend und
        // wird beim nächsten Aufruf erneut versucht. Kein Fehler für den Nutzer
        // — die Bestellung selbst ist ja vollständig lesbar.
      }
    }
    if (geaendert) { b.lastModifiedAt = nowIso(); db.saveBestellung(b); }
    res.json(anreichern(b));
  });

  // --- Anlegen und ändern -------------------------------------------------
  r.post('/', (req, res) => {
    const { lieferant, bestelltAm, belegnummer, notiz, positionen } = req.body || {};
    const b = {
      id: crypto.randomUUID(),
      lieferant: text(lieferant),
      bestelltAm: text(bestelltAm) || heuteIso(),
      belegnummer: text(belegnummer),
      notiz: text(notiz),
      positionen: (Array.isArray(positionen) ? positionen : []).map(p => normPosition(p)),
      eingaenge: [],
      belege: [],
      rechnung: null,
      erledigtAm: '',
      storniertAm: '',
      angelegtAm: nowIso(),
      angelegtVon: req.benutzer.name,
      schemaVersion: 1,
    };
    db.saveBestellung(b);
    broadcast({ type: 'bestellung:save', id: b.id, origin: req.header('x-client-id') || '' });
    res.json(anreichern(b));
  });

  r.put('/:id', (req, res) => {
    const b = holen(req, res);
    if (!b) return;
    const { lieferant, bestelltAm, belegnummer, notiz, positionen } = req.body || {};
    if (lieferant !== undefined) b.lieferant = text(lieferant);
    if (bestelltAm !== undefined) b.bestelltAm = text(bestelltAm);
    if (belegnummer !== undefined) b.belegnummer = text(belegnummer);
    if (notiz !== undefined) b.notiz = text(notiz);

    if (Array.isArray(positionen)) {
      // Gelieferte Mengen dürfen ein Formular NIE überschreiben — sie sind
      // gebuchter Bestand. Deshalb wird jede Position an ihrer ID mit dem
      // bisherigen Stand zusammengeführt.
      const alt = new Map((b.positionen || []).map(p => [p.id, p]));
      const neu = positionen.map(p => normPosition(p, alt.get(text(p.id)) || null));
      // Eine Position mit bereits geliefertem Bestand darf nicht verschwinden:
      // sonst wäre die Buchung in Homebox ohne Beleg.
      const behalten = (b.positionen || []).filter(p => (p.geliefert || 0) > 0 && !neu.some(n => n.id === p.id));
      b.positionen = [...neu, ...behalten];
    }
    res.json(sichern(b, req));
  });

  // Erledigt/storniert/wieder offen — eine Entscheidung, keine Rechnung.
  r.post('/:id/zustand', (req, res) => {
    const b = holen(req, res);
    if (!b) return;
    const z = text((req.body || {}).zustand);
    if (!['erledigt', 'storniert', 'offen'].includes(z)) {
      return res.status(400).json({ error: 'Unbekannter Zustand.' });
    }
    b.erledigtAm = z === 'erledigt' ? nowIso() : '';
    b.storniertAm = z === 'storniert' ? nowIso() : '';
    res.json(sichern(b, req));
  });

  r.delete('/:id', auth.requireRolle('admin'), (req, res) => {
    const b = holen(req, res);
    if (!b) return;
    db.deleteBestellung(b.id);
    broadcast({ type: 'bestellung:delete', id: b.id, origin: req.header('x-client-id') || '' });
    res.json({ ok: true });
  });

  // --- Wareneingang -------------------------------------------------------
  // Der Kern dieser Ansicht: gelieferte Mengen aller Positionen auf EINEN
  // Schlag nach Homebox buchen.
  //
  // `positionen`: [{ positionId, menge, artikelId?, ortId?, ortName? }]
  //   menge      = was JETZT ankam (nicht die Gesamtsumme) — relativ gedacht,
  //                so wie gebucht wird.
  //   artikelId  = nachgereicht, wenn eine freie Position beim Eingang zum
  //                Artikel wurde.
  //   ortId      = Ziel beim Einlagern; wird am Artikel gesetzt, falls er
  //                noch keinen Lagerort hat.
  //
  // Einzelne Fehlschläge halten den Rest NICHT auf und werden benannt. Wer
  // eine halb gebuchte Lieferung für vollständig hält, sucht später Bestand,
  // den es nie gab.
  r.post('/:id/eingang', async (req, res) => {
    const b = holen(req, res);
    if (!b) return;
    const eingaben = Array.isArray((req.body || {}).positionen) ? req.body.positionen : [];
    if (!eingaben.length) return res.status(400).json({ error: 'Es wurde nichts zum Buchen übergeben.' });

    const nachId = new Map((b.positionen || []).map(p => [p.id, p]));
    const gebucht = [];
    const ergebnisse = [];

    for (const e of eingaben) {
      const p = nachId.get(text(e.positionId));
      if (!p) {
        ergebnisse.push({ positionId: text(e.positionId), ok: false, fehler: 'Position gehört nicht zu dieser Bestellung.' });
        continue;
      }
      const menge = Number(e.menge) || 0;
      const artikelId = text(e.artikelId) || p.artikelId;
      if (menge <= 0) continue;                      // nicht geliefert: nichts zu tun
      if (!artikelId) {
        ergebnisse.push({
          positionId: p.id, artikelName: p.artikelName, ok: false,
          fehler: 'Freie Position ohne Artikel — bitte zuerst den Artikel anlegen oder zuordnen.',
        });
        continue;
      }

      try {
        // ERST buchen …
        await homebox.bestandAendern(artikelId, { delta: menge });
        // … und den Lagerort nur setzen, wenn der Artikel noch keinen hat.
        // Einen vorhandenen zu überschreiben wäre ein stilles Umlagern: das
        // Regal, in dem das Zeug wirklich steht, hätte plötzlich einen
        // anderen Namen als in der App.
        const ortId = text(e.ortId);
        if (ortId) {
          const a = await homebox.holen(artikelId).catch(() => null);
          if (a && !a.ortId) await homebox.aktualisieren(artikelId, { ortId });
          p.ortId = ortId;
          p.ortName = text(e.ortName) || (a ? a.ortName : '');
        }
        // … dann protokollieren.
        p.artikelId = artikelId;
        if (text(e.artikelName)) p.artikelName = text(e.artikelName);
        p.geliefert = (p.geliefert || 0) + menge;
        gebucht.push({ positionId: p.id, menge });
        ergebnisse.push({ positionId: p.id, artikelName: p.artikelName, ok: true, menge });
      } catch (err) {
        ergebnisse.push({ positionId: p.id, artikelName: p.artikelName, ok: false, fehler: err.message });
      }
    }

    if (gebucht.length) {
      b.eingaenge = b.eingaenge || [];
      b.eingaenge.push({
        id: crypto.randomUUID(),
        datum: nowIso(),
        von: req.benutzer.name,
        notiz: text((req.body || {}).notiz),
        positionen: gebucht,
      });
      sichern(b, req);
    }

    const fehler = ergebnisse.filter(x => !x.ok).length;
    res.json({ gebucht: gebucht.length, fehler, ergebnisse, bestellung: anreichern(b) });
  });

  // Einlagern abhaken. Bewusst KEINE Homebox-Buchung — der Bestand ist beim
  // Wareneingang gebucht worden. Das Häkchen sagt nur: steht im Regal.
  r.post('/:id/position/:positionId/eingelagert', (req, res) => {
    const b = holen(req, res);
    if (!b) return;
    const p = (b.positionen || []).find(x => x.id === req.params.positionId);
    if (!p) return res.status(404).json({ error: 'Position nicht gefunden.' });
    p.eingelagert = (req.body || {}).eingelagert !== false;
    res.json(sichern(b, req));
  });

  // --- Belege (Paperless) -------------------------------------------------
  // Hochgeladen wird über /api/dokumente; hier wird nur die Nummer am Vorgang
  // vermerkt. Getrennt, weil ein Beleg auch ohne Bestellung entstehen kann.
  r.post('/:id/beleg', (req, res) => {
    const b = holen(req, res);
    if (!b) return;
    const { art, taskId, dokumentId, titel } = req.body || {};
    if (!taskId && !dokumentId) return res.status(400).json({ error: 'Es fehlt die Paperless-Kennung.' });
    b.belege = b.belege || [];
    b.belege.push({
      id: crypto.randomUUID(),
      art: ['lieferschein', 'rechnung'].includes(text(art)) ? text(art) : 'sonstiges',
      taskId: text(taskId),
      dokumentId: dokumentId ? Number(dokumentId) : null,
      titel: text(titel),
      fehler: '',
      hochgeladenAm: nowIso(),
      von: req.benutzer.name,
    });
    res.json(sichern(b, req));
  });

  // Nur die VERKNÜPFUNG lösen. Das Dokument bleibt in Paperless — diese App
  // löscht dort nichts; die Ablage der Schule gehört nicht ihr.
  r.delete('/:id/beleg/:belegId', (req, res) => {
    const b = holen(req, res);
    if (!b) return;
    b.belege = (b.belege || []).filter(x => x.id !== req.params.belegId);
    res.json(sichern(b, req));
  });

  // --- Rechnung -----------------------------------------------------------
  // Zweiter Schritt, Wochen nach dem Wareneingang: Rechnungsdaten festhalten
  // und die Preise nachtragen. Auf Wunsch wandern sie an die Artikel in
  // Homebox weiter (Kaufpreis, Kaufdatum, Lieferant) — dort ist der Preis
  // „zuletzt bezahlt", hier bleibt er „für diese Lieferung bezahlt".
  r.post('/:id/rechnung', async (req, res) => {
    const b = holen(req, res);
    if (!b) return;
    const { nummer, datum, betrag, positionen, anArtikel } = req.body || {};
    b.rechnung = {
      nummer: text(nummer),
      datum: text(datum) || heuteIso(),
      betrag: zahl(betrag),
      zugeordnetAm: nowIso(),
      von: req.benutzer.name,
    };

    const nachId = new Map((b.positionen || []).map(p => [p.id, p]));
    const ergebnisse = [];
    for (const e of (Array.isArray(positionen) ? positionen : [])) {
      const p = nachId.get(text(e.positionId));
      if (!p) continue;
      const preis = zahl(e.preis);
      if (preis === null || Number.isNaN(preis)) continue;
      p.preis = preis;
      if (anArtikel && p.artikelId) {
        try {
          await homebox.aktualisieren(p.artikelId, {
            kaufpreis: preis,
            kaufdatum: b.rechnung.datum,
            lieferant: b.lieferant || undefined,
          });
          ergebnisse.push({ positionId: p.id, artikelName: p.artikelName, ok: true });
        } catch (err) {
          ergebnisse.push({ positionId: p.id, artikelName: p.artikelName, ok: false, fehler: err.message });
        }
      }
    }
    res.json({ bestellung: sichern(b, req), ergebnisse, fehler: ergebnisse.filter(x => !x.ok).length });
  });

  return r;
};
