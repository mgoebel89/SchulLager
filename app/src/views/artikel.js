(function () {
  'use strict';
  window.SL = window.SL || {};
  SL.views = SL.views || {};

  const { el, karte, input, toast } = SL.ui;

  const PRO_SEITE = 25;

  // Artikelsuche und Artikeldetail.
  //
  // Der Bestand wird bei jedem Aufruf frisch aus Homebox geholt und NICHT
  // zwischengespeichert: zwei Leute am selben Regal dürfen keine
  // unterschiedlichen Zahlen sehen.
  function renderArtikel(mount, params = {}) {
    if (params.id) return detailAnzeigen(mount, params.id, params);
    return listeAnzeigen(mount, params);
  }

  // --- Liste ---------------------------------------------------------------
  function listeAnzeigen(mount, params) {
    const zustand = {
      q: params.q || '',
      ortId: params.ortId || '',
      seite: 1,
      artikel: [],
      gesamt: 0,
      laeuft: false,
    };

    const suchfeld = input({
      value: zustand.q,
      placeholder: 'Bezeichnung, Barcode oder Kennung…',
      autocomplete: 'off',
      'aria-label': 'Suche',
    });

    const ergebnisse = el('div');
    const fuss = el('div', { class: 'btn-reihe' });
    const kopfzeile = el('p', { class: 'muted' }, '');

    const toolbar = el('div', { class: 'toolbar' }, [
      el('h1', {}, 'Artikel'),
      el('span', { class: 'spacer' }),
      SL.store.darfBuchen()
        ? el('a', { class: 'btn', href: '#/neu' }, '+ Artikel')
        : null,
      SL.ui.scannerBereit()
        ? el('button', { class: 'btn btn-primary', type: 'button', onclick: () => SL.views.scanStarten() }, '⌷ Scannen')
        : null,
    ]);
    mount.appendChild(toolbar);

    const filterbar = el('div', { class: 'filterbar' }, [suchfeld]);
    mount.appendChild(karte(null, [filterbar, kopfzeile, ergebnisse, fuss]));

    // Suche erst nach einer kurzen Pause abschicken. Ohne das feuert jede
    // Taste eine Anfrage an Homebox — auf dem Handy spürbar zäh.
    let tippTimer = null;
    suchfeld.addEventListener('input', () => {
      clearTimeout(tippTimer);
      tippTimer = setTimeout(() => {
        zustand.q = suchfeld.value.trim();
        zustand.seite = 1;
        // Suchbegriff in die Adresse schreiben, damit „Zurück" aus dem Detail
        // wieder bei derselben Trefferliste landet.
        adresseSetzen(zustand);
        laden(false);
      }, 300);
    });
    // Enter: sofort suchen, ohne die Pause abzuwarten.
    suchfeld.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      clearTimeout(tippTimer);
      zustand.q = suchfeld.value.trim();
      zustand.seite = 1;
      adresseSetzen(zustand);
      laden(false);
    });

    // Ortsfilter beschriften, sobald der Baum da ist.
    if (zustand.ortId) {
      SL.store.orteLaden().then(orte => {
        const pfad = SL.models.ortPfad(orte, zustand.ortId);
        filterbar.insertBefore(el('span', { class: 'chip chip-aktiv' }, [
          pfad || 'Lagerort',
          el('button', {
            class: 'chip-x', type: 'button', title: 'Filter entfernen',
            onclick: () => { location.hash = '#/artikel'; },
          }, '✕'),
        ]), filterbar.firstChild);
      }).catch(() => {});
    }

    async function laden(anhaengen) {
      if (zustand.laeuft) return;
      zustand.laeuft = true;
      fuss.innerHTML = '';
      if (!anhaengen) {
        ergebnisse.innerHTML = '';
        kopfzeile.textContent = 'Suche…';
      }
      try {
        const a = await SL.api.lagerSuchen({
          q: zustand.q, ortId: zustand.ortId, seite: zustand.seite, proSeite: PRO_SEITE,
        });
        zustand.artikel = anhaengen ? zustand.artikel.concat(a.artikel) : a.artikel;
        zustand.gesamt = a.gesamt;
        zeichnen();
      } catch (e) {
        ergebnisse.innerHTML = '';
        kopfzeile.textContent = '';
        ergebnisse.appendChild(fehlerKarte(e, () => laden(false)));
      } finally {
        zustand.laeuft = false;
      }
    }

    function zeichnen() {
      ergebnisse.innerHTML = '';
      if (!zustand.artikel.length) {
        kopfzeile.textContent = '';
        ergebnisse.appendChild(el('p', { class: 'muted' }, zustand.q
          ? `Nichts gefunden zu „${zustand.q}".`
          : 'Noch keine Artikel in diesem Bestand.'));
        return;
      }
      kopfzeile.textContent = zustand.gesamt > zustand.artikel.length
        ? `${zustand.artikel.length} von ${zustand.gesamt} Treffern`
        : `${zustand.artikel.length} ${zustand.artikel.length === 1 ? 'Treffer' : 'Treffer'}`;

      const liste = el('div', { class: 'liste' });
      for (const a of zustand.artikel) liste.appendChild(artikelZeile(a));
      ergebnisse.appendChild(liste);

      // „Mehr laden" statt Seitenzahlen: am Handy die einzige Bedienform, die
      // sich nicht wie ein Formular anfühlt.
      fuss.innerHTML = '';
      if (zustand.artikel.length < zustand.gesamt) {
        fuss.appendChild(el('button', {
          class: 'btn', type: 'button',
          onclick: () => { zustand.seite += 1; laden(true); },
        }, 'Mehr laden'));
      }
    }

    laden(false);
  }

  function adresseSetzen(zustand) {
    const p = new URLSearchParams();
    if (zustand.q) p.set('q', zustand.q);
    if (zustand.ortId) p.set('ortId', zustand.ortId);
    const neu = '#/artikel' + (p.toString() ? '?' + p.toString() : '');
    // Austauschen statt zuweisen: sonst legt jeder Tastendruck einen Eintrag im
    // Verlauf an und „Zurück" wird unbenutzbar — und ein hashchange-Ereignis
    // würde die Ansicht mitten im Tippen neu aufbauen.
    SL.app.adresseErsetzen(neu);
  }

  function artikelZeile(a) {
    const zeile = el('a', { class: 'eintrag eintrag-klick', href: `#/artikel?id=${encodeURIComponent(a.id)}` }, [
      el('div', { class: 'benutzer-kopf' }, [
        el('strong', {}, a.name || '(ohne Namen)'),
        bestandChip(a),
      ]),
      el('div', { class: 'muted' }, [
        a.ortName ? a.ortName : 'kein Lagerort',
        a.barcode ? ' · ' + a.barcode : '',
      ].join('')),
    ]);
    return zeile;
  }

  // Menge mit Warnung, wenn der Mindestbestand unterschritten ist. In der Liste
  // ist das die wichtigste Einzelinformation — deshalb steht sie direkt neben
  // dem Namen und nicht in der zweiten Zeile.
  function bestandChip(a) {
    const knapp = a.mindestbestand != null && a.menge <= a.mindestbestand;
    return el('span', { class: 'tag' + (knapp ? ' tag-warn' : '') },
      `${a.menge} Stück${knapp ? ' · knapp' : ''}`);
  }

  // --- Detail --------------------------------------------------------------
  async function detailAnzeigen(mount, id, params = {}) {
    mount.appendChild(el('div', { class: 'toolbar' }, [
      el('a', { class: 'btn btn-sm', href: zurueckZiel() }, '‹ Zurück'),
      el('span', { class: 'spacer' }),
    ]));
    const behaelter = el('div');
    mount.appendChild(behaelter);
    behaelter.appendChild(el('p', { class: 'muted' }, 'Wird geladen…'));

    let a = null;
    try {
      a = await SL.api.lagerArtikel(id);
    } catch (e) {
      behaelter.innerHTML = '';
      behaelter.appendChild(fehlerKarte(e, () => { SL.app.router(); }));
      return;
    }

    let pfad = a.ortName || '';
    if (a.ortId) {
      try {
        const orte = await SL.store.orteLaden();
        pfad = SL.models.ortPfad(orte, a.ortId) || a.ortName || '';
      } catch (_) { /* ohne Baum bleibt der einfache Name stehen */ }
    }

    behaelter.innerHTML = '';
    behaelter.appendChild(el('div', { class: 'toolbar' }, [el('h1', {}, a.name || '(ohne Namen)')]));

    // Nach jeder Buchung den Artikel frisch holen statt lokal zu rechnen:
    // in der Zwischenzeit kann jemand anders am selben Regal gebucht haben.
    const neuLaden = () => SL.app.router();

    // Ausleihe und Defektmeldungen liegen in unserer Datenbank und sind nur
    // angemeldet abrufbar. Fehlschläge dürfen die Artikelansicht nicht
    // mitreißen — sie ist auch ohne diese Angaben brauchbar.
    let leihe = null;
    let defekt = null;
    if (SL.store.darfBuchen()) {
      const [ausleihen, defekte] = await Promise.all([
        SL.api.listAusleihen(false).catch(() => []),
        SL.api.listDefekte(false).catch(() => []),
      ]);
      leihe = ausleihen.find(x => x.artikelId === a.id
        && (x.art || 'ausleihe') === 'ausleihe' && !x.zurueckAm) || null;
      defekt = defekte.find(x => x.artikelId === a.id && !x.behobenAm) || null;
    }

    // Gerät (Demonstrator oder Netzgerät) oder Verbrauchsmaterial? Hier ist
    // die Prüfung verlässlich: `a` ist der DETAIL-Datensatz und trägt die
    // Marken vollständig — eine Listen-Kurzfassung täte das nicht.
    const art = SL.models.geraeteArt(a, SL.store.state.settings);
    const istDemo = !!art;

    if (defekt) behaelter.appendChild(defektHinweis(defekt, neuLaden));
    if (leihe) behaelter.appendChild(leihHinweis(leihe, neuLaden));

    // Die Buchungskarte steht vor den Stammdaten. Wer am Regal steht, will
    // entnehmen — nicht erst an Beschreibung und Hersteller vorbeiscrollen.
    if (SL.store.darfBuchen()) behaelter.appendChild(buchenKarte(a, neuLaden));

    const kopf = el('div', { class: 'artikel-kopf' }, [
      el('div', { class: 'artikel-menge' }, [
        el('span', { class: 'artikel-zahl' }, String(a.menge)),
        el('span', { class: 'muted' }, 'Stück'),
      ]),
      a.mindestbestand != null && a.menge <= a.mindestbestand
        ? el('span', { class: 'ampel ampel-faellig' }, `Mindestbestand ${a.mindestbestand} erreicht`)
        : null,
    ]);

    const daten = el('dl', { class: 'daten' });
    // Nur verlinken, wenn es auch ein Ziel gibt: ein Artikel kann einen
    // Ortsnamen ohne Ortsbezug tragen (ältere Homebox-Antworten), und ein Link
    // auf „#/orte?id=" führte ins Leere.
    datenZeile(daten, 'Lagerort', a.ortId && pfad
      ? el('a', { href: `#/orte?id=${encodeURIComponent(a.ortId)}` }, pfad)
      : (pfad ? el('span', {}, pfad) : el('span', { class: 'muted' }, 'nicht zugeordnet')));
    if (a.beschreibung) datenZeile(daten, 'Beschreibung', a.beschreibung);
    if (a.barcode) datenZeile(daten, 'Barcode', el('span', { class: 'lager-barcode' }, a.barcode));
    if (a.code) datenZeile(daten, 'Kennung', el('span', { class: 'lager-barcode' }, a.code));
    if (a.mindestbestand != null) datenZeile(daten, 'Mindestbestand', String(a.mindestbestand));
    if (a.hersteller) datenZeile(daten, 'Hersteller', a.hersteller);
    if (a.marken && a.marken.length) {
      datenZeile(daten, 'Marken', el('span', { class: 'chips-statisch' },
        a.marken.map(m => el('span', { class: 'tag' }, m.name))));
    }
    const werkzeuge = SL.store.darfBuchen()
      ? el('div', { class: 'btn-reihe' }, [
        el('button', { class: 'btn btn-sm', type: 'button', onclick: () => bearbeitenDialog(a, neuLaden) }, 'Bearbeiten'),
        el('button', { class: 'btn btn-sm', type: 'button', onclick: () => umlagern(a, neuLaden) }, 'Umlagern'),
        // Ausleihen gibt es NUR für Demonstratoren (so entschieden): sonst
        // „leiht" jemand 200 Widerstände aus, die nie zurückkommen.
        // Verbrauchsmaterial wird stattdessen ausgegeben — das bucht den
        // Bestand ab und hält fest, an welche Klasse es ging.
        //
        // Verliehen? Dann führt der Weg über die Rückgabe oben, nicht über
        // einen zweiten Ausleih-Knopf.
        (leihe || !istDemo) ? null : el('button', {
          class: 'btn btn-sm', type: 'button',
          onclick: () => SL.views.ausleihenDialog(a, neuLaden),
        }, 'Ausleihen'),
        istDemo ? null : el('button', {
          class: 'btn btn-sm', type: 'button',
          onclick: () => SL.views.ausgabeDialog(a, neuLaden),
        }, 'Ausgabe an Gruppe'),
        defekt ? null : el('button', {
          class: 'btn btn-sm', type: 'button',
          onclick: () => SL.views.defektDialog(a, neuLaden),
        }, 'Defekt melden'),
        SL.ui.fotoPickButtons(async (datei) => {
          try {
            const klein = await SL.ui.resizeImageFile(datei);
            await SL.api.lagerFoto(a.id, klein);
            SL.ui.toast('Foto an Homebox übergeben.');
          } catch (e) { SL.ui.toast(e.message || 'Das Foto ging nicht durch.', 4500); }
        }, '📷 Foto'),
      ])
      : null;
    behaelter.appendChild(karte(null, [kopf, daten, werkzeuge]));

    // Beschaffung nur zeigen, wenn etwas drinsteht — eine Karte mit vier
    // leeren Zeilen ist schlechter als gar keine.
    if (a.kaufdatum || a.kaufpreis || a.lieferant) {
      const b = el('dl', { class: 'daten' });
      if (a.kaufdatum) datenZeile(b, 'Kaufdatum', SL.ui.formatDatum(String(a.kaufdatum).slice(0, 10)));
      if (a.kaufpreis) datenZeile(b, 'Preis', SL.ui.formatZahl(a.kaufpreis, 2) + ' €');
      if (a.lieferant) datenZeile(b, 'Lieferant', a.lieferant);
      behaelter.appendChild(karte('Beschaffung', b));
    }

    if (a.notizen) behaelter.appendChild(karte('Notizen', el('p', {}, a.notizen)));

    // Netzangaben gibt es nur bei Geräten — ein Widerstand hat keine SPS.
    // Bei einem Netzgerät beschreiben sie das Gerät selbst, bei einem
    // Demonstrator seine Einbauten; die Karte heißt deshalb unterschiedlich.
    if (istDemo && SL.store.darfBuchen()) {
      behaelter.appendChild(await SL.views.komponentenKarte(a, neuLaden, art));
      behaelter.appendChild(await defektHistorie(a));
      // Frisch angelegtes Netzgerät: die Eingabe gleich öffnen. Ohne das
      // müsste man nach dem Anlegen erst suchen, wofür man es angelegt hat.
      if (params.netz === '1') {
        SL.app.adresseErsetzen(`#/artikel?id=${encodeURIComponent(a.id)}`);
        SL.views.komponenteAnlegen(a, neuLaden);
      }
    }

    if (!SL.store.darfBuchen()) {
      behaelter.appendChild(karte(null, el('p', { class: 'muted' }, [
        'Zum Buchen bitte ',
        el('a', { href: '#/anmelden' }, 'anmelden'),
        '.',
      ])));
    }
  }

  // Verliehen: der Zustand gehört ganz nach oben. Wer den Artikel sucht,
  // findet ihn nicht im Schrank — und die Antwort warum, muss die erste sein.
  function leihHinweis(leihe, neuLaden) {
    const st = SL.models.leihStatus(leihe);
    return karte(null, [
      el('div', { class: 'daten-zeile status-zeile' }, [
        el('span', { class: 'ampel ' + st.klasse }, 'verliehen'),
        el('span', {}, [
          `an ${leihe.benutzerName}`,
          leihe.klasse ? ` (Klasse ${leihe.klasse})` : '',
          ` seit ${SL.ui.formatDatum(String(leihe.ausgeliehenAm).slice(0, 10))}`,
          leihe.faelligAm ? ` — ${st.label}` : '',
        ].join('')),
      ]),
      leihe.notiz ? el('p', { class: 'muted' }, leihe.notiz) : null,
      el('div', { class: 'btn-reihe' }, [
        el('button', {
          class: 'btn btn-primary btn-sm', type: 'button',
          onclick: async () => {
            try {
              await SL.api.rueckgabe(leihe.id);
              SL.ui.toast('Zurückgebucht.');
              neuLaden();
            } catch (e) { SL.ui.toast(e.message || 'Rückgabe fehlgeschlagen.', 4500); }
          },
        }, 'Zurückgenommen'),
      ]),
    ]);
  }

  function defektHinweis(defekt, neuLaden) {
    return karte(null, [
      el('div', { class: 'daten-zeile status-zeile' }, [
        el('span', { class: 'ampel ampel-faellig' }, 'defekt'),
        el('span', {}, defekt.notiz),
      ]),
      el('p', { class: 'muted' },
        `gemeldet von ${defekt.gemeldetVon} am ${SL.ui.formatDatum(String(defekt.gemeldetAm).slice(0, 10))}`),
      el('div', { class: 'btn-reihe' }, [
        el('button', {
          class: 'btn btn-sm', type: 'button',
          onclick: async () => {
            try {
              await SL.api.defektBehoben(defekt.id);
              SL.ui.toast('Als repariert vermerkt.');
              neuLaden();
            } catch (e) { SL.ui.toast(e.message || 'Das hat nicht geklappt.', 4500); }
          },
        }, 'Repariert'),
      ]),
    ]);
  }

  // --- Defekt-Historie ------------------------------------------------------
  // Nicht nur der aktuelle Defekt zählt, sondern die Vorgeschichte: ein Gerät,
  // das dreimal im Jahr ausfällt, ist ein Fall für Ersatz und nicht für die
  // vierte Reparatur. Deshalb bleiben behobene Meldungen stehen, statt beim
  // Abhaken zu verschwinden.
  async function defektHistorie(a) {
    const box = el('div');
    const details = el('details', { class: 'aufklapp' }, [
      el('summary', {}, 'Defekt-Historie'),
      box,
    ]);
    const k = karte(null, details);
    box.appendChild(el('p', { class: 'muted' }, 'Wird geladen…'));

    let alle = [];
    try {
      alle = (await SL.api.listDefekte(true)).filter(d => d.artikelId === a.id);
    } catch (e) {
      box.innerHTML = '';
      box.appendChild(el('p', { class: 'anmeldung-fehler' }, e.message || ''));
      return k;
    }

    box.innerHTML = '';
    if (!alle.length) {
      box.appendChild(el('p', { class: 'muted' }, 'Für dieses Gerät wurde noch nie ein Defekt gemeldet.'));
      return k;
    }

    alle.sort((x, y) => String(y.gemeldetAm).localeCompare(String(x.gemeldetAm)));
    const offen = alle.filter(d => !d.behobenAm).length;

    // Die Kopfzeile beantwortet die Frage, für die man die Historie aufmacht:
    // wie oft war das Ding schon kaputt?
    details.querySelector('summary').textContent =
      `Defekt-Historie (${alle.length} ${alle.length === 1 ? 'Meldung' : 'Meldungen'}`
      + (offen ? `, ${offen} offen` : '') + ')';

    const liste = el('div', { class: 'liste' });
    for (const d of alle) {
      liste.appendChild(el('div', { class: 'eintrag' }, [
        el('div', { class: 'benutzer-kopf' }, [
          el('span', { class: 'ampel ' + (d.behobenAm ? 'ampel-ok' : 'ampel-faellig') },
            d.behobenAm ? 'behoben' : 'offen'),
          el('span', { class: 'muted' }, SL.ui.formatDatum(String(d.gemeldetAm).slice(0, 10))),
        ]),
        el('div', {}, d.notiz),
        el('div', { class: 'muted' }, [
          `gemeldet von ${d.gemeldetVon}`,
          d.behobenAm ? ` · behoben am ${SL.ui.formatDatum(String(d.behobenAm).slice(0, 10))}${d.behobenVon ? ' von ' + d.behobenVon : ''}` : '',
        ].join('')),
      ]));
    }
    box.appendChild(liste);
    return k;
  }

  // --- Buchen --------------------------------------------------------------
  // Die Buchungskarte steht GANZ OBEN im Detail: wer am Regal steht, will
  // entnehmen und nicht lesen. Sie wird deshalb vor den Stammdaten eingefügt.
  function buchenKarte(a, neuLaden) {
    let menge = 1;

    const anzeige = input({
      class: 'inp buchen-menge', type: 'number', min: '1', value: '1',
      inputmode: 'numeric', 'aria-label': 'Anzahl',
    });
    const setzen = (n) => {
      menge = Math.max(1, n || 1);
      anzeige.value = String(menge);
    };
    anzeige.addEventListener('input', () => { menge = Math.max(1, parseInt(anzeige.value, 10) || 1); });

    const stepper = el('div', { class: 'buchen-stepper' }, [
      el('button', { class: 'btn btn-rund', type: 'button', 'aria-label': 'weniger', onclick: () => setzen(menge - 1) }, '−'),
      anzeige,
      el('button', { class: 'btn btn-rund', type: 'button', 'aria-label': 'mehr', onclick: () => setzen(menge + 1) }, '+'),
    ]);

    const knoepfe = el('div', { class: 'buchen-reihe' }, [
      el('button', {
        class: 'btn btn-primary buchen-knopf', type: 'button',
        onclick: () => buchen(a, -menge, neuLaden),
      }, '− Entnehmen'),
      el('button', {
        class: 'btn buchen-knopf', type: 'button',
        onclick: () => buchen(a, +menge, neuLaden),
      }, '+ Zurücklegen'),
    ]);

    return karte('Buchen', [stepper, knoepfe]);
  }

  async function buchen(a, delta, neuLaden) {
    // Mehr entnehmen als da ist, ist fast immer ein Vertipper — aber nicht
    // immer: der Bestand kann falsch geführt sein. Deshalb nachfragen statt
    // verbieten. Homebox kappt serverseitig ohnehin bei null.
    if (delta < 0 && -delta > a.menge) {
      const weiter = SL.ui.confirmDialog(
        `Es sind nur ${a.menge} Stück verzeichnet, entnommen werden sollen ${-delta}. `
        + 'Trotzdem buchen? Der Bestand geht dann auf 0.');
      if (!weiter) return;
    }
    try {
      const neu = await SL.api.lagerBestand(a.id, { delta });
      toast(`${delta < 0 ? 'Entnommen' : 'Zurückgelegt'}: ${Math.abs(delta)} — Bestand jetzt ${neu.menge}.`, 3000);
      neuLaden();
    } catch (e) {
      toast(e.message || 'Die Buchung hat nicht geklappt.', 4500);
    }
  }

  // --- Bearbeiten ----------------------------------------------------------
  function bearbeitenDialog(a, neuLaden) {
    const name = input({ value: a.name || '' });
    const beschreibung = SL.ui.textarea({ rows: 2 });
    beschreibung.value = a.beschreibung || '';
    const barcode = input({ value: a.barcode || '', autocapitalize: 'none' });
    const mindest = input({ type: 'number', min: '0', value: a.mindestbestand != null ? String(a.mindestbestand) : '' });
    const hersteller = input({ value: a.hersteller || '' });
    const notizen = SL.ui.textarea({ rows: 2 });
    notizen.value = a.notizen || '';

    const dlg = SL.ui.modal('Artikel bearbeiten', [
      feldBlock('Bezeichnung', name),
      feldBlock('Beschreibung', beschreibung),
      feldBlock('Barcode', barcode),
      feldBlock('Mindestbestand (leer = keine Warnung)', mindest),
      feldBlock('Hersteller', hersteller),
      feldBlock('Notizen', notizen),
      el('p', { class: 'muted' }, 'Die Angaben werden in Homebox gespeichert und sind dort ebenfalls sichtbar.'),
    ], {
      fuss: [
        el('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
        el('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: async () => {
            if (!name.value.trim()) { toast('Bitte eine Bezeichnung angeben.'); return; }
            try {
              await SL.api.lagerSpeichern(a.id, {
                name: name.value.trim(),
                beschreibung: beschreibung.value,
                barcode: barcode.value.trim(),
                // Leeres Feld heißt „keine Warnung" — das muss als null
                // durchgereicht werden, sonst bliebe der alte Wert stehen.
                mindestbestand: mindest.value === '' ? null : Math.max(0, parseInt(mindest.value, 10) || 0),
                hersteller: hersteller.value.trim(),
                notizen: notizen.value,
              });
              dlg.close();
              toast('Gespeichert.');
              neuLaden();
            } catch (e) { toast(e.message || 'Speichern fehlgeschlagen.', 4500); }
          },
        }, 'Speichern'),
      ],
    });
    setTimeout(() => name.focus(), 50);
  }

  function feldBlock(label, control) {
    return el('label', { class: 'feld feld-breit' }, [
      el('span', { class: 'feld-label' }, label),
      control,
    ]);
  }

  // --- Umlagern ------------------------------------------------------------
  function umlagern(a, neuLaden) {
    SL.ui.ortWaehlen({
      titel: 'Wohin umlagern?',
      aktuellId: a.ortId,
      onWahl: async (ort) => {
        if (ort.id === a.ortId) { toast('Der Artikel liegt schon dort.'); return; }
        try {
          await SL.api.lagerSpeichern(a.id, { ortId: ort.id });
          toast(`Umgelagert nach ${ort.name}.`, 3000);
          neuLaden();
        } catch (e) { toast(e.message || 'Umlagern fehlgeschlagen.', 4500); }
      },
    });
  }

  // Zurück in die Trefferliste — mit Suchbegriff, wenn wir von dort kamen.
  function zurueckZiel() {
    const vorher = SL.app.vorigeAdresse();
    return (vorher && vorher.startsWith('#/artikel') && !vorher.includes('id=')) ? vorher : '#/artikel';
  }

  function datenZeile(dl, label, wert) {
    dl.appendChild(el('div', { class: 'daten-zeile' }, [
      el('dt', {}, label),
      el('dd', {}, typeof wert === 'string' ? el('span', {}, wert) : wert),
    ]));
  }

  // Fehler aus dem Homebox-Weg brauchen eine eigene Behandlung: „nicht
  // eingerichtet" (503) ist kein Defekt, sondern eine offene Aufgabe.
  function fehlerKarte(e, nochmal) {
    const status = e && e.status;
    if (status === 503) {
      return karte('Homebox fehlt', [
        el('p', { class: 'muted' }, 'Der Bestand liegt in Homebox — die ist noch nicht eingerichtet.'),
        SL.store.istAdmin()
          ? el('div', { class: 'btn-reihe' }, [el('a', { class: 'btn btn-primary', href: '#/einstellungen' }, 'Jetzt einrichten')])
          : el('p', { class: 'muted' }, 'Bitte an einen Administrator wenden.'),
      ]);
    }
    return karte('Das hat nicht geklappt', [
      el('p', { class: 'anmeldung-fehler' }, (e && e.message) || 'Unbekannter Fehler'),
      el('div', { class: 'btn-reihe' }, [
        el('button', { class: 'btn', type: 'button', onclick: nochmal }, 'Erneut versuchen'),
      ]),
    ]);
  }

  SL.views.renderArtikel = renderArtikel;
  SL.views.artikelFehlerKarte = fehlerKarte;
})();
