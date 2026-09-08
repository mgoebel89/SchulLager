(function () {
  'use strict';
  window.SL = window.SL || {};
  const { el, input, toast } = SL.ui;

  // Lagerort auswählen — gebraucht beim Umlagern und beim Anlegen.
  //
  // Drei Wege, weil im Lager drei Situationen vorkommen:
  //   scannen   man steht vor dem Fach und hält das Orts-Etikett hin
  //   suchen    man kennt den Namen ("Fach B")
  //   blättern  man weiß nur ungefähr, wo es hingehört
  //
  // Angezeigt wird immer der VOLLE Pfad. Ein Ort namens „Fach B" gibt es in
  // jedem zweiten Schrank; ohne „Raum 214 › Schrank 3 › " ist die Auswahl
  // Glückssache.

  function ortWaehlen({ titel = 'Lagerort wählen', aktuellId = '', onWahl }) {
    const suchfeld = input({ placeholder: 'Lagerort suchen…', autocomplete: 'off' });
    const liste = el('div', { class: 'ortwahl-liste' }, el('p', { class: 'muted' }, 'Wird geladen…'));

    const scanKnopf = SL.ui.scannerBereit()
      ? el('button', {
        class: 'btn', type: 'button',
        onclick: () => SL.ui.scannen(async (text) => {
          const { art, wert } = SL.models.codeArt(text);
          if (art !== 'ort') { toast('Das ist kein Lagerort-Etikett.', 3500); return; }
          const orte = await SL.store.orteLaden().catch(() => []);
          const o = orte.find(x => String(x.code || '').toUpperCase() === wert);
          if (!o) { toast('Kein Lagerort mit dieser Kennung.', 3500); return; }
          fertig(o);
        }),
      }, '⌷ Ort scannen')
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

    function fertig(ort) {
      dlg.close();
      onWahl(ort);
    }

    let alle = [];
    SL.store.orteLaden().then(orte => {
      alle = orte;
      zeichnen();
    }).catch(e => {
      liste.innerHTML = '';
      liste.appendChild(el('p', { class: 'anmeldung-fehler' }, e.message || 'Lagerorte nicht abrufbar.'));
    });

    function zeichnen() {
      const filter = suchfeld.value.trim().toLowerCase();
      liste.innerHTML = '';
      if (!alle.length) {
        liste.appendChild(el('p', { class: 'muted' }, 'Es sind keine Lagerorte angelegt. Sie werden in Homebox gepflegt.'));
        return;
      }
      // Nach vollem Pfad filtern, nicht nur nach dem eigenen Namen: so findet
      // „schrank 3" auch die Fächer darin.
      const mitPfad = alle
        .map(o => ({ ...o, pfad: SL.models.ortPfad(alle, o.id) }))
        .filter(o => !filter || o.pfad.toLowerCase().includes(filter))
        .sort((a, b) => a.pfad.localeCompare(b.pfad, 'de'));

      if (!mitPfad.length) {
        liste.appendChild(el('p', { class: 'muted' }, 'Kein Lagerort passt dazu.'));
        return;
      }
      for (const o of mitPfad.slice(0, 200)) {
        liste.appendChild(el('button', {
          class: 'ortwahl-eintrag' + (o.id === aktuellId ? ' ortwahl-aktuell' : ''),
          type: 'button',
          onclick: () => fertig(o),
        }, [
          el('span', { class: 'ortwahl-pfad' }, o.pfad || o.name),
          o.id === aktuellId ? el('span', { class: 'tag' }, 'aktuell') : null,
        ]));
      }
      if (mitPfad.length > 200) {
        liste.appendChild(el('p', { class: 'muted' }, `${mitPfad.length} Treffer — bitte genauer suchen.`));
      }
    }

    suchfeld.addEventListener('input', zeichnen);
    setTimeout(() => suchfeld.focus(), 50);
    return dlg;
  }

  SL.ui.ortWaehlen = ortWaehlen;
})();
