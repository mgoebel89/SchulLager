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
    if (params.id) return detailAnzeigen(mount, params.id);
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
  async function detailAnzeigen(mount, id) {
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
    datenZeile(daten, 'Lagerort', pfad
      ? el('a', { href: `#/orte?id=${encodeURIComponent(a.ortId)}` }, pfad)
      : el('span', { class: 'muted' }, 'nicht zugeordnet'));
    if (a.beschreibung) datenZeile(daten, 'Beschreibung', a.beschreibung);
    if (a.barcode) datenZeile(daten, 'Barcode', el('span', { class: 'lager-barcode' }, a.barcode));
    if (a.code) datenZeile(daten, 'Kennung', el('span', { class: 'lager-barcode' }, a.code));
    if (a.mindestbestand != null) datenZeile(daten, 'Mindestbestand', String(a.mindestbestand));
    if (a.hersteller) datenZeile(daten, 'Hersteller', a.hersteller);
    if (a.marken && a.marken.length) {
      datenZeile(daten, 'Marken', el('span', { class: 'chips-statisch' },
        a.marken.map(m => el('span', { class: 'tag' }, m.name))));
    }
    behaelter.appendChild(karte(null, [kopf, daten]));

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

    // Was hier später hinkommt, steht bewusst schon da: sonst sucht man beim
    // Testen nach einem Knopf, den es noch gar nicht geben soll.
    behaelter.appendChild(karte(null, el('p', { class: 'muted' },
      SL.store.darfBuchen()
        ? 'Entnahme, Rückgabe und Bearbeiten kommen in der nächsten Ausbaustufe.'
        : 'Zum Buchen bitte anmelden.')));
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
