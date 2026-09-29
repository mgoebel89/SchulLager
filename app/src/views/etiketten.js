(function () {
  'use strict';
  window.SL = window.SL || {};
  SL.views = SL.views || {};

  const { el, karte, input, select, toast } = SL.ui;

  // Etiketten (Phase 3).
  //
  // Diese Seite DRUCKT NICHT. Sie stellt eine CSV-Datei zusammen, die eine
  // P-touch-Editor-Vorlage als Datenbank einbindet; gedruckt wird am PC aus
  // P-touch (so entschieden, 2026-09-28).
  //
  // Aufbau:
  //   Reiter      Artikel | Lagerorte — zwei Vorlagen, zwei Dateien
  //   Merkliste   was Kollegen am Artikel/Ort/Wareneingang vorgemerkt haben;
  //               steht automatisch angehakt, bis es exportiert ist
  //   Filter      Suche, Lagerort (samt Unterorten), Tag, „noch nie gedruckt"
  //   Liste       Checkboxen; die Auswahl überlebt Filterwechsel
  //   Fuß         Anzahl + „CSV herunterladen"
  //
  // „Gedruckt" heißt hier ehrlich „exportiert" — ob P-touch wirklich gedruckt
  // hat, kann die App nicht wissen. Deshalb gibt es den Filter „heute
  // exportiert": damit ist ein missglückter Druck schnell wiederholt.

  async function renderEtiketten(mount, params = {}) {
    const typ = params.typ === 'ort' ? 'ort' : 'artikel';

    mount.appendChild(el('div', { class: 'toolbar' }, [el('h1', {}, 'Etiketten')]));
    mount.appendChild(el('div', { class: 'reiter' }, [
      reiterKnopf('Artikel', typ === 'artikel', '#/etiketten'),
      reiterKnopf('Lagerorte', typ === 'ort', '#/etiketten?typ=ort'),
    ]));

    if (!SL.store.darfBuchen()) {
      mount.appendChild(karte(null, el('p', { class: 'muted' }, 'Etiketten bitte nach der Anmeldung zusammenstellen.')));
      return;
    }

    const s = SL.store.state.settings;
    if (!String(s.etikettAdresse || '').trim()) {
      mount.appendChild(karte(null, [
        el('p', { class: 'anmeldung-fehler' }, 'Die Adresse für den QR-Code ist noch nicht eingetragen.'),
        el('p', { class: 'muted' }, 'Sie wird auf jedes Etikett gedruckt und lässt sich danach nicht mehr ändern. '
          + (SL.store.istAdmin() ? '' : 'Bitte einen Administrator, sie einzutragen.')),
        SL.store.istAdmin()
          ? el('div', { class: 'btn-reihe' }, [el('a', { class: 'btn btn-primary', href: '#/einstellungen?kat=etiketten' }, 'Zu den Einstellungen')])
          : null,
      ]));
    }

    const behaelter = el('div');
    mount.appendChild(behaelter);
    behaelter.appendChild(karte(null, el('p', { class: 'muted' }, 'Wird geladen…')));

    // --- Zustand ---
    // `gewaehlt` hält id → Anzeigename. Die Auswahl überlebt Filterwechsel —
    // wer erst Schrank 3, dann Schrank 4 anhakt, will beide exportieren.
    const zustand = {
      typ,
      q: params.q || '',
      ortId: params.ortId || '',
      markeId: params.markeId || '',
      sicht: params.sicht || 'alle',        // alle | nie | heute
      gewaehlt: new Map(),
      status: new Map(),                     // id → Eintrag aus /api/etiketten
      treffer: [],
      unvollstaendig: false,
    };

    let orte = [];
    let marken = [];
    try {
      [orte, marken] = await Promise.all([
        SL.store.orteLaden(),
        typ === 'artikel' ? SL.api.lagerMarken().catch(() => []) : Promise.resolve([]),
      ]);
      await statusLaden();
    } catch (e) {
      behaelter.innerHTML = '';
      behaelter.appendChild(SL.views.artikelFehlerKarte(e, () => SL.app.router()));
      return;
    }

    // Interne Tags gehören nicht in den Filter — sie stehen auch nicht auf dem Etikett.
    const intern = new Set(['demonstratorMarke', 'netzgeraetMarke', 'profinetMarke', 'roboterMarke', 'pcMarke']
      .map(k => String(s[k] || '').trim().toLowerCase()));
    marken = marken.filter(m => !intern.has(String(m.name || '').trim().toLowerCase()))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'de'));

    // Vorgemerktes steht von Anfang an angehakt.
    for (const e of zustand.status.values()) {
      if (e.vorgemerkt && (e.typ || 'artikel') === typ) zustand.gewaehlt.set(e.id, e.name || '(ohne Namen)');
    }

    async function statusLaden() {
      const liste = await SL.api.listEtiketten();
      zustand.status = new Map((liste || []).map(e => [e.id, e]));
    }

    // --- Bausteine ---
    const merkBox = el('div');
    const listenBox = el('div');
    const fussAnzahl = el('strong');
    const exportKnopf = el('button', { class: 'btn btn-primary', type: 'button', onclick: () => exportieren() }, 'CSV herunterladen');
    const fuss = el('div', { class: 'etikett-fuss' }, [
      fussAnzahl, el('span', { class: 'spacer' }),
      el('button', { class: 'btn btn-sm', type: 'button', onclick: () => { zustand.gewaehlt.clear(); zeichnen(); } }, 'Auswahl leeren'),
      exportKnopf,
    ]);

    const suchfeld = input({ placeholder: typ === 'ort' ? 'Lagerort suchen…' : 'Bezeichnung suchen…', value: zustand.q, autocomplete: 'off' });
    let suchTimer = null;
    suchfeld.addEventListener('input', () => {
      clearTimeout(suchTimer);
      // Artikel kommen vom Server (teuer), Orte liegen schon vor.
      suchTimer = setTimeout(() => { zustand.q = suchfeld.value.trim(); neuLaden(); }, typ === 'ort' ? 120 : 450);
    });

    const ortKnopf = el('button', { class: 'btn', type: 'button' });
    function ortKnopfBeschriften() {
      ortKnopf.textContent = zustand.ortId
        ? '📍 ' + (SL.models.ortPfad(orte, zustand.ortId) || 'Lagerort')
        : '📍 Alle Lagerorte';
    }
    ortKnopfBeschriften();
    ortKnopf.addEventListener('click', () => SL.ui.ortWaehlen({
      titel: 'Nur diesen Lagerort (mit Unterorten)',
      aktuellId: zustand.ortId,
      onWahl: (o) => { zustand.ortId = o ? o.id : ''; ortKnopfBeschriften(); neuLaden(); },
    }));
    const ortWeg = el('button', {
      class: 'btn btn-sm', type: 'button', title: 'Lagerortfilter aufheben',
      onclick: () => { zustand.ortId = ''; ortKnopfBeschriften(); neuLaden(); },
    }, '✕');

    const markeWahl = typ === 'artikel'
      ? select(marken.map(m => ({ wert: m.id, label: m.name })), zustand.markeId,
        v => { zustand.markeId = v; neuLaden(); }, { leerLabel: 'Alle Tags' })
      : null;

    const sichtWahl = select([
      { wert: 'alle', label: 'Alle' },
      { wert: 'nie', label: 'Noch nie gedruckt' },
      { wert: 'heute', label: 'Heute exportiert' },
    ], zustand.sicht, v => { zustand.sicht = v || 'alle'; adresseMerken(); zeichnen(); }, { leerLabel: false });

    behaelter.innerHTML = '';
    behaelter.appendChild(merkBox);
    behaelter.appendChild(karte(null, [
      el('div', { class: 'filterbar etikett-filter' }, [suchfeld, ortKnopf, ortWeg, markeWahl, sichtWahl]),
      listenBox,
    ]));
    behaelter.appendChild(fuss);

    // Die Filter in die Adresse schreiben — „‹ Zurück" aus einem Artikel soll
    // wieder hier landen und nicht auf der leeren Liste.
    function adresseMerken() {
      const p = new URLSearchParams();
      if (typ === 'ort') p.set('typ', 'ort');
      if (zustand.q) p.set('q', zustand.q);
      if (zustand.ortId) p.set('ortId', zustand.ortId);
      if (zustand.markeId) p.set('markeId', zustand.markeId);
      if (zustand.sicht !== 'alle') p.set('sicht', zustand.sicht);
      SL.app.adresseErsetzen('#/etiketten' + (p.toString() ? '?' + p.toString() : ''));
    }

    // --- Laden ---
    let ladeNr = 0;
    async function neuLaden() {
      adresseMerken();
      ortWeg.hidden = !zustand.ortId;
      const nr = ++ladeNr;
      if (typ === 'ort') {
        zustand.treffer = orteFiltern();
        zustand.unvollstaendig = false;
        zeichnen();
        return;
      }
      listenBox.innerHTML = '';
      listenBox.appendChild(el('p', { class: 'muted' }, 'Artikel werden geladen — bei vielen Artikeln einen Moment…'));
      try {
        const erg = await SL.api.etikettenArtikel({ q: zustand.q, ortId: zustand.ortId, markeId: zustand.markeId });
        if (nr !== ladeNr) return;     // eine neuere Anfrage läuft schon
        zustand.treffer = erg.artikel.map(a => ({
          id: a.id,
          name: a.name || '(ohne Namen)',
          zusatz: [a.hersteller, SL.models.ortPfad(orte, a.ortId) || a.ortName].filter(Boolean).join(' · '),
          marken: (a.marken || []).map(m => m.name).filter(n => !intern.has(String(n).trim().toLowerCase())),
          ohneAsset: !a.assetId,
        }));
        zustand.unvollstaendig = !!erg.unvollstaendig;
      } catch (e) {
        if (nr !== ladeNr) return;
        listenBox.innerHTML = '';
        listenBox.appendChild(el('p', { class: 'anmeldung-fehler' }, e.message || 'Artikel konnten nicht geladen werden.'));
        return;
      }
      zeichnen();
    }

    function orteFiltern() {
      let liste = orte;
      if (zustand.ortId) {
        const teil = new Set([zustand.ortId]);
        let gewachsen = true;
        while (gewachsen) {
          gewachsen = false;
          for (const o of orte) {
            if (o.elternId && teil.has(o.elternId) && !teil.has(o.id)) { teil.add(o.id); gewachsen = true; }
          }
        }
        liste = liste.filter(o => teil.has(o.id));
      }
      const q = zustand.q.toLowerCase();
      return liste
        .map(o => ({ id: o.id, name: o.name || '(ohne Namen)', zusatz: SL.models.ortPfad(orte, o.id), marken: [], ohneAsset: !o.assetId }))
        .filter(o => !q || o.zusatz.toLowerCase().includes(q))
        .sort((a, b) => a.zusatz.localeCompare(b.zusatz, 'de'));
    }

    // --- Zeichnen ---
    function sichtbar() {
      const heute = SL.models.heuteIso();
      return zustand.treffer.filter(t => {
        const st = zustand.status.get(t.id);
        if (zustand.sicht === 'nie') return !(st && st.gedrucktAm);
        if (zustand.sicht === 'heute') return !!(st && st.gedrucktAm && SL.models.dateToIso(new Date(st.gedrucktAm)) === heute);
        return true;
      });
    }

    function zeichnen() {
      merkZeichnen();
      listenBox.innerHTML = '';
      const liste = sichtbar();

      if (!liste.length) {
        listenBox.appendChild(el('p', { class: 'muted' }, zustand.treffer.length
          ? 'Mit diesem Filter bleibt nichts übrig.'
          : (typ === 'ort' ? 'Keine Lagerorte gefunden.' : 'Keine Artikel gefunden.')));
      } else {
        const alleAn = liste.every(t => zustand.gewaehlt.has(t.id));
        const kopfChk = el('input', {
          type: 'checkbox', class: 'chk', checked: alleAn,
          onchange: (e) => {
            for (const t of liste) {
              if (e.target.checked) zustand.gewaehlt.set(t.id, t.name); else zustand.gewaehlt.delete(t.id);
            }
            zeichnen();
          },
        });
        listenBox.appendChild(el('label', { class: 'etikett-zeile etikett-kopf' }, [
          kopfChk,
          el('span', {}, `Alle ${liste.length} angezeigten ${alleAn ? 'abwählen' : 'auswählen'}`),
        ]));
        const box = el('div', { class: 'liste' });
        for (const t of liste) box.appendChild(zeile(t));
        listenBox.appendChild(box);
      }
      if (zustand.unvollstaendig) {
        listenBox.appendChild(el('p', { class: 'anmeldung-fehler' },
          'Der Bestand ist größer als der durchsuchte Ausschnitt — bitte über Lagerort oder Suche eingrenzen.'));
      }
      fussZeichnen();
    }

    function zeile(t) {
      const st = zustand.status.get(t.id);
      const chk = el('input', {
        type: 'checkbox', class: 'chk', checked: zustand.gewaehlt.has(t.id),
        onchange: (e) => {
          if (e.target.checked) zustand.gewaehlt.set(t.id, t.name); else zustand.gewaehlt.delete(t.id);
          // Nur Fuß und Kopf-Häkchen neu — ein Neuaufbau der Liste risse die
          // Scrollposition weg, gerade wenn man eine lange Liste abhakt.
          fussZeichnen();
          merkZeichnen();
        },
      });
      const gedruckt = st && st.gedrucktAm
        ? `zuletzt gedruckt ${new Date(st.gedrucktAm).toLocaleDateString('de-DE')}`
        : 'noch nie gedruckt';
      return el('label', { class: 'etikett-zeile' }, [
        chk,
        el('div', { class: 'etikett-text' }, [
          el('div', { class: 'eintrag-kopf' }, [
            el('strong', {}, t.name),
            st && st.vorgemerkt ? el('span', { class: 'tag' }, 'vorgemerkt') : null,
            ...t.marken.map(m => el('span', { class: 'tag' }, m)),
          ]),
          el('div', { class: 'muted' }, [t.zusatz, gedruckt].filter(Boolean).join(' · ')),
        ]),
      ]);
    }

    function merkZeichnen() {
      merkBox.innerHTML = '';
      const vorgemerkt = [...zustand.status.values()]
        .filter(e => e.vorgemerkt && (e.typ || 'artikel') === typ)
        .sort((a, b) => String(a.name).localeCompare(String(b.name), 'de'));
      if (!vorgemerkt.length) return;
      const chips = el('div', { class: 'chips' }, vorgemerkt.map(e => el('span', { class: 'chip' + (zustand.gewaehlt.has(e.id) ? ' chip-aktiv' : '') }, [
        e.name || '(ohne Namen)',
        el('button', {
          class: 'chip-x', type: 'button', title: 'Von der Merkliste nehmen',
          onclick: async () => {
            try {
              await SL.api.etikettEntmerken(e.id);
              zustand.status.set(e.id, { ...e, vorgemerkt: false });
              zustand.gewaehlt.delete(e.id);
              zeichnen();
            } catch (err) { toast(err.message || 'Fehler', 3500); }
          },
        }, '×'),
      ])));
      merkBox.appendChild(karte(`Merkliste (${vorgemerkt.length})`, [
        el('p', { class: 'muted' }, 'Von Kollegen vorgemerkt. Steht angehakt und verschwindet nach dem Export von selbst.'),
        chips,
      ]));
    }

    function fussZeichnen() {
      const n = zustand.gewaehlt.size;
      fussAnzahl.textContent = n === 1 ? '1 Etikett ausgewählt' : `${n} Etiketten ausgewählt`;
      exportKnopf.disabled = !n;
      // Kopf-Häkchen nachziehen, ohne die Liste neu zu bauen.
      const kopf = listenBox.querySelector('.etikett-kopf input');
      if (kopf) {
        const liste = sichtbar();
        const alleAn = liste.length && liste.every(t => zustand.gewaehlt.has(t.id));
        kopf.checked = !!alleAn;
        kopf.nextSibling.textContent = `Alle ${liste.length} angezeigten ${alleAn ? 'abwählen' : 'auswählen'}`;
      }
    }

    // --- Export ---
    async function exportieren() {
      const ids = [...zustand.gewaehlt.keys()];
      if (!ids.length) return;
      exportKnopf.disabled = true;
      exportKnopf.textContent = 'Wird erstellt…';
      try {
        const erg = await SL.api.etikettenExport(typ, ids);
        const bytes = Uint8Array.from(atob(erg.inhalt), c => c.charCodeAt(0));
        const name = `${typ === 'ort' ? 'lagerort-etiketten' : 'etiketten'}-${SL.models.heuteIso()}.csv`;
        SL.ui.downloadFile(name, new Blob([bytes], { type: 'text/csv' }));

        zustand.gewaehlt.clear();
        await statusLaden();
        zeichnen();
        if (typ === 'ort') {
          // Nachgezogene Asset-IDs stehen jetzt an den Orten — Baum neu holen.
          SL.store.orteVergessen();
          orte = await SL.store.orteLaden().catch(() => orte);
          zustand.treffer = orteFiltern();
          zeichnen();
        }
        // EINE Meldung je Vorgang, und zwar die wahre: Anmerkungen gehen vor.
        if (erg.nachgezogen || (erg.anmerkungen || []).length) {
          ergebnisDialog(erg, name);
        } else {
          toast(`${erg.anzahl} ${erg.anzahl === 1 ? 'Etikett' : 'Etiketten'} in ${name}.`, 3500);
        }
      } catch (e) {
        toast(e.message || 'Export fehlgeschlagen.', 5000);
      } finally {
        exportKnopf.textContent = 'CSV herunterladen';
        fussZeichnen();
      }
    }

    function ergebnisDialog(erg, name) {
      const m = SL.ui.modal('CSV erstellt', [
        el('p', {}, `${erg.anzahl} ${erg.anzahl === 1 ? 'Etikett' : 'Etiketten'} in ${name}.`),
        erg.nachgezogen
          ? el('p', { class: 'muted' }, `Homebox hat ${erg.nachgezogen === 1 ? 'eine fehlende Asset-ID' : `${erg.nachgezogen} fehlende Asset-IDs`} vergeben `
            + '(an alle Einträge ohne Nummer, nicht nur an die gewählten).')
          : null,
        ...(erg.anmerkungen || []).map(t => el('p', { class: 'anmeldung-fehler' }, t)),
      ], {
        fuss: [el('span', { class: 'spacer' }), el('button', { class: 'btn btn-primary', type: 'button', onclick: () => m.close() }, 'OK')],
      });
    }

    await neuLaden();
  }

  function reiterKnopf(label, aktiv, href) {
    return el('a', { class: 'reiter-btn' + (aktiv ? ' aktiv' : ''), href }, label);
  }

  // Vormerken von außen (Artikelseite, Lagerort, Wareneingang). Ein Knopf,
  // der seinen Zustand selbst kennt, damit man nicht doppelt vormerkt.
  //
  // `opts.vorgemerkt` (true/false) setzt den Zustand vorab — wer viele Knöpfe
  // auf einmal zeigt (Einlagern), fragt die Merkliste EINMAL statt je Zeile.
  function vormerkKnopf({ id, typ = 'artikel', name = '' }, opts = {}) {
    if (!SL.store.darfBuchen() || !id) return null;
    const knopf = el('button', { class: 'btn' + (opts.klein ? ' btn-sm' : ''), type: 'button' }, '🏷 Etikett vormerken');
    let vorgemerkt = !!opts.vorgemerkt;
    const beschriften = () => {
      knopf.textContent = vorgemerkt ? '🏷 Vorgemerkt ✓' : '🏷 Etikett vormerken';
      knopf.title = vorgemerkt ? 'Steht auf der Merkliste — Klick nimmt es wieder herunter' : 'Auf die gemeinsame Merkliste für den nächsten Etikettendruck';
    };
    beschriften();
    if (opts.vorgemerkt === undefined) {
      SL.api.listEtiketten().then(liste => {
        vorgemerkt = !!(liste || []).find(e => e.id === id && e.vorgemerkt);
        beschriften();
      }).catch(() => {});
    }
    knopf.addEventListener('click', async (ev) => {
      // Steht der Knopf in einem <label> (Einlagern), würde der Klick sonst
      // auch dessen Häkchen umschalten.
      ev.preventDefault();
      try {
        if (vorgemerkt) { await SL.api.etikettEntmerken(id); vorgemerkt = false; toast('Von der Merkliste genommen.'); }
        else { await SL.api.etikettVormerken([{ id, typ, name }]); vorgemerkt = true; toast('Für den Etikettendruck vorgemerkt.'); }
        beschriften();
      } catch (e) { toast(e.message || 'Fehler', 3500); }
    });
    return knopf;
  }

  SL.views.renderEtiketten = renderEtiketten;
  SL.ui.vormerkKnopf = vormerkKnopf;
})();
