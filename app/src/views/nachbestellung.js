(function () {
  'use strict';
  window.SL = window.SL || {};
  SL.views = SL.views || {};

  const { el, karte } = SL.ui;

  // Nachbestell-Liste: alles, dessen Bestand den Mindestbestand erreicht oder
  // unterschritten hat.
  //
  // Diese Frage kann Homebox nicht beantworten — der Mindestbestand ist dort
  // ein Textfeld, danach lässt sich nicht rechnen. Der Server geht deshalb den
  // Bestand einmal durch. Das ist die teuerste Abfrage der App und deshalb
  // eine eigene Seite und keine Kachel, die bei jedem Seitenaufruf mitlädt.
  async function renderNachbestellung(mount) {
    mount.appendChild(el('div', { class: 'toolbar' }, [
      el('h1', {}, 'Nachbestellen'),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'btn btn-sm', type: 'button',
        onclick: () => SL.app.router(),
      }, '↻ Neu prüfen'),
    ]));

    const behaelter = el('div');
    mount.appendChild(behaelter);
    behaelter.appendChild(karte(null, el('p', { class: 'muted' },
      'Der Bestand wird durchgegangen — das kann bei vielen Artikeln einen Moment dauern…')));

    let daten = null;
    try {
      daten = await SL.api.lagerNachbestellung();
    } catch (e) {
      behaelter.innerHTML = '';
      behaelter.appendChild(SL.views.artikelFehlerKarte(e, () => SL.app.router()));
      return;
    }

    behaelter.innerHTML = '';

    if (!daten.artikel.length) {
      behaelter.appendChild(karte(null, [
        el('p', {}, 'Nichts ist knapp — alle Artikel liegen über ihrem Mindestbestand.'),
        el('p', { class: 'muted' }, hinweisZeile(daten)),
      ]));
      return;
    }

    const liste = el('div', { class: 'liste' });
    for (const a of daten.artikel) liste.appendChild(zeile(a));

    behaelter.appendChild(karte(
      `${daten.artikel.length} ${daten.artikel.length === 1 ? 'Artikel ist' : 'Artikel sind'} knapp`,
      [liste, el('p', { class: 'muted' }, hinweisZeile(daten))],
    ));
  }

  function zeile(a) {
    const fehlt = a.mindestbestand - a.menge;
    return el('a', { class: 'eintrag eintrag-klick', href: `#/artikel?id=${encodeURIComponent(a.id)}` }, [
      el('div', { class: 'benutzer-kopf' }, [
        el('strong', {}, a.name || '(ohne Namen)'),
        el('span', { class: 'tag tag-warn' }, `${a.menge} von ${a.mindestbestand}`),
      ]),
      el('div', { class: 'muted' }, [
        // „Fehlt: 0" wäre verwirrend — bei genau erreichtem Mindestbestand ist
        // nichts zu wenig da, es ist nur Zeit, daran zu denken.
        fehlt > 0 ? `Es fehlen ${fehlt} Stück` : 'Mindestbestand genau erreicht',
        a.ortName ? ' · ' + a.ortName : '',
        a.barcode ? ' · ' + a.barcode : '',
      ].join('')),
    ]);
  }

  // Ehrlich sagen, worauf sich die Liste stützt. Wurde der Durchgang gekappt,
  // ist die Liste unvollständig — das darf nicht stillschweigend passieren.
  function hinweisZeile(daten) {
    const stand = new Date(daten.stand).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const basis = `${daten.geprueft} Artikel geprüft, Stand ${stand} Uhr. Nur Artikel mit gesetztem Mindestbestand werden überwacht.`;
    return daten.unvollstaendig
      ? basis + ' ACHTUNG: Der Bestand ist größer als der geprüfte Ausschnitt — die Liste kann unvollständig sein.'
      : basis;
  }

  SL.views.renderNachbestellung = renderNachbestellung;
})();
