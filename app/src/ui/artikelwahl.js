(function () {
  'use strict';
  window.SL = window.SL || {};
  const { el, input, toast } = SL.ui;

  // Artikel auswählen — gebraucht überall dort, wo ein Vorgang bei einem
  // Gegenstand anfängt statt bei einer Liste: Ausleihen von der Ausleihseite
  // aus, später die Inventur.
  //
  // Zwei Wege, wie beim Lagerort: scannen (man hält das Gerät in der Hand)
  // oder suchen (man sitzt am Rechner). Gegenstück zu SL.ui.ortWaehlen.
  function artikelWaehlen({ titel = 'Artikel wählen', onWahl }) {
    const suchfeld = input({ placeholder: 'Bezeichnung oder Barcode…', autocomplete: 'off' });
    const liste = el('div', { class: 'ortwahl-liste' },
      el('p', { class: 'muted' }, 'Bezeichnung eingeben oder Etikett scannen.'));

    const scanKnopf = SL.ui.scannerBereit()
      ? el('button', {
        class: 'btn', type: 'button',
        onclick: () => SL.ui.scannen(async (text) => {
          const { art, wert } = SL.models.codeArt(text);
          if (art === 'ort') { toast('Das ist ein Lagerort-Etikett.', 3500); return; }
          try {
            const a = art === 'homeboxId' ? await SL.api.lagerArtikel(wert)
              : art === 'artikel' ? await SL.api.lagerBeiCode(wert)
                : await SL.api.lagerBeiBarcode(wert);
            fertig(a);
          } catch (e) {
            toast(e && e.status === 404 ? 'Zu diesem Code ist kein Artikel hinterlegt.' : (e.message || 'Fehler'), 4000);
          }
        }),
      }, '⌷ Scannen')
      : null;

    const dlg = SL.ui.modal(titel, [
      el('div', { class: 'btn-reihe' }, [scanKnopf]),
      suchfeld,
      liste,
    ], {
      fuss: [
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
      ],
    });

    function fertig(artikel) {
      dlg.close();
      onWahl(artikel);
    }

    // Gleiche Entprellung wie in der Artikelsuche: jede Taste eine Anfrage an
    // Homebox wäre am Handy zäh.
    let timer = null;
    suchfeld.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(suchen, 300);
    });
    suchfeld.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      clearTimeout(timer);
      suchen();
    });

    async function suchen() {
      const q = suchfeld.value.trim();
      liste.innerHTML = '';
      if (!q) {
        liste.appendChild(el('p', { class: 'muted' }, 'Bezeichnung eingeben oder Etikett scannen.'));
        return;
      }
      liste.appendChild(el('p', { class: 'muted' }, 'Suche…'));
      try {
        const erg = await SL.api.lagerSuchen({ q, seite: 1, proSeite: 25 });
        liste.innerHTML = '';
        if (!erg.artikel.length) {
          liste.appendChild(el('p', { class: 'muted' }, `Nichts gefunden zu „${q}".`));
          return;
        }
        for (const a of erg.artikel) {
          liste.appendChild(el('button', {
            class: 'ortwahl-eintrag', type: 'button',
            onclick: () => fertig(a),
          }, [
            el('span', { class: 'ortwahl-pfad' }, [
              el('strong', {}, a.name || '(ohne Namen)'),
              el('span', { class: 'muted' }, a.ortName ? ' · ' + a.ortName : ''),
            ]),
            el('span', { class: 'tag' }, `${a.menge} Stück`),
          ]));
        }
        if (erg.gesamt > erg.artikel.length) {
          liste.appendChild(el('p', { class: 'muted' }, `${erg.artikel.length} von ${erg.gesamt} — bitte genauer suchen.`));
        }
      } catch (e) {
        liste.innerHTML = '';
        liste.appendChild(el('p', { class: 'anmeldung-fehler' }, e.message || 'Die Suche hat nicht geklappt.'));
      }
    }

    setTimeout(() => suchfeld.focus(), 50);
    return dlg;
  }

  SL.ui.artikelWaehlen = artikelWaehlen;
})();
