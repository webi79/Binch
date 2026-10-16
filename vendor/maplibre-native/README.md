# MapLibre Native mit Globus (selbst gebaut)

Die Karte zeichnet sich weit draußen selbst als Erdkugel und geht beim
Hineinzoomen nahtlos in die flache Karte über — ein Renderer, wie in Google
Earth. Dazu kommen Atmosphäre, Sterne, Milchstraße und der Tag-und-Nacht-Schatten
auf der Erde. Die veröffentlichten MapLibre-Versionen (bis 13.6.1) können das
nicht; es steckt in zwei offenen Pull Requests:

- [maplibre/maplibre-native#4533](https://github.com/maplibre/maplibre-native/pull/4533)
  — „render the map as a globe when the style sets projection" (Globus),
- [maplibre/maplibre-native#4534](https://github.com/maplibre/maplibre-native/pull/4534)
  — `sky` mit physikalischer Atmosphäre (`atmosphere-blend`), aufgesetzt auf
  #4533.

Bis beides veröffentlicht ist, liegt hier die daraus gebaute Android-Bibliothek
als kleines Maven-Verzeichnis.

- Eingebunden über `plugins/withMaplibreGlobe.js` (Maven-Quelle +
  `org.maplibre.reactnative.nativeVersion`), eingeschaltet über
  `projection` und `sky` in `components/surroundings/mapStyle.ts`.
- Version `13.6.1-globe.6` (08.10.2026), zusammengesetzt aus:
  1. Zweig `ClayWarren:codex/sky-style-spec-4414` (#4534), Stand `5f8dbc2f` —
     enthält den Globus bis Phase 12n,
  2. darauf Phase 12o aus #4533 (`e8ba14f` auf `johncarmack1984:phased/12h`,
     „draw only the uncovered parts of raster tiles on the globe") per
     `git cherry-pick`,
  3. darauf unser Patch [`patches/0001-binch-himmel-und-pole.patch`](patches/0001-binch-himmel-und-pole.patch):
     - im Atmosphären-Durchgang (`shaders/atmosphere.fragment.glsl`, `sky_pass.cpp`):
       Sterne (im Shader), die Milchstraße als Foto, Tag-und-Nacht-Schatten und
       ein schwacher Schein um die Erde. Er läuft ZWEIMAL: als Hintergrund vor
       allen Ebenen (das All) und als Überzug danach (Dunst, Nachtschatten) — in
       einem Durchgang nach den Ebenen übermalte das deckende All alles, was über
       den Erdrand ragt;
     - im Raster-Shader: weiche Polkappen. Mercator-Kacheln enden bei 85,05°, den
       Rest zog der Globus als Fächer aus der obersten Pixelzeile; jetzt verwischt
       und in eine feste Polfarbe auslaufend;
     - **gehobene Linien** für die Flugbögen: In Linien-Ebenen, deren ID mit
       `binch-arc` beginnt (`LineLayerTweaker` setzt dann ein Kennzeichen im
       Eigenschaften-Block), hebt `line.vertex.glsl` jeden Punkt auf
       `line-gap-width` (Kilometer) · sin(π · Fortschritt) — der Fortschritt kommt
       aus der Linien-Metrik der Quelle. Das Band liegt im Bildschirmraum (quer
       zur projizierten Richtung samt Steigung; dafür die Mercator-Länge des
       Fluges über `line-offset`), ohne Kachel-Stencil (ein gehobener Bogen
       erscheint über fremden Kacheln) und mit der echten Sichtbarkeit gehobener
       Punkte (Sichtlinie verfehlt die Kugel) statt der Horizontebene;
     - **Mip-Stufen für Raster-Kacheln**: Der GL-Teil überging `mipmapped`
       ganz; am Rand des Globus verkleinerte Kacheln grisselten. Nur für Kacheln,
       die auf dem Globus unter Zoom 7 angelegt werden;
     - **Stencil-Fehler**: Einfache Ebenengruppen setzten für 3D-Drawables keinen
       Stencil — die Atmosphäre erbte den Kachel-Stenciltest der zuletzt
       gezeichneten Linie und verschwand ganz (`layer_group_gl.cpp`);
     - **Zoom-Nachlaufen in Schritten** (`MapGestureDetector.createScaleAnimator`):
       Feste Zoomwerte je Bild machten auf dem Globus den Breiten-Ausgleich von
       `zoomAroundPoint` zunichte — die Kugel sprang nach einer Zoomgeste kurz
       auf das 1,5- bis 3-Fache;
     - **leere Kachelwahl von oben** (`bounding_volumes.cpp`,
       `idealNearFarPlaneDistance`): Beim Blick senkrecht nach unten wurde ein
       Vektor der Länge ~1e-16 — reines Rundungsrauschen — auf Länge 1 gebracht
       und als Richtung benutzt. Bei manchen Kamerastellungen rückte die
       Fernebene des Sichtkörpers dadurch vor die Kugel, keine Kachel galt als
       sichtbar, und die Karte blieb schwarz, bis sich die Kamera wieder
       bewegte. Jetzt in geschlossener Form; Test
       `TileCover.GlobeTopDownCoverIsNeverEmpty`.
- Die Milchstraße ist [`sky/milkyway.jpg`](sky/milkyway.jpg): „The Milky Way
  panorama" von **ESO/S. Brunier** (eso0932a, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)),
  zugeschnitten auf ±50° galaktische Breite, Sterne per Medianfilter entfernt,
  4096 × 1138. Sie wird als Header in die Bibliothek eingebettet
  (`sky/embed.py`) und im Hintergrund dekodiert. **Die Nennung ist Pflicht** —
  sie steht über die Quelle `sky-credit` in `mapStyle.ts` im ⓘ-Dialog.
- Die POM ist die offizielle von 13.6.1, nur mit geänderter Versionsnummer —
  gleiche Abhängigkeiten.
- Alle vier Architekturen (`arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`).

## Neu bauen

Voraussetzungen im Android-SDK: NDK `28.2.13676358`, CMake `3.31.6` (über
`sdkmanager`), Java 17. Auf 10 Kernen dauert eine Architektur rund 8 Minuten.

```bash
git clone https://github.com/ClayWarren/maplibre-native.git mln-globe
cd mln-globe
git checkout -b binch-globe-sky 5f8dbc2f
git remote add carmack https://github.com/johncarmack1984/maplibre-native.git
git fetch carmack phased/12h && git cherry-pick e8ba14f
git am <projekt>/vendor/maplibre-native/patches/0001-binch-himmel-und-pole.patch
python3 <projekt>/vendor/maplibre-native/sky/embed.py src/mln/renderer/binch_milkyway.hpp
git submodule update --init --recursive --depth 1 --jobs 8
# Nach Änderungen an shaders/*.glsl: node shaders/generate_shader_code.mjs
cd platform/android && echo "sdk.dir=$HOME/Android/Sdk" > local.properties
# Speicher: 15 GB reichen mit 10 Kernen; mit allen 24 droht OOM.
taskset -c 0-9 ./gradlew --no-daemon --max-workers=4 \
  '-Pmaplibre.abis=arm64-v8a armeabi-v7a x86 x86_64' \
  :MapLibreAndroid:assembleOpenglRelease
cp MapLibreAndroid/build/outputs/aar/MapLibreAndroid-opengl-release.aar \
  <projekt>/vendor/maplibre-native/org/maplibre/gl/android-sdk-opengl/13.6.1-globe.6/android-sdk-opengl-13.6.1-globe.6.aar
```

Bei jedem neuen Stand die Versionsnummer hochzählen (`-globe.7`: Verzeichnis,
Dateinamen, POM und `VERSION` im Plugin), sonst nimmt Gradle die alte Datei aus
seinem Zwischenspeicher.

## Vorschau ohne Handy

Der Shader lässt sich unter Linux prüfen, ohne eine App zu bauen:
`mbgl-render` aus demselben Stand (`cmake --preset linux-opengl` im
Docker-Image des Repos, `docker/`) rendert einen Stil als PNG, mit `xvfb-run`
auch ohne Bildschirm. Den Stil dafür als JSON aus `buildMapStyle()` erzeugen.
Beim Docker-Lauf das Cache-Verzeichnis einhängen
(`-v $PWD/docker/.cache:/home/ubuntu/.cache`), sonst startet der Container
nicht. `mbgl-render` zeichnet nur EIN Bild — bis dahin ist die im Hintergrund
dekodierte Milchstraße nicht fertig. Für die Vorschau deshalb vorübergehend
`BINCH_SKY_WAIT_MS` in `sky_pass.cpp` auf 5000 setzen (für die Bibliothek
wieder 0).

## Sobald MapLibre Globus und Himmel veröffentlicht

Dieses Verzeichnis und das Plugin löschen, maplibre-react-native auf die
offizielle Version heben. `projection` und `sky` im Stil bleiben; Sterne und
Milchstraße kann die offizielle Fassung voraussichtlich nicht — dann entweder
den Patch dort einbringen oder darauf verzichten.
