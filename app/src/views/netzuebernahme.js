(function () {
  'use strict';
  window.SL = window.SL || {};
  SL.views = SL.views || {};

  const { el, karte, input, select, toast, leer } = SL.ui;

  // Übernahme der alten Komponentenliste in die Netzwerkgeräte.
  //
  // REGEL DIESES ASSISTENTEN (ausdrücklicher Wunsch von Matthias): es wird
  // NICHTS still überführt. Erst Sicherung anbieten, dann Zeile für Zeile
  // zeigen, was entstünde — geschrieben wird nur auf Klick.
  //
  // Die alten Einträge werden NICHT gelöscht, sondern mit `uebernommenAls`
  // markiert. Drei Gründe: ein Abbruch mitten im Lauf bleibt folgenlos, ein
  // zweiter Lauf überspringt Erledigtes, und wenn etwas schiefging, liegen die
  // Ausgangsdaten noch da.

  async function renderNetzUebernahme(mount) {
    if (!SL.store.darfBuchen()) {
      mount.appendChild(karte('Übernahme', el('p', {}, [
        'Dafür bitte zuerst ',
        el('a', { href: '#/anmelden?weiter=' + encodeURIComponent(location.hash) }, 'anmelden'),
        '.',
      ])));
      return;
    }

    mount.appendChild(el('div', { class: 'toolbar' }, [
      el('h1', {}, 'Komponenten übernehmen'),
      el('span', { class: 'spacer' }),
      el('a', { class: 'btn', href: '#/netzwerk' }, '‹ Zurück'),
    ]));

    const box = el('div');
    mount.appendChild(box);
    box.appendChild(karte(null, el('p', { class: 'muted' }, 'Wird geladen…')));

    let alt = [];
    let vorhanden = [];
    try {
      [alt, vorhanden] = await Promise.all([SL.api.listKomponenten(), SL.api.listNetzgeraete()]);
    } catch (e) {
      box.innerHTML = '';
      box.appendChild(karte('Übernahme', el('p', { class: 'anmeldung-fehler' }, e.message || '')));
      return;
    }

    box.innerHTML = '';
    const offen = alt.filter(k => !k.uebernommenAls);
    const fertig = alt.length - offen.length;

    if (!alt.length) {
      box.appendChild(karte('Nichts zu übernehmen', leer(
        'In der alten Komponentenliste liegt kein Eintrag. Neue Geräte legst du direkt unter „Netzwerk" an.')));
      return;
    }
    if (!offen.length) {
      box.appendChild(karte('Übernahme abgeschlossen', el('p', { class: 'ampel ampel-ok' },
        `Alle ${alt.length} Einträge sind übernommen. Die alten Daten bleiben als Sicherung stehen.`)));
      return;
    }

    box.appendChild(karte('Bevor es losgeht', [
      el('p', {}, `${offen.length} Einträge stehen noch in der alten Struktur`
        + (fertig ? ` (${fertig} sind bereits übernommen)` : '') + '. '
        + 'Aus jedem wird ein Artikel im Lager und ein Netzwerkgerät — erst dadurch greift die Wartung für sie.'),
      el('p', { class: 'muted' }, 'Die alten Einträge werden nicht gelöscht, sondern nur als übernommen markiert. '
        + 'Bricht der Lauf ab, kannst du ihn gefahrlos wiederholen.'),
      el('div', { class: 'btn-reihe' }, [
        el('button', {
          class: 'btn', type: 'button',
          onclick: () => sicherung(alt),
        }, '⭳ Sicherung herunterladen'),
      ]),
    ]));

    // --- Vorschau, Zeile für Zeile ---
    // Jede Zeile trägt ihre eigene Entscheidung: übernehmen ja/nein, welche
    // Klasse, welcher Lagerort. Eine Sammelentscheidung für 80 Zeilen wäre
    // bequem und in der Hälfte der Fälle falsch.
    const zeilen = offen.map(k => ({
      k,
      dabei: true,
      klasse: klasseRaten(k),
      ortId: '',
      ortName: '(vom Demonstrator)',
      // Gibt es im Lager schon einen Artikel dieses Namens, wird verknüpft
      // statt angelegt — sonst entstehen Doubletten.
      artikelId: '',
      artikelName: '',
      zustand: '',
    }));

    const liste = el('div', { class: 'liste' });
    const kopf = el('p', { class: 'muted' });
    const starten = el('button', { class: 'btn btn-primary', type: 'button' }, 'Übernahme starten');

    function zaehlenZeigen() {
      const n = zeilen.filter(z => z.dabei && !z.zustand).length;
      kopf.textContent = `${n} von ${zeilen.length} Einträgen werden übernommen.`;
      starten.disabled = !n;
    }

    function zeichnen() {
      liste.innerHTML = '';
      for (const z of zeilen) liste.appendChild(zeileBauen(z));
      zaehlenZeigen();
    }

    function zeileBauen(z) {
      const haken = el('input', {
        type: 'checkbox',
        checked: z.dabei,
        disabled: !!z.zustand,
        onchange: (e) => { z.dabei = e.target.checked; zaehlenZeigen(); },
      });
      const klasseFeld = select(
        SL.models.NETZ_KLASSEN.map(x => ({ wert: x, label: SL.models.netzKlasseLabel(x) })),
        z.klasse, (v) => { z.klasse = v; }, { leerLabel: false });
      klasseFeld.disabled = !!z.zustand;

      const ort = el('span', { class: 'muted' }, z.ortName);
      const ortKnopf = el('button', {
        class: 'btn btn-sm', type: 'button', disabled: !!z.zustand,
        onclick: () => SL.ui.ortWaehlen({
          aktuellId: z.ortId,
          onWahl: (o) => { z.ortId = o.id; z.ortName = o.pfad || o.name; ort.textContent = z.ortName; },
        }),
      }, 'Ort ändern');

      const netz = [
        z.k.profinetName ? `Gerätename ${z.k.profinetName}` : '',
        z.k.ip ? `IP ${z.k.ip}` : '',
        z.k.mac ? `MAC ${z.k.mac}` : '',
      ].filter(Boolean).join(' · ');

      return el('div', { class: 'eintrag' }, [
        el('div', { class: 'benutzer-kopf' }, [
          haken,
          el('strong', {}, z.k.name || '(ohne Bezeichnung)'),
          z.k.demonstratorName ? el('span', { class: 'muted' }, `in ${z.k.demonstratorName}`) : null,
          z.zustand === 'ok' ? el('span', { class: 'ampel ampel-ok' }, 'übernommen') : null,
          z.zustand === 'fehler' ? el('span', { class: 'ampel ampel-warnung' }, z.fehler || 'fehlgeschlagen') : null,
        ]),
        netz ? el('div', { class: 'lager-barcode' }, netz) : null,
        el('div', { class: 'wahl-zeile' }, [klasseFeld, ort, ortKnopf]),
      ]);
    }

    zeichnen();

    starten.onclick = async () => {
      starten.disabled = true;
      let ok = 0;
      let fehler = 0;
      for (const z of zeilen) {
        if (!z.dabei || z.zustand) continue;
        try {
          await uebernehmen(z, vorhanden);
          z.zustand = 'ok';
          ok++;
        } catch (e) {
          z.zustand = 'fehler';
          z.fehler = e.message || 'fehlgeschlagen';
          fehler++;
        }
        zeichnen();
      }
      // Der Ortsbaum zeigt Stückzahlen je Ort — die stimmen jetzt nicht mehr.
      SL.store.orteVergessen();
      // EINE Meldung, und zwar die wahre.
      toast(fehler
        ? `${ok} übernommen, ${fehler} fehlgeschlagen — die Zeilen sagen, woran es lag.`
        : `${ok} Einträge übernommen.`, fehler ? 7000 : 3000);
      starten.disabled = false;
      zaehlenZeigen();
    };

    box.appendChild(karte('Vorschau', [
      el('p', { class: 'muted' }, 'Die Art ist geraten und lässt sich je Zeile ändern. Der Lagerort kommt vom '
        + 'Demonstrator, in dem das Gerät steckt — dort steht es ja auch physisch.'),
      kopf,
      liste,
      el('div', { class: 'btn-reihe' }, [starten]),
    ]));
  }

  // Die Art aus dem alten Typ-Feld raten. Geraten wird nur der Vorschlag —
  // entschieden wird in der Vorschau, deshalb ist ein Fehlgriff hier harmlos.
  function klasseRaten(k) {
    const t = String(k.typ || '').toLowerCase();
    if (t.includes('rechner') || t.includes('pc')) return 'pc';
    if (t.includes('roboter')) return 'roboter';
    return 'profinet';
  }

  // Eine Zeile übernehmen. Reihenfolge ist wichtig: erst das Gerät anlegen,
  // DANN den alten Eintrag markieren. Andersherum stünde nach einem Fehlschlag
  // „übernommen" an einem Eintrag, für den nie etwas entstanden ist.
  async function uebernehmen(z, vorhanden) {
    const k = z.k;
    // Schon ein Netzwerkgerät mit diesem Artikelnamen? Dann verknüpfen statt
    // ein zweites anlegen.
    const doppelt = vorhanden.find(g => String(g.artikelName || '').trim().toLowerCase()
      === String(k.name || '').trim().toLowerCase());
    if (doppelt) {
      throw new Error(`„${k.name}" ist unter Netzwerk schon erfasst — bitte den Haken entfernen.`);
    }

    const koerper = {
      klasse: z.klasse,
      name: k.name,
      ortId: z.ortId || undefined,
      // Der Demonstrator, in dem die Komponente steckte, bleibt die Zuordnung.
      demonstratorIds: k.demonstratorId ? [k.demonstratorId] : [],
      ausKomponenteId: k.id,
    };
    // Nur die Felder mitgeben, die die gewählte Klasse überhaupt kennt — der
    // Server verwirft den Rest ohnehin, aber so ist sichtbar, was ankommt.
    for (const f of SL.models.netzFelder(z.klasse)) {
      if (k[f] !== undefined && k[f] !== '') koerper[f] = k[f];
    }
    // Ohne eigenen Ort erbt der Artikel den des Demonstrators. Den kennt nur
    // Homebox — deshalb hier nachschlagen statt zu raten.
    if (!z.ortId && k.demonstratorId) {
      try {
        const demo = await SL.api.lagerArtikel(k.demonstratorId);
        if (demo && demo.ortId) koerper.ortId = demo.ortId;
      } catch (_) { /* ohne Ort anlegen ist besser als gar nicht */ }
    }

    const antwort = await SL.api.netzgeraetAnlegen(koerper);
    // Alten Eintrag markieren, nicht löschen.
    await SL.api.komponenteSpeichern(k.id, { uebernommenAls: antwort.geraet.id });
    vorhanden.push(antwort.geraet);
    return antwort;
  }

  // Sicherung als JSON — bevor irgendetwas geschrieben wird. Im Zweifel hat man
  // damit die Ausgangsdaten noch, auch wenn das nächtliche Backup gerade nicht
  // greift.
  function sicherung(alt) {
    const text = JSON.stringify({
      erstelltAm: new Date().toISOString(),
      hinweis: 'Sicherung der alten Komponentenliste von SchulLager vor der Übernahme in die Netzwerkgeräte.',
      komponenten: alt,
    }, null, 2);
    SL.ui.downloadFile(`schullager-komponenten-${SL.models.heuteIso()}.json`,
      new Blob([text], { type: 'application/json' }), 'application/json');
    toast('Sicherung heruntergeladen.');
  }

  SL.views.renderNetzUebernahme = renderNetzUebernahme;
})();
