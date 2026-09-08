(function () {
  'use strict';
  window.SL = window.SL || {};
  SL.views = SL.views || {};

  const { el, karte, input, textarea, toast, confirmDialog } = SL.ui;

  // Komponenten eines Demonstrators.
  //
  // Viele Demonstratoren bestehen aus mehreren Geräten; wichtig sind die im
  // Profinet hängenden — meist SPS-Baugruppen. Sie bleiben dem Demonstrator
  // fest zugeordnet, weil sie ohne ihn keinen Sinn ergeben.
  //
  // Der führende Bezeichner in Profinet ist NICHT die IP, sondern der
  // Gerätename (NameOfStation): über ihn findet die Steuerung das Gerät, und
  // beim Gerätetausch muss genau er neu vergeben werden. Deshalb steht er in
  // der Anzeige vorn.

  const TYPEN = ['SPS', 'HMI / Panel', 'IO-Modul', 'Switch', 'Antrieb / Umrichter', 'Sensor', 'Netzteil', 'Rechner', 'Sonstiges'];

  // --- Karte im Artikeldetail ----------------------------------------------
  async function komponentenKarte(demonstrator, neuLaden, art) {
    // Bei einem Netzgerät beschreiben die Angaben das Gerät SELBST (ein SPS-
    // Board ist seine eigene Netzkomponente), bei einem Demonstrator seine
    // Einbauten. Ein gemeinsamer Titel wäre in einem der beiden Fälle falsch.
    const netzgeraet = art === 'netzgeraet';
    const box = el('div');
    const k = karte(netzgeraet ? 'Netzangaben' : 'Komponenten', box, {
      aktion: el('button', {
        class: 'btn btn-sm', type: 'button',
        onclick: () => dialog(demonstrator, null, neuLaden, netzgeraet),
      }, netzgeraet ? '+ Netzangaben' : '+ Komponente'),
    });
    box.appendChild(el('p', { class: 'muted' }, 'Wird geladen…'));

    let liste = [];
    try {
      liste = await SL.api.listKomponenten(demonstrator.id);
    } catch (e) {
      box.innerHTML = '';
      box.appendChild(el('p', { class: 'anmeldung-fehler' }, e.message || ''));
      return k;
    }

    box.innerHTML = '';
    if (!liste.length) {
      box.appendChild(el('p', { class: 'muted' }, netzgeraet
        ? 'Noch keine Netzangaben erfasst — Profinet-Gerätename, IP und Seriennummer gehören hierher.'
        : 'Noch keine Komponenten erfasst. Hier gehören die Geräte hinein, die im Netz hängen — '
          + 'mit Profinet-Gerätename, IP und Seriennummer.'));
      return k;
    }
    const l = el('div', { class: 'liste' });
    for (const komp of liste) l.appendChild(zeile(komp, demonstrator, neuLaden, netzgeraet));
    box.appendChild(l);
    return k;
  }

  function zeile(komp, demonstrator, neuLaden, netzgeraet) {
    const netz = [
      komp.profinetName ? `Gerätename ${komp.profinetName}` : '',
      komp.ip ? `IP ${komp.ip}${komp.subnetz ? ' / ' + komp.subnetz : ''}` : '',
      komp.mac ? `MAC ${komp.mac}` : '',
    ].filter(Boolean).join(' · ');

    const geraet = [
      komp.hersteller,
      komp.bestellnummer,
      komp.seriennummer ? `S/N ${komp.seriennummer}` : '',
      komp.firmware ? `FW ${komp.firmware}` : '',
      komp.steckplatz ? `Platz ${komp.steckplatz}` : '',
    ].filter(Boolean).join(' · ');

    return el('div', { class: 'eintrag' }, [
      el('div', { class: 'benutzer-kopf' }, [
        el('strong', {}, komp.name),
        komp.typ ? el('span', { class: 'tag' }, komp.typ) : null,
        komp.passwort ? el('span', { class: 'tag' }, '🔑') : null,
      ]),
      netz ? el('div', { class: 'lager-barcode' }, netz) : null,
      geraet ? el('div', { class: 'muted' }, geraet) : null,
      komp.notiz ? el('div', { class: 'muted' }, komp.notiz) : null,
      komp.passwort ? zugangZeile(komp) : null,
      el('div', { class: 'btn-reihe' }, [
        el('button', { class: 'btn btn-sm', type: 'button', onclick: () => dialog(demonstrator, komp, neuLaden, netzgeraet) }, 'Bearbeiten'),
        el('button', {
          class: 'btn btn-sm btn-danger', type: 'button',
          onclick: async () => {
            if (!confirmDialog(`Komponente „${komp.name}" wirklich löschen?`)) return;
            try {
              await SL.api.komponenteLoeschen(komp.id);
              toast('Komponente gelöscht.');
              neuLaden();
            } catch (e) { toast(e.message || 'Löschen fehlgeschlagen.', 4500); }
          },
        }, 'Löschen'),
      ]),
    ]);
  }

  // Zugangsdaten stehen nicht offen auf dem Schirm: im Lager schaut oft jemand
  // mit. Erst auf Klick — und dann auch nur, weil die Schule sich dafür
  // entschieden hat, sie überhaupt zu speichern.
  function zugangZeile(komp) {
    const wert = el('span', { class: 'lager-barcode' }, '••••••••');
    let sichtbar = false;
    const knopf = el('button', {
      class: 'btn btn-sm', type: 'button',
      onclick: () => {
        sichtbar = !sichtbar;
        wert.textContent = sichtbar ? komp.passwort : '••••••••';
        knopf.textContent = sichtbar ? 'Verbergen' : 'Anzeigen';
      },
    }, 'Anzeigen');
    return el('div', { class: 'wahl-zeile' }, [
      el('span', { class: 'muted' }, komp.benutzername ? `Zugang ${komp.benutzername} /` : 'Passwort'),
      wert,
      knopf,
    ]);
  }

  // --- Dialog ---------------------------------------------------------------
  function dialog(demonstrator, komp, neuLaden, netzgeraet) {
    const f = {};
    const mk = (schluessel, attrs) => {
      f[schluessel] = input({ value: (komp && komp[schluessel]) || '', autocomplete: 'off', ...(attrs || {}) });
      return f[schluessel];
    };

    const typ = SL.ui.select(TYPEN.map(t => ({ wert: t, label: t })), (komp && komp.typ) || '',
      v => { typWert = v; }, { leerLabel: '— ohne —' });
    let typWert = (komp && komp.typ) || '';

    const notiz = textarea({ rows: 2 });
    notiz.value = (komp && komp.notiz) || '';

    const inhalt = [
      feld('Bezeichnung', mk('name', { placeholder: netzgeraet ? 'z. B. S7-1200 CPU 1214C' : 'z. B. SPS Hauptsteuerung' })),
      feld('Art', typ),
      abschnitt('Netz (Profinet)'),
      feld('Profinet-Gerätename (NameOfStation)', mk('profinetName', { placeholder: 'z. B. sps-hydraulik-01', autocapitalize: 'none' })),
      feld('IP-Adresse', mk('ip', { placeholder: '192.168.0.10', inputmode: 'decimal' })),
      feld('Subnetzmaske', mk('subnetz', { placeholder: '255.255.255.0', inputmode: 'decimal' })),
      feld('MAC-Adresse', mk('mac', { placeholder: '00:1B:1B:AA:BB:CC', autocapitalize: 'none' })),
      abschnitt('Gerät'),
      feld('Hersteller', mk('hersteller')),
      feld('Bestellnummer', mk('bestellnummer', { placeholder: 'z. B. 6ES7214-1AG40-0XB0' })),
      feld('Seriennummer', mk('seriennummer')),
      feld('UUID', mk('uuid')),
      feld('Firmware-Stand', mk('firmware')),
      feld('Steckplatz / Rack', mk('steckplatz', { placeholder: 'z. B. Rack 0, Slot 2' })),
      abschnitt('Zugang'),
      feld('Benutzername', mk('benutzername', { autocapitalize: 'none' })),
      feld('Passwort', mk('passwort', { autocapitalize: 'none' })),
      el('p', { class: 'muted' },
        'Das Passwort wird unverschlüsselt gespeichert und steht damit auch in der nächtlichen Sicherung. '
        + 'Für Geräte mit ernsthaftem Schutzbedarf besser einen Verweis eintragen statt des Passworts.'),
      feld('Notiz', notiz),
    ];

    // Bei einem Netzgerät beschreibt der Eintrag das Gerät selbst — „Komponente
    // zu …" wäre dort schlicht falsch.
    const titel = komp
      ? `${netzgeraet ? 'Netzangaben' : 'Komponente'}: ${komp.name}`
      : `${netzgeraet ? 'Netzangaben zu' : 'Komponente zu'} ${demonstrator.name}`;
    const dlg = SL.ui.modal(titel, inhalt, {
      fuss: [
        el('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
        el('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: async () => {
            if (!f.name.value.trim()) { toast('Bitte eine Bezeichnung angeben.'); return; }
            const daten = { typ: typWert, notiz: notiz.value };
            for (const [k, feldEl] of Object.entries(f)) daten[k] = feldEl.value;
            try {
              const antwort = komp
                ? await SL.api.komponenteSpeichern(komp.id, daten)
                : await SL.api.komponenteAnlegen({
                  ...daten,
                  demonstratorId: demonstrator.id,
                  demonstratorName: demonstrator.name,
                });
              dlg.close();
              // Doppelbelegungen melden, aber nicht blockieren: manchmal ist
              // die Dopplung gewollt (Ersatzgerät) — und manchmal ist sie
              // genau der Fehler, den man gerade sucht.
              if (antwort.konflikte && antwort.konflikte.length) {
                konfliktHinweis(antwort.konflikte);
              } else {
                toast(komp ? 'Gespeichert.' : 'Komponente angelegt.');
              }
              neuLaden();
            } catch (e) { toast(e.message || 'Das hat nicht geklappt.', 5000); }
          },
        }, komp ? 'Speichern' : 'Anlegen'),
      ],
    });
    setTimeout(() => f.name.focus(), 50);
  }

  function konfliktHinweis(konflikte) {
    const liste = el('div', { class: 'liste' });
    for (const k of konflikte) {
      liste.appendChild(el('div', { class: 'eintrag' }, [
        el('div', {}, [el('strong', {}, k.feld), ` ${k.wert} steht auch bei:`]),
        el('div', { class: 'muted' }, `${k.komponenteName}${k.demonstratorName ? ' — ' + k.demonstratorName : ''}`),
      ]));
    }
    const m = SL.ui.modal('Gespeichert — aber Achtung', [
      el('p', {}, 'Die Angaben sind gespeichert. Sie kommen aber noch woanders vor:'),
      liste,
      el('p', { class: 'muted' }, 'Doppelte IP-Adressen und Gerätenamen sind im Profinet die häufigste Störungsursache.'),
    ], {
      fuss: [el('span', { class: 'spacer' }), el('button', { class: 'btn btn-primary', type: 'button', onclick: () => m.close() }, 'Verstanden')],
    });
  }

  function feld(label, control) {
    return el('label', { class: 'feld feld-breit' }, [el('span', { class: 'feld-label' }, label), control]);
  }
  function abschnitt(titel) {
    return el('h3', { class: 'dlg-abschnitt' }, titel);
  }

  // --- Netzübersicht --------------------------------------------------------
  // Beantwortet „welche IP ist frei?" und „wer hat die .10?" ohne Zettel.
  async function renderNetz(mount) {
    if (!SL.store.darfBuchen()) {
      mount.appendChild(karte('Anmeldung nötig', el('p', { class: 'muted' }, [
        'Netzangaben sind nur angemeldet einsehbar. Bitte ',
        el('a', { href: '#/anmelden?weiter=' + encodeURIComponent('#/netz') }, 'anmelden'),
        '.',
      ])));
      return;
    }

    mount.appendChild(el('div', { class: 'toolbar' }, [
      el('h1', {}, 'Netzübersicht'),
      el('span', { class: 'spacer' }),
      el('a', { class: 'btn', href: '#/import' }, '⤒ CSV-Import'),
    ]));
    const behaelter = el('div');
    mount.appendChild(behaelter);
    behaelter.appendChild(karte(null, el('p', { class: 'muted' }, 'Wird geladen…')));

    let liste = [];
    try {
      liste = await SL.api.netzUebersicht();
    } catch (e) {
      behaelter.innerHTML = '';
      behaelter.appendChild(karte('Das hat nicht geklappt', el('p', { class: 'anmeldung-fehler' }, e.message || '')));
      return;
    }

    behaelter.innerHTML = '';
    if (!liste.length) {
      behaelter.appendChild(karte(null, el('p', { class: 'muted' },
        'Noch keine Komponenten mit Netzangaben erfasst. Sie werden am jeweiligen Demonstrator gepflegt.')));
      return;
    }

    const doppelte = liste.filter(k => k.doppelt.ip || k.doppelt.mac || k.doppelt.profinetName);
    if (doppelte.length) {
      const box = el('div', { class: 'liste' });
      for (const k of doppelte) box.appendChild(netzZeile(k));
      behaelter.appendChild(karte(`Doppelt vergeben (${doppelte.length})`, [
        el('p', { class: 'muted' }, 'Dieselbe IP, MAC oder derselbe Gerätename kommt mehrfach vor — im Profinet die häufigste Störungsursache.'),
        box,
      ]));
    }

    const alle = el('div', { class: 'liste' });
    for (const k of liste) alle.appendChild(netzZeile(k));
    behaelter.appendChild(karte(`Alle Netzgeräte (${liste.length})`, alle));
  }

  function netzZeile(k) {
    const marker = [];
    if (k.doppelt.ip) marker.push(el('span', { class: 'ampel ampel-faellig' }, 'IP doppelt'));
    if (k.doppelt.mac) marker.push(el('span', { class: 'ampel ampel-faellig' }, 'MAC doppelt'));
    if (k.doppelt.profinetName) marker.push(el('span', { class: 'ampel ampel-faellig' }, 'Name doppelt'));

    return el('a', {
      class: 'eintrag eintrag-klick',
      href: `#/artikel?id=${encodeURIComponent(k.demonstratorId)}`,
    }, [
      el('div', { class: 'benutzer-kopf' }, [
        el('strong', {}, k.profinetName || k.name),
        k.typ ? el('span', { class: 'tag' }, k.typ) : null,
        ...marker,
      ]),
      el('div', { class: 'lager-barcode' }, [
        k.ip ? `IP ${k.ip}` : 'ohne IP',
        k.mac ? ` · MAC ${k.mac}` : '',
      ].join('')),
      el('div', { class: 'muted' }, [
        k.name,
        k.demonstratorName ? ' — ' + k.demonstratorName : '',
      ].join('')),
    ]);
  }

  SL.views.komponentenKarte = komponentenKarte;
  // Von der Neuaufnahme aus: gleich nach dem Anlegen eines Netzgeräts.
  SL.views.komponenteAnlegen = (artikel, neuLaden) => dialog(artikel, null, neuLaden, true);
  SL.views.renderNetz = renderNetz;
})();
