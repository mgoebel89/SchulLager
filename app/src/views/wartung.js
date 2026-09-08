(function () {
  'use strict';
  window.SL = window.SL || {};
  SL.views = SL.views || {};

  const { el, karte, textarea, toast } = SL.ui;

  // Wartung: was ist kaputt, seit wann, und was fällt ständig aus.
  //
  // Die Liste ist nach ALTER sortiert, nicht nach Meldedatum absteigend — die
  // älteste offene Meldung ist die, die vergessen wurde. Genau sie soll oben
  // stehen, nicht die von heute Morgen.
  //
  // „Dauerpatienten" sind der zweite Zweck: Ein Gerät mit vier Meldungen im
  // Jahr ist ein Fall für Ersatz, nicht für die fünfte Reparatur. Diese Frage
  // beantwortet keine Einzelmeldung, sondern nur die Zusammenschau.

  const DAUERPATIENT_AB = 3;      // Meldungen …
  const BETRACHTUNG_TAGE = 365;   // … in diesem Zeitraum

  async function renderWartung(mount, params = {}) {
    if (!SL.store.darfBuchen()) {
      mount.appendChild(karte('Anmeldung nötig', el('p', { class: 'muted' }, [
        'Die Wartungsübersicht ist nur angemeldet einsehbar. Bitte ',
        el('a', { href: '#/anmelden?weiter=' + encodeURIComponent('#/wartung') }, 'anmelden'),
        '.',
      ])));
      return;
    }

    const alleZeigen = params.alle === '1';

    mount.appendChild(el('div', { class: 'toolbar' }, [
      el('h1', {}, 'Wartung'),
      el('span', { class: 'spacer' }),
      el('a', {
        class: 'btn btn-sm',
        href: alleZeigen ? '#/wartung' : '#/wartung?alle=1',
      }, alleZeigen ? 'Nur offene' : 'Auch erledigte'),
      el('button', {
        class: 'btn btn-primary', type: 'button',
        onclick: () => geraetWaehlenUndMelden(),
      }, '+ Defekt melden'),
    ]));

    const behaelter = el('div');
    mount.appendChild(behaelter);
    behaelter.appendChild(karte(null, el('p', { class: 'muted' }, 'Wird geladen…')));

    // Immer ALLE Meldungen holen, auch wenn nur die offenen gezeigt werden:
    // die Dauerpatienten-Erkennung braucht die Vorgeschichte.
    let alle = [];
    let ausleihen = [];
    try {
      [alle, ausleihen] = await Promise.all([
        SL.api.listDefekte(true),
        SL.api.listAusleihen(false).catch(() => []),
      ]);
    } catch (e) {
      behaelter.innerHTML = '';
      behaelter.appendChild(karte('Das hat nicht geklappt', el('p', { class: 'anmeldung-fehler' }, e.message || '')));
      return;
    }

    behaelter.innerHTML = '';

    const offen = alle.filter(d => !d.behobenAm);
    const leihNach = new Map(ausleihen
      .filter(a => (a.art || 'ausleihe') === 'ausleihe' && !a.zurueckAm)
      .map(a => [a.artikelId, a]));

    behaelter.appendChild(kennzahlen(alle, offen));

    const dauer = dauerpatienten(alle);
    if (dauer.length) behaelter.appendChild(dauerpatientenKarte(dauer));

    if (!offen.length) {
      behaelter.appendChild(karte('Offene Meldungen', el('p', { class: 'hinweis-ok' },
        'Zurzeit ist nichts als defekt gemeldet.')));
    } else {
      // Älteste zuerst.
      const sortiert = offen.slice().sort((a, b) => String(a.gemeldetAm).localeCompare(String(b.gemeldetAm)));
      const box = el('div', { class: 'liste' });
      for (const d of sortiert) box.appendChild(zeile(d, leihNach.get(d.artikelId), false));
      behaelter.appendChild(karte(`Offene Meldungen (${offen.length})`, box));
    }

    if (alleZeigen) {
      const erledigt = alle.filter(d => d.behobenAm)
        .sort((a, b) => String(b.behobenAm).localeCompare(String(a.behobenAm)));
      if (erledigt.length) {
        const box = el('div', { class: 'liste' });
        for (const d of erledigt.slice(0, 100)) box.appendChild(zeile(d, null, true));
        behaelter.appendChild(karte(`Erledigt (${erledigt.length})`, [
          box,
          erledigt.length > 100 ? el('p', { class: 'muted' }, 'Die 100 jüngsten sind gezeigt.') : null,
        ]));
      }
    }
  }

  function kennzahlen(alle, offen) {
    const heute = SL.models.heuteIso();
    const aeltesteTage = offen.length
      ? Math.max(...offen.map(d => SL.models.tageZwischen(String(d.gemeldetAm).slice(0, 10), heute)))
      : 0;
    const imJahr = alle.filter(d => SL.models.tageZwischen(String(d.gemeldetAm).slice(0, 10), heute) <= BETRACHTUNG_TAGE).length;

    const dl = el('dl', { class: 'daten' }, [
      wert('Offen', String(offen.length)),
      wert('Längste offene Meldung', offen.length ? `${aeltesteTage} ${aeltesteTage === 1 ? 'Tag' : 'Tage'}` : '—'),
      wert('Meldungen im letzten Jahr', String(imJahr)),
    ]);
    return karte(null, dl);
  }

  function wert(label, w) {
    return el('div', { class: 'daten-zeile' }, [el('dt', {}, label), el('dd', {}, w)]);
  }

  // Geräte mit auffällig vielen Meldungen im Betrachtungszeitraum.
  function dauerpatienten(alle) {
    const heute = SL.models.heuteIso();
    const nachGeraet = new Map();
    for (const d of alle) {
      if (SL.models.tageZwischen(String(d.gemeldetAm).slice(0, 10), heute) > BETRACHTUNG_TAGE) continue;
      const e = nachGeraet.get(d.artikelId)
        || { artikelId: d.artikelId, artikelName: d.artikelName, anzahl: 0, offen: 0, letzte: '' };
      e.anzahl += 1;
      if (!d.behobenAm) e.offen += 1;
      if (String(d.gemeldetAm) > String(e.letzte)) e.letzte = d.gemeldetAm;
      nachGeraet.set(d.artikelId, e);
    }
    return [...nachGeraet.values()]
      .filter(e => e.anzahl >= DAUERPATIENT_AB)
      .sort((a, b) => b.anzahl - a.anzahl);
  }

  function dauerpatientenKarte(liste) {
    const box = el('div', { class: 'liste' });
    for (const e of liste) {
      box.appendChild(el('a', { class: 'eintrag eintrag-klick', href: `#/artikel?id=${encodeURIComponent(e.artikelId)}` }, [
        el('div', { class: 'benutzer-kopf' }, [
          el('strong', {}, e.artikelName || '(Gerät)'),
          el('span', { class: 'ampel ampel-faellig' }, `${e.anzahl} Meldungen`),
          e.offen ? el('span', { class: 'tag tag-warn' }, `${e.offen} offen`) : null,
        ]),
        el('div', { class: 'muted' }, `zuletzt am ${SL.ui.formatDatum(String(e.letzte).slice(0, 10))}`),
      ]));
    }
    return karte('Häufig defekt', [
      el('p', { class: 'muted' },
        `Diese Geräte wurden in den letzten zwölf Monaten mindestens ${DAUERPATIENT_AB}-mal gemeldet. `
        + 'Bei solchen Fällen lohnt die Frage nach Ersatz mehr als die nächste Reparatur.'),
      box,
    ]);
  }

  function zeile(d, leihe, erledigt) {
    const heute = SL.models.heuteIso();
    const tage = SL.models.tageZwischen(String(d.gemeldetAm).slice(0, 10), heute);

    const kopf = el('div', { class: 'benutzer-kopf' }, [
      el('a', { class: 'leih-titel', href: `#/artikel?id=${encodeURIComponent(d.artikelId)}` },
        d.artikelName || '(Gerät)'),
      erledigt
        ? el('span', { class: 'ampel ampel-ok' }, 'erledigt')
        : el('span', { class: 'ampel ' + (tage > 30 ? 'ampel-faellig' : 'ampel-bald') },
          tage === 0 ? 'heute gemeldet' : `seit ${tage} ${tage === 1 ? 'Tag' : 'Tagen'}`),
      // Ein defektes Gerät, das gerade jemand ausgeliehen hat, ist der Fall,
      // bei dem man zum Hörer greift — deshalb sichtbar und nicht versteckt.
      leihe ? el('span', { class: 'tag tag-warn' }, `verliehen an ${leihe.benutzerName}`) : null,
    ]);

    const teile = [
      kopf,
      el('div', {}, d.notiz),
      el('div', { class: 'muted' }, [
        `gemeldet von ${d.gemeldetVon} am ${SL.ui.formatDatum(String(d.gemeldetAm).slice(0, 10))}`,
        d.behobenAm ? ` · erledigt am ${SL.ui.formatDatum(String(d.behobenAm).slice(0, 10))} von ${d.behobenVon}` : '',
      ].join('')),
    ];

    if (d.behebungNotiz) {
      teile.push(el('div', { class: 'muted' }, ['Reparatur: ', el('span', {}, d.behebungNotiz)]));
    }

    if (!erledigt) {
      teile.push(el('div', { class: 'btn-reihe' }, [
        el('button', {
          class: 'btn btn-primary btn-sm', type: 'button',
          onclick: () => repariertDialog(d),
        }, 'Repariert melden'),
      ]));
    }

    return el('div', { class: 'eintrag' }, teile);
  }

  // Beim Erledigen nach der ausgeführten Arbeit fragen — freiwillig, aber
  // angeboten. Beim nächsten Ausfall desselben Geräts ist genau das die Frage.
  function repariertDialog(d) {
    const notiz = textarea({ rows: 3, placeholder: 'z. B. Netzteil getauscht, Sicherung erneuert' });
    const dlg = SL.ui.modal(`Repariert: ${d.artikelName || '(Gerät)'}`, [
      el('p', { class: 'muted' }, ['Gemeldet war: ', el('strong', {}, d.notiz)]),
      el('label', { class: 'feld feld-breit' }, [
        el('span', { class: 'feld-label' }, 'Was wurde gemacht? (freiwillig)'),
        notiz,
      ]),
      el('p', { class: 'muted' }, 'Die Meldung bleibt als Historie am Gerät stehen — sie verschwindet nur aus den offenen.'),
    ], {
      fuss: [
        el('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
        el('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: async () => {
            try {
              await SL.api.defektBehoben(d.id, notiz.value.trim());
              dlg.close();
              toast('Als repariert vermerkt.');
              SL.app.router();
            } catch (e) { toast(e.message || 'Das hat nicht geklappt.', 4500); }
          },
        }, 'Erledigt'),
      ],
    });
    setTimeout(() => notiz.focus(), 50);
  }

  // Defekt melden, ohne vorher den Artikel zu suchen — der übliche Weg, wenn
  // man mit dem kaputten Gerät in der Hand vor dem Rechner steht.
  function geraetWaehlenUndMelden() {
    SL.ui.artikelWaehlen({
      titel: 'Welches Gerät ist defekt?',
      onWahl: async (treffer) => {
        let artikel = treffer;
        try { artikel = await SL.api.lagerArtikel(treffer.id); } catch (_) { /* Treffer genügt */ }
        SL.views.defektDialog(artikel, () => SL.app.router());
      },
    });
  }

  SL.views.renderWartung = renderWartung;
  // Von der Artikelansicht aus benutzt, damit „Repariert" überall nach der
  // ausgeführten Arbeit fragt und nicht nur hier.
  SL.views.repariertDialog = repariertDialog;
})();
