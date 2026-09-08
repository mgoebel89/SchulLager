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

    const offen = liste.filter(a => !a.zurueckAm);
    if (!offen.length && !alleZeigen) {
      behaelter.appendChild(karte(null, el('p', {}, 'Zurzeit ist nichts ausgeliehen.')));
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
  SL.views.defektDialog = defektDialog;
})();
