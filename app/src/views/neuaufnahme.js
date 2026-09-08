(function () {
  'use strict';
  window.SL = window.SL || {};
  SL.views = SL.views || {};

  const { el, karte, input, textarea, toast } = SL.ui;

  // Neuen Artikel aufnehmen.
  //
  // Der übliche Weg dorthin ist der Scanner: Barcode gelesen, nichts gefunden,
  // „Neu anlegen" — deshalb kommt der Code als Parameter herein und steht
  // schon im Feld. Der zweite Weg ist der Knopf in der Artikelliste.
  //
  // Bewusst KEINE Online-Produktdatenbank (so entschieden): bei Elektronik-
  // Bauteilen liefert sie ohnehin selten etwas, und der Container bräuchte
  // Internet.
  function renderNeuaufnahme(mount, params = {}) {
    if (!SL.store.darfBuchen()) {
      mount.appendChild(karte('Anmeldung nötig', el('p', { class: 'muted' }, [
        'Zum Anlegen bitte ',
        el('a', { href: '#/anmelden?weiter=' + encodeURIComponent(location.hash) }, 'anmelden'),
        '.',
      ])));
      return;
    }

    const zustand = { ortId: params.ortId || '', ortPfad: '', foto: null };
    // Aus dem Menüpunkt „Geräte" heraus ist die Sorte schon klar.
    // '' = Verbrauchsmaterial, sonst 'demonstrator' oder 'netzgeraet'.
    let art = ['demonstrator', 'netzgeraet'].includes(params.art) ? params.art
      : (params.demo === '1' ? 'demonstrator' : '');

    const name = input({ autocomplete: 'off', placeholder: 'z. B. Widerstand 10 kΩ' });
    const menge = input({ type: 'number', min: '0', value: '1', inputmode: 'numeric' });
    const barcode = input({ value: params.barcode || '', autocapitalize: 'none' });
    const mindest = input({ type: 'number', min: '0', placeholder: 'leer = keine Warnung' });
    const beschreibung = textarea({ rows: 2 });
    const kaufpreis = input({ type: 'number', min: '0', step: '0.01', inputmode: 'decimal', placeholder: 'z. B. 1249.50' });

    // Hersteller mit Vorschlagsliste: die häufigsten aus dem Bestand. Ein
    // freies Feld bleibt es trotzdem — sonst kann man einen neuen Hersteller
    // nicht eintragen.
    const herstellerListeId = 'hersteller-vorschlaege';
    const hersteller = input({ autocomplete: 'off', list: herstellerListeId });
    const herstellerListe = el('datalist', { id: herstellerListeId });
    SL.api.lagerHersteller().then(liste => {
      for (const h of liste.slice(0, 50)) {
        herstellerListe.appendChild(el('option', { value: h.name }));
      }
    }).catch(() => { /* ohne Vorschläge tippt man den Namen eben selbst */ });

    // Welche Sorte wird angelegt? Entscheidet, welchen Homebox-Tag der Artikel
    // bekommt — und damit, ob er ausleihbar ist und Netzangaben tragen kann.
    const st = SL.store.state.settings;
    const artWahl = SL.ui.select([
      { wert: '', label: 'Verbrauchsmaterial (wird entnommen und ausgegeben)' },
      { wert: 'demonstrator', label: `Demonstrator (Tag „${st.demonstratorMarke}", ausleihbar)` },
      { wert: 'netzgeraet', label: `Netzgerät / SPS-Board (Tag „${st.netzgeraetMarke}", ausleihbar)` },
    ], art, (v) => {
      art = v;
      // Geräte sind Einzelstücke: Anzahl und Mindestbestand sind dort sinnlose
      // Fragen und verschwinden.
      const geraet = !!art;
      mengeZeile.hidden = geraet;
      mindestZeile.hidden = geraet;
      netzHinweis.hidden = art !== 'netzgeraet';
    }, { leerLabel: false });

    const netzHinweis = el('p', { class: 'muted' },
      'Nach dem Anlegen öffnet sich gleich die Eingabe für Profinet-Gerätename, IP und Seriennummer.');
    netzHinweis.hidden = art !== 'netzgeraet';

    // Lagerort
    const ortAnzeige = el('span', { class: 'muted' }, 'nicht gewählt');
    const ortKnopf = el('button', {
      class: 'btn', type: 'button',
      onclick: () => SL.ui.ortWaehlen({
        aktuellId: zustand.ortId,
        onWahl: (o) => {
          zustand.ortId = o.id;
          zustand.ortPfad = o.pfad || o.name;
          ortAnzeige.textContent = zustand.ortPfad;
          ortAnzeige.className = '';
        },
      }),
    }, 'Lagerort wählen');

    // Barcode nachträglich scannen — nützlich, wenn man den Artikel von Hand
    // anfängt und das Etikett erst danach in die Hand nimmt.
    const barcodeScan = SL.ui.scannerBereit()
      ? el('button', {
        class: 'btn btn-sm', type: 'button',
        onclick: () => SL.ui.scannen((text) => {
          const { art, wert } = SL.models.codeArt(text);
          if (art === 'ort') { toast('Das ist ein Lagerort-Etikett.', 3500); return; }
          barcode.value = wert;
        }),
      }, '⌷ Scannen')
      : null;

    // Foto
    const fotoAnzeige = el('span', { class: 'muted' }, 'kein Foto');
    const fotoWahl = SL.ui.fotoPickButtons(async (datei) => {
      zustand.foto = await SL.ui.resizeImageFile(datei);
      fotoAnzeige.textContent = zustand.foto.name || 'Foto gewählt';
      fotoAnzeige.className = '';
    });

    const speichern = el('button', { class: 'btn btn-primary', type: 'button' }, 'Anlegen');
    const abbrechen = el('a', { class: 'btn', href: '#/artikel' }, 'Abbrechen');

    speichern.addEventListener('click', async () => {
      if (!name.value.trim()) { toast('Bitte eine Bezeichnung angeben.'); name.focus(); return; }
      speichern.disabled = true;
      speichern.textContent = 'Wird angelegt…';
      try {
        // Der Tag muss existieren, bevor er vergeben werden kann — beim ersten
        // Demonstrator legt ihn der Server in Homebox an.
        let markenIds;
        if (art) {
          const marke = await SL.api.markeAnlegen(
            art === 'netzgeraet' ? st.netzgeraetMarke : st.demonstratorMarke);
          markenIds = [marke.id];
        }

        const a = await SL.api.lagerAnlegen({
          name: name.value.trim(),
          // Ein Demonstrator ist ein Einzelstück; die Mengenfrage stellt sich
          // dort nicht und das Feld ist ausgeblendet.
          menge: art ? 1 : Math.max(0, parseInt(menge.value, 10) || 0),
          ortId: zustand.ortId || undefined,
          barcode: barcode.value.trim() || undefined,
          mindestbestand: (art || mindest.value === '') ? undefined : Math.max(0, parseInt(mindest.value, 10) || 0),
          beschreibung: beschreibung.value || undefined,
          hersteller: hersteller.value.trim() || undefined,
          kaufpreis: kaufpreis.value === '' ? undefined : Number(kaufpreis.value),
          markenIds,
        });

        // Das Foto kommt NACH dem Anlegen — es braucht die Artikel-ID. Geht es
        // schief, bleibt der Artikel trotzdem bestehen: ihn deswegen wieder zu
        // löschen wäre schlimmer als ein fehlendes Bild.
        let fotoFehler = '';
        if (zustand.foto) {
          try {
            await SL.api.lagerFoto(a.id, zustand.foto);
          } catch (e) {
            fotoFehler = e.message || 'unbekannter Fehler';
          }
        }
        // Der Ortsbaum zeigt Stückzahlen je Ort — die stimmen jetzt nicht mehr.
        SL.store.orteVergessen();
        // EINE Meldung, und zwar die wahre. Zwei Aufrufe hintereinander gehen
        // nicht: der zweite überschreibt den ersten, und der Nutzer erführe nie,
        // dass sein Foto fehlt.
        toast(fotoFehler
          ? `Artikel angelegt — aber das Foto ging nicht durch: ${fotoFehler}`
          : 'Artikel angelegt.', fotoFehler ? 6000 : 2200);
        // Bei einem Netzgerät fehlt jetzt genau das, wofür man es angelegt hat:
        // die Netzangaben. Also gleich dorthin, statt sie im Detail suchen zu
        // lassen.
        location.hash = `#/artikel?id=${encodeURIComponent(a.id)}`
          + (art === 'netzgeraet' ? '&netz=1' : '');
      } catch (e) {
        toast(e.message || 'Das Anlegen hat nicht geklappt.', 5000);
        speichern.disabled = false;
        speichern.textContent = 'Anlegen';
      }
    });

    mount.appendChild(el('div', { class: 'toolbar' }, [
      el('h1', {}, art === 'netzgeraet' ? 'Netzgerät aufnehmen'
        : art === 'demonstrator' ? 'Demonstrator aufnehmen' : 'Artikel aufnehmen'),
    ]));

    const mengeZeile = feld('Anzahl', menge);
    const mindestZeile = feld('Mindestbestand', mindest);
    mengeZeile.hidden = !!art;
    mindestZeile.hidden = !!art;

    mount.appendChild(karte(null, [
      params.barcode
        ? el('p', { class: 'muted' }, `Gescannter Barcode ${params.barcode} ist übernommen.`)
        : null,
      feld('Art', artWahl),
      netzHinweis,
      feld('Bezeichnung', name),
      mengeZeile,
      feld('Lagerort', el('div', { class: 'wahl-zeile' }, [ortKnopf, ortAnzeige])),
      feld('Barcode', el('div', { class: 'wahl-zeile' }, [barcode, barcodeScan])),
      mindestZeile,
      feld('Hersteller', hersteller),
      herstellerListe,
      feld('Anschaffungskosten (€)', kaufpreis),
      feld('Beschreibung', beschreibung),
      feld('Foto', el('div', { class: 'wahl-zeile' }, [fotoWahl, fotoAnzeige])),
      el('div', { class: 'btn-reihe' }, [speichern, abbrechen]),
    ]));

    setTimeout(() => name.focus(), 50);
  }

  function feld(label, control) {
    return el('label', { class: 'feld feld-breit' }, [
      el('span', { class: 'feld-label' }, label),
      control,
    ]);
  }

  SL.views.renderNeuaufnahme = renderNeuaufnahme;
})();
