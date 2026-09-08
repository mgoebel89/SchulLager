(function () {
  'use strict';
  window.SL = window.SL || {};
  SL.views = SL.views || {};

  const { el, karte } = SL.ui;

  // Startbildschirm: wer bin ich, hängt Homebox dran, und was will ich tun?
  // Die Kacheln zeigen nur, was der Angemeldete auch darf — ein Gast sieht
  // Suchen, Scannen und Lagerorte.
  function renderUebersicht(mount) {
    const s = SL.store.state;

    mount.appendChild(el('div', { class: 'toolbar' }, [
      el('h1', {}, 'Lagerverwaltung'),
      el('span', { class: 'spacer' }),
      s.benutzer
        ? el('span', { class: 'muted' }, `Angemeldet: ${s.benutzer.name}`)
        : el('a', { class: 'btn btn-primary', href: '#/anmelden' }, 'Anmelden'),
    ]));

    // --- Zustand von Homebox ------------------------------------------------
    // Bewusst prominent: ohne Homebox ist diese App eine leere Hülle, und die
    // wahrscheinlichste Ursache („noch nicht eingerichtet") soll man sofort
    // sehen statt einer leeren Artikelliste.
    mount.appendChild(homeboxKarte());

    // --- Schnellzugriff -----------------------------------------------------
    const kacheln = el('div', { class: 'kachel-grid' });
    kacheln.appendChild(kachel('Suchen', 'Artikel über Namen oder Barcode finden', '#/artikel', true));
    kacheln.appendChild(kachel('Scannen', 'Barcode oder QR mit der Kamera lesen', '#/scannen', true));
    kacheln.appendChild(kachel('Lagerorte', 'Räume, Schränke und Fächer durchgehen', '#/orte', true));
    if (SL.store.darfBuchen()) {
      kacheln.appendChild(kachel('Geräte', 'Demonstratoren und Netzgeräte — verfügbar oder verliehen?', '#/geraete', true));
      kacheln.appendChild(kachel('Aufnehmen', 'Neuen Artikel anlegen, Barcode scannen', '#/neu', true));
      kacheln.appendChild(kachel('Ausleihe', 'Wer hat welches Gerät, und was ist überfällig?', '#/ausleihe', true));
      kacheln.appendChild(kachel('Nachbestellen', 'Was ist unter den Mindestbestand gerutscht?', '#/nachbestellung', true));
      kacheln.appendChild(kachel('Inventur', 'Regal für Regal zählen, Abweichungen festhalten', '#/inventur', true));
    }
    mount.appendChild(karte('Schnellzugriff', kacheln));

    // --- Hinweis für Gäste --------------------------------------------------
    if (!s.benutzer) {
      mount.appendChild(karte('Ohne Anmeldung', el('p', { class: 'muted' }, [
        'Suchen und Nachschauen geht ohne Anmeldung. Zum Buchen, Anlegen und ',
        'Ausleihen bitte ',
        el('a', { href: '#/anmelden' }, 'anmelden'),
        '.',
      ])));
    }
  }

  function homeboxKarte() {
    const l = SL.store.state.lager;
    // `.ampel` ist in dieser Designsprache ein beschriftetes Fähnchen, kein
    // Punkt — der Zustand steht also als Wort darin, die Erklärung daneben.
    let ampel = 'ampel-ok';
    let fahne = 'verbunden';
    let text = '';
    let aktion = null;

    if (!l.eingerichtet) {
      ampel = 'ampel-offen';
      fahne = 'nicht eingerichtet';
      text = 'Homebox ist noch nicht eingerichtet — ohne sie gibt es keinen Bestand zu zeigen.';
      if (SL.store.istAdmin()) aktion = el('a', { class: 'btn btn-primary btn-sm', href: '#/einstellungen' }, 'Jetzt einrichten');
      else text += ' Bitte an einen Administrator wenden.';
    } else if (!l.ok) {
      ampel = 'ampel-faellig';
      fahne = 'gestört';
      text = l.hinweis || 'Homebox antwortet nicht.';
      aktion = el('button', {
        class: 'btn btn-sm', type: 'button',
        onclick: async () => { await SL.store.lagerZustandLaden(); SL.app.neuZeichnen(); },
      }, 'Erneut prüfen');
    } else {
      text = l.sammlung ? `Aktive Sammlung: ${l.sammlung}.` : 'Der Bestand ist erreichbar.';
    }

    const zeile = el('div', { class: 'daten-zeile status-zeile' }, [
      el('span', { class: 'ampel ' + ampel }, fahne),
      el('span', {}, text),
    ]);
    return karte('Homebox', [zeile, aktion ? el('div', { class: 'btn-reihe' }, [aktion]) : null]);
  }

  function kachel(titel, text, ziel, aktiv) {
    const k = el(ziel && aktiv ? 'a' : 'div', {
      class: 'kachel' + (aktiv ? '' : ' kachel-inaktiv'),
      href: aktiv && ziel ? ziel : null,
    }, [
      el('div', { class: 'kachel-kopf' }, [el('h3', {}, titel)]),
      el('p', { class: 'muted' }, text),
    ]);
    return k;
  }

  SL.views.renderUebersicht = renderUebersicht;
})();
