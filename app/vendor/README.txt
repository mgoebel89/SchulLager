Vendorierte Bibliotheken
========================

Der Container hat kein Internet und soll auch keins brauchen. Fremdbibliotheken
liegen deshalb als fertige Datei hier und werden in index.html direkt
eingebunden — kein CDN, kein Build-Schritt, kein npm im Frontend.

zxing.min.js
    ZXing (@zxing/library 0.21.3, Apache-2.0), UMD-Build von jsDelivr.
    Barcode-Leser als Rueckfallebene fuer Browser ohne BarcodeDetector —
    namentlich Safari auf iOS. Zugriff ueber window.ZXing.

    Das Bundle enthaelt keine Encoder fuer 1D-Codes: wer den Leser testen will,
    muss einen EAN-13 selbst per Canvas zeichnen (Kodiertabellen L/G/R plus
    Paritaetsmuster). Fuer 2D ist es anders — QRCodeWriter, MultiFormatWriter
    und EncodeHintType sind enthalten. Die QR-Etiketten in Phase 3 brauchen
    also keine zusaetzliche Abhaengigkeit.
