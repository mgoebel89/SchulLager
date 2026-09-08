(function () {
  'use strict';
  window.SL = window.SL || {};
  SL.views = SL.views || {};

  const { el, karte, input, toast, confirmDialog } = SL.ui;

  // Inventur — Regal für Regal zählen.
  //
  // Vorbild ist der Abgleichsassistent aus der Gemeindeverwaltung, der sich
  // beim Einwohnerabgleich bewährt hat: EIN Ort auf einmal, jede Position mit
  // einem Griff erledigt, der Fortschritt immer sichtbar.
  //
  // Der wichtigste Entwurfspunkt: Zählen verändert den Bestand NICHT. Erst der
  // ausdrückliche Schritt „Bestände übernehmen" schreibt nach Homebox. So kann
  // man in Ruhe zählen, Abweichungen klären und erst danach buchen.

  async function renderInventur(mount, params = {}) {
    if (!SL.store.darfBuchen()) {
      mount.appendChild(karte('Anmeldung nötig', el('p', { class: 'muted' }, [
        'Zum Zählen bitte ',
        el('a', { href: '#/anmelden?weiter=' + encodeURIComponent('#/inventur') }, 'anmelden'),
        '.',
      ])));
      return;
    }
    if (params.id) return laufAnzeigen(mount, params.id, params);
    return uebersicht(mount);
  }

  // --- Übersicht ------------------------------------------------------------
  async function uebersicht(mount) {
    mount.appendChild(el('div', { class: 'toolbar' }, [
      el('h1', {}, 'Inventur'),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn btn-primary', type: 'button', onclick: () => startenDialog() }, '+ Inventur starten'),
    ]));

    const behaelter = el('div');
    mount.appendChild(behaelter);
    behaelter.appendChild(karte(null, el('p', { class: 'muted' }, 'Wird geladen…')));

    let liste = [];
    try {
      liste = await SL.api.listInventuren();
    } catch (e) {
      behaelter.innerHTML = '';
      behaelter.appendChild(karte('Das hat nicht geklappt', el('p', { class: 'anmeldung-fehler' }, e.message || '')));
      return;
    }

    behaelter.innerHTML = '';
    if (!liste.length) {
      behaelter.appendChild(karte(null, [
        el('p', {}, 'Es wurde noch keine Inventur durchgeführt.'),
        el('p', { class: 'muted' },
          'Eine Inventur geht einen Lagerort nach dem anderen durch: Sollbestand steht da, '
          + 'gezählt wird daneben. Der Bestand ändert sich dabei nicht — erst am Ende, '
          + 'wenn du die gezählten Werte ausdrücklich übernimmst.'),
      ]));
      return;
    }

    const box = el('div', { class: 'liste' });
    for (const i of liste) box.appendChild(laufZeile(i));
    behaelter.appendChild(karte(null, box));
  }

  function laufZeile(i) {
    const zustand = i.abgeschlossenAm
      ? (i.uebernommenAm ? { label: 'übernommen', klasse: 'ampel-ok' } : { label: 'abgeschlossen', klasse: 'ampel-bald' })
      : { label: 'läuft', klasse: 'ampel-offen' };

    return el('a', { class: 'eintrag eintrag-klick', href: `#/inventur?id=${encodeURIComponent(i.id)}` }, [
      el('div', { class: 'benutzer-kopf' }, [
        el('strong', {}, i.titel),
        el('span', { class: 'ampel ' + zustand.klasse }, zustand.label),
        el('span', { class: 'tag' }, `${i.anzahlPositionen} gezählt`),
      ]),
      el('div', { class: 'muted' }, [
        `begonnen ${SL.ui.formatDatum(String(i.gestartetAm).slice(0, 10))} von ${i.gestartetVon}`,
        i.ortName ? ` · nur ${i.ortName}` : ' · gesamter Bestand',
        i.abgeschlossenAm ? ` · abgeschlossen ${SL.ui.formatDatum(String(i.abgeschlossenAm).slice(0, 10))}` : '',
      ].join('')),
    ]);
  }

  function startenDialog() {
    const titel = input({ value: `Inventur ${new Date().getFullYear()}` });
    let ortId = '';
    let ortName = '';
    const ortAnzeige = el('span', { class: 'muted' }, 'gesamter Bestand');

    const dlg = SL.ui.modal('Inventur starten', [
      el('label', { class: 'feld feld-breit' }, [el('span', { class: 'feld-label' }, 'Bezeichnung'), titel]),
      el('label', { class: 'feld feld-breit' }, [
        el('span', { class: 'feld-label' }, 'Umfang'),
        el('div', { class: 'wahl-zeile' }, [
          el('button', {
            class: 'btn', type: 'button',
            onclick: () => SL.ui.ortWaehlen({
              titel: 'Auf welchen Lagerort beschränken?',
              onWahl: (o) => { ortId = o.id; ortName = o.pfad || o.name; ortAnzeige.textContent = ortName; ortAnzeige.className = ''; },
            }),
          }, 'Auf Lagerort beschränken'),
          ortAnzeige,
          el('button', {
            class: 'btn btn-sm', type: 'button',
            onclick: () => { ortId = ''; ortName = ''; ortAnzeige.textContent = 'gesamter Bestand'; ortAnzeige.className = 'muted'; },
          }, 'gesamter Bestand'),
        ]),
      ]),
      el('p', { class: 'muted' },
        'Der Bestand wird beim Zählen NICHT verändert. Erst am Ende entscheidest du, '
        + 'ob die gezählten Werte übernommen werden.'),
    ], {
      fuss: [
        el('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
        el('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: async () => {
            try {
              const i = await SL.api.inventurStarten({ titel: titel.value, ortId, ortName });
              dlg.close();
              location.hash = `#/inventur?id=${encodeURIComponent(i.id)}`;
            } catch (e) {
              // „Es läuft schon eine" ist kein Fehler, sondern ein Wegweiser.
              if (e.status === 409) {
                dlg.close();
                toast(e.message, 6000);
                return;
              }
              toast(e.message || 'Das hat nicht geklappt.', 5000);
            }
          },
        }, 'Starten'),
      ],
    });
    setTimeout(() => titel.focus(), 50);
  }

  // --- Ein Lauf -------------------------------------------------------------
  async function laufAnzeigen(mount, id, params) {
    const behaelter = el('div');
    mount.appendChild(el('div', { class: 'toolbar' }, [
      el('a', { class: 'btn btn-sm', href: '#/inventur' }, '‹ Alle Inventuren'),
      el('span', { class: 'spacer' }),
    ]));
    mount.appendChild(behaelter);
    behaelter.appendChild(el('p', { class: 'muted' }, 'Wird geladen…'));

    let lauf = null;
    let orte = [];
    try {
      [lauf, orte] = await Promise.all([SL.api.getInventur(id), SL.store.orteLaden().catch(() => [])]);
    } catch (e) {
      behaelter.innerHTML = '';
      behaelter.appendChild(karte('Das hat nicht geklappt', el('p', { class: 'anmeldung-fehler' }, e.message || '')));
      return;
    }

    behaelter.innerHTML = '';
    behaelter.appendChild(el('div', { class: 'toolbar' }, [el('h1', {}, lauf.titel)]));

    const positionen = Object.values(lauf.positionen || {});
    const abweichungen = positionen.filter(p => p.ist != null && p.ist !== p.soll);

    // Kopfkarte: Zustand, Zahlen, und was als Nächstes zu tun ist.
    behaelter.appendChild(kopfKarte(lauf, positionen, abweichungen));

    if (!lauf.abgeschlossenAm) {
      behaelter.appendChild(await zaehlKarte(lauf, orte));
    }

    if (positionen.length) {
      behaelter.appendChild(abweichungsKarte(lauf, positionen, abweichungen));
    }
  }

  function kopfKarte(lauf, positionen, abweichungen) {
    const zustand = lauf.abgeschlossenAm
      ? (lauf.uebernommenAm ? 'übernommen' : 'abgeschlossen')
      : 'läuft';

    const knoepfe = el('div', { class: 'btn-reihe' });

    if (!lauf.abgeschlossenAm) {
      knoepfe.appendChild(el('button', {
        class: 'btn btn-primary', type: 'button',
        onclick: async () => {
          if (!confirmDialog(`${positionen.length} Positionen gezählt, davon ${abweichungen.length} mit Abweichung.\n\nInventur abschließen? Danach lässt sich nichts mehr zählen.`)) return;
          try {
            await SL.api.inventurAbschliessen(lauf.id);
            toast('Inventur abgeschlossen.');
            SL.app.router();
          } catch (e) { toast(e.message || 'Das hat nicht geklappt.', 4500); }
        },
      }, 'Inventur abschließen'));
    } else if (!lauf.uebernommenAm) {
      knoepfe.appendChild(el('button', {
        class: 'btn btn-primary', type: 'button',
        onclick: () => uebernehmen(lauf, abweichungen),
      }, `${abweichungen.length} Bestände übernehmen`));
    }

    knoepfe.appendChild(el('button', {
      class: 'btn', type: 'button',
      onclick: () => {
        try { SL.export.inventurPdf.bauen(lauf); }
        catch (e) { toast(e.message || 'Das PDF ließ sich nicht erzeugen.', 5000); }
      },
    }, '📄 Protokoll als PDF'));

    if (SL.store.istAdmin() && !lauf.uebernommenAm) {
      knoepfe.appendChild(el('button', {
        class: 'btn btn-danger btn-sm', type: 'button',
        onclick: async () => {
          if (!confirmDialog('Diese Inventur samt allen gezählten Positionen löschen?')) return;
          try {
            await SL.api.inventurLoeschen(lauf.id);
            toast('Inventur gelöscht.');
            location.hash = '#/inventur';
          } catch (e) { toast(e.message || 'Löschen fehlgeschlagen.', 4500); }
        },
      }, 'Löschen'));
    }

    const daten = el('dl', { class: 'daten' }, [
      zeile('Zustand', zustand),
      zeile('Umfang', lauf.ortName || 'gesamter Bestand'),
      zeile('Gezählt', `${positionen.length} Positionen`),
      zeile('Abweichungen', String(abweichungen.length)),
      zeile('Begonnen', `${SL.ui.formatDatum(String(lauf.gestartetAm).slice(0, 10))} von ${lauf.gestartetVon}`),
      lauf.abgeschlossenAm ? zeile('Abgeschlossen', `${SL.ui.formatDatum(String(lauf.abgeschlossenAm).slice(0, 10))} von ${lauf.abgeschlossenVon}`) : null,
      lauf.uebernommenAm ? zeile('Übernommen', `${SL.ui.formatDatum(String(lauf.uebernommenAm).slice(0, 10))} von ${lauf.uebernommenVon}`) : null,
    ].filter(Boolean));

    return karte(null, [daten, knoepfe]);
  }

  function zeile(label, wert) {
    return el('div', { class: 'daten-zeile' }, [el('dt', {}, label), el('dd', {}, String(wert))]);
  }

  // --- Zählen ---------------------------------------------------------------
  async function zaehlKarte(lauf, orte) {
    const box = el('div');
    const k = karte('Zählen', box);

    // Ort wählen: EIN Regal auf einmal. Wer alles auf einmal sieht, zählt
    // nichts zu Ende.
    let ortId = lauf.ortId || '';
    let ortPfad = lauf.ortName || '';
    const ortAnzeige = el('span', { class: ortId ? '' : 'muted' }, ortPfad || 'noch kein Lagerort gewählt');
    const listeBox = el('div');

    const ortKnopf = el('button', {
      class: 'btn btn-primary', type: 'button',
      onclick: () => SL.ui.ortWaehlen({
        titel: 'Welchen Lagerort zählen?',
        aktuellId: ortId,
        onWahl: (o) => {
          ortId = o.id;
          ortPfad = o.pfad || o.name;
          ortAnzeige.textContent = ortPfad;
          ortAnzeige.className = '';
          artikelLaden();
        },
      }),
    }, 'Lagerort wählen');

    const scanKnopf = SL.ui.scannerBereit()
      ? el('button', {
        class: 'btn', type: 'button',
        title: 'Artikel scannen und sofort zählen',
        onclick: () => SL.ui.scannen(async (text) => {
          const { art, wert } = SL.models.codeArt(text);
          try {
            const a = art === 'homeboxId' ? await SL.api.lagerArtikel(wert)
              : art === 'artikel' ? await SL.api.lagerBeiCode(wert)
                : art === 'ort' ? null
                  : await SL.api.lagerBeiBarcode(wert);
            if (!a) { toast('Das ist ein Lagerort-Etikett — bitte einen Artikel scannen.', 3500); return; }
            einzelZaehlen(lauf, a);
          } catch (e) {
            toast(e && e.status === 404 ? 'Zu diesem Code ist kein Artikel hinterlegt.' : (e.message || 'Fehler'), 4000);
          }
        }),
      }, '⌷ Artikel scannen')
      : null;

    box.appendChild(el('div', { class: 'wahl-zeile' }, [ortKnopf, scanKnopf, ortAnzeige]));
    box.appendChild(listeBox);

    async function artikelLaden() {
      listeBox.innerHTML = '';
      listeBox.appendChild(el('p', { class: 'muted' }, 'Artikel werden geladen…'));
      try {
        const erg = await SL.api.lagerSuchen({ ortId, seite: 1, proSeite: 100 });
        listeBox.innerHTML = '';
        if (!erg.artikel.length) {
          listeBox.appendChild(el('p', { class: 'muted' }, 'An diesem Lagerort ist nichts verzeichnet.'));
          return;
        }
        const l = el('div', { class: 'liste' });
        for (const a of erg.artikel) l.appendChild(zaehlZeile(lauf, a, ortPfad));
        listeBox.appendChild(l);
        if (erg.gesamt > erg.artikel.length) {
          listeBox.appendChild(el('p', { class: 'muted' },
            `${erg.artikel.length} von ${erg.gesamt} — dieser Ort enthält mehr, als auf einmal gezählt werden kann. Bitte in Unterorte aufteilen.`));
        }
      } catch (e) {
        listeBox.innerHTML = '';
        listeBox.appendChild(el('p', { class: 'anmeldung-fehler' }, e.message || ''));
      }
    }

    if (ortId) artikelLaden();
    return k;
  }

  // Eine Zeile beim Zählen: Sollwert steht da, „stimmt" ist ein Griff, eine
  // abweichende Zahl kostet zwei.
  function zaehlZeile(lauf, artikel, ortPfad) {
    const vorhanden = (lauf.positionen || {})[artikel.id];
    const wrap = el('div', { class: 'eintrag' });

    const zahl = input({
      type: 'number', min: '0', class: 'inp zaehl-feld', inputmode: 'numeric',
      value: vorhanden && vorhanden.ist != null ? String(vorhanden.ist) : '',
      placeholder: String(artikel.menge),
    });

    const status = el('span', { class: 'muted' },
      vorhanden && vorhanden.ist != null
        ? (vorhanden.ist === vorhanden.soll ? '✓ gezählt' : `✓ gezählt: ${vorhanden.ist} statt ${vorhanden.soll}`)
        : '');

    const speichern = async (ist) => {
      try {
        const p = await SL.api.inventurZaehlen(lauf.id, {
          artikelId: artikel.id,
          artikelName: artikel.name,
          ortName: ortPfad,
          soll: artikel.menge,
          ist,
        });
        lauf.positionen[artikel.id] = p;
        status.textContent = p.ist === p.soll ? '✓ gezählt' : `✓ gezählt: ${p.ist} statt ${p.soll}`;
        status.className = p.ist === p.soll ? 'hinweis-ok' : 'ampel ampel-bald';
        zahl.value = String(p.ist);
      } catch (e) { toast(e.message || 'Konnte nicht gespeichert werden.', 4500); }
    };

    wrap.appendChild(el('div', { class: 'benutzer-kopf' }, [
      el('strong', {}, artikel.name || '(ohne Namen)'),
      el('span', { class: 'tag' }, `Soll ${artikel.menge}`),
      status,
    ]));
    wrap.appendChild(el('div', { class: 'wahl-zeile' }, [
      el('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => speichern(artikel.menge) }, '✓ stimmt'),
      zahl,
      el('button', {
        class: 'btn btn-sm', type: 'button',
        onclick: () => {
          if (zahl.value === '') { toast('Bitte die gezählte Anzahl eintragen.'); zahl.focus(); return; }
          speichern(Math.max(0, parseInt(zahl.value, 10) || 0));
        },
      }, 'Abweichung buchen'),
    ]));
    return wrap;
  }

  // Aus dem Scanner heraus: ein einzelner Artikel, ohne den Ort zu wechseln.
  function einzelZaehlen(lauf, artikel) {
    const zahl = input({ type: 'number', min: '0', value: String(artikel.menge), inputmode: 'numeric' });
    const dlg = SL.ui.modal(`Zählen: ${artikel.name}`, [
      el('p', { class: 'muted' }, `Verzeichnet sind ${artikel.menge} Stück${artikel.ortName ? ' in ' + artikel.ortName : ''}.`),
      el('label', { class: 'feld feld-breit' }, [el('span', { class: 'feld-label' }, 'Gezählt'), zahl]),
    ], {
      fuss: [
        el('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
        el('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: async () => {
            try {
              await SL.api.inventurZaehlen(lauf.id, {
                artikelId: artikel.id, artikelName: artikel.name, ortName: artikel.ortName || '',
                soll: artikel.menge, ist: Math.max(0, parseInt(zahl.value, 10) || 0),
              });
              dlg.close();
              toast('Gezählt.');
              SL.app.router();
            } catch (e) { toast(e.message || 'Das hat nicht geklappt.', 4500); }
          },
        }, 'Übernehmen'),
      ],
    });
    setTimeout(() => { zahl.focus(); zahl.select(); }, 50);
  }

  // --- Abweichungen ---------------------------------------------------------
  function abweichungsKarte(lauf, positionen, abweichungen) {
    const box = el('div');
    if (!abweichungen.length) {
      box.appendChild(el('p', { class: 'hinweis-ok' },
        `Alle ${positionen.length} gezählten Positionen stimmen mit dem verzeichneten Bestand überein.`));
      return karte('Ergebnis', box);
    }

    const liste = el('div', { class: 'liste' });
    for (const p of abweichungen.slice().sort((a, b) => (a.ist - a.soll) - (b.ist - b.soll))) {
      const diff = p.ist - p.soll;
      liste.appendChild(el('a', { class: 'eintrag eintrag-klick', href: `#/artikel?id=${encodeURIComponent(p.artikelId)}` }, [
        el('div', { class: 'benutzer-kopf' }, [
          el('strong', {}, p.artikelName || '(Artikel)'),
          el('span', { class: 'ampel ' + (diff < 0 ? 'ampel-faellig' : 'ampel-bald') },
            `${diff > 0 ? '+' : ''}${diff}`),
        ]),
        el('div', { class: 'muted' }, [
          `verzeichnet ${p.soll}, gezählt ${p.ist}`,
          p.ortName ? ' · ' + p.ortName : '',
          ` · ${SL.ui.formatDatum(String(p.gezaehltAm).slice(0, 10))} ${p.gezaehltVon}`,
        ].join('')),
      ]));
    }

    box.appendChild(el('p', { class: 'muted' },
      `${abweichungen.length} von ${positionen.length} gezählten Positionen weichen ab. `
      + 'Minus heißt: es ist weniger da als verzeichnet.'));
    box.appendChild(liste);
    return karte('Abweichungen', box);
  }

  async function uebernehmen(lauf, abweichungen) {
    if (!abweichungen.length) { toast('Es gibt keine Abweichungen zu übernehmen.'); return; }
    if (!confirmDialog(
      `${abweichungen.length} Bestände in Homebox auf die gezählten Werte setzen?\n\n`
      + 'Das ist der einzige Schritt dieser Inventur, der den Bestand verändert.')) return;
    try {
      const erg = await SL.api.inventurUebernehmen(lauf.id);
      if (erg.fehler) {
        toast(`${erg.uebernommen} übernommen, ${erg.fehler} fehlgeschlagen — siehe Liste.`, 6000);
      } else {
        toast(`${erg.uebernommen} Bestände übernommen.`);
      }
      SL.app.router();
    } catch (e) { toast(e.message || 'Das hat nicht geklappt.', 5000); }
  }

  SL.views.renderInventur = renderInventur;
})();
