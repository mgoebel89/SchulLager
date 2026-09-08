(function () {
  'use strict';
  window.SL = window.SL || {};
  SL.views = SL.views || {};

  const { el, karte, input } = SL.ui;

  // Schuldemonstratoren — eigener Menüpunkt neben den Artikeln.
  //
  // Erkannt werden sie an einem Homebox-Tag (Voreinstellung „Demonstrator",
  // änderbar unter Einstellungen). Die Liste zeigt bewusst ANDERE Angaben als
  // die Artikelsuche: bei einem Gerät zählt, ob es gerade da ist und ob es
  // heil ist — nicht, wie viele Stück im Fach liegen.
  async function renderDemonstratoren(mount) {
    const marke = SL.store.state.settings.demonstratorMarke || 'Demonstrator';

    mount.appendChild(el('div', { class: 'toolbar' }, [
      el('h1', {}, 'Demonstratoren'),
      el('span', { class: 'spacer' }),
      SL.ui.scannerBereit()
        ? el('button', { class: 'btn', type: 'button', onclick: () => SL.views.scanStarten() }, '⌷ Scannen')
        : null,
    ]));

    const behaelter = el('div');
    mount.appendChild(behaelter);
    behaelter.appendChild(karte(null, el('p', { class: 'muted' }, 'Wird geladen…')));

    let daten = null;
    let ausleihen = [];
    let defekte = [];
    try {
      [daten, ausleihen, defekte] = await Promise.all([
        SL.api.lagerNachMarke(marke),
        SL.store.darfBuchen() ? SL.api.listAusleihen(false).catch(() => []) : Promise.resolve([]),
        SL.store.darfBuchen() ? SL.api.listDefekte(false).catch(() => []) : Promise.resolve([]),
      ]);
    } catch (e) {
      behaelter.innerHTML = '';
      behaelter.appendChild(SL.views.artikelFehlerKarte(e, () => SL.app.router()));
      return;
    }

    behaelter.innerHTML = '';

    // Den Tag gibt es in Homebox gar nicht: das ist kein Fehler, sondern eine
    // offene Aufgabe — und sie gehört erklärt, sonst sucht man den Fehler in
    // der App statt im Bestand.
    if (!daten.markeGefunden) {
      behaelter.appendChild(karte('Noch keine Demonstratoren gekennzeichnet', [
        el('p', {}, [
          'In Homebox gibt es keinen Tag namens ',
          el('strong', {}, marke),
          '. Geräte werden daran erkannt.',
        ]),
        el('p', { class: 'muted' },
          'Den Tag in Homebox anlegen und den Geräten zuweisen — das geht dort auch für mehrere auf einmal. '
          + (SL.store.istAdmin() ? 'Heißt euer Tag anders, lässt sich der Name unter Einstellungen → Allgemein ändern.' : '')),
      ]));
      return;
    }

    if (!daten.artikel.length) {
      behaelter.appendChild(karte(null, el('p', { class: 'muted' },
        `Es trägt noch kein Artikel den Tag „${marke}".`)));
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
      const treffer = daten.artikel.filter(a => !f || String(a.name).toLowerCase().includes(f));
      if (!treffer.length) {
        liste.appendChild(el('p', { class: 'muted' }, 'Kein Gerät passt dazu.'));
        return;
      }
      for (const a of treffer) liste.appendChild(zeile(a, leihNach.get(a.id), defektNach.get(a.id)));
    };
    suche.addEventListener('input', zeichnen);
    zeichnen();

    const kopf = el('p', { class: 'muted' }, [
      `${daten.artikel.length} ${daten.artikel.length === 1 ? 'Gerät' : 'Geräte'}`,
      daten.unvollstaendig ? ' — ACHTUNG: der Bestand ist größer als der geprüfte Ausschnitt, die Liste kann unvollständig sein.' : '',
    ].join(''));

    behaelter.appendChild(karte(null, [suche, kopf, liste]));
  }

  function zeile(a, leihe, defekt) {
    const marker = [];
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
      : (a.ortName || 'kein Lagerort');

    return el('a', { class: 'eintrag eintrag-klick', href: `#/artikel?id=${encodeURIComponent(a.id)}` }, [
      el('div', { class: 'benutzer-kopf' }, [el('strong', {}, a.name || '(ohne Namen)'), ...marker]),
      el('div', { class: 'muted' }, zweite),
    ]);
  }

  SL.views.renderDemonstratoren = renderDemonstratoren;
})();
