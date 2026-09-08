(function () {
  'use strict';
  window.SL = window.SL || {};
  SL.views = SL.views || {};

  const { el, karte, input } = SL.ui;

  // Geräte: Schuldemonstratoren UND einzelne Netzgeräte (SPS-Boards ohne
  // übergeordneten Demonstrator).
  //
  // Beide sind eigene Artikel in Homebox, beide stehen in einem Raum, beide
  // sind ausleihbar und können Netzangaben tragen. Unterschieden werden sie
  // nur durch ihren Tag — ein nacktes SPS-Board ist eben kein Demonstrator.
  //
  // Die Liste zeigt bewusst ANDERE Angaben als die Artikelsuche: bei einem
  // Gerät zählt, ob es da ist und ob es heil ist, nicht wie viele Stück im
  // Fach liegen.
  async function renderGeraete(mount, params = {}) {
    const s = SL.store.state.settings;
    const filter = ['demonstrator', 'netzgeraet'].includes(params.art) ? params.art : '';

    mount.appendChild(el('div', { class: 'toolbar' }, [
      el('h1', {}, 'Geräte'),
      el('span', { class: 'spacer' }),
      SL.ui.scannerBereit()
        ? el('button', { class: 'btn', type: 'button', onclick: () => SL.views.scanStarten() }, '⌷ Scannen')
        : null,
      // Anlegen gehört hierher: wer Geräte verwaltet, sucht den Knopf nicht in
      // der Artikelliste. Die Art wird gleich mitgegeben.
      SL.store.darfBuchen()
        ? el('a', { class: 'btn', href: '#/neu?art=demonstrator' }, '+ Demonstrator')
        : null,
      SL.store.darfBuchen()
        ? el('a', { class: 'btn btn-primary', href: '#/neu?art=netzgeraet' }, '+ Netzgerät')
        : null,
    ]));

    // Umschalter. Er steht in der Adresse, lässt sich also als Lesezeichen
    // ablegen und überlebt ein Neuzeichnen.
    const chips = el('div', { class: 'chips geraete-filter' }, [
      chip('Alle', '#/geraete', !filter),
      chip('Demonstratoren', '#/geraete?art=demonstrator', filter === 'demonstrator'),
      chip('Netzgeräte', '#/geraete?art=netzgeraet', filter === 'netzgeraet'),
    ]);
    mount.appendChild(chips);

    const behaelter = el('div');
    mount.appendChild(behaelter);
    behaelter.appendChild(karte(null, el('p', { class: 'muted' }, 'Wird geladen…')));

    let demos = null;
    let netz = null;
    let ausleihen = [];
    let defekte = [];
    try {
      [demos, netz, ausleihen, defekte] = await Promise.all([
        (!filter || filter === 'demonstrator') ? SL.api.lagerNachMarke(s.demonstratorMarke) : Promise.resolve(null),
        (!filter || filter === 'netzgeraet') ? SL.api.lagerNachMarke(s.netzgeraetMarke) : Promise.resolve(null),
        SL.store.darfBuchen() ? SL.api.listAusleihen(false).catch(() => []) : Promise.resolve([]),
        SL.store.darfBuchen() ? SL.api.listDefekte(false).catch(() => []) : Promise.resolve([]),
      ]);
    } catch (e) {
      behaelter.innerHTML = '';
      behaelter.appendChild(SL.views.artikelFehlerKarte(e, () => SL.app.router()));
      return;
    }

    behaelter.innerHTML = '';

    // Beide Sorten zusammenführen und die Art mitschreiben. Ein Artikel, der
    // beide Tags trägt, soll nicht doppelt erscheinen — der Demonstrator
    // gewinnt, weil er die speziellere Aussage ist.
    const nachId = new Map();
    for (const a of (demos ? demos.artikel : [])) nachId.set(a.id, { ...a, art: 'demonstrator' });
    for (const a of (netz ? netz.artikel : [])) if (!nachId.has(a.id)) nachId.set(a.id, { ...a, art: 'netzgeraet' });
    const geraete = [...nachId.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), 'de'));

    const fehlendeTags = [
      (demos && !demos.markeGefunden) ? s.demonstratorMarke : '',
      (netz && !netz.markeGefunden) ? s.netzgeraetMarke : '',
    ].filter(Boolean);

    if (!geraete.length) {
      behaelter.appendChild(karte(null, [
        el('p', {}, filter
          ? `Es trägt noch kein Artikel den Tag „${filter === 'demonstrator' ? s.demonstratorMarke : s.netzgeraetMarke}".`
          : 'Es ist noch kein Gerät gekennzeichnet.'),
        fehlendeTags.length
          ? el('p', { class: 'muted' },
            `In Homebox gibt es ${fehlendeTags.length === 1 ? 'den Tag' : 'die Tags'} `
            + fehlendeTags.map(t => `„${t}"`).join(' und ')
            + ' noch nicht. Er entsteht von selbst, sobald du hier ein Gerät anlegst — '
            + 'oder du vergibst ihn in Homebox an vorhandene Artikel.')
          : null,
      ]));
      return;
    }

    const leihNach = new Map(ausleihen.filter(a => (a.art || 'ausleihe') === 'ausleihe' && !a.zurueckAm)
      .map(a => [a.artikelId, a]));
    const defektNach = new Map(defekte.filter(d => !d.behobenAm).map(d => [d.artikelId, d]));

    const suche = input({ placeholder: 'Gerät filtern…', autocomplete: 'off', 'aria-label': 'Gerät filtern' });
    const liste = el('div', { class: 'liste' });

    const zeichnen = () => {
      const f = suche.value.trim().toLowerCase();
      liste.innerHTML = '';
      const treffer = geraete.filter(a => !f || String(a.name).toLowerCase().includes(f));
      if (!treffer.length) {
        liste.appendChild(el('p', { class: 'muted' }, 'Kein Gerät passt dazu.'));
        return;
      }
      for (const a of treffer) liste.appendChild(zeile(a, leihNach.get(a.id), defektNach.get(a.id), !filter));
    };
    suche.addEventListener('input', zeichnen);
    zeichnen();

    const unvollstaendig = (demos && demos.unvollstaendig) || (netz && netz.unvollstaendig);
    behaelter.appendChild(karte(null, [
      suche,
      el('p', { class: 'muted' }, [
        `${geraete.length} ${geraete.length === 1 ? 'Gerät' : 'Geräte'}`,
        unvollstaendig ? ' — ACHTUNG: der Bestand ist größer als der geprüfte Ausschnitt, die Liste kann unvollständig sein.' : '',
      ].join('')),
      liste,
    ]));
  }

  // `.chip`/`.chip-aktiv` gibt es in der Designsprache bereits (Mehrfachauswahl
  // in den Schwesterprojekten) — hier als Links statt Knöpfe, damit die Auswahl
  // in der Adresse steht und sich als Lesezeichen ablegen lässt.
  function chip(text, ziel, aktiv) {
    return el('a', { class: 'chip' + (aktiv ? ' chip-aktiv' : ''), href: ziel }, text);
  }

  function zeile(a, leihe, defekt, artZeigen) {
    const marker = [];
    if (artZeigen) marker.push(el('span', { class: 'tag' }, SL.models.GERAET_LABEL[a.art] || ''));
    if (defekt) marker.push(el('span', { class: 'ampel ampel-faellig' }, 'defekt'));
    if (leihe) {
      const st = SL.models.leihStatus(leihe);
      marker.push(el('span', { class: 'ampel ' + st.klasse }, 'verliehen'));
    } else if (!defekt) {
      marker.push(el('span', { class: 'ampel ampel-ok' }, 'verfügbar'));
    }

    const zweite = leihe
      ? `bei ${leihe.benutzerName}${leihe.klasse ? ' (Klasse ' + leihe.klasse + ')' : ''}`
        + (leihe.faelligAm ? ` · ${SL.models.leihStatus(leihe).label}` : '')
      : (a.ortName || 'kein Raum zugeordnet');

    return el('a', { class: 'eintrag eintrag-klick', href: `#/artikel?id=${encodeURIComponent(a.id)}` }, [
      el('div', { class: 'benutzer-kopf' }, [el('strong', {}, a.name || '(ohne Namen)'), ...marker]),
      el('div', { class: 'muted' }, zweite),
    ]);
  }

  SL.views.renderGeraete = renderGeraete;
})();
