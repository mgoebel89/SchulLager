(function () {
  'use strict';
  window.SL = window.SL || {};
  SL.views = SL.views || {};

  const { el, karte, input } = SL.ui;

  // Lagerorte als aufklappbarer Baum (Raum → Schrank → Fach) und, wenn einer
  // gewählt ist, sein Inhalt.
  //
  // Welche Äste offen sind, überlebt das Neuzeichnen — sonst klappt der Baum
  // bei jedem Klick zusammen und man sucht sich dumm.
  const offen = new Set();

  async function renderOrte(mount, params = {}) {
    mount.appendChild(el('div', { class: 'toolbar' }, [
      el('h1', {}, 'Lagerorte'),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'btn btn-sm', type: 'button',
        title: 'Lagerorte neu von Homebox holen',
        onclick: async () => { SL.store.orteVergessen(); SL.app.router(); },
      }, '↻ Aktualisieren'),
    ]));

    const behaelter = el('div');
    mount.appendChild(behaelter);
    behaelter.appendChild(el('p', { class: 'muted' }, 'Wird geladen…'));

    let orte = [];
    try {
      orte = await SL.store.orteLaden();
    } catch (e) {
      behaelter.innerHTML = '';
      behaelter.appendChild(SL.views.artikelFehlerKarte(e, () => { SL.store.orteVergessen(); SL.app.router(); }));
      return;
    }

    behaelter.innerHTML = '';

    if (!orte.length) {
      behaelter.appendChild(karte(null, el('p', { class: 'muted' },
        'In diesem Bestand sind noch keine Lagerorte angelegt. Sie werden in Homebox gepflegt.')));
      return;
    }

    // Ist ein Ort gewählt, gehören alle seine Vorfahren aufgeklappt — sonst
    // steht der Baum zu, obwohl rechts sein Inhalt liegt.
    if (params.id) {
      const nachId = new Map(orte.map(o => [o.id, o]));
      let o = nachId.get(params.id);
      const gesehen = new Set();
      while (o && o.elternId && !gesehen.has(o.id)) {
        gesehen.add(o.id);
        offen.add(o.elternId);
        o = nachId.get(o.elternId);
      }
    }

    const suche = input({ placeholder: 'Lagerort filtern…', autocomplete: 'off', 'aria-label': 'Lagerort filtern' });
    const baumBox = el('div', { class: 'ort-baum' });

    const baumZeichnen = () => {
      baumBox.innerHTML = '';
      const filter = suche.value.trim().toLowerCase();
      const sichtbar = filter ? gefiltert(orte, filter) : orte;
      const wurzeln = SL.models.ortBaum(sichtbar);
      if (!wurzeln.length) {
        baumBox.appendChild(el('p', { class: 'muted' }, 'Kein Lagerort passt dazu.'));
        return;
      }
      for (const w of wurzeln) baumBox.appendChild(astZeichnen(w, 0, params.id, !!filter, baumZeichnen));
    };
    suche.addEventListener('input', baumZeichnen);
    baumZeichnen();

    behaelter.appendChild(karte(null, [suche, baumBox]));

    if (params.id) behaelter.appendChild(await inhaltKarte(orte, params.id));
  }

  // Beim Filtern müssen die Elternorte mitkommen, sonst hängt ein Treffer
  // namens „Fach B" ohne Zusammenhang in der Luft.
  function gefiltert(orte, filter) {
    const nachId = new Map(orte.map(o => [o.id, o]));
    const behalten = new Set();
    for (const o of orte) {
      if (!o.name.toLowerCase().includes(filter)) continue;
      behalten.add(o.id);
      let e = o.elternId ? nachId.get(o.elternId) : null;
      const gesehen = new Set();
      while (e && !gesehen.has(e.id)) { gesehen.add(e.id); behalten.add(e.id); e = e.elternId ? nachId.get(e.elternId) : null; }
    }
    return orte.filter(o => behalten.has(o.id));
  }

  function astZeichnen(o, tiefe, gewaehltId, filterAktiv, neuZeichnen) {
    const hatKinder = o.kinder && o.kinder.length;
    // Beim Filtern alles offen zeigen: wer sucht, will das Ergebnis sehen und
    // nicht erst klicken.
    const istOffen = filterAktiv || offen.has(o.id);

    const zeile = el('div', {
      class: 'ort-zeile' + (o.id === gewaehltId ? ' ort-zeile-aktiv' : ''),
      style: `padding-left: ${tiefe * 18}px`,
    }, [
      hatKinder
        ? el('button', {
          class: 'ort-klapp', type: 'button',
          'aria-label': istOffen ? 'Zuklappen' : 'Aufklappen',
          onclick: () => {
            if (offen.has(o.id)) offen.delete(o.id); else offen.add(o.id);
            neuZeichnen();
          },
        }, istOffen ? '▾' : '▸')
        : el('span', { class: 'ort-klapp ort-klapp-leer' }, ''),
      el('a', { class: 'ort-name', href: `#/orte?id=${encodeURIComponent(o.id)}` }, o.name),
      o.anzahl != null ? el('span', { class: 'tag' }, `${o.anzahl}`) : null,
    ]);

    const wrap = el('div', {}, [zeile]);
    if (hatKinder && istOffen) {
      for (const k of o.kinder) wrap.appendChild(astZeichnen(k, tiefe + 1, gewaehltId, filterAktiv, neuZeichnen));
    }
    return wrap;
  }

  // Inhalt eines Lagerorts. Bewusst nur die ersten Treffer plus Verweis in die
  // Artikelsuche — ein Regal mit 300 Kleinteilen soll die Seite nicht sprengen.
  async function inhaltKarte(orte, ortId) {
    const pfad = SL.models.ortPfad(orte, ortId) || 'Lagerort';
    const box = el('div');
    const k = karte(pfad, box, {
      aktion: el('a', {
        class: 'btn btn-sm',
        href: `#/artikel?ortId=${encodeURIComponent(ortId)}`,
      }, 'In der Suche öffnen'),
    });
    box.appendChild(el('p', { class: 'muted' }, 'Inhalt wird geladen…'));
    try {
      const a = await SL.api.lagerSuchen({ ortId, seite: 1, proSeite: 10 });
      box.innerHTML = '';
      if (!a.artikel.length) {
        box.appendChild(el('p', { class: 'muted' }, 'Hier liegt (laut Homebox) nichts.'));
        return k;
      }
      const liste = el('div', { class: 'liste' });
      for (const art of a.artikel) {
        liste.appendChild(el('a', { class: 'eintrag eintrag-klick', href: `#/artikel?id=${encodeURIComponent(art.id)}` }, [
          el('div', { class: 'benutzer-kopf' }, [
            el('strong', {}, art.name || '(ohne Namen)'),
            el('span', { class: 'tag' }, `${art.menge} Stück`),
          ]),
        ]));
      }
      box.appendChild(liste);
      if (a.gesamt > a.artikel.length) {
        box.appendChild(el('p', { class: 'muted' }, `${a.artikel.length} von ${a.gesamt} — die übrigen über „In der Suche öffnen".`));
      }
    } catch (e) {
      box.innerHTML = '';
      box.appendChild(el('p', { class: 'anmeldung-fehler' }, e.message || 'Der Inhalt konnte nicht geladen werden.'));
    }
    return k;
  }

  SL.views.renderOrte = renderOrte;
})();
