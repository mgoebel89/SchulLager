(function () {
  'use strict';
  window.SL = window.SL || {};
  SL.views = SL.views || {};

  const { el, karte, input, textarea, select, modal, feld, toast, leer, confirmDialog } = SL.ui;

  // „Netzwerk" — das Verzeichnis dessen, was im Netz der Schule hängt.
  //
  // JEDES Gerät ist ein eigener Homebox-Artikel (so mit Matthias entschieden).
  // Dadurch greifen Wartung, Lagerort und Etikett ohne Zusatzbau; hier liegen
  // nur die Netzangaben und die Zuordnung zu Demonstratoren.
  //
  // NAMENSFALLE: „Geräte" (Menüpunkt) meint Demonstratoren und ausleihbare
  // Netzgerät-Artikel. „Netzwerk" meint Teilnehmer im Netz. Ein IO-Modul aus
  // einem Trainer steht hier, aber nicht dort — es wird nicht verliehen.

  const KLASSEN = ['profinet', 'roboter', 'pc'];

  // Vorschläge für das Typ-Feld, je Klasse verschieden: ein Roboter ist kein
  // IO-Modul, und eine gemeinsame Liste wäre in beiden Fällen halb falsch.
  const TYP_VORSCHLAEGE = {
    profinet: ['SPS', 'HMI / Panel', 'IO-Modul', 'Switch', 'Antrieb / Umrichter', 'Sensor', 'Netzteil', 'Sonstiges'],
    roboter: ['Knickarm', 'SCARA', 'Delta', 'Cobot', 'Portal', 'Sonstiges'],
    pc: [],
  };

  const klasseLabel = (k) => SL.models.netzKlasseLabel(k);
  // Eigene Mehrzahl statt angehängtem „e": aus „Profinet-Teilnehmer" würde
  // sonst „Profinet-Teilnehmere".
  const PLURAL = { profinet: 'Profinet', roboter: 'Roboter', pc: 'PCs' };

  // --- Liste ----------------------------------------------------------------
  async function renderNetzwerk(mount, params = {}) {
    if (!SL.store.istAngemeldet()) {
      mount.appendChild(karte('Netzwerk', el('p', {}, [
        'Diese Liste enthält Zugangsdaten und die Netzstruktur der Schule. Bitte zuerst ',
        el('a', { href: '#/anmelden?weiter=' + encodeURIComponent(location.hash) }, 'anmelden'),
        '.',
      ])));
      return;
    }

    const filter = KLASSEN.includes(params.klasse) ? params.klasse : '';
    const ansicht = params.ansicht === 'uebersicht' ? 'uebersicht' : 'liste';

    mount.appendChild(el('div', { class: 'toolbar' }, [
      el('h1', {}, 'Netzwerk'),
      el('span', { class: 'spacer' }),
      SL.store.darfBuchen()
        ? el('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: () => geraetDialog(null, { klasse: filter || 'profinet' }, () => SL.app.neuZeichnen()),
        }, '+ Gerät')
        : null,
    ]));

    const chip = (text, href, aktiv) => el('a', { class: 'chip' + (aktiv ? ' chip-aktiv' : ''), href }, text);
    mount.appendChild(el('div', { class: 'chips' }, [
      chip('Alle', '#/netzwerk', ansicht === 'liste' && !filter),
      ...KLASSEN.map(k => chip(PLURAL[k], `#/netzwerk?klasse=${k}`, ansicht === 'liste' && filter === k)),
      chip('Übersicht: IP & MAC', '#/netzwerk?ansicht=uebersicht', ansicht === 'uebersicht'),
    ]));

    const box = el('div');
    mount.appendChild(box);
    box.appendChild(el('p', { class: 'muted' }, 'Wird geladen…'));

    if (ansicht === 'uebersicht') return uebersichtZeigen(box);

    let liste;
    try {
      liste = await SL.api.listNetzgeraete({ klasse: filter });
    } catch (e) {
      box.innerHTML = '';
      box.appendChild(karte('Netzwerk', el('p', { class: 'anmeldung-fehler' }, e.message || '')));
      return;
    }

    box.innerHTML = '';
    // Hinweis auf die alte Struktur, solange dort noch etwas liegt. Er
    // verschwindet von selbst, sobald die Übernahme durch ist — ein Banner,
    // das nie weggeht, liest nach einer Woche niemand mehr.
    box.appendChild(await uebernahmeHinweis());

    if (!liste.length) {
      box.appendChild(karte('Netzwerk', leer(filter
        ? `Noch kein Gerät der Art „${klasseLabel(filter)}".`
        : 'Noch kein Netzwerkgerät erfasst. Jedes Gerät hier ist zugleich ein Artikel im Lager — '
          + 'damit lassen sich Reparaturen in der Wartung dokumentieren.')));
      return;
    }

    const l = el('div', { class: 'liste' });
    for (const g of liste) l.appendChild(zeile(g, () => SL.app.neuZeichnen()));
    box.appendChild(karte(filter ? klasseLabel(filter) : 'Alle Geräte', l));
  }

  function zeile(g, neuLaden) {
    const netz = [
      g.profinetName ? `Gerätename ${g.profinetName}` : '',
      g.steuerungsName ? `Steuerung ${g.steuerungsName}` : '',
      g.ip ? `IP ${g.ip}${g.subnetz ? ' / ' + g.subnetz : ''}` : '',
      g.mac ? `MAC ${g.mac}` : '',
    ].filter(Boolean).join(' · ');

    const geraet = [
      [g.hersteller, g.typ].filter(Boolean).join(' '),
      g.seriennummer ? `S/N ${g.seriennummer}` : '',
      g.firmware ? `FW ${g.firmware}` : '',
      g.hardwarestand ? `HW ${g.hardwarestand}` : '',
      g.steckplatz ? `Platz ${g.steckplatz}` : '',
    ].filter(Boolean).join(' · ');

    return el('div', { class: 'eintrag' }, [
      el('div', { class: 'benutzer-kopf' }, [
        el('strong', {}, g.artikelName || '(ohne Bezeichnung)'),
        el('span', { class: 'tag' }, klasseLabel(g.klasse)),
        g.passwort ? el('span', { class: 'tag' }, '🔑') : null,
      ]),
      netz ? el('div', { class: 'lager-barcode' }, netz) : null,
      geraet ? el('div', { class: 'muted' }, geraet) : null,
      g.notiz ? el('div', { class: 'muted' }, g.notiz) : null,
      g.passwort ? zugangZeile(g) : null,
      el('div', { class: 'btn-reihe' }, [
        // Der Weg zum Artikel ist der Weg zu Ort, Ausleihe und Wartung —
        // deshalb steht er vorn und nicht versteckt.
        el('a', { class: 'btn btn-sm', href: `#/artikel?id=${encodeURIComponent(g.artikelId)}` }, 'Artikel & Wartung'),
        el('button', { class: 'btn btn-sm', type: 'button', onclick: () => geraetDialog(g, {}, neuLaden) }, 'Bearbeiten'),
        el('button', {
          class: 'btn btn-sm btn-danger', type: 'button',
          onclick: () => entfernen(g, neuLaden),
        }, 'Entfernen'),
      ]),
    ]);
  }

  // Zugangsdaten stehen nicht offen auf dem Schirm: im Labor schaut oft jemand
  // mit. Erst auf Klick — und dann auch nur, weil die Schule sich dafür
  // entschieden hat, sie überhaupt zu speichern.
  function zugangZeile(g) {
    const wert = el('span', { class: 'lager-barcode' }, '••••••••');
    let sichtbar = false;
    const knopf = el('button', {
      class: 'btn btn-sm', type: 'button',
      onclick: () => {
        sichtbar = !sichtbar;
        wert.textContent = sichtbar ? g.passwort : '••••••••';
        knopf.textContent = sichtbar ? 'Verbergen' : 'Anzeigen';
      },
    }, 'Anzeigen');
    return el('div', { class: 'wahl-zeile' }, [
      el('span', { class: 'muted' }, g.benutzername ? `Zugang ${g.benutzername} /` : 'Passwort'),
      wert,
      knopf,
    ]);
  }

  // --- Entfernen ------------------------------------------------------------
  // Zwei verschiedene Dinge, und der Unterschied muss dastehen: die
  // Netzangaben zu lösen ist harmlos, den Artikel zu löschen nimmt Bestand,
  // Lagerort und Defekthistorie mit.
  function entfernen(g, neuLaden) {
    let mitArtikel = false;
    const wahl = el('label', { class: 'wahl-zeile' }, [
      el('input', {
        type: 'checkbox',
        onchange: (e) => { mitArtikel = e.target.checked; warnung.hidden = !mitArtikel; },
      }),
      el('span', {}, `Auch den Artikel „${g.artikelName}" in Homebox löschen`),
    ]);
    const warnung = el('p', { class: 'ampel ampel-warnung', hidden: true },
      'Damit verschwinden Bestand, Lagerort, Fotos UND die Defekthistorie dieses Geräts. '
      + 'Das lässt sich nicht rückgängig machen.');

    const dlg = modal(`„${g.artikelName}" entfernen`, [
      el('p', {}, 'Die Netzangaben (IP, MAC, Zuordnung) werden gelöscht. Der Artikel im Lager bleibt '
        + 'bestehen — mit ihm auch alles, was daran hängt.'),
      wahl,
      warnung,
    ], {
      fuss: [
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
        el('button', {
          class: 'btn btn-danger', type: 'button',
          onclick: async () => {
            if (mitArtikel && !confirmDialog(`Wirklich auch den Artikel „${g.artikelName}" löschen? Die Defekthistorie geht mit verloren.`)) return;
            try {
              const r = await SL.api.netzgeraetLoeschen(g.id, mitArtikel);
              dlg.close();
              // EINE Meldung je Vorgang, und zwar die wahre.
              toast(r.artikelGeloescht ? 'Gerät und Artikel gelöscht.' : 'Netzangaben gelöscht, Artikel bleibt bestehen.');
              neuLaden();
            } catch (e) { toast(e.message || 'Entfernen fehlgeschlagen.', 4500); }
          },
        }, 'Entfernen'),
      ],
    });
  }

  // --- Dialog: anlegen und ändern -------------------------------------------
  //
  // `vorgabe.demonstratorId` heftet das neue Gerät gleich an einen
  // Demonstrator — der Weg vom Demonstrator aus.
  function geraetDialog(g, vorgabe = {}, neuLaden) {
    const istNeu = !g;
    const st = SL.store.state.settings || {};
    let klasse = g ? g.klasse : (vorgabe.klasse || 'profinet');

    // Beim Anlegen: entweder einen Artikel anlegen lassen oder einen
    // vorhandenen verknüpfen. Der zweite Weg verhindert Doubletten, wenn das
    // Gerät im Bestand schon steht — beim Roboter der Regelfall.
    // `vorgabe.artikel` heisst: den Artikel gibt es schon (der Tag wurde in
    // Homebox von Hand vergeben). Dann wird verknuepft statt angelegt.
    let artikelId = (vorgabe.artikel && vorgabe.artikel.id) || '';
    let ortId = '';
    let ortName = '';

    const nameFeld = input({
      value: g ? g.artikelName : ((vorgabe.artikel && vorgabe.artikel.name) || ''),
      placeholder: klasse === 'pc' ? 'z. B. PC Labor 3 Platz 1' : 'z. B. S7-1200 CPU 1214C',
    });

    const klasseFeld = select(KLASSEN.map(k => ({ wert: k, label: klasseLabel(k) })), klasse,
      (v) => { klasse = v; felderZeichnen(); }, { leerLabel: false });

    const ortZeile = el('div', { class: 'wahl-zeile' });
    function ortZeichnen() {
      ortZeile.innerHTML = '';
      ortZeile.appendChild(el('span', { class: 'muted' }, ortName || 'noch kein Lagerort'));
      ortZeile.appendChild(el('button', {
        class: 'btn btn-sm', type: 'button',
        onclick: () => SL.ui.ortWaehlen({
          aktuellId: ortId,
          onWahl: (o) => { ortId = o.id; ortName = o.pfad || o.name; ortZeichnen(); },
        }),
      }, ortId ? 'Ändern' : 'Wählen'));
    }
    ortZeichnen();

    const artikelZeile = el('div', { class: 'wahl-zeile' });
    function artikelZeichnen() {
      artikelZeile.innerHTML = '';
      if (!artikelId) {
        artikelZeile.appendChild(el('span', { class: 'muted' }, 'Es wird ein neuer Artikel angelegt.'));
        artikelZeile.appendChild(el('button', {
          class: 'btn btn-sm', type: 'button',
          onclick: () => SL.ui.artikelWaehlen({
            titel: 'Vorhandenen Artikel verknüpfen',
            onWahl: (a) => {
              artikelId = a.id;
              nameFeld.value = a.name || nameFeld.value;
              artikelZeichnen();
            },
          }),
        }, 'Vorhandenen verknüpfen'));
      } else {
        artikelZeile.appendChild(el('span', {}, `verknüpft mit „${nameFeld.value}"`));
        artikelZeile.appendChild(el('button', {
          class: 'btn btn-sm', type: 'button',
          onclick: () => { artikelId = ''; artikelZeichnen(); },
        }, 'Doch neu anlegen'));
      }
    }
    artikelZeichnen();

    // Die Felder wechseln mit der Klasse. Eingetragenes bleibt erhalten, auch
    // wenn ein Feld gerade nicht sichtbar ist — wer sich in der Klasse vertut
    // und zurückwechselt, soll nicht alles neu tippen.
    const werte = {};
    for (const f of Object.keys(SL.models.NETZ_FELD_LABEL)) werte[f] = (g && g[f]) || '';
    const felderBox = el('div');

    function felderZeichnen() {
      felderBox.innerHTML = '';
      const liste = SL.models.netzFelder(klasse);
      const raster = el('div', { class: 'form-grid' });
      for (const f of liste) {
        if (f === 'notiz') continue;
        const label = SL.models.NETZ_FELD_LABEL[f] || f;
        let steuer;
        if (f === 'typ' && (TYP_VORSCHLAEGE[klasse] || []).length) {
          steuer = select(TYP_VORSCHLAEGE[klasse].map(t => ({ wert: t, label: t })), werte.typ,
            (v) => { werte.typ = v; }, { leerLabel: '— ohne —' });
        } else {
          steuer = input({
            value: werte[f] || '',
            type: f === 'passwort' ? 'password' : 'text',
            autocomplete: 'off',
            autocapitalize: f === 'ip' || f === 'mac' ? 'none' : undefined,
            placeholder: PLATZHALTER[f] || '',
          });
          steuer.addEventListener('input', () => { werte[f] = steuer.value; });
        }
        raster.appendChild(feld(label, steuer));
      }
      felderBox.appendChild(raster);
      if (liste.includes('notiz')) {
        const n = textarea({ rows: 2 });
        n.value = werte.notiz || '';
        n.addEventListener('input', () => { werte.notiz = n.value; });
        felderBox.appendChild(feld('Bemerkung', n, { breit: true }));
      }
      hinweis.textContent = KLASSEN_HINWEIS[klasse] || '';
    }

    const hinweis = el('p', { class: 'muted' });
    felderZeichnen();

    const dlg = modal(istNeu ? 'Netzwerkgerät anlegen' : `„${g.artikelName}" bearbeiten`, [
      el('div', { class: 'form-grid' }, [
        feld('Bezeichnung', nameFeld),
        feld('Art des Geräts', klasseFeld),
      ]),
      hinweis,
      istNeu ? feld('Artikel im Lager', artikelZeile, { breit: true }) : null,
      (istNeu && !artikelId) ? feld('Lagerort', ortZeile, { breit: true }) : null,
      felderBox,
      istNeu
        ? el('p', { class: 'muted' }, 'Das Gerät wird zugleich als Artikel im Lager angelegt (Einzelstück). '
          + 'Dadurch lassen sich Reparaturen in der Wartung dokumentieren.')
        : null,
    ], {
      fuss: [
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
        el('button', { class: 'btn btn-primary', type: 'button', onclick: () => speichern() }, 'Speichern'),
      ],
    });
    setTimeout(() => nameFeld.focus(), 50);

    async function speichern() {
      if (!nameFeld.value.trim()) { toast('Bitte eine Bezeichnung angeben.'); nameFeld.focus(); return; }
      const koerper = { klasse, name: nameFeld.value.trim() };
      for (const f of SL.models.netzFelder(klasse)) koerper[f] = werte[f] || '';
      if (istNeu) {
        if (artikelId) koerper.artikelId = artikelId;
        else if (ortId) koerper.ortId = ortId;
        if (vorgabe.demonstratorId) koerper.demonstratorIds = [vorgabe.demonstratorId];
      }
      try {
        const antwort = istNeu
          ? await SL.api.netzgeraetAnlegen(koerper)
          : await SL.api.netzgeraetSpeichern(g.id, koerper);
        dlg.close();
        // Der Ortsbaum zeigt Stückzahlen je Ort — die stimmen nach einer
        // Neuanlage nicht mehr.
        if (istNeu) SL.store.orteVergessen();
        // EINE Meldung je Vorgang, und zwar die wahre: ein Konflikt ist
        // wichtiger als die Bestätigung, dass gespeichert wurde.
        const k = (antwort && antwort.konflikte) || [];
        if (k.length) {
          toast(`Gespeichert — aber ${k[0].feld} ${k[0].wert} hat auch „${k[0].geraetName}".`, 6000);
        } else {
          toast(istNeu ? 'Netzwerkgerät angelegt.' : 'Gespeichert.');
        }
        neuLaden();
      } catch (e) {
        toast(e.message || 'Speichern fehlgeschlagen.', 5000);
      }
    }
  }

  const PLATZHALTER = {
    profinetName: 'NameOfStation, z. B. sps-hydraulik-01',
    ip: '192.168.0.10',
    subnetz: '255.255.255.0',
    mac: '00:1B:1B:AA:BB:CC',
    steuerungsName: 'Name der Steuerung im Schulnetz',
    hardwarestand: 'z. B. A4',
    firmware: 'z. B. 4.5.1',
  };

  const KLASSEN_HINWEIS = {
    profinet: 'In Profinet ist nicht die IP der führende Bezeichner, sondern der Gerätename (NameOfStation). '
      + 'Beim Gerätetausch muss genau er neu vergeben werden.',
    roboter: 'Roboter hängen im normalen Schulnetz — deshalb kein Profinet-Gerätename, aber Hardware- und Firmwarestand.',
    pc: 'Für einen PC genügen Bezeichnung und IP. Der Raum steht am Artikel im Lager.',
  };

  // --- Übersicht: doppelte IP, MAC und Namen --------------------------------
  async function uebersichtZeigen(box) {
    let d;
    try {
      d = await SL.api.netzwerkUebersicht();
    } catch (e) {
      box.innerHTML = '';
      box.appendChild(karte('Übersicht', el('p', { class: 'anmeldung-fehler' }, e.message || '')));
      return;
    }
    box.innerHTML = '';

    const bloecke = [
      ['Doppelte IP-Adressen', d.doppelteIp],
      ['Doppelte MAC-Adressen', d.doppelteMac],
      ['Doppelte Geräte- oder Steuerungsnamen', d.doppelteNamen],
    ];
    const warnungen = el('div');
    let gefunden = 0;
    for (const [titel, treffer] of bloecke) {
      if (!treffer.length) continue;
      gefunden += treffer.length;
      const l = el('div', { class: 'liste' });
      for (const t of treffer) {
        l.appendChild(el('div', { class: 'eintrag' }, [
          el('strong', {}, t.wert),
          el('div', { class: 'muted' }, t.geraete.map(x => `${x.name} (${klasseLabel(x.klasse)})`).join(' · ')),
        ]));
      }
      warnungen.appendChild(karte(titel, l));
    }
    if (!gefunden) {
      warnungen.appendChild(karte('Übersicht', el('p', { class: 'ampel ampel-ok' },
        'Keine doppelten IP- oder MAC-Adressen und keine doppelten Gerätenamen.')));
    } else {
      warnungen.insertBefore(el('p', { class: 'muted' },
        'Gewarnt, nicht verboten: manchmal ist die Dopplung gewollt (Ersatzgerät im Schrank) — '
        + 'und manchmal ist sie genau der Fehler, den man sucht.'), warnungen.firstChild);
    }
    box.appendChild(warnungen);

    // Die belegten Adressen am Stück — die Antwort auf „welche IP ist frei?".
    const belegt = (d.geraete || []).filter(g => g.ip)
      .sort((a, b) => ipSortierbar(a.ip).localeCompare(ipSortierbar(b.ip)));
    if (belegt.length) {
      const l = el('div', { class: 'liste' });
      for (const g of belegt) {
        l.appendChild(el('div', { class: 'eintrag' }, [
          el('div', { class: 'benutzer-kopf' }, [
            el('strong', {}, g.ip),
            el('span', {}, g.artikelName),
            el('span', { class: 'tag' }, klasseLabel(g.klasse)),
          ]),
          (g.profinetName || g.steuerungsName || g.mac)
            ? el('div', { class: 'muted' }, [g.profinetName, g.steuerungsName, g.mac].filter(Boolean).join(' · '))
            : null,
        ]));
      }
      box.appendChild(karte(`Belegte Adressen (${belegt.length})`, l));
    }
  }

  // IPv4 so umschreiben, dass ein Textvergleich die richtige Reihenfolge
  // ergibt: sonst steht .10 vor .9.
  function ipSortierbar(ip) {
    const teile = String(ip || '').split('.');
    if (teile.length !== 4) return String(ip || '');
    return teile.map(t => String(Number(t) || 0).padStart(3, '0')).join('.');
  }

  // --- Hinweis auf die alte Komponentenliste --------------------------------
  async function uebernahmeHinweis() {
    let alt = [];
    try { alt = await SL.api.listKomponenten(); } catch (_) { return el('div'); }
    const offen = alt.filter(k => !k.uebernommenAls);
    if (!offen.length) return el('div');
    return karte('Aus der alten Komponentenliste übernehmen', [
      el('p', {}, `Es liegen noch ${offen.length} Einträge in der alten Struktur — dort steckte ein Gerät `
        + 'unter einem Demonstrator und existierte im Lager nicht.'),
      el('p', { class: 'muted' }, 'Der Assistent zeigt dir vorher Zeile für Zeile, was angelegt würde. '
        + 'Geschrieben wird erst auf deinen Klick; die alten Einträge bleiben stehen.'),
      el('div', { class: 'btn-reihe' }, [
        el('a', { class: 'btn btn-primary', href: '#/netzuebernahme' }, 'Übernahme ansehen'),
      ]),
    ]);
  }

  // --- Karte am Demonstrator ------------------------------------------------
  // Ersetzt die alte Komponentenkarte: hier wird zugeordnet, nicht mehr
  // innerhalb des Demonstrators angelegt.
  async function netzwerkKarte(artikel, neuLaden) {
    const box = el('div');
    const k = karte('Netzwerkgeräte', box, {
      aktion: el('div', { class: 'btn-reihe' }, [
        el('button', {
          class: 'btn btn-sm', type: 'button',
          onclick: () => zuordnenDialog(artikel, neuLaden),
        }, 'Zuordnen'),
        el('button', {
          class: 'btn btn-sm', type: 'button',
          onclick: () => geraetDialog(null, { demonstratorId: artikel.id }, neuLaden),
        }, '+ Neues Gerät'),
      ]),
    });
    box.appendChild(el('p', { class: 'muted' }, 'Wird geladen…'));

    let liste = [];
    try {
      liste = await SL.api.listNetzgeraete({ demonstratorId: artikel.id });
    } catch (e) {
      box.innerHTML = '';
      box.appendChild(el('p', { class: 'anmeldung-fehler' }, e.message || ''));
      return k;
    }

    box.innerHTML = '';
    if (!liste.length) {
      box.appendChild(leer('Diesem Gerät ist noch nichts zugeordnet. „Zuordnen" hängt ein vorhandenes '
        + 'Netzwerkgerät an, „+ Neues Gerät" legt eines an.'));
      return k;
    }
    const l = el('div', { class: 'liste' });
    for (const g of liste) {
      l.appendChild(el('div', { class: 'eintrag' }, [
        el('div', { class: 'benutzer-kopf' }, [
          el('strong', {}, g.artikelName),
          el('span', { class: 'tag' }, klasseLabel(g.klasse)),
        ]),
        el('div', { class: 'lager-barcode' }, [
          g.profinetName ? `Gerätename ${g.profinetName}` : '',
          g.steuerungsName ? `Steuerung ${g.steuerungsName}` : '',
          g.ip ? `IP ${g.ip}` : '',
          g.mac ? `MAC ${g.mac}` : '',
        ].filter(Boolean).join(' · ') || '—'),
        el('div', { class: 'btn-reihe' }, [
          el('button', { class: 'btn btn-sm', type: 'button', onclick: () => geraetDialog(g, {}, neuLaden) }, 'Bearbeiten'),
          el('button', {
            class: 'btn btn-sm', type: 'button',
            title: 'Nur die Zuordnung lösen — das Gerät selbst bleibt im Netzwerk stehen.',
            onclick: async () => {
              try {
                await SL.api.netzgeraetSpeichern(g.id, {
                  demonstratorIds: (g.demonstratorIds || []).filter(x => x !== artikel.id),
                });
                toast('Zuordnung gelöst.');
                neuLaden();
              } catch (e) { toast(e.message || 'Fehlgeschlagen.', 4500); }
            },
          }, 'Lösen'),
        ]),
      ]));
    }
    box.appendChild(l);
    return k;
  }

  // Ein Gerät kann zu mehreren Demonstratoren gehören — der Programmier-PC
  // dient drei Stationen. Deshalb Mehrfachauswahl statt Umhängen.
  async function zuordnenDialog(artikel, neuLaden) {
    let alle = [];
    try {
      alle = await SL.api.listNetzgeraete();
    } catch (e) { toast(e.message || 'Liste nicht abrufbar.', 4500); return; }

    const frei = alle.filter(g => !(g.demonstratorIds || []).includes(artikel.id));
    const gewaehlt = new Set();
    const box = el('div', { class: 'liste' });
    if (!frei.length) {
      box.appendChild(leer('Alle erfassten Netzwerkgeräte sind diesem Gerät bereits zugeordnet.'));
    }
    for (const g of frei) {
      box.appendChild(el('label', { class: 'eintrag wahl-zeile' }, [
        el('input', {
          type: 'checkbox',
          onchange: (e) => { if (e.target.checked) gewaehlt.add(g.id); else gewaehlt.delete(g.id); },
        }),
        el('span', {}, [
          el('strong', {}, g.artikelName),
          el('span', { class: 'muted' }, ` · ${klasseLabel(g.klasse)}${g.ip ? ' · ' + g.ip : ''}`),
          (g.demonstratorIds || []).length
            ? el('div', { class: 'muted' }, `bereits an ${g.demonstratorIds.length} anderen Gerät(en)`)
            : null,
        ]),
      ]));
    }

    const dlg = modal('Netzwerkgeräte zuordnen', [
      el('p', { class: 'muted' }, 'Ein Gerät darf zu mehreren Demonstratoren gehören — der Programmier-PC '
        + 'bedient oft mehrere Stationen.'),
      box,
    ], {
      fuss: [
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
        el('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: async () => {
            if (!gewaehlt.size) { toast('Nichts ausgewählt.'); return; }
            let fehler = 0;
            for (const id of gewaehlt) {
              const g = alle.find(x => x.id === id);
              try {
                await SL.api.netzgeraetSpeichern(id, {
                  demonstratorIds: [...(g.demonstratorIds || []), artikel.id],
                });
              } catch (_) { fehler++; }
            }
            dlg.close();
            toast(fehler
              ? `${gewaehlt.size - fehler} zugeordnet, ${fehler} fehlgeschlagen.`
              : `${gewaehlt.size} zugeordnet.`, fehler ? 5000 : 2200);
            neuLaden();
          },
        }, 'Zuordnen'),
      ],
    });
  }

  // --- Karte am Gerät selbst ------------------------------------------------
  // Dieser Artikel IST ein Netzwerkgerät. Dann beschreiben die Angaben ihn
  // selbst — nicht seine Einbauten. Steht der Satz in der App noch nicht (etwa
  // weil der Tag in Homebox von Hand vergeben wurde), wird er hier angeboten.
  async function netzAngabenKarte(artikel, neuLaden, klasse) {
    let g = null;
    try {
      const liste = await SL.api.listNetzgeraete();
      g = liste.find(x => x.artikelId === artikel.id) || null;
    } catch (e) {
      return karte('Netzangaben', el('p', { class: 'anmeldung-fehler' }, e.message || ''));
    }

    if (!g) {
      return karte('Netzangaben', [
        el('p', {}, `Dieser Artikel trägt den Tag „${klasseLabel(klasse)}", hat aber noch keine Netzangaben.`),
        el('div', { class: 'btn-reihe' }, [
          el('button', {
            class: 'btn btn-primary', type: 'button',
            // Verknüpfen statt neu anlegen: den Artikel gibt es ja schon.
            onclick: () => geraetDialog(null, { klasse, artikel }, neuLaden),
          }, '+ Netzangaben erfassen'),
        ]),
      ]);
    }

    const zeilen = [];
    for (const f of SL.models.netzFelder(g.klasse)) {
      if (f === 'passwort' || f === 'notiz') continue;
      if (!g[f]) continue;
      zeilen.push(el('div', { class: 'daten-zeile' }, [
        el('span', { class: 'muted' }, SL.models.NETZ_FELD_LABEL[f] || f),
        el('span', {}, g[f]),
      ]));
    }
    if (!zeilen.length) zeilen.push(leer('Noch nichts eingetragen.'));

    return karte('Netzangaben', [
      el('div', { class: 'benutzer-kopf' }, [el('span', { class: 'tag' }, klasseLabel(g.klasse))]),
      ...zeilen,
      g.notiz ? el('p', { class: 'muted' }, g.notiz) : null,
      g.passwort ? zugangZeile(g) : null,
      (g.demonstratorIds || []).length
        ? el('p', { class: 'muted' }, `Zugeordnet zu ${g.demonstratorIds.length} Demonstrator(en).`)
        : null,
      el('div', { class: 'btn-reihe' }, [
        el('button', { class: 'btn btn-sm', type: 'button', onclick: () => geraetDialog(g, {}, neuLaden) }, 'Bearbeiten'),
        el('a', { class: 'btn btn-sm', href: '#/netzwerk' }, 'Zur Netzwerkliste'),
      ]),
    ]);
  }

  SL.views.renderNetzwerk = renderNetzwerk;
  SL.views.netzAngabenKarte = netzAngabenKarte;
  SL.views.netzwerkKarte = netzwerkKarte;
  SL.views.netzgeraetDialog = geraetDialog;
})();
