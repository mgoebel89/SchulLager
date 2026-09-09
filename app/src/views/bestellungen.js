(function () {
  'use strict';
  window.SL = window.SL || {};
  SL.views = SL.views || {};

  const { el, karte, feld, input, textarea, toast, modal, leer, formatDatum } = SL.ui;

  // Beschaffung: bestellen → Wareneingang gegen den Lieferschein → einlagern →
  // Rechnung nachtragen.
  //
  // DER ROTE FADEN: Die Bestellung ist die führende Liste. Beim Prüfen sieht
  // man alle bestellten Positionen mit Soll-Menge; der Scan springt zur
  // passenden Zeile und zählt hoch. Was fehlt, fällt dadurch von selbst auf —
  // ohne dass jemand am Ende noch einmal alles durchgehen müsste.
  //
  // Gescannt wird auf zwei Wegen: mit der Kamera wie im übrigen Lager UND über
  // das Eingabefeld, in das ein USB-Handscanner wie eine Tastatur hineintippt
  // (Abschluss mit Enter). Deshalb hat das Feld immer den Fokus.

  const ZUSTAND = {
    offen: { label: 'offen', klasse: 'ampel-offen' },
    teilweise: { label: 'teilweise geliefert', klasse: 'ampel-bald' },
    vollstaendig: { label: 'vollständig geliefert', klasse: 'ampel-ok' },
    erledigt: { label: 'erledigt', klasse: 'ampel-ok' },
    storniert: { label: 'storniert', klasse: 'ampel-warnung' },
  };

  const euro = (n) => (n === null || n === undefined || n === '' ? '' : SL.ui.formatZahl(n, 2) + ' €');
  const zustandFlagge = (z) => el('span', { class: 'ampel ' + (ZUSTAND[z] || ZUSTAND.offen).klasse }, (ZUSTAND[z] || ZUSTAND.offen).label);

  // --- Einstieg -------------------------------------------------------------
  async function renderBestellungen(mount, params = {}) {
    if (!SL.store.istAngemeldet()) {
      mount.appendChild(karte('Anmeldung nötig', [
        el('p', { class: 'muted' }, 'Bestellungen, Preise und Rechnungen sind angemeldeten Lehrkräften vorbehalten.'),
        el('p', {}, [el('a', { class: 'btn btn-primary', href: '#/anmelden?weiter=' + encodeURIComponent('#/bestellungen') }, 'Anmelden')]),
      ]));
      return;
    }
    if (params.id) return renderDetail(mount, params.id);
    return renderListe(mount, params);
  }

  // --- Liste ----------------------------------------------------------------
  async function renderListe(mount, params) {
    const filter = params.filter || 'offen';

    mount.appendChild(el('div', { class: 'toolbar' }, [
      el('h1', {}, 'Bestellungen'),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'btn btn-primary', type: 'button',
        onclick: () => bestellungBearbeiten(null),
      }, '+ Neue Bestellung'),
    ]));

    mount.appendChild(el('div', { class: 'geraete-filter' }, [
      el('a', { class: 'chip' + (filter === 'offen' ? ' chip-aktiv' : ''), href: '#/bestellungen?filter=offen' }, 'Offen'),
      el('a', { class: 'chip' + (filter === 'alle' ? ' chip-aktiv' : ''), href: '#/bestellungen?filter=alle' }, 'Alle'),
    ]));

    const box = el('div');
    mount.appendChild(box);
    box.appendChild(karte(null, leer('Wird geladen…')));

    let liste = [];
    try {
      liste = await SL.api.listBestellungen();
    } catch (e) {
      box.innerHTML = '';
      box.appendChild(karte('Bestellungen', el('p', { class: 'anmeldung-fehler' }, e.message)));
      return;
    }

    const sichtbar = filter === 'offen'
      ? liste.filter(b => !['erledigt', 'storniert', 'vollstaendig'].includes(b.zustand))
      : liste;

    box.innerHTML = '';
    if (!sichtbar.length) {
      box.appendChild(karte(null, [
        leer(filter === 'offen'
          ? 'Keine offene Bestellung. Was geliefert und eingelagert ist, steht unter „Alle".'
          : 'Noch keine Bestellung erfasst.'),
        // Merksatz aus der Ausleihe: die Seite, auf der man nachschaut, muss
        // auch der Ort sein, an dem man den Vorgang startet.
        el('div', { class: 'btn-reihe' }, [
          el('button', { class: 'btn btn-primary', type: 'button', onclick: () => bestellungBearbeiten(null) }, '+ Neue Bestellung'),
        ]),
      ]));
      return;
    }

    for (const b of sichtbar) {
      const zeilen = [
        el('div', { class: 'kachel-kopf' }, [
          el('h3', {}, b.lieferant || '(ohne Lieferant)'),
          zustandFlagge(b.zustand),
        ]),
        el('p', { class: 'muted' }, [
          formatDatum(String(b.bestelltAm || '').slice(0, 10)),
          b.belegnummer ? ` · ${b.belegnummer}` : '',
          ` · ${b.anzahlPositionen} ${b.anzahlPositionen === 1 ? 'Position' : 'Positionen'}`,
          b.summe ? ` · ${euro(b.summe)}` : '',
        ].join('')),
      ];
      if (b.einzulagern) {
        zeilen.push(el('p', { class: 'ampel ampel-bald' }, `${b.einzulagern} noch einzulagern`));
      }
      const k = karte(null, zeilen, { class: 'kachel-offen' });
      k.style.cursor = 'pointer';
      k.addEventListener('click', () => { location.hash = `#/bestellungen?id=${encodeURIComponent(b.id)}`; });
      mount.appendChild(k);
    }
  }

  // --- Detail ---------------------------------------------------------------
  async function renderDetail(mount, id) {
    const box = el('div');
    mount.appendChild(box);
    box.appendChild(karte(null, leer('Wird geladen…')));

    let b = null;
    try {
      b = await SL.api.getBestellung(id);
    } catch (e) {
      box.innerHTML = '';
      box.appendChild(karte('Bestellung', el('p', { class: 'anmeldung-fehler' }, e.message)));
      return;
    }

    const auffrischen = () => { mount.innerHTML = ''; renderDetail(mount, id); };

    box.innerHTML = '';
    box.appendChild(el('div', { class: 'toolbar' }, [
      el('a', { class: 'btn btn-sm', href: SL.app.vorigeAdresse() || '#/bestellungen' }, '‹ Zurück'),
      el('h1', {}, b.lieferant || 'Bestellung'),
      el('span', { class: 'spacer' }),
      zustandFlagge(b.zustand),
    ]));

    // --- Kopf
    const kopf = el('dl', { class: 'daten' }, [
      zeile('Bestellt am', formatDatum(String(b.bestelltAm || '').slice(0, 10))),
      b.belegnummer ? zeile('Bestellnummer', b.belegnummer) : null,
      zeile('Positionen', String((b.positionen || []).length)),
      zeile('Summe (bestellt)', euro(b.summe)),
      b.rechnung ? zeile('Rechnung', `${b.rechnung.nummer || '(ohne Nummer)'} vom ${formatDatum(b.rechnung.datum)}${b.rechnung.betrag != null ? ' · ' + euro(b.rechnung.betrag) : ''}`) : null,
      b.notiz ? zeile('Bemerkung', b.notiz) : null,
    ]);

    const aktionen = el('div', { class: 'btn-reihe' }, [
      el('button', {
        class: 'btn btn-primary', type: 'button',
        disabled: b.zustand === 'storniert',
        onclick: () => wareneingangOeffnen(b, auffrischen),
      }, '📦 Wareneingang'),
      b.einzulagern ? el('button', {
        class: 'btn', type: 'button', onclick: () => einlagernOeffnen(b, auffrischen),
      }, `🗄 Einlagern (${b.einzulagern})`) : null,
      el('button', { class: 'btn', type: 'button', onclick: () => rechnungOeffnen(b, auffrischen) }, '🧾 Rechnung'),
      el('button', { class: 'btn', type: 'button', onclick: () => bestellungBearbeiten(b, auffrischen) }, 'Bearbeiten'),
      el('button', {
        class: 'btn', type: 'button',
        onclick: () => SL.export.bestellungPdf(b),
      }, 'Bestellanforderung (PDF)'),
    ]);

    box.appendChild(karte('Bestellung', [kopf, aktionen]));

    // --- Positionen
    box.appendChild(karte('Positionen', [positionenTabelle(b)]));

    // --- Belege
    box.appendChild(await belegKarte(b, auffrischen));

    // --- Wareneingänge (Verlauf)
    if ((b.eingaenge || []).length) {
      const eintraege = el('ul', { class: 'liste' });
      for (const e of [...b.eingaenge].reverse()) {
        const stueck = e.positionen.reduce((s, p) => s + p.menge, 0);
        eintraege.appendChild(el('li', {}, [
          el('div', {}, `${formatDatum(String(e.datum).slice(0, 10))} — ${e.positionen.length} ${e.positionen.length === 1 ? 'Position' : 'Positionen'}, ${stueck} Stück`),
          el('div', { class: 'muted' }, `${e.von}${e.notiz ? ' · ' + e.notiz : ''}`),
        ]));
      }
      box.appendChild(karte('Wareneingänge', eintraege));
    }

    // --- Zustand
    box.appendChild(karte('Vorgang', [
      el('p', { class: 'muted' }, 'Eine Bestellung bleibt offen, solange etwas fehlt. „Erledigt" ist eine Entscheidung — '
        + 'etwa wenn der Rest nicht mehr kommt und nachbestellt wird.'),
      el('div', { class: 'btn-reihe' }, [
        b.zustand !== 'erledigt' ? el('button', { class: 'btn', type: 'button', onclick: () => zustand(b, 'erledigt', auffrischen) }, 'Als erledigt schließen') : null,
        b.zustand !== 'storniert' ? el('button', { class: 'btn', type: 'button', onclick: () => zustand(b, 'storniert', auffrischen) }, 'Stornieren') : null,
        (b.zustand === 'erledigt' || b.zustand === 'storniert') ? el('button', { class: 'btn', type: 'button', onclick: () => zustand(b, 'offen', auffrischen) }, 'Wieder öffnen') : null,
        SL.store.istAdmin() ? el('button', {
          class: 'btn btn-danger', type: 'button',
          onclick: async () => {
            if (!SL.ui.confirmDialog('Bestellung wirklich löschen? Gebuchter Bestand bleibt in Homebox bestehen.')) return;
            try { await SL.api.bestellungLoeschen(b.id); toast('Bestellung gelöscht.'); location.hash = '#/bestellungen'; }
            catch (e) { toast(e.message || 'Löschen fehlgeschlagen.'); }
          },
        }, 'Löschen') : null,
      ]),
    ]));
  }

  function zeile(label, wert) {
    if (!wert) return null;
    return el('div', { class: 'daten-zeile' }, [el('dt', {}, label), el('dd', {}, String(wert))]);
  }

  async function zustand(b, z, fertig) {
    try { await SL.api.bestellungZustand(b.id, z); toast('Vorgang aktualisiert.'); fertig(); }
    catch (e) { toast(e.message || 'Ändern fehlgeschlagen.'); }
  }

  function positionenTabelle(b) {
    const wrap = el('div', { class: 'tabelle-scroll' });
    const t = el('table', { class: 'ds-tabelle' });
    t.appendChild(el('thead', {}, el('tr', {}, [
      el('th', {}, 'Artikel'),
      el('th', {}, 'Bestellt'),
      el('th', {}, 'Geliefert'),
      el('th', {}, 'Preis'),
      el('th', {}, 'Lagerort'),
    ])));
    const tb = el('tbody');
    for (const p of b.positionen || []) {
      const fehlt = p.menge - (p.geliefert || 0);
      tb.appendChild(el('tr', { class: 'ds-zeile' + (fehlt > 0 && (p.geliefert || 0) > 0 ? ' ds-zeile-warn' : '') }, [
        el('td', {}, [
          el('div', {}, p.artikelName || '(ohne Bezeichnung)'),
          el('div', { class: 'muted' }, [
            p.bestellnummer ? `Best.-Nr. ${p.bestellnummer}` : '',
            // Eine freie Position hat noch keinen Artikel im Lager. Das muss
            // man sehen, denn beim Wareneingang ist genau das der Zwischenschritt.
            !p.artikelId ? (p.bestellnummer ? ' · ' : '') + 'freie Position' : '',
          ].join('')),
        ]),
        el('td', {}, String(p.menge)),
        el('td', {}, (p.geliefert || 0) + (fehlt > 0 ? ` (${fehlt} fehlen)` : '')),
        el('td', {}, euro(p.preis)),
        el('td', {}, p.ortName || ''),
      ]));
    }
    t.appendChild(tb);
    wrap.appendChild(t);
    return wrap;
  }

  // --- Belege (Paperless) ---------------------------------------------------
  async function belegKarte(b, fertig) {
    let eingerichtet = false;
    try { eingerichtet = (await SL.api.paperlessHealth()).eingerichtet; } catch (_) {}

    const inhalt = [];
    if (!eingerichtet) {
      inhalt.push(el('p', { class: 'muted' }, 'Paperless ist noch nicht eingerichtet — Belege lassen sich erst danach ablegen. '
        + 'Ein Administrator trägt Adresse und Zugangsschlüssel unter Einstellungen → Paperless ein.'));
      return karte('Belege', inhalt);
    }

    const liste = el('div');
    for (const beleg of b.belege || []) {
      const titel = beleg.titel || (beleg.art === 'rechnung' ? 'Rechnung' : 'Lieferschein');
      liste.appendChild(el('div', { class: 'doc-zeile' }, [
        el('span', { class: 'doc-titel' }, [
          el('strong', {}, titel),
          el('span', { class: 'muted' }, ` · ${beleg.art} · ${formatDatum(String(beleg.hochgeladenAm).slice(0, 10))}`),
        ]),
        // Schwebend heißt: Paperless verarbeitet noch (OCR). Kein Fehler —
        // aber es muss dranstehen, sonst hält man den Beleg für verloren.
        beleg.dokumentId
          ? el('a', { class: 'btn btn-sm', href: SL.api.paperlessDateiUrl(beleg.dokumentId, 'preview'), target: '_blank', rel: 'noopener' }, 'Ansehen')
          : el('span', { class: 'ampel ' + (beleg.fehler ? 'ampel-warnung' : 'ampel-offen') },
            beleg.fehler ? 'Paperless meldet einen Fehler' : 'wird verarbeitet…'),
        el('button', {
          class: 'btn btn-sm link-danger', type: 'button',
          title: 'Nur die Verknüpfung lösen — das Dokument bleibt in Paperless.',
          onclick: async () => {
            if (!SL.ui.confirmDialog('Verknüpfung lösen? Das Dokument selbst bleibt in Paperless erhalten.')) return;
            try { await SL.api.belegLoesen(b.id, beleg.id); toast('Verknüpfung gelöst.'); fertig(); }
            catch (e) { toast(e.message || 'Fehlgeschlagen.'); }
          },
        }, '✕'),
      ]));
    }
    if (!(b.belege || []).length) liste.appendChild(leer('Noch kein Beleg abgelegt.'));

    inhalt.push(liste);
    inhalt.push(el('div', { class: 'btn-reihe' }, [
      el('button', { class: 'btn', type: 'button', onclick: () => belegHochladen(b, 'lieferschein', fertig) }, '+ Lieferschein'),
      el('button', { class: 'btn', type: 'button', onclick: () => belegHochladen(b, 'rechnung', fertig) }, '+ Rechnung'),
    ]));
    inhalt.push(el('p', { class: 'muted' }, 'Belege liegen in Paperless — hier steht nur die Verknüpfung. '
      + 'Ein Foto des Lieferscheins genügt; die Rechnung geht als PDF.'));
    return karte('Belege', inhalt);
  }

  async function belegHochladen(b, art, fertig) {
    // Am Lieferschein steht man mit dem Handy vor dem Karton → Kamera.
    // Die Rechnung ist eine Datei auf dem Rechner → Dateiauswahl.
    const datei = art === 'lieferschein'
      ? await SL.ui.pickFile('image/*,application/pdf', 'environment')
      : await SL.ui.pickFile('application/pdf,image/*');
    if (!datei) return;

    const titel = `${art === 'rechnung' ? 'Rechnung' : 'Lieferschein'} ${b.lieferant || ''}`.trim()
      + (b.belegnummer ? ` (${b.belegnummer})` : '');
    toast('Beleg wird hochgeladen…', 8000);
    try {
      // Fotos verkleinern; PDFs bleiben unangetastet (resizeImageFile gibt sie
      // unverändert zurück).
      const klein = await SL.ui.resizeImageFile(datei, { maxPx: 2000, quality: 0.85 });
      const { taskId } = await SL.api.belegHochladen(klein, { titel, erstellt: SL.models.heuteIso() });
      await SL.api.belegVerknuepfen(b.id, { art, taskId, titel });
      // EINE Meldung je Vorgang, und zwar die wahre: der Upload ist da, aber
      // die Dokumentnummer entsteht erst nach der Verarbeitung in Paperless.
      toast('Beleg in Paperless abgelegt — die Nummer trägt sich nach der Verarbeitung nach.', 4000);
      fertig();
    } catch (e) {
      toast(e.message || 'Hochladen fehlgeschlagen.', 5000);
    }
  }

  // --- Bestellung anlegen und bearbeiten ------------------------------------
  async function bestellungBearbeiten(b, fertig) {
    const istNeu = !b;
    const daten = {
      lieferant: b ? b.lieferant : '',
      bestelltAm: b ? String(b.bestelltAm || '').slice(0, 10) : SL.models.heuteIso(),
      belegnummer: b ? b.belegnummer : '',
      notiz: b ? b.notiz : '',
      positionen: b ? (b.positionen || []).map(p => ({ ...p })) : [],
    };

    const lieferantFeld = input({ value: daten.lieferant, list: 'sl-lieferanten', placeholder: 'z. B. Conrad, Reichelt' });
    const datenListe = el('datalist', { id: 'sl-lieferanten' });
    const datumFeld = input({ type: 'date', value: daten.bestelltAm });
    const nummerFeld = input({ value: daten.belegnummer, placeholder: 'Bestell- oder Vorgangsnummer' });
    const notizFeld = textarea({ value: daten.notiz, placeholder: 'Bemerkung, Reklamation, Hinweis für die Verwaltung' });

    const posBox = el('div');
    const summe = el('p', { class: 'muted' });

    function posZeichnen() {
      posBox.innerHTML = '';
      if (!daten.positionen.length) posBox.appendChild(leer('Noch keine Position.'));
      daten.positionen.forEach((p, i) => {
        const menge = input({ type: 'number', min: '0', step: '1', value: String(p.menge || 1), class: 'inp zaehl-feld' });
        const preis = input({ type: 'number', min: '0', step: '0.01', value: p.preis != null ? String(p.preis) : '', placeholder: '€', class: 'inp' });
        preis.style.maxWidth = '7rem';
        menge.addEventListener('input', () => { p.menge = Math.max(0, Number(menge.value) || 0); summeZeigen(); });
        preis.addEventListener('input', () => { p.preis = preis.value === '' ? null : Number(preis.value); summeZeigen(); });
        posBox.appendChild(el('div', { class: 'doc-zeile' }, [
          el('span', { class: 'doc-titel' }, [
            el('div', {}, p.artikelName || '(ohne Bezeichnung)'),
            el('div', { class: 'muted' }, [
              p.bestellnummer ? `Best.-Nr. ${p.bestellnummer}` : '',
              !p.artikelId ? (p.bestellnummer ? ' · ' : '') + 'freie Position' : '',
              (p.geliefert || 0) > 0 ? ` · ${p.geliefert} geliefert` : '',
            ].join('')),
          ]),
          menge, preis,
          el('button', {
            class: 'btn btn-sm link-danger', type: 'button',
            onclick: () => {
              // Was schon geliefert ist, wurde in Homebox gebucht. Die Zeile zu
              // entfernen hieße, die Buchung ohne Beleg stehen zu lassen.
              if ((p.geliefert || 0) > 0) { toast('Diese Position ist bereits geliefert und kann nicht entfernt werden.', 3500); return; }
              daten.positionen.splice(i, 1);
              posZeichnen();
            },
          }, '✕'),
        ]));
      });
      summeZeigen();
    }
    function summeZeigen() {
      const s = daten.positionen.reduce((acc, p) => acc + (p.preis != null ? p.preis * p.menge : 0), 0);
      summe.textContent = s ? `Summe: ${euro(s)}` : '';
    }

    const dlg = modal(istNeu ? 'Neue Bestellung' : 'Bestellung bearbeiten', [
      el('div', { class: 'form-grid' }, [
        feld('Lieferant', el('span', {}, [lieferantFeld, datenListe])),
        feld('Bestelldatum', datumFeld),
        feld('Bestellnummer', nummerFeld),
      ]),
      feld('Bemerkung', notizFeld, { breit: true }),
      el('h3', { class: 'abschnitt' }, 'Positionen'),
      posBox,
      summe,
      el('div', { class: 'btn-reihe' }, [
        el('button', { class: 'btn', type: 'button', onclick: () => ausBestand() }, '+ Aus dem Bestand'),
        el('button', { class: 'btn', type: 'button', onclick: () => ausNachbestellung() }, '+ Aus der Nachbestell-Liste'),
        el('button', { class: 'btn', type: 'button', onclick: () => freiePosition() }, '+ Freie Position'),
      ]),
      el('p', { class: 'muted' }, 'Eine freie Position ist etwas, das es im Lager noch nicht gibt. '
        + 'Der Artikel entsteht erst beim Wareneingang — so hinterlässt eine stornierte Bestellung keine leeren Artikel.'),
    ], {
      fuss: [
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
        el('button', { class: 'btn btn-primary', type: 'button', onclick: speichern }, 'Speichern'),
      ],
    });

    posZeichnen();
    // Vorschläge sind Komfort — scheitern sie, geht das Formular trotzdem.
    SL.api.lagerLieferanten().then(liste => {
      for (const l of liste.slice(0, 40)) datenListe.appendChild(el('option', { value: l.name }));
    }).catch(() => {});

    function hinzufuegen(p) {
      // Zweimal derselbe Artikel wäre beim Scannen mehrdeutig: welche Zeile
      // soll hochzählen? Deshalb zusammenführen statt anhängen.
      const da = p.artikelId && daten.positionen.find(x => x.artikelId === p.artikelId);
      if (da) { da.menge += p.menge || 1; toast(`„${da.artikelName}" war schon dabei — Menge erhöht.`); }
      else daten.positionen.push(p);
      posZeichnen();
    }

    function ausBestand() {
      SL.ui.artikelWaehlen({
        titel: 'Artikel bestellen',
        onWahl: (a) => hinzufuegen({
          artikelId: a.id, artikelName: a.name, artikelCode: a.code || '',
          bestellnummer: '', menge: 1, preis: a.kaufpreis != null ? a.kaufpreis : null, notiz: '',
        }),
      });
    }

    async function ausNachbestellung() {
      toast('Nachbestell-Liste wird geholt…');
      let knapp = null;
      try { knapp = await SL.api.lagerNachbestellung(); }
      catch (e) { toast(e.message || 'Nachbestell-Liste nicht abrufbar.'); return; }
      const artikel = (knapp && knapp.artikel) || (Array.isArray(knapp) ? knapp : []);
      if (!artikel.length) { toast('Nichts unter Mindestbestand.'); return; }

      const gewaehlt = new Set();
      const liste = el('div');
      for (const a of artikel) {
        const fehlt = Math.max(1, (a.mindestbestand || 0) - (a.menge || 0));
        liste.appendChild(el('label', { class: 'doc-zeile' }, [
          el('input', { type: 'checkbox', class: 'chk', onchange: (e) => { if (e.target.checked) gewaehlt.add(a); else gewaehlt.delete(a); } }),
          el('span', { class: 'doc-titel' }, [
            el('div', {}, a.name),
            el('div', { class: 'muted' }, `Bestand ${a.menge} · Mindestbestand ${a.mindestbestand} · Vorschlag ${fehlt}`),
          ]),
        ]));
        a._fehlt = fehlt;
      }
      const m = modal('Aus der Nachbestell-Liste', [
        el('p', { class: 'muted' }, 'Vorgeschlagen wird die Menge, die bis zum Mindestbestand fehlt. Ändern lässt sie sich danach in der Bestellung.'),
        liste,
      ], {
        fuss: [
          el('span', { class: 'spacer' }),
          el('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Abbrechen'),
          el('button', {
            class: 'btn btn-primary', type: 'button',
            onclick: () => {
              for (const a of gewaehlt) {
                hinzufuegen({
                  artikelId: a.id, artikelName: a.name, artikelCode: a.code || '',
                  bestellnummer: '', menge: a._fehlt, preis: a.kaufpreis != null ? a.kaufpreis : null, notiz: '',
                });
              }
              m.close();
            },
          }, 'Übernehmen'),
        ],
      });
    }

    function freiePosition() {
      const name = input({ placeholder: 'Bezeichnung' });
      const bn = input({ placeholder: 'Bestellnummer beim Lieferanten' });
      const menge = input({ type: 'number', min: '1', value: '1', class: 'inp zaehl-feld' });
      const preis = input({ type: 'number', min: '0', step: '0.01', placeholder: '€' });
      const m = modal('Freie Position', [
        el('p', { class: 'muted' }, 'Für Dinge, die es im Lager noch nicht gibt. Beim Wareneingang wird daraus ein Artikel.'),
        feld('Bezeichnung', name, { breit: true }),
        el('div', { class: 'form-grid' }, [
          feld('Bestellnummer', bn),
          feld('Menge', menge),
          feld('Einzelpreis', preis),
        ]),
      ], {
        fuss: [
          el('span', { class: 'spacer' }),
          el('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Abbrechen'),
          el('button', {
            class: 'btn btn-primary', type: 'button',
            onclick: () => {
              if (!name.value.trim()) { toast('Bitte eine Bezeichnung eintragen.'); return; }
              hinzufuegen({
                artikelId: '', artikelName: name.value.trim(), artikelCode: '',
                bestellnummer: bn.value.trim(), menge: Math.max(1, Number(menge.value) || 1),
                preis: preis.value === '' ? null : Number(preis.value), notiz: '',
              });
              m.close();
            },
          }, 'Übernehmen'),
        ],
      });
    }

    async function speichern() {
      const koerper = {
        lieferant: lieferantFeld.value.trim(),
        bestelltAm: datumFeld.value,
        belegnummer: nummerFeld.value.trim(),
        notiz: notizFeld.value.trim(),
        positionen: daten.positionen,
      };
      if (!koerper.lieferant) { toast('Bitte den Lieferanten eintragen.'); return; }
      try {
        if (istNeu) {
          const angelegt = await SL.api.bestellungAnlegen(koerper);
          dlg.close();
          toast('Bestellung angelegt.');
          location.hash = `#/bestellungen?id=${encodeURIComponent(angelegt.id)}`;
        } else {
          await SL.api.bestellungSpeichern(b.id, koerper);
          dlg.close();
          toast('Bestellung gespeichert.');
          if (fertig) fertig();
        }
      } catch (e) {
        toast(e.message || 'Speichern fehlgeschlagen.', 4000);
      }
    }
  }

  // --- Wareneingang ---------------------------------------------------------
  // Die Prüfung gegen den Lieferschein. Führend sind die Positionen; der Scan
  // springt in die passende Zeile.
  async function wareneingangOeffnen(b, fertig) {
    // Zeilenzustand: was JETZT ankommt, plus der Lagerort, falls er beim
    // Scannen festgelegt werden musste.
    const zeilen = (b.positionen || []).map(p => ({
      p,
      menge: 0,
      artikelId: p.artikelId,
      artikelName: p.artikelName,
      ortId: '',
      ortName: '',
      ortGeprueft: false,      // Artikel schon einmal auf einen Lagerort geprüft?
      knoten: null,
      feld: null,
    }));

    const scanFeld = input({
      placeholder: 'Barcode scannen oder eintippen — Enter',
      autocapitalize: 'characters',
      autocomplete: 'off',
    });
    const listeBox = el('div');
    const notiz = input({ placeholder: 'Bemerkung zur Lieferung (Reklamation, Teillieferung …)' });

    const dlg = modal(`Wareneingang · ${b.lieferant || ''}`, [
      el('p', { class: 'muted' }, 'Lieferschein daneben legen und durchgehen. Ein Scan zählt die passende Zeile um eins hoch; '
        + 'Mengen lassen sich auch direkt eintragen — bei hundert Widerständen scannt niemand hundertmal.'),
      el('div', { class: 'barcode-zeile' }, [
        scanFeld,
        SL.ui.scannerBereit()
          ? el('button', { class: 'btn', type: 'button', onclick: () => SL.ui.scannen((c) => verarbeiten(c)) }, '⌷ Kamera')
          : null,
      ]),
      listeBox,
      feld('Bemerkung', notiz, { breit: true }),
    ], {
      fuss: [
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
        el('button', { class: 'btn btn-primary', type: 'button', onclick: buchen }, 'Wareneingang buchen'),
      ],
    });

    // Der Fokus gehört ins Scanfeld: ein USB-Handscanner tippt dorthin, und am
    // Handy ist es das erste, was man sieht.
    setTimeout(() => scanFeld.focus(), 60);
    scanFeld.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const c = scanFeld.value.trim();
      scanFeld.value = '';
      if (c) verarbeiten(c);
    });

    zeichnen();

    function zeichnen() {
      listeBox.innerHTML = '';
      for (const z of zeilen) {
        const fehltVorher = z.p.menge - (z.p.geliefert || 0);
        const feldMenge = input({ type: 'number', min: '0', step: '1', value: String(z.menge), class: 'inp zaehl-feld' });
        feldMenge.addEventListener('input', () => {
          const vorher = z.menge;
          z.menge = Math.max(0, Number(feldMenge.value) || 0);
          statusZeigen(z);
          // Auch die GETIPPTE Menge muss die Lagerort-Frage auslösen. Sonst
          // rutscht genau der Fall durch, für den das Tippen gedacht ist —
          // hundert Widerstände scannt niemand einzeln —, und die Position
          // landet am Ende unter „kein Lagerort".
          if (!vorher && z.menge > 0) ortPruefen(z);
        });
        z.feld = feldMenge;

        const status = el('span', { class: 'muted' });
        // Minus, Feld und Plus bleiben EINE Einheit. Ohne die Klammer bricht
        // die Reihe am Handy zwischen den Knöpfen um, und das Plus steht
        // plötzlich unter dem Minus einer anderen Zeile.
        const stepper = el('span', { class: 'eingang-stepper' }, [
          el('button', { class: 'btn btn-sm btn-rund', type: 'button', onclick: () => zaehlen(z, -1) }, '−'),
          feldMenge,
          el('button', { class: 'btn btn-sm btn-rund', type: 'button', onclick: () => zaehlen(z, +1) }, '+'),
          // Eine freie Position braucht zuerst einen Artikel — sonst gibt es
          // nichts, worauf sich der Bestand buchen ließe. Der Weg dahin gehört
          // an die Zeile, nicht in eine Fehlermeldung am Ende: man steht mit
          // der Ware in der Hand davor.
          !z.artikelId
            ? el('button', { class: 'btn btn-sm', type: 'button', onclick: () => artikelKlaeren(z) }, 'Artikel …')
            : el('button', {
              class: 'btn btn-sm', type: 'button', title: 'Lagerort für diese Position',
              onclick: () => ortSetzen(z, true),
            }, 'Ort'),
        ]);
        const knoten = el('div', { class: 'doc-zeile eingang-zeile' }, [
          el('span', { class: 'doc-titel' }, [
            el('div', {}, z.artikelName || '(ohne Bezeichnung)'),
            el('div', { class: 'muted' }, [
              `bestellt ${z.p.menge}`,
              (z.p.geliefert || 0) ? ` · bereits ${z.p.geliefert}` : '',
              fehltVorher > 0 ? ` · offen ${fehltVorher}` : ' · vollständig',
              !z.artikelId ? ' · freie Position' : '',
            ].join('')),
            status,
          ]),
          stepper,
        ]);
        z.knoten = knoten;
        z.status = status;
        listeBox.appendChild(knoten);
        statusZeigen(z);
      }
    }

    function statusZeigen(z) {
      if (!z.status) return;
      const teile = [];
      if (z.ortName) teile.push(`→ ${z.ortName}`);
      if (z.menge > 0 && z.menge + (z.p.geliefert || 0) > z.p.menge) teile.push('mehr als bestellt');
      z.status.textContent = teile.join(' · ');
      z.status.className = teile.includes('mehr als bestellt') ? 'ampel ampel-bald' : 'muted';
    }

    function zaehlen(z, delta) {
      z.menge = Math.max(0, z.menge + delta);
      if (z.feld) z.feld.value = String(z.menge);
      statusZeigen(z);
      if (delta > 0) ortPruefen(z);
    }

    // Fehlt dem Artikel der Lagerort, wird er SOFORT gefragt — solange der
    // Karton noch offen ist. Wer das ans Ende schiebt, steht vor einer Frage,
    // deren Antwort er gerade weggeräumt hat.
    async function ortPruefen(z) {
      if (z.ortGeprueft || !z.artikelId) return;
      z.ortGeprueft = true;
      try {
        const a = await SL.api.lagerArtikel(z.artikelId);
        if (a && !a.ortId) ortSetzen(z, false);
        else if (a) { z.ortName = a.ortName || ''; statusZeigen(z); }
      } catch (_) { /* Lagerort lässt sich auch später setzen */ }
    }

    function ortSetzen(z, erzwungen) {
      SL.ui.ortWaehlen({
        titel: erzwungen ? `Lagerort für „${z.artikelName}"` : `„${z.artikelName}" hat noch keinen Lagerort`,
        onWahl: (o) => { z.ortId = o.id; z.ortName = o.name; statusZeigen(z); },
      });
    }

    // Freie Position klären: entweder gehört sie zu einem Artikel, den es
    // schon gibt (dann zuordnen), oder sie ist wirklich neu (dann hier anlegen,
    // mit Bestand 0 — die gelieferte Menge bucht gleich darauf der Eingang).
    function artikelKlaeren(z) {
      const m = modal(`„${z.artikelName}"`, [
        el('p', { class: 'muted' }, 'Diese Position hat noch keinen Artikel im Lager. '
          + 'Gibt es ihn doch schon, ordne ihn zu — sonst legen wir ihn jetzt an.'),
        el('div', { class: 'btn-reihe' }, [
          el('button', {
            class: 'btn', type: 'button',
            onclick: () => {
              m.close();
              SL.ui.artikelWaehlen({
                titel: `Artikel für „${z.artikelName}"`,
                onWahl: (a) => { z.artikelId = a.id; z.artikelName = a.name; zeichnen(); toast(`Zugeordnet: ${a.name}`); },
              });
            },
          }, 'Vorhandenen Artikel zuordnen'),
          el('button', { class: 'btn btn-primary', type: 'button', onclick: () => { m.close(); artikelAnlegen(z); } }, 'Neu anlegen'),
        ]),
      ], {
        fuss: [
          el('span', { class: 'spacer' }),
          el('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Abbrechen'),
        ],
      });
    }

    function artikelAnlegen(z) {
      const name = input({ value: z.artikelName || '' });
      const barcode = input({ placeholder: 'EAN vom Karton (kann leer bleiben)', autocapitalize: 'none' });
      const hersteller = input({ placeholder: 'Hersteller' });
      const mindest = input({ type: 'number', min: '0', placeholder: 'Mindestbestand (leer = keine Warnung)' });
      const ortAnzeige = el('span', { class: 'muted' }, 'noch keiner');
      let ortId = '';

      const m = modal('Artikel anlegen', [
        el('p', { class: 'muted' }, 'Wird mit Bestand 0 angelegt — die gelieferte Menge bucht gleich darauf der Wareneingang. '
          + 'Lieferant und Preis kommen aus der Bestellung.'),
        feld('Bezeichnung', name, { breit: true }),
        feld('Barcode', barcode, { breit: true }),
        el('div', { class: 'form-grid' }, [
          feld('Hersteller', hersteller),
          feld('Mindestbestand', mindest),
        ]),
        el('div', { class: 'btn-reihe' }, [
          el('button', {
            class: 'btn', type: 'button',
            onclick: () => SL.ui.ortWaehlen({
              titel: 'Wohin gehört das?',
              onWahl: (o) => { ortId = o.id; ortAnzeige.textContent = o.name; },
            }),
          }, 'Lagerort wählen'),
          ortAnzeige,
        ]),
      ], {
        fuss: [
          el('span', { class: 'spacer' }),
          el('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Abbrechen'),
          el('button', {
            class: 'btn btn-primary', type: 'button',
            onclick: async () => {
              if (!name.value.trim()) { toast('Bitte eine Bezeichnung angeben.'); return; }
              try {
                const a = await SL.api.lagerAnlegen({
                  name: name.value.trim(),
                  menge: 0,
                  ortId,
                  barcode: barcode.value.trim(),
                  hersteller: hersteller.value.trim(),
                  mindestbestand: mindest.value === '' ? null : Math.max(0, parseInt(mindest.value, 10) || 0),
                  lieferant: b.lieferant || '',
                  kaufpreis: z.p.preis != null ? z.p.preis : undefined,
                });
                z.artikelId = a.id;
                z.artikelName = a.name;
                z.ortGeprueft = true;          // Ort wurde gerade gesetzt, nicht noch einmal fragen
                if (ortId) { z.ortId = ortId; z.ortName = ortAnzeige.textContent; }
                m.close();
                zeichnen();
                toast(`„${a.name}" angelegt.`);
              } catch (e) {
                toast(e.message || 'Anlegen fehlgeschlagen.', 5000);
              }
            },
          }, 'Anlegen'),
        ],
      });
      setTimeout(() => name.focus(), 50);
    }

    // --- Scan deuten
    async function verarbeiten(code) {
      const { art, wert } = SL.models.codeArt(code);
      if (art === 'leer') return;
      if (art === 'ort') { toast('Das ist ein Lagerort-Etikett, kein Artikel.', 3000); return; }

      let artikel = null;
      try {
        if (art === 'homeboxId') artikel = await SL.api.lagerArtikel(wert);
        else if (art === 'artikel') artikel = await SL.api.lagerBeiCode(wert);
        else if (art === 'barcode') artikel = await SL.api.lagerBeiBarcode(wert);
      } catch (e) {
        if (!(e && e.status === 404)) { toast(e.message || 'Nachschlagen fehlgeschlagen.', 4000); return; }
      }

      if (artikel) {
        const z = zeilen.find(x => x.artikelId === artikel.id);
        if (z) { zaehlen(z, +1); return; }
        // Der Artikel ist bekannt, gehört aber nicht zu dieser Bestellung.
        // Beipack und Nachlieferung sind Alltag — also anbieten statt abweisen.
        if (SL.ui.confirmDialog(`„${artikel.name}" steht nicht auf dieser Bestellung. Als zusätzliche Position aufnehmen?`)) {
          nachtragen({ artikelId: artikel.id, artikelName: artikel.name, artikelCode: artikel.code || '' });
        }
        return;
      }

      // Unbekannter Code: an eine offene Position anlernen. Das Lager lernt
      // sich dadurch beim Arbeiten selbst ein, ohne Pflegetermin.
      if (art === 'barcode') return anlernen(wert);
      toast('Zu dieser Kennung ist kein Artikel hinterlegt.', 3500);
    }

    // Eine zusätzliche Position an die Bestellung hängen (und sofort zählen).
    async function nachtragen({ artikelId, artikelName, artikelCode }) {
      try {
        const gespeichert = await SL.api.bestellungSpeichern(b.id, {
          positionen: [
            ...(b.positionen || []),
            { artikelId, artikelName, artikelCode, menge: 0, preis: null, bestellnummer: '', notiz: 'beim Wareneingang ergänzt' },
          ],
        });
        const neu = (gespeichert.positionen || []).find(p => p.artikelId === artikelId && !zeilen.some(z => z.p.id === p.id));
        if (!neu) { toast('Position konnte nicht ergänzt werden.'); return; }
        b.positionen = gespeichert.positionen;
        const z = { p: neu, menge: 0, artikelId, artikelName, ortId: '', ortName: '', ortGeprueft: false, knoten: null, feld: null };
        zeilen.push(z);
        zeichnen();
        zaehlen(z, +1);
      } catch (e) {
        toast(e.message || 'Ergänzen fehlgeschlagen.', 4000);
      }
    }

    function anlernen(barcode) {
      const liste = el('div');
      // Nur Positionen, denen noch etwas fehlt: an eine vollständig gelieferte
      // Zeile einen fremden Code zu hängen, ist fast immer ein Griff daneben.
      const kandidaten = zeilen.filter(z => (z.p.geliefert || 0) + z.menge < z.p.menge).length
        ? zeilen.filter(z => (z.p.geliefert || 0) + z.menge < z.p.menge)
        : zeilen;
      for (const z of kandidaten) {
        liste.appendChild(el('button', {
          class: 'btn', type: 'button', style: 'display:block;width:100%;text-align:left;margin-bottom:6px',
          onclick: async () => {
            m.close();
            if (!z.artikelId) {
              // Freie Position: erst braucht sie einen Artikel. Danach wird der
              // Code an ihm gemerkt.
              return freiZuordnen(z, barcode);
            }
            await codeMerken(z, barcode);
          },
        }, [
          el('div', {}, z.artikelName || '(ohne Bezeichnung)'),
          el('div', { class: 'muted' }, !z.artikelId ? 'freie Position — erst Artikel zuordnen' : `bestellt ${z.p.menge}`),
        ]));
      }
      const m = modal('Unbekannter Code', [
        el('p', {}, [el('strong', {}, barcode)]),
        el('p', { class: 'muted' }, 'Dieser Code ist im Lager noch nicht hinterlegt. Zu welcher Position gehört er? '
          + 'Die App merkt ihn sich am Artikel — beim nächsten Mal wird er sofort erkannt.'),
        liste,
      ], {
        fuss: [
          el('span', { class: 'spacer' }),
          el('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Gehört zu keiner'),
        ],
      });
    }

    async function codeMerken(z, barcode) {
      try {
        await SL.api.lagerSpeichern(z.artikelId, { barcode });
        zaehlen(z, +1);
        toast(`Code für „${z.artikelName}" gemerkt.`);
      } catch (e) {
        // Die Zeile trotzdem hochzählen wäre bequem — aber dann glaubte man,
        // der Code sei gelernt, und stünde beim nächsten Mal wieder hier.
        toast(e.message || 'Code konnte nicht gespeichert werden.', 4000);
      }
    }

    function freiZuordnen(z, barcode) {
      SL.ui.artikelWaehlen({
        titel: `Artikel für „${z.artikelName}"`,
        onWahl: async (a) => {
          z.artikelId = a.id;
          z.artikelName = a.name;
          zeichnen();
          await codeMerken(z, barcode);
        },
      });
    }

    // --- Buchen
    async function buchen() {
      const gemeldet = zeilen.filter(z => z.menge > 0);
      if (!gemeldet.length) { toast('Keine Menge eingetragen.'); return; }

      const ohneArtikel = gemeldet.filter(z => !z.artikelId);
      if (ohneArtikel.length) {
        // Sperre bleibt — aber sie weist auch den Weg: der Dialog geht auf.
        toast(`„${ohneArtikel[0].artikelName}" braucht zuerst einen Artikel im Lager.`, 5000);
        artikelKlaeren(ohneArtikel[0]);
        return;
      }

      const zuviel = gemeldet.filter(z => z.menge + (z.p.geliefert || 0) > z.p.menge);
      if (zuviel.length && !SL.ui.confirmDialog(
        `Bei ${zuviel.length} ${zuviel.length === 1 ? 'Position' : 'Positionen'} kommt mehr an als bestellt wurde. Trotzdem buchen?`)) return;

      try {
        const antwort = await SL.api.wareneingang(b.id, {
          notiz: notiz.value.trim(),
          positionen: gemeldet.map(z => ({
            positionId: z.p.id,
            menge: z.menge,
            artikelId: z.artikelId,
            artikelName: z.artikelName,
            ortId: z.ortId,
            ortName: z.ortName,
          })),
        });
        dlg.close();
        // EINE Meldung je Vorgang, und zwar die wahre: verschweigt man die
        // Fehlschläge, sucht später jemand Bestand, den es nie gab.
        if (antwort.fehler) {
          const erster = (antwort.ergebnisse || []).find(e => !e.ok);
          toast(`${antwort.gebucht} gebucht, ${antwort.fehler} fehlgeschlagen — ${erster ? erster.fehler : ''}`, 6000);
        } else {
          toast(`${antwort.gebucht} ${antwort.gebucht === 1 ? 'Position' : 'Positionen'} gebucht.`);
        }
        // Direkt weiter zum Einlagern: der Karton steht noch da.
        if (antwort.bestellung && antwort.bestellung.einzulagern) einlagernOeffnen(antwort.bestellung, fertig);
        else fertig();
      } catch (e) {
        toast(e.message || 'Buchen fehlgeschlagen.', 5000);
      }
    }
  }

  // --- Einlagern ------------------------------------------------------------
  // Nach Raum → Schrank → Fach gruppiert: man geht den Weg EINMAL ab, statt
  // zwischen den Räumen zu pendeln. Das Häkchen bucht nichts — der Bestand ist
  // beim Wareneingang gebucht worden; es sagt nur „steht im Regal".
  async function einlagernOeffnen(b, fertig) {
    const offen = (b.positionen || []).filter(p => (p.geliefert || 0) > 0 && !p.eingelagert);
    if (!offen.length) { toast('Nichts mehr einzulagern.'); if (fertig) fertig(); return; }

    const inhalt = el('div');
    inhalt.appendChild(leer('Lagerorte werden geladen…'));

    const dlg = modal('Einlagern', [inhalt], {
      fuss: [
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn btn-primary', type: 'button', onclick: () => { dlg.close(); if (fertig) fertig(); } }, 'Fertig'),
      ],
      onClose: () => { if (fertig) fertig(); },
    });

    let orte = [];
    try { orte = await SL.store.orteLaden(); } catch (_) {}

    // Pfad je Position bestimmen. Steht am Artikel ein Lagerort, gilt der;
    // sonst der beim Wareneingang gewählte. „(kein Lagerort)" gruppiert alles,
    // was noch niemand zugewiesen hat — genau die Zeilen, die man suchen würde.
    const mitPfad = await Promise.all(offen.map(async (p) => {
      let ortId = p.ortId;
      let ortName = p.ortName;
      if (!ortId && p.artikelId) {
        try {
          const a = await SL.api.lagerArtikel(p.artikelId);
          if (a) { ortId = a.ortId; ortName = a.ortName; }
        } catch (_) {}
      }
      const pfad = ortId ? (SL.models.ortPfad(orte, ortId) || ortName) : '';
      return { p, pfad: pfad || '(kein Lagerort)' };
    }));

    const gruppen = new Map();
    for (const x of mitPfad) {
      if (!gruppen.has(x.pfad)) gruppen.set(x.pfad, []);
      gruppen.get(x.pfad).push(x.p);
    }
    const namen = [...gruppen.keys()].sort((a, b2) => {
      if (a === '(kein Lagerort)') return 1;
      if (b2 === '(kein Lagerort)') return -1;
      return a.localeCompare(b2, 'de');
    });

    inhalt.innerHTML = '';
    inhalt.appendChild(el('p', { class: 'muted' }, 'Nach Lagerort sortiert — einmal den Weg abgehen und abhaken. '
      + 'Die Liste bleibt erhalten, wenn du zwischendurch unterbrochen wirst.'));

    for (const name of namen) {
      inhalt.appendChild(el('h3', { class: 'abschnitt' }, name));
      for (const p of gruppen.get(name)) {
        const chk = el('input', { type: 'checkbox', class: 'chk' });
        // Ohne Lagerort weiß niemand, wohin damit — dann gehört der Weg, ihn
        // zu setzen, genau hierhin und nicht auf eine andere Seite.
        const ortKnopf = (name === '(kein Lagerort)' && p.artikelId)
          ? el('button', {
            class: 'btn btn-sm', type: 'button',
            onclick: (ev) => {
              ev.preventDefault();
              SL.ui.ortWaehlen({
                titel: `Wohin gehört „${p.artikelName}"?`,
                onWahl: async (o) => {
                  try {
                    await SL.api.lagerSpeichern(p.artikelId, { ortId: o.id });
                    ortKnopf.textContent = o.name;
                    ortKnopf.disabled = true;
                    toast(`„${p.artikelName}" liegt jetzt in ${o.name}.`);
                  } catch (e) { toast(e.message || 'Lagerort konnte nicht gesetzt werden.', 4000); }
                },
              });
            },
          }, 'Lagerort wählen')
          : null;
        const zeileEl = el('label', { class: 'doc-zeile' }, [
          chk,
          el('span', { class: 'doc-titel' }, [
            el('div', {}, p.artikelName || '(ohne Bezeichnung)'),
            el('div', { class: 'muted' }, `${p.geliefert} Stück geliefert`),
          ]),
          ortKnopf,
        ]);
        chk.addEventListener('change', async () => {
          try {
            await SL.api.positionEingelagert(b.id, p.id, chk.checked);
            zeileEl.style.opacity = chk.checked ? '.5' : '1';
          } catch (e) {
            chk.checked = !chk.checked;
            toast(e.message || 'Abhaken fehlgeschlagen.');
          }
        });
        inhalt.appendChild(zeileEl);
      }
    }
  }

  // --- Rechnung -------------------------------------------------------------
  // Zweiter Schritt, oft Wochen nach der Lieferung: Rechnungsdaten festhalten,
  // Preise nachtragen und auf Wunsch an die Artikel durchschreiben.
  function rechnungOeffnen(b, fertig) {
    const r = b.rechnung || {};
    const nummer = input({ value: r.nummer || '', placeholder: 'Rechnungsnummer' });
    const datum = input({ type: 'date', value: r.datum || SL.models.heuteIso() });
    const betrag = input({ type: 'number', step: '0.01', min: '0', value: r.betrag != null ? String(r.betrag) : '', placeholder: 'Gesamtbetrag' });
    const anArtikel = el('input', { type: 'checkbox', class: 'chk', checked: true });

    const felder = new Map();
    const posBox = el('div');
    for (const p of b.positionen || []) {
      const preis = input({ type: 'number', step: '0.01', min: '0', value: p.preis != null ? String(p.preis) : '', placeholder: '€' });
      preis.style.maxWidth = '7rem';
      felder.set(p.id, preis);
      posBox.appendChild(el('div', { class: 'doc-zeile' }, [
        el('span', { class: 'doc-titel' }, [
          el('div', {}, p.artikelName || '(ohne Bezeichnung)'),
          el('div', { class: 'muted' }, `${p.geliefert || 0} von ${p.menge} geliefert${!p.artikelId ? ' · freie Position' : ''}`),
        ]),
        preis,
      ]));
    }

    const dlg = modal('Rechnung zuordnen', [
      el('div', { class: 'form-grid' }, [
        feld('Rechnungsnummer', nummer),
        feld('Rechnungsdatum', datum),
        feld('Gesamtbetrag', betrag),
      ]),
      el('h3', { class: 'abschnitt' }, 'Einzelpreise'),
      el('p', { class: 'muted' }, 'Der Preis gehört zu DIESER Lieferung und bleibt daran hängen. '
        + 'Eine Abrechnung vom Mai ändert sich nicht, weil im Oktober teurer nachgekauft wurde.'),
      posBox,
      el('label', { class: 'inline-chk' }, [anArtikel, el('span', {}, 'Preise als Kaufpreis an die Artikel in Homebox übernehmen')]),
      el('p', { class: 'muted' }, 'Damit stehen am Artikel Kaufpreis, Kaufdatum und Lieferant auf dem neuesten Stand — '
        + 'die Materialabrechnung der Klassen rechnet künftig damit.'),
      el('p', { class: 'muted' }, 'Die Rechnung selbst legst du unter „Belege" in Paperless ab.'),
    ], {
      fuss: [
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
        el('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: async () => {
            const positionen = [];
            for (const [pid, f] of felder) {
              if (f.value !== '') positionen.push({ positionId: pid, preis: Number(f.value) });
            }
            try {
              const antwort = await SL.api.rechnungZuordnen(b.id, {
                nummer: nummer.value.trim(),
                datum: datum.value,
                betrag: betrag.value === '' ? null : Number(betrag.value),
                anArtikel: anArtikel.checked,
                positionen,
              });
              dlg.close();
              if (antwort.fehler) {
                const erster = (antwort.ergebnisse || []).find(e => !e.ok);
                toast(`Rechnung gespeichert, aber ${antwort.fehler} Artikel nicht aktualisiert — ${erster ? erster.fehler : ''}`, 6000);
              } else {
                toast('Rechnung zugeordnet.');
              }
              if (fertig) fertig();
            } catch (e) {
              toast(e.message || 'Speichern fehlgeschlagen.', 4000);
            }
          },
        }, 'Speichern'),
      ],
    });
  }

  SL.views.renderBestellungen = renderBestellungen;
})();
