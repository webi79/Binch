package expo.modules.mapcover

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * DAS STANDBILD BEIM WECHSEL DES KARTENTYPS — als eigene Ansicht über der
 * Karte (Umsetzung und Begründung in `MapCoverView`).
 *
 * Die Funktionen hängen an der Ansicht (`ref.current.capture(…)` in JS) und
 * laufen auf dem UI-Strang (für Ansichts-Funktionen fest so in
 * expo-modules-core).
 */
class MapCoverModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MapCover")

    View(MapCoverView::class) {
      /** Bild der Karte mit dieser Kennung festhalten und zeigen — `true`, sobald es auf dem Schirm steht. */
      AsyncFunction("capture") { view: MapCoverView, mapTag: Int, promise: Promise ->
        view.capture(mapTag, promise)
      }

      /**
       * Auf die NEUE Karte mit dieser Kennung warten, dann ausblenden. Erfüllt
       * mit `true`, sobald das Ausblenden beginnt; mit `false`, wenn ein
       * neuerer Auftrag diesen ablöst oder nichts zu zeigen ist.
       */
      AsyncFunction("reveal") { view: MapCoverView, mapTag: Int, capMs: Int, maxMs: Int, fadeMs: Int, promise: Promise ->
        view.reveal(mapTag, capMs.toLong(), maxMs.toLong(), fadeMs.toLong(), promise)
      }

      /** Sofort ausblenden — die Karte wird angefasst, ein Standbild bewegt sich nicht mit. */
      AsyncFunction("fadeNow") { view: MapCoverView, fadeMs: Int ->
        view.fadeNow(fadeMs.toLong())
      }

      OnViewDestroys { view -> view.release() }
    }
  }
}
