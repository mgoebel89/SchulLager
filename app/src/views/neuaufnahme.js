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
    // Aus dem Menüpunkt „Demonstratoren" heraus ist die Sorte schon klar.
    let istDemo = params.demo === '1';

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

    // Demonstrator oder Verbrauchsmaterial? Entscheidet, ob der Artikel den
    // Homebox-Tag bekommt — und damit, ob er später ausleihbar ist.
    const markeName = SL.store.state.settings.demonstratorMarke || 'Demonstrator';
    const demoBox = el('input', {
      type: 'checkbox', class: 'chk', checked: istDemo,
      // Ein Demonstrator ist ein Einzelstück: Anzahl und Mindestbestand sind
      // dort sinnlose Fragen und verschwinden.
      onchange: (e) => {
        istDemo = e.target.checked;
        mengeZeile.hidden = istDemo;
        mindestZeile.hidden = istDemo;
      },
    });

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
        if (istDemo) {
          const marke = await SL.api.markeAnlegen(markeName);
          markenIds = [marke.id];
        }

        const a = await SL.api.lagerAnlegen({
          name: name.value.trim(),
          // Ein Demonstrator ist ein Einzelstück; die Mengenfrage stellt sich
          // dort nicht und das Feld ist ausgeblendet.
          menge: istDemo ? 1 : Math.max(0, parseInt(menge.value, 10) || 0),
          ortId: zustand.ortId || undefined,
          barcode: barcode.value.trim() || undefined,
          mindestbestand: (istDemo || mindest.value === '') ? undefined : Math.max(0, parseInt(mindest.value, 10) || 0),
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
        location.hash = `#/artikel?id=${encodeURIComponent(a.id)}`;
      } catch (e) {
        toast(e.message || 'Das Anlegen hat nicht geklappt.', 5000);
        speichern.disabled = false;
        speichern.textContent = 'Anlegen';
      }
    });

    mount.appendChild(el('div', { class: 'toolbar' }, [
      el('h1', {}, istDemo ? 'Demonstrator aufnehmen' : 'Artikel aufnehmen'),
    ]));

    const mengeZeile = feld('Anzahl', menge);
    const mindestZeile = feld('Mindestbestand', mindest);
    mengeZeile.hidden = istDemo;
    mindestZeile.hidden = istDemo;

    mount.appendChild(karte(null, [
      params.barcode
        ? el('p', { class: 'muted' }, `Gescannter Barcode ${params.barcode} ist übernommen.`)
        : null,
      el('label', { class: 'feld feld-breit' }, [
        el('span', { class: 'feld-label' }, 'Art'),
        el('span', {}, [demoBox, ` Schuldemonstrator (Tag „${markeName}", ausleihbar)`]),
      ]),
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
