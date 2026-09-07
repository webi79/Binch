# Klänge

## `tick.wav`

Der Klick des Zahlenrades (Uhrzeit-Blatt im Datumswähler).

**Herkunft:** `mixkit-gate-latch-click-1924.wav` — ausgesucht und beigesteuert,
liegt als Vorlage daneben. Mixkit Free License: Verwendung im Produkt erlaubt,
Weitergabe als Klangdatei nicht. Die Vorlage wird nicht mitgeliefert (Metro packt
nur ein, was auch `require`d wird), sie steht hier nur als Ausgangsmaterial.

**Bearbeitung — und warum:**

1. **133,7 ms Stille am Anfang entfernt.** Das war die gesamte Verzögerung: Ein
   Abspieler spielt die Stille brav mit ab, der Klick kam also eine
   Achtelsekunde nach der Zahl. Die Datei beginnt jetzt 0,8 ms vor dem Anschlag.
2. Hinten auf 52 ms gekürzt (danach ist er still), letzte 5 ms ausgeblendet.
   Die Länge ist kein Zufall: Sie muss unter dem Mindestabstand zweier Klicks
   liegen (60 ms), sonst überlagern sich zwei Anschläge zu einem Kammfilter —
   das klang nach seltsamem Klackern.
3. Von 24 auf 16 Bit, **aber weiterhin Stereo**. Die Mono-Summe war ein Fehler:
   Die beiden Kanäle der Aufnahme sind kaum verwandt (Korrelation +0,25), das
   Zusammenmischen löschte 38 % der Energie aus und machte den Anschlag hohl.
   Bei einer Raumaufnahme mit zwei Mikrofonen ist das kein Vereinfachen,
   sondern ein Eingriff in den Klang.
4. **Pegel unverändert** (Spitze 0,33 — die Mono-Summe kam auf 0,26, auch daran
   sieht man die Auslöschung). Die Lautstärke steht in
   [`lib/ui/tick.ts`](../../lib/ui/tick.ts) und ist dort halbiert worden.

Reproduzierbar: schneiden ab 0,8 ms vor dem ersten Ausschlag über 2 % der
Spitze, 52 ms behalten, letzte 5 ms linear ausblenden, Kanäle unangetastet.

### Verworfen

- **Wecker-Aufnahme** (gemeinfrei, Wikimedia Commons): zwei Anschläge daraus
  abwechselnd gespielt, echtes „Klack Klack" — aber nicht der Klang, der
  gewollt war.
- **AOSP `Effect_Tick`** (Androids eigener `FX_KEY_CLICK`): sauber, aber ein
  weiches UI-Blip, kein Uhrenschlag.
- **Selbst erzeugt** (gedämpfte Sinuswelle mit fallender Tonhöhe): klingt nach
  Laserpistole — eine fallende Tonhöhe auf einem schmalen Ton ist genau deren
  Signatur. Ein Anschlag ist breitbandig und wandert nicht.
