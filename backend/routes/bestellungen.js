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
//
// ANFRAGE VOR BESTELLUNG. Ab einem Bruttowert, den die Schule vorgibt (3000 €),
// müssen mehrere Angebote eingeholt werden — und die holt man VOR der
// Bestellung ein. Ein Vorgang ohne `bestelltAm` ist deshalb eine Anfrage: die
// Positionen stehen, der Lieferant nicht. Erst das BEAUFTRAGEN eines Angebots
// macht daraus eine Bestellung und setzt den Lieferanten.
//
// NETTO ODER BRUTTO entscheidet der einzelne Vorgang (`preisArt`) — der eine
// Lieferant bietet so an, der andere anders. Die Schwelle ist brutto; welcher
// Wert erfasst wurde, muss deshalb an JEDER angezeigten Summe stehen.

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

// Positionspreise eines Angebots. Leere Eintraege fallen raus, damit
// "kein Preis angegeben" und "0 Euro" unterscheidbar bleiben.
function normPreise(roh) {
  const out = {};
  for (const [k, v] of Object.entries(roh || {})) {
    const n = zahl(v);
    if (n !== null && !Number.isNaN(n)) out[text(k)] = n;
  }
  return out;
}

// Der Nachlass auf den ganzen Vorgang: Kommissions- und Sonderrabatte lassen
// sich nicht auf einzelne Positionen aufteilen, und der Positionspreis soll
// der Listenpreis bleiben -- er geht als Kaufpreis an den Homebox-Artikel.
// Deshalb eine eigene Zeile unter der Summe statt einer Umlage.
function normNachlass(b, roh) {
  if (!roh) return;
  if (roh.nachlassArt !== undefined) b.nachlassArt = roh.nachlassArt === 'prozent' ? 'prozent' : 'betrag';
  if (roh.nachlassWert !== undefined) {
    const n = zahl(roh.nachlassWert);
    b.nachlassWert = n === null || Number.isNaN(n) ? 0 : Math.max(0, n);
  }
  if (roh.nachlassText !== undefined) b.nachlassText = text(roh.nachlassText);
}

function normAngebot(a, alt = null) {
  return {
    id: text(a.id) || (alt && alt.id) || crypto.randomUUID(),
    lieferant: a.lieferant !== undefined ? text(a.lieferant) : (alt ? alt.lieferant : ''),
    betrag: a.betrag === '' || a.betrag === null || a.betrag === undefined
      ? (alt ? alt.betrag : null) : Number(a.betrag),
    // Ein Angebot kann netto ausgewiesen sein, während der Vorgang brutto
    // rechnet (oder umgekehrt) — deshalb trägt es seine eigene Angabe.
    preisArt: a.preisArt === 'brutto' ? 'brutto' : (a.preisArt === 'netto' ? 'netto' : (alt ? alt.preisArt : 'netto')),
    datum: a.datum !== undefined ? text(a.datum) : (alt ? alt.datum : ''),
    nummer: a.nummer !== undefined ? text(a.nummer) : (alt ? alt.nummer : ''),
    notiz: a.notiz !== undefined ? text(a.notiz) : (alt ? alt.notiz : ''),
    // Preise JE POSITION der Anfrage: { positionId: preis }. Freiwillig -- der
    // Endbetrag oben fuehrt (so mit Matthias entschieden), die Einzelpreise
    // sind dafuer da, beim Beauftragen in die Bestellung zu wandern. Ein
    // dreiseitiges Angebot muss niemand abtippen, nur um vergleichen zu koennen.
    preise: a.preise !== undefined ? normPreise(a.preise) : (alt ? alt.preise : {}),
    // Das Angebots-PDF liegt in Paperless, wie Lieferschein und Rechnung.
    taskId: a.taskId !== undefined ? text(a.taskId) : (alt ? alt.taskId : ''),
    dokumentId: a.dokumentId !== undefined ? (a.dokumentId ? Number(a.dokumentId) : null) : (alt ? alt.dokumentId : null),
    fehler: alt ? alt.fehler : '',
    gewaehlt: alt ? !!alt.gewaehlt : false,
    erfasstAm: (alt && alt.erfasstAm) || nowIso(),
  };
}

