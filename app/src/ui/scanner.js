(function () {
  'use strict';
  window.SL = window.SL || {};
  const { el, toast } = SL.ui;

  // Barcode-Scanner über die Handykamera.
  //
  // Zwei Wege, weil kein einzelner überall funktioniert:
  //   1. BarcodeDetector — in Chrome auf Android eingebaut, schnell und
  //      stromsparend, weil das Betriebssystem dekodiert.
  //   2. ZXing (vendored) — Rückfallebene für Safari/iOS, das BarcodeDetector
  //      nicht kennt. Kostet mehr Rechenzeit, funktioniert aber überall.
  //
  // Beides braucht einen „secure context": über http://<IP> bleibt die Kamera
  // stumm. Deshalb richtet der Installer HTTPS ein.
  //
  // ZXing wird hier BILDWEISE angesteuert (MultiFormatReader auf einem Canvas)
  // statt über `decodeFromVideoElementContinuously`. Grund: dessen Ablauf
  // wartet intern auf das `playing`-Ereignis des Videos. Da der Stream hier
  // schon vorher gestartet wird, ist das Ereignis längst gefeuert — die
  // eingebaute Erkennung wartet dann ewig und dekodiert nie ein einziges Bild.
  // Genau so fiel der Scanner auf dem iPad aus: Bild da, Erkennung tot.
  // Die eigene Schleife hat außerdem zwei Vorteile: der Ausschnitt im
  // Zielrahmen wird in voller Kameraauflösung ausgewertet, und „TRY_HARDER"
  // lässt sich setzen.

  // Gesucht wird, was im Schullager vorkommt: Baukomponenten sind Handelsware
  // mit EAN/UPC, Schuldemonstratoren tragen ein selbst gedrucktes QR-Etikett.
  const FORMATE_NATIV = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar', 'qr_code'];
  // Ohne EAN-13 taugt ein Erkenner für dieses Lager nicht — dann lieber ZXing.
  const PFLICHTFORMAT = 'ean_13';

  const ABSTAND_MS = 90;      // ~11 Versuche je Sekunde: flüssig, aber kein Akkufresser
  const MAX_BREITE = 1280;    // mehr Pixel bringen für Strichcodes nichts, kosten aber Zeit

  function kameraVerfuegbar() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  function sichererKontext() {
    // localhost gilt als sicher, damit die Entwicklung ohne TLS funktioniert.
    return window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  }

  // Öffnet den Scanner als Vollbild. onCode(code) wird beim ersten Treffer
  // gerufen, danach schließt sich der Scanner.
  function scannen(onCode) {
    if (!sichererKontext()) {
      toast('Die Kamera braucht eine HTTPS-Verbindung. Bitte die Adresse mit https:// aufrufen.', 5000);
      return codeEintippen(onCode);
    }
    if (!kameraVerfuegbar()) {
      toast('Dieses Gerät stellt keine Kamera bereit.', 4000);
      return codeEintippen(onCode);
    }

    const video = el('video', {
      class: 'scan-video', playsinline: '', 'webkit-playsinline': '', muted: '', autoplay: '',
    });
    // Als Eigenschaft nachziehen: iOS wertet nur das Attribut aus, andere
    // Browser nur die Eigenschaft.
    video.muted = true;
    video.playsInline = true;

    const status = el('div', { class: 'scan-status' }, 'Kamera wird gestartet…');
    // Welcher Erkenner läuft, gehört sichtbar auf den Schirm: fällt das Scannen
    // auf einem Gerät aus, ist das die erste Frage.
    const werkzeug = el('span', { class: 'scan-werkzeug muted' }, '');
    const buehne = el('div', { class: 'scan-buehne' }, [
      video,
      el('div', { class: 'scan-rahmen' }),
    ]);

    const overlay = el('div', { class: 'scan-overlay' }, [
      buehne,
      status,
      el('div', { class: 'scan-leiste' }, [
        el('button', { class: 'btn', type: 'button', onclick: () => { schliessen(); codeEintippen(onCode); } }, '⌨ Eintippen'),
        werkzeug,
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn', type: 'button', onclick: () => schliessen() }, 'Abbrechen'),
      ]),
    ]);
    document.body.appendChild(overlay);

    let stream = null;
    let laeuft = true;
    let timer = null;

    const flaeche = document.createElement('canvas');
    const stift = flaeche.getContext('2d', { willReadFrequently: true });

    function schliessen() {
      laeuft = false;
      if (timer) { clearTimeout(timer); timer = null; }
      if (stream) { for (const t of stream.getTracks()) { try { t.stop(); } catch (_) {} } stream = null; }
      document.removeEventListener('keydown', onKey);
      overlay.remove();
    }
    function onKey(e) { if (e.key === 'Escape') schliessen(); }
    document.addEventListener('keydown', onKey);

    function treffer(code) {
      if (!laeuft) return;
      const sauber = String(code || '').trim();
      if (!sauber) return;
      // Kurz bestätigen, damit man sieht, dass gelesen wurde — sonst wirkt der
      // sofortige Sprung wie ein Fehlklick.
      status.textContent = '✓ ' + sauber;
      if (navigator.vibrate) { try { navigator.vibrate(60); } catch (_) {} }
      laeuft = false;
      if (timer) { clearTimeout(timer); timer = null; }
      setTimeout(() => { schliessen(); onCode(sauber); }, 250);
    }

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            // Ein EAN-13 auf einem Deckel ist klein. Mehr Kameraauflösung ist
            // hier der wirksamste Hebel; ausgewertet wird ohnehin nur der
            // Ausschnitt im Zielrahmen.
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        video.srcObject = stream;
        try { await video.play(); } catch (_) { /* iOS spielt autoplay+muted selbst an */ }
        await bildBereit();
        dauerfokus();
      } catch (e) {
        status.textContent = 'Kamera nicht verfügbar: ' + e.message;
        setTimeout(() => { schliessen(); codeEintippen(onCode); }, 1800);
        return;
      }
      if (!laeuft) return;

      const nativ = await nativErkennerBauen();
      if (nativ) { werkzeug.textContent = 'Erkennung: Gerät'; nativLesen(nativ); }
      else { werkzeug.textContent = 'Erkennung: ZXing'; zxingLesen(); }
    })();

    // Ohne Bildmaße lässt sich kein Ausschnitt berechnen. Auf iOS steht
    // videoWidth erst einige Bilder nach dem Start.
    function bildBereit() {
      return new Promise(resolve => {
        const bis = Date.now() + 4000;
        (function pruefen() {
          if (!laeuft || video.videoWidth || Date.now() > bis) return resolve();
          setTimeout(pruefen, 60);
        })();
      });
    }

    // Nicht jedes Gerät kann das; wo es geht, spart es das Suchen nach Schärfe.
    function dauerfokus() {
      const spur = stream && stream.getVideoTracks()[0];
      if (!spur || !spur.applyConstraints) return;
      spur.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    }

    // --- Bildausschnitt -----------------------------------------------------
    // Das Video liegt mit `object-fit: cover` in der Bühne, wird also
    // beschnitten dargestellt. Diese Rechnung bildet den sichtbaren Zielrahmen
    // auf die Pixel des Kamerabildes ab — sonst würde ein Ausschnitt an der
    // falschen Stelle ausgewertet, und man zielt ins Leere.
    function zielbereich() {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return null;
      const r = buehne.getBoundingClientRect();
      if (!r.width || !r.height) return { sx: 0, sy: 0, sw: vw, sh: vh };

      const skala = Math.max(r.width / vw, r.height / vh);   // „cover"
      const abX = (vw * skala - r.width) / 2;                // links/rechts abgeschnitten
      const abY = (vh * skala - r.height) / 2;

      // Maße des Rahmens aus styles.css (.scan-rahmen).
      const rb = r.width * 0.84, rh = r.height * 0.22;
      const rx = r.width * 0.08, ry = r.height * 0.5 - rh / 2;

      // Etwas Luft, damit ein knapp daneben gehaltener Code noch mitkommt.
      const luft = 1.2;
      const sw0 = rb / skala, sh0 = rh / skala;
      let sw = sw0 * luft, sh = sh0 * luft;
      let sx = (rx + abX) / skala - (sw - sw0) / 2;
      let sy = (ry + abY) / skala - (sh - sh0) / 2;

      sx = Math.max(0, Math.min(sx, vw - 1));
      sy = Math.max(0, Math.min(sy, vh - 1));
      sw = Math.max(16, Math.min(sw, vw - sx));
      sh = Math.max(16, Math.min(sh, vh - sy));
      return { sx, sy, sw, sh };
    }

    // Drei Blickwinkel auf dasselbe Kamerabild. Mehr als einer ist nötig, weil
    // ZXing nur waagerecht liegende Strichcodes liest — ein hochkant gehaltener
    // Code bleibt sonst unsichtbar (im Test bestätigt).
    const ART_RAHMEN = 0;     // Ausschnitt im Zielrahmen, volle Kameraauflösung
    const ART_VOLLBILD = 1;   // ganzes Bild, falls jemand daneben zielt
    const ART_GEDREHT = 2;    // ganzes Bild um 90° gedreht

    function aufFlaeche(art) {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return false;
      const z = art === ART_RAHMEN
        ? (zielbereich() || { sx: 0, sy: 0, sw: vw, sh: vh })
        : { sx: 0, sy: 0, sw: vw, sh: vh };

      const f = Math.min(1, MAX_BREITE / z.sw);
      const bw = Math.max(1, Math.round(z.sw * f));
      const bh = Math.max(1, Math.round(z.sh * f));

      if (art === ART_GEDREHT) {
        flaeche.width = bh; flaeche.height = bw;   // setzt den Zeichenzustand zurück
        stift.translate(bh / 2, bw / 2);
        stift.rotate(-Math.PI / 2);
        stift.drawImage(video, z.sx, z.sy, z.sw, z.sh, -bw / 2, -bh / 2, bw, bh);
        stift.setTransform(1, 0, 0, 1, 0, 0);
      } else {
        flaeche.width = bw; flaeche.height = bh;
        stift.drawImage(video, z.sx, z.sy, z.sw, z.sh, 0, 0, bw, bh);
      }
      return true;
    }

    // --- Weg 1: eingebauter Leser -------------------------------------------
    async function nativErkennerBauen() {
      if (!('BarcodeDetector' in window)) return null;
      try {
        const koennen = await window.BarcodeDetector.getSupportedFormats();
        // Ein Erkenner, der nur QR kann (so verhalten sich manche Browser),
        // würde Handelsware stumm liegen lassen. Dann lieber gleich ZXing.
        if (!koennen || !koennen.includes(PFLICHTFORMAT)) return null;
        const formate = FORMATE_NATIV.filter(f => koennen.includes(f));
        return new window.BarcodeDetector({ formats: formate });
      } catch (_) {
        return null;
      }
    }

    function nativLesen(detector) {
      let fehler = 0;
      const schleife = async () => {
        if (!laeuft) return;
        status.textContent = 'Barcode vor die Kamera halten…';
        try {
          const codes = await detector.detect(video);
          if (codes && codes.length) return treffer(codes[0].rawValue);
          fehler = 0;
        } catch (_) {
          // Einzelne Bilder dürfen scheitern. Scheitert es dauerhaft, ist der
          // Erkenner selbst defekt — dann auf ZXing wechseln, statt still
          // nichts zu tun.
          if (++fehler >= 10) { werkzeug.textContent = 'Erkennung: ZXing'; return zxingLesen(); }
        }
        timer = setTimeout(schleife, ABSTAND_MS);
      };
      schleife();
    }

    // --- Weg 2: ZXing --------------------------------------------------------
    function zxingLesen() {
      const ZX = window.ZXing;
      if (!ZX || !ZX.MultiFormatReader) {
        status.textContent = 'Kein Scanner verfügbar — bitte eintippen.';
        setTimeout(() => { schliessen(); codeEintippen(onCode); }, 1500);
        return;
      }

      const F = ZX.BarcodeFormat;
      const hinweise = new Map();
      hinweise.set(ZX.DecodeHintType.POSSIBLE_FORMATS, [
        F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.ITF, F.CODABAR, F.QR_CODE,
      ]);
      // Kostet Rechenzeit, findet dafür auch schräg gehaltene und schwach
      // belichtete Codes — am Lager der Normalfall.
      hinweise.set(ZX.DecodeHintType.TRY_HARDER, true);

      const leser = new ZX.MultiFormatReader();
      leser.setHints(hinweise);
      status.textContent = 'Barcode vor die Kamera halten…';

      // Der Zielrahmen bekommt das meiste Gewicht — dort hält man den Code hin.
      const REIHENFOLGE = [ART_RAHMEN, ART_RAHMEN, ART_VOLLBILD, ART_GEDREHT];
      let durchgang = 0;
      const schleife = () => {
        if (!laeuft) return;
        const art = REIHENFOLGE[durchgang++ % REIHENFOLGE.length];
        if (aufFlaeche(art)) {
          try {
            const quelle = new ZX.HTMLCanvasElementLuminanceSource(flaeche);
            const bitmap = new ZX.BinaryBitmap(new ZX.HybridBinarizer(quelle));
            const erg = leser.decodeWithState(bitmap);
            if (erg) return treffer(erg.getText());
          } catch (_) {
            // NotFoundException heißt nur: in diesem Bild war nichts.
          }
          leser.reset();
        }
        timer = setTimeout(schleife, ABSTAND_MS);
      };
      schleife();
    }
  }

  // Immer erreichbarer Ausweg: Code von Hand eingeben. Ein verschmierter oder
  // fehlender Barcode darf die Arbeit nicht blockieren.
  //
  // Bewusst KEIN inputmode 'numeric': hier kommen zwei Sorten Code an — die
  // Ziffernfolge unter einem Strichcode und die Kurzkennung vom eigenen
  // Etikett (A-1042). Eine Zifferntastatur würde die zweite unmöglich machen.
  function codeEintippen(onCode) {
    const feld = SL.ui.input({ placeholder: 'z. B. 4001234567890 oder A-1042', autocapitalize: 'characters', autofocus: '' });
    const m = SL.ui.modal('Code eingeben', el('div', {}, [
      el('p', { class: 'muted' }, 'Die Ziffernfolge unter dem Strichcode — oder die Kennung vom Etikett.'),
      feld,
    ]), {
      fuss: [
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn', onclick: () => m.close() }, 'Abbrechen'),
        el('button', {
          class: 'btn btn-primary', onclick: () => {
            const c = feld.value.trim();
            if (!c) { toast('Bitte einen Code eingeben.'); return; }
            m.close(); onCode(c);
          },
        }, 'Übernehmen'),
      ],
    });
    feld.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const c = feld.value.trim();
        if (c) { m.close(); onCode(c); }
      }
    });
    setTimeout(() => feld.focus(), 50);
  }

  SL.ui.scannen = scannen;
  SL.ui.codeEintippen = codeEintippen;
  SL.ui.scannerBereit = () => sichererKontext() && kameraVerfuegbar();
})();
