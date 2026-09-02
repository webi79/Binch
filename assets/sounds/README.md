# Klänge

## `tick.wav`

Der Klick des Zahlenrades (Uhrzeit-Blatt im Datumswähler).

**Herkunft:** `data/sounds/effects/Effect_Tick.ogg` aus dem Android Open Source
Project (`platform_frameworks_base`). Das ist Androids eigener `FX_KEY_CLICK` —
derselbe Klang, den `NumberPicker` und `TimePicker` beim Drehen spielen. Genau
deshalb dieser und kein selbst erzeugter: Ein synthetischer Klick mit fallender
Tonhöhe klingt nach Laserpistole, nicht nach Uhr.

**Lizenz:** Apache License 2.0 (AOSP), Copyright The Android Open Source
Project. Weitergabe erlaubt, dieser Hinweis muss erhalten bleiben.

**Bearbeitung:** Ogg-Vorbis dekodiert, auf Mono gemischt, auf die ersten 34ms
gekürzt (danach ist er still), Spitzenpegel auf 0,70 normiert, letzte 3ms
ausgeblendet. 16 Bit, 44,1 kHz. Die Abspiel-Lautstärke steht in
[`lib/ui/tick.ts`](../../lib/ui/tick.ts).