// Zustand aus den Positionen ableiten statt ihn zu speichern: gespeicherte
// Zustände laufen früher oder später gegen die Daten, aus denen sie stammen.
// `storniert` und `erledigt` sind die Ausnahme — die sind eine Entscheidung
// und keine Rechnung.
function zustandBerechnen(b) {
  if (b.storniertAm) return 'storniert';
  if (b.erledigtAm) return 'erledigt';
  // Ohne Bestelldatum ist noch nichts beauftragt — der Vorgang sammelt Angebote.
  if (!b.bestelltAm) return 'anfrage';
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
    // Rohsumme in der Währung, die der Vorgang erfasst hat. Ob das netto oder
    // brutto ist, sagt `preisArt` — und ohne die Angabe darf die Zahl nirgends
    // auftauchen. Die Umrechnung macht die Oberfläche (SL.models.summen), damit
    // der MwSt-Satz aus den Einstellungen nur an EINER Stelle angewandt wird.
    summe: pos.reduce((s, p) => s + (p.preis != null ? p.preis * p.menge : 0), 0),
    // Vorbelegung fuer aeltere Vorgaenge, die die Felder noch nicht haben.
    nachlassArt: b.nachlassArt === 'prozent' ? 'prozent' : 'betrag',
    nachlassWert: Number(b.nachlassWert) || 0,
    nachlassText: b.nachlassText || '',
    anzahlAngebote: (b.angebote || []).length,
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
    // Angebote tragen ihr PDF genauso wie Lieferschein und Rechnung — also
    // dieselbe Nachverfolgung, in EINER Schleife über beide Listen.
    for (const beleg of [...(b.belege || []), ...(b.angebote || [])]) {
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
    const { lieferant, bestelltAm, belegnummer, notiz, positionen, preisArt, alsAnfrage } = req.body || {};
    const b = {
      id: crypto.randomUUID(),
      lieferant: text(lieferant),
      // Als Anfrage angelegt heißt: noch kein Bestelldatum. Ein leeres
      // `bestelltAm` ist hier also eine Aussage, kein fehlender Wert.
      bestelltAm: alsAnfrage ? '' : (text(bestelltAm) || heuteIso()),
      angefragtAm: nowIso(),
      preisArt: preisArt === 'brutto' ? 'brutto' : 'netto',
      // Nachlass auf den ganzen Vorgang (Kommissionsrabatt). 0 heisst: keiner.
      nachlassArt: 'betrag',
      nachlassWert: 0,
      nachlassText: '',
      angebote: [],
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
    if (req.body && req.body.preisArt !== undefined) {
      b.preisArt = req.body.preisArt === 'brutto' ? 'brutto' : 'netto';
    }
    normNachlass(b, req.body);
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

  // --- Angebote -----------------------------------------------------------
  // Ab dem Schwellenwert der Schule (brutto) müssen mehrere Angebote vorliegen.
  // Sie gehören VOR die Bestellung: man holt sie ein, vergleicht, und erst das
  // Beauftragen macht aus der Anfrage eine Bestellung.
  //
  // Die Schwelle selbst prüft die App NICHT hier, sondern zeigt sie an: es gibt
  // begründete Ausnahmen (Alleinanbieter, Folgebeschaffung), die ein Server
  // nicht kennen kann. Gewarnt, nicht blockiert — wie bei doppelten IPs in der
  // Netzübersicht und bei der Überentnahme.
  r.post('/:id/angebot', (req, res) => {
    const b = holen(req, res);
    if (!b) return;
    b.angebote = b.angebote || [];
    const a = normAngebot(req.body || {});
    a.erfasstVon = req.benutzer.name;
    if (!a.lieferant) return res.status(400).json({ error: 'Ein Angebot braucht einen Lieferanten.' });
    b.angebote.push(a);
    res.json(sichern(b, req));
  });

  r.put('/:id/angebot/:angebotId', (req, res) => {
    const b = holen(req, res);
    if (!b) return;
    const i = (b.angebote || []).findIndex(x => x.id === req.params.angebotId);
    if (i < 0) return res.status(404).json({ error: 'Angebot nicht gefunden.' });
    b.angebote[i] = normAngebot({ ...(req.body || {}), id: b.angebote[i].id }, b.angebote[i]);
    res.json(sichern(b, req));
  });

  r.delete('/:id/angebot/:angebotId', (req, res) => {
    const b = holen(req, res);
    if (!b) return;
    const a = (b.angebote || []).find(x => x.id === req.params.angebotId);
    if (!a) return res.status(404).json({ error: 'Angebot nicht gefunden.' });
    // Ein beauftragtes Angebot ist der Grund, warum die Bestellung so aussieht,
    // wie sie aussieht — und der Nachweis gegenüber der Verwaltung. Es zu
    // löschen, während die Bestellung darauf steht, hinterließe eine Vergabe
    // ohne Grundlage.
    if (a.gewaehlt && b.bestelltAm) {
      return res.status(409).json({
        error: 'Dieses Angebot ist beauftragt. Erst die Beauftragung zurücknehmen, dann löschen.',
      });
    }
    b.angebote = b.angebote.filter(x => x.id !== a.id);
    // Nur die Verknüpfung fällt weg; das PDF bleibt in Paperless.
    res.json(sichern(b, req));
  });

  // Beauftragen: aus der Anfrage wird eine Bestellung. Lieferant und Bestell-
  // datum kommen aus dem Angebot — genau das ist die Vergabeentscheidung.
  r.post('/:id/angebot/:angebotId/beauftragen', (req, res) => {
    const b = holen(req, res);
    if (!b) return;
    const a = (b.angebote || []).find(x => x.id === req.params.angebotId);
    if (!a) return res.status(404).json({ error: 'Angebot nicht gefunden.' });

    for (const x of b.angebote) x.gewaehlt = (x.id === a.id);
    b.lieferant = a.lieferant || b.lieferant;
    b.bestelltAm = text((req.body || {}).bestelltAm) || heuteIso();

    // Die Bestellung wird zu DEN BEDINGUNGEN dieses Angebots erteilt. Deshalb
    // uebernimmt sie auch dessen Netto/Brutto-Angabe: sonst muesste jeder
    // uebernommene Positionspreis umgerechnet werden, und eine umgerechnete
    // Zahl steht in keinem Angebot -- man koennte sie spaeter nicht wiederfinden.
    const preise = a.preise || {};
    if (Object.keys(preise).length) {
      b.preisArt = a.preisArt === 'brutto' ? 'brutto' : 'netto';
      for (const p of b.positionen || []) {
        if (preise[p.id] !== undefined) p.preis = preise[p.id];
      }
    }

    // Die Differenz zwischen der Summe der Positionen und dem Endbetrag des
    // Angebots IST der Rabatt (so mit Matthias entschieden). Ohne diese Zeile
    // stuende in der Bestellung die Summe der Listenpreise und niemand wuesste
    // mehr, warum die Rechnung niedriger ausfaellt.
    if (Object.keys(preise).length && a.betrag != null) {
      // Gerechnet wird ueber GENAU die Positionen, die das Angebot bepreist --
      // dieselbe Zahl, die der Beauftragen-Dialog vorher angezeigt hat. Wuerde
      // hier ueber alle Positionen summiert, koennte ein alter Preis aus einer
      // frueheren Fassung den Rabatt verfaelschen.
      const roh = (b.positionen || [])
        .filter(p => preise[p.id] !== undefined)
        .reduce((sum, p) => sum + preise[p.id] * p.menge, 0);
      const diff = roh - a.betrag;
      // Nur ein echter Nachlass. Liegt der Endbetrag hoeher (Fracht, Zuschlag),
      // wird nichts erfunden -- das gehoert als eigene Position erfasst.
      if (diff > 0.005) {
        b.nachlassArt = 'betrag';
        b.nachlassWert = Math.round(diff * 100) / 100;
        if (!b.nachlassText) b.nachlassText = `Rabatt laut Angebot${a.nummer ? ' ' + a.nummer : ''}`;
      }
    }
    b.beauftragtAm = nowIso();
    b.beauftragtVon = req.benutzer.name;
    // Die Begründung ist Pflicht, sobald NICHT das günstigste Angebot gewählt
    // wurde — aber das entscheidet die Oberfläche, die die Beträge vergleichen
    // kann. Hier wird sie nur mitgeschrieben.
    if ((req.body || {}).begruendung !== undefined) b.vergabeBegruendung = text(req.body.begruendung);
    res.json(sichern(b, req));
  });

  // Beauftragung zurücknehmen — der Vorgang ist wieder eine Anfrage.
  r.post('/:id/anfrage', (req, res) => {
    const b = holen(req, res);
    if (!b) return;
    if ((b.eingaenge || []).length) {
      // Nach einem Wareneingang wäre das eine Lüge: es wurde geliefert, also
      // wurde beauftragt.
      return res.status(409).json({ error: 'Zu diesem Vorgang wurde bereits Ware gebucht — er lässt sich nicht mehr in eine Anfrage zurückversetzen.' });
    }
    for (const x of b.angebote || []) x.gewaehlt = false;
    b.bestelltAm = '';
    b.beauftragtAm = '';
    b.beauftragtVon = '';
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

  // Die Verknüpfung nachtragen: für Belege, deren Vorgangsnummer nichts mehr
  // hergibt (Paperless vergisst erledigte Uploads) und die über den Titel
  // wiedergefunden wurden. Ohne diesen Weg stünde „wird verarbeitet" für immer.
  r.put('/:id/beleg/:belegId', (req, res) => {
    const b = holen(req, res);
    if (!b) return;
    const beleg = (b.belege || []).find(x => x.id === req.params.belegId);
    if (!beleg) return res.status(404).json({ error: 'Beleg nicht gefunden.' });
    const { dokumentId, titel } = req.body || {};
    if (dokumentId !== undefined) beleg.dokumentId = dokumentId ? Number(dokumentId) : null;
    if (titel !== undefined) beleg.titel = text(titel);
    // Eine gefundene Nummer beendet den Fehlerzustand — sonst bliebe die alte
    // Meldung neben einem Beleg stehen, den man ansehen kann.
    if (beleg.dokumentId) beleg.fehler = '';
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
