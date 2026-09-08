(function () {
  'use strict';
  window.SL = window.SL || {};
  SL.views = SL.views || {};

  const { el, karte, input, textarea, select, toast, confirmDialog } = SL.ui;

  // Ausleihe: wer hat was, seit wann, bis wann.
  //
  // Ausleihen und Defektmeldungen liegen in unserer Datenbank — Homebox kennt
  // keinen Begriff dafür. Der Bestand bleibt davon unberührt (siehe models.js).
  //
  // Personenangaben gehören nicht ins offene Schulnetz: die ganze Ansicht
  // verlangt eine Anmeldung, das Backend ebenso.
  async function renderAusleihe(mount, params = {}) {
    if (!SL.store.darfBuchen()) {
      mount.appendChild(karte('Anmeldung nötig', el('p', { class: 'muted' }, [
        'Wer welches Gerät hat, ist nur angemeldet einsehbar. Bitte ',
        el('a', { href: '#/anmelden?weiter=' + encodeURIComponent('#/ausleihe') }, 'anmelden'),
        '.',
      ])));
      return;
    }

    const alleZeigen = params.alle === '1';

    mount.appendChild(el('div', { class: 'toolbar' }, [
      el('h1', {}, 'Ausleihe'),
      el('span', { class: 'spacer' }),
      el('a', {
        class: 'btn btn-sm',
        href: alleZeigen ? '#/ausleihe' : '#/ausleihe?alle=1',
      }, alleZeigen ? 'Nur offene' : 'Auch zurückgegebene'),
      // Der Einstieg gehört HIERHER. Wer etwas ausleihen will, geht auf die
      // Ausleihseite — nicht erst in die Artikelsuche.
      el('button', {
        class: 'btn btn-primary', type: 'button',
        onclick: () => geraetWaehlenUndAusleihen(),
      }, '+ Ausleihen'),
    ]));

    const behaelter = el('div');
    mount.appendChild(behaelter);
    behaelter.appendChild(el('p', { class: 'muted' }, 'Wird geladen…'));

    let liste = [];
    let defekte = [];
    try {
      [liste, defekte] = await Promise.all([
        SL.api.listAusleihen(alleZeigen),
        SL.api.listDefekte(false).catch(() => []),
      ]);
    } catch (e) {
      behaelter.innerHTML = '';
      behaelter.appendChild(karte('Das hat nicht geklappt', el('p', { class: 'anmeldung-fehler' }, e.message || '')));
      return;
    }

    behaelter.innerHTML = '';

    // Defekte zuerst: ein kaputtes Gerät, das jemand gleich holen will, ist
    // die dringendere Information als eine Frist in zehn Tagen.
    if (defekte.length) behaelter.appendChild(defektKarte(defekte));

    const offen = liste.filter(a => !a.zurueckAm && (a.art || 'ausleihe') === 'ausleihe');
    if (!offen.length && !alleZeigen) {
      behaelter.appendChild(karte(null, [
        el('p', {}, 'Zurzeit ist nichts ausgeliehen.'),
        el('p', { class: 'muted' },
          'Zum Ausleihen oben auf „+ Ausleihen" — oder das Gerät scannen und im Artikel „Ausleihen" wählen. '
          + 'Ausgeliehen werden nur Demonstratoren; Verbrauchsmaterial wird entnommen und dabei auf Wunsch einer Klasse zugeschrieben.'),
        el('div', { class: 'btn-reihe' }, [
          el('button', { class: 'btn btn-primary', type: 'button', onclick: () => geraetWaehlenUndAusleihen() }, '+ Ausleihen'),
        ]),
      ]));
      // Auch ohne offene Ausleihe kann es Ausgaben geben — sie hier
      // wegzulassen hieße, gebuchte Vorgänge zu verstecken.
      behaelter.appendChild(await ausgabenKarte());
      return;
    }

    // Nach Dringlichkeit gruppieren statt einer langen Liste: die Frage im
    // Alltag ist „was ist überfällig?", nicht „was gibt es alles?".
    const gruppen = [
      { art: 'ueberfaellig', titel: 'Überfällig' },
      { art: 'heute', titel: 'Heute fällig' },
      { art: 'laufend', titel: 'Laufend' },
      { art: 'offen', titel: 'Ohne Frist' },
    ];
    for (const g of gruppen) {
      const teil = offen.filter(a => SL.models.leihStatus(a).art === g.art);
      if (!teil.length) continue;
      const box = el('div', { class: 'liste' });
      for (const a of teil) box.appendChild(zeile(a));
      behaelter.appendChild(karte(`${g.titel} (${teil.length})`, box));
    }

    if (alleZeigen) {
      const zurueck = liste.filter(a => a.zurueckAm)
        .sort((a, b) => String(b.zurueckAm).localeCompare(String(a.zurueckAm)));
      if (zurueck.length) {
        const box = el('div', { class: 'liste' });
        for (const a of zurueck.slice(0, 100)) box.appendChild(zeile(a));
        behaelter.appendChild(karte(`Zurückgegeben (${zurueck.length})`, box));
      }
    }

    // Ausgaben stehen immer unten und immer eingeklappt: sie sind Dokumentation,
    // keine offene Aufgabe. Wer sie sucht, sucht gezielt.
    behaelter.appendChild(await ausgabenKarte());
  }

  async function ausgabenKarte() {
    const box = el('div');
    const details = el('details', { class: 'aufklapp' }, [
      el('summary', {}, 'Ausgaben an Klassen (Dokumentation)'),
      box,
    ]);
    box.appendChild(el('p', { class: 'muted' }, 'Wird geladen…'));

    let ausgaben = [];
    try {
      ausgaben = await SL.api.listAusleihen(true, 'ausgabe');
    } catch (e) {
      box.innerHTML = '';
      box.appendChild(el('p', { class: 'anmeldung-fehler' }, e.message || ''));
      return karte(null, details);
    }

    box.innerHTML = '';
    if (!ausgaben.length) {
      box.appendChild(el('p', { class: 'muted' },
        'Noch nichts ausgegeben. Verbrauchsmaterial wird im Artikel über „Ausgabe an Gruppe" gebucht — '
        + 'der Bestand sinkt dabei, zurück erwartet wird nichts.'));
      return karte(null, details);
    }

    ausgaben.sort((a, b) => String(b.ausgeliehenAm).localeCompare(String(a.ausgeliehenAm)));

    // Zeitraum wählen und drucken. Voreingestellt ist das laufende Schuljahr:
    // danach wird in der Praxis abgerechnet, nicht nach Kalenderjahr.
    const von = input({ type: 'date', value: schuljahrStart() });
    const bis = input({ type: 'date', value: SL.models.heuteIso() });
    const anzahl = el('span', { class: 'muted' });

    const gefiltert = () => ausgaben.filter(a => {
      const tag = String(a.ausgeliehenAm).slice(0, 10);
      if (von.value && tag < von.value) return false;
      if (bis.value && tag > bis.value) return false;
      return true;
    });
    const zaehlen = () => {
      const n = gefiltert().length;
      anzahl.textContent = `${n} ${n === 1 ? 'Buchung' : 'Buchungen'} im Zeitraum`;
    };
    von.addEventListener('change', zaehlen);
    bis.addEventListener('change', zaehlen);
    zaehlen();

    box.appendChild(el('div', { class: 'wahl-zeile ausgaben-filter' }, [
      el('span', { class: 'feld-label' }, 'von'), von,
      el('span', { class: 'feld-label' }, 'bis'), bis,
      anzahl,
      el('button', {
        class: 'btn btn-primary btn-sm', type: 'button',
        onclick: () => {
          const teil = gefiltert();
          if (!teil.length) { toast('Im gewählten Zeitraum gibt es keine Ausgaben.', 3500); return; }
          try {
            SL.export.ausgabenPdf.bauen(teil, { von: von.value, bis: bis.value });
          } catch (e) { toast(e.message || 'Das PDF ließ sich nicht erzeugen.', 5000); }
        },
      }, '📄 PDF nach Gruppen'),
    ]));

    const liste = el('div', { class: 'liste' });
    for (const a of ausgaben.slice(0, 100)) {
      liste.appendChild(el('a', { class: 'eintrag eintrag-klick', href: `#/artikel?id=${encodeURIComponent(a.artikelId)}` }, [
        el('div', { class: 'benutzer-kopf' }, [
          el('strong', {}, a.artikelName || '(Artikel)'),
          el('span', { class: 'tag' }, `${a.menge} Stück`),
        ]),
        el('div', { class: 'muted' }, [
          SL.ui.formatDatum(String(a.ausgeliehenAm).slice(0, 10)),
          a.klasse ? ' · an ' + a.klasse : '',
          ' · gebucht von ' + a.benutzerName,
          a.notiz ? ' · ' + a.notiz : '',
        ].join('')),
      ]));
    }
    box.appendChild(liste);
    if (ausgaben.length > 100) {
      box.appendChild(el('p', { class: 'muted' }, `${ausgaben.length} Einträge — die 100 jüngsten sind gezeigt.`));
    }
    return karte(null, details);
  }

  // Beginn des laufenden Schuljahres (1. August). Vor August gehört man noch
  // zum Schuljahr, das im Vorjahr begonnen hat.
  function schuljahrStart() {
    const heute = new Date();
    const jahr = heute.getMonth() >= 7 ? heute.getFullYear() : heute.getFullYear() - 1;
    return `${jahr}-08-01`;
  }

  // Gerät auswählen und ausleihen.
  //
  // Ausgeliehen wird NUR, was den Demonstrator-Tag trägt (so entschieden) —
  // sonst „leiht" jemand 200 Widerstände aus, die nie zurückkommen. Geprüft
  // wird am DETAIL-Datensatz: Listenantworten von Homebox sind Kurzfassungen
  // und tragen die Marken nicht zuverlässig mit.
  function geraetWaehlenUndAusleihen() {
    SL.ui.artikelWaehlen({
      titel: 'Was soll ausgeliehen werden?',
      onWahl: async (treffer) => {
        let artikel = treffer;
        try {
          artikel = await SL.api.lagerArtikel(treffer.id);
        } catch (_) { /* ohne Detail mit dem Treffer weiterarbeiten */ }

        const marke = SL.store.state.settings.demonstratorMarke || 'Demonstrator';
        if (!SL.models.istDemonstrator(artikel, marke)) {
          keinDemonstrator(artikel, marke);
          return;
        }
        ausleihenDialog(artikel, () => SL.app.router());
      },
    });
  }

  // Kein Demonstrator: nicht einfach abweisen, sondern den richtigen Weg
  // anbieten. Die Ausgabe ist genau dafür da.
  function keinDemonstrator(artikel, marke) {
    const m = SL.ui.modal('Nicht zum Ausleihen', el('div', {}, [
      el('p', {}, [
        el('strong', {}, artikel.name || '(Artikel)'),
        ` trägt nicht den Tag „${marke}" und gilt damit als Verbrauchsmaterial.`,
      ]),
      el('p', { class: 'muted' },
        'Verbrauchsmaterial wird entnommen statt ausgeliehen — dabei lässt sich festhalten, '
        + 'an welche Klasse es ging. Zurück erwartet wird es nicht.'),
    ]), {
      fuss: [
        el('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Abbrechen'),
        el('span', { class: 'spacer' }),
        el('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: () => { m.close(); ausgabeDialog(artikel, () => SL.app.router()); },
        }, 'Stattdessen ausgeben'),
      ],
    });
  }

  function zeile(a) {
    const st = SL.models.leihStatus(a);
    const kopf = el('div', { class: 'benutzer-kopf' }, [
      el('a', { class: 'leih-titel', href: `#/artikel?id=${encodeURIComponent(a.artikelId)}` },
        a.artikelName || '(Artikel)'),
      a.menge > 1 ? el('span', { class: 'tag' }, `${a.menge} Stück`) : null,
      el('span', { class: 'ampel ' + st.klasse }, st.label),
    ]);

    const wer = [
      a.benutzerName,
      a.klasse ? `Klasse ${a.klasse}` : '',
      `seit ${SL.ui.formatDatum(String(a.ausgeliehenAm).slice(0, 10))}`,
      a.faelligAm ? `fällig ${SL.ui.formatDatum(a.faelligAm)}` : '',
    ].filter(Boolean).join(' · ');

    const teile = [kopf, el('div', { class: 'muted' }, wer)];
    if (a.notiz) teile.push(el('div', { class: 'muted' }, a.notiz));

    if (a.zurueckAm) {
      teile.push(el('div', { class: 'muted' },
        `zurück am ${SL.ui.formatDatum(String(a.zurueckAm).slice(0, 10))}${a.zurueckVon ? ' — angenommen von ' + a.zurueckVon : ''}`));
    } else {
      teile.push(el('div', { class: 'btn-reihe' }, [
        el('button', {
          class: 'btn btn-sm btn-primary', type: 'button',
          onclick: async () => {
            try {
              await SL.api.rueckgabe(a.id);
              toast('Zurückgebucht.');
              SL.app.router();
            } catch (e) { toast(e.message || 'Rückgabe fehlgeschlagen.', 4500); }
          },
        }, 'Zurückgenommen'),
        SL.store.istAdmin()
          ? el('button', {
            class: 'btn btn-sm btn-danger', type: 'button',
            title: 'Fehleingabe entfernen — die Rückgabe ist der normale Weg',
            onclick: async () => {
              if (!confirmDialog('Diesen Eintrag löschen? Das ist für Fehleingaben gedacht, nicht für die Rückgabe.')) return;
              try {
                await SL.api.ausleiheLoeschen(a.id);
                toast('Eintrag gelöscht.');
                SL.app.router();
              } catch (e) { toast(e.message || 'Löschen fehlgeschlagen.', 4500); }
            },
          }, 'Löschen')
          : null,
      ]));
    }

    return el('div', { class: 'eintrag' }, teile);
  }

  function defektKarte(defekte) {
    const box = el('div', { class: 'liste' });
    for (const d of defekte) {
      box.appendChild(el('div', { class: 'eintrag' }, [
        el('div', { class: 'benutzer-kopf' }, [
          el('a', { class: 'leih-titel', href: `#/artikel?id=${encodeURIComponent(d.artikelId)}` },
            d.artikelName || '(Artikel)'),
          el('span', { class: 'ampel ampel-faellig' }, 'defekt'),
        ]),
        el('div', {}, d.notiz),
        el('div', { class: 'muted' },
          `gemeldet von ${d.gemeldetVon} am ${SL.ui.formatDatum(String(d.gemeldetAm).slice(0, 10))}`),
        el('div', { class: 'btn-reihe' }, [
          el('button', {
            class: 'btn btn-sm', type: 'button',
            onclick: async () => {
              try {
                await SL.api.defektBehoben(d.id);
                toast('Als repariert vermerkt.');
                SL.app.router();
              } catch (e) { toast(e.message || 'Das hat nicht geklappt.', 4500); }
            },
          }, 'Repariert'),
        ]),
      ]));
    }
    return karte(`Defekt gemeldet (${defekte.length})`, box);
  }

  // --- Dialoge, von der Artikelansicht aus benutzt --------------------------
  function ausleihenDialog(artikel, fertig) {
    const klassen = SL.store.state.settings.klassen || [];
    let klasse = '';
    // Auswahlliste, wenn Klassen gepflegt sind — sonst ein freies Feld. Die
    // Liste wächst sonst nie, und ein leeres Pflichtfeld hilft niemandem.
    const klassenFeld = klassen.length
      ? select(klassen.map(k => ({ wert: k, label: k })), '', v => { klasse = v; }, { leerLabel: '— keine Klasse —' })
      : input({ placeholder: 'z. B. BSMT 22b' });

    const faellig = input({ type: 'date', value: SL.models.faelligVorschlag() });
    const menge = input({ type: 'number', min: '1', value: '1', inputmode: 'numeric' });
    const notiz = textarea({ rows: 2, placeholder: 'z. B. für die Projektwoche' });

    const dlg = SL.ui.modal(`Ausleihen: ${artikel.name}`, [
      el('p', { class: 'muted' }, [
        'Ausgeliehen auf ', el('strong', {}, SL.store.state.benutzer.name),
        '. Der Bestand ändert sich dadurch nicht — das Gerät bleibt im Inventar, es ist nur nicht im Schrank.',
      ]),
      feld('Klasse oder Gruppe', klassenFeld),
      feld('Rückgabe bis', faellig),
      artikel.menge > 1 ? feld('Anzahl', menge) : null,
      feld('Notiz', notiz),
    ], {
      fuss: [
        el('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
        el('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: async () => {
            try {
              await SL.api.ausleihen({
                artikelId: artikel.id,
                artikelName: artikel.name,
                artikelCode: artikel.code || '',
                menge: artikel.menge > 1 ? Math.max(1, parseInt(menge.value, 10) || 1) : 1,
                klasse: klassen.length ? klasse : klassenFeld.value.trim(),
                faelligAm: faellig.value || '',
                notiz: notiz.value.trim(),
              });
              dlg.close();
              toast('Ausgeliehen.');
              fertig();
            } catch (e) { toast(e.message || 'Das hat nicht geklappt.', 5000); }
          },
        }, 'Ausleihen'),
      ],
    });
  }

  // Ausgabe an eine Gruppe: bucht den Bestand ab UND schreibt mit, wohin es
  // ging. Zwei Schritte, die zusammengehören — deshalb ein Dialog.
  function ausgabeDialog(artikel, fertig) {
    const klassen = SL.store.state.settings.klassen || [];
    let klasse = '';
    const klassenFeld = klassen.length
      ? select(klassen.map(k => ({ wert: k, label: k })), '', v => { klasse = v; }, { leerLabel: '— keine Klasse —' })
      : input({ placeholder: 'z. B. BSMT 22b' });

    const menge = input({ type: 'number', min: '1', value: '1', inputmode: 'numeric' });
    const notiz = textarea({ rows: 2, placeholder: 'z. B. Projekt Ampelsteuerung' });

    const dlg = SL.ui.modal(`Ausgeben: ${artikel.name}`, [
      el('p', { class: 'muted' },
        `Bestand zurzeit ${artikel.menge} Stück. Die ausgegebene Menge wird abgebucht — `
        + 'zurück erwartet wird nichts, der Eintrag dient der Dokumentation.'),
      feld('Anzahl', menge),
      feld('An Klasse oder Gruppe', klassenFeld),
      feld('Wofür', notiz),
    ], {
      fuss: [
        el('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
        el('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: async () => {
            const n = Math.max(1, parseInt(menge.value, 10) || 1);
            if (n > artikel.menge && !confirmDialog(
              `Es sind nur ${artikel.menge} Stück verzeichnet, ausgegeben werden sollen ${n}. `
              + 'Trotzdem buchen? Der Bestand geht dann auf 0.')) return;
            try {
              // Erst abbuchen, dann protokollieren. Andersherum stünde bei
              // einem Fehlschlag eine Ausgabe im Protokoll, die nie stattfand.
              await SL.api.lagerBestand(artikel.id, { delta: -n });
              await SL.api.ausleihen({
                art: 'ausgabe',
                artikelId: artikel.id,
                artikelName: artikel.name,
                artikelCode: artikel.code || '',
                menge: n,
                klasse: klassen.length ? klasse : klassenFeld.value.trim(),
                notiz: notiz.value.trim(),
                // Schnappschuss des Preises — siehe Kommentar im Backend.
                preis: artikel.kaufpreis != null ? artikel.kaufpreis : null,
              });
              dlg.close();
              toast(`${n} ausgegeben.`);
              fertig();
            } catch (e) { toast(e.message || 'Das hat nicht geklappt.', 5000); }
          },
        }, 'Ausgeben'),
      ],
    });
  }

  function defektDialog(artikel, fertig) {
    const notiz = textarea({ rows: 3, placeholder: 'Was ist kaputt?' });
    const dlg = SL.ui.modal(`Defekt melden: ${artikel.name}`, [
      feld('Beschreibung', notiz),
      el('p', { class: 'muted' }, 'Das Gerät erscheint danach in der Ausleihe als defekt. Ausleihen bleibt möglich — die Meldung ist ein Hinweis, keine Sperre.'),
    ], {
      fuss: [
        el('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
        el('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: async () => {
            try {
              await SL.api.defektMelden({ artikelId: artikel.id, artikelName: artikel.name, notiz: notiz.value });
              dlg.close();
              toast('Defekt gemeldet.');
              fertig();
            } catch (e) { toast(e.message || 'Das hat nicht geklappt.', 5000); }
          },
        }, 'Melden'),
      ],
    });
    setTimeout(() => notiz.focus(), 50);
  }

  function feld(label, control) {
    return el('label', { class: 'feld feld-breit' }, [
      el('span', { class: 'feld-label' }, label),
      control,
    ]);
  }

  SL.views.renderAusleihe = renderAusleihe;
  SL.views.ausleihenDialog = ausleihenDialog;
  SL.views.ausgabeDialog = ausgabeDialog;
  SL.views.defektDialog = defektDialog;
})();
