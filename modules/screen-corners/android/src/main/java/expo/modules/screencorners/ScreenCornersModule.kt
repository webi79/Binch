package expo.modules.screencorners

import android.content.res.Resources
import android.os.Build
import android.view.RoundedCorner
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Liest den echten Display-Eckradius des Geräts und gibt ihn in dp zurück.
 *
 * Drei Stufen (siehe getCornerRadius):
 *   1. Ab Android 12 (API 31): WindowInsets.getRoundedCorner() — der offizielle,
 *      exakte Weg. Braucht ein attached Window (rootWindowInsets), was beim
 *      allerersten Aufruf noch fehlen kann → dann greift Stufe 2.
 *   2. Versteckte System-Dimension `rounded_corner_radius` — auf vielen OEMs
 *      (MIUI/HyperOS, Samsung u.a.) vorhanden, sofort verfügbar, kein Window
 *      nötig.
 *   3. 0 → kein runder Bezel erkennbar (die JS-Seite nimmt dann ihren Fallback,
 *      bzw. behandelt echte 0-Geräte als eckig).
 *
 * Alles in dp normalisiert (px / density), damit die JS-/RN-Styles den Wert
 * direkt als borderRadius verwenden können.
 */
class ScreenCornersModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ScreenCorners")

    Function("getCornerRadius") {
      val activity = appContext.currentActivity
      val resources: Resources =
        activity?.resources ?: appContext.reactContext?.resources ?: return@Function 0.0
      val density = resources.displayMetrics.density.takeIf { it > 0f } ?: 1f

      // 1) Offiziell ab API 31.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val insets = activity?.window?.decorView?.rootWindowInsets
        val radiusPx = insets?.getRoundedCorner(RoundedCorner.POSITION_TOP_LEFT)?.radius ?: 0
        if (radiusPx > 0) {
          return@Function (radiusPx / density).toDouble()
        }
      }

      // 2) Versteckte OEM-Dimension.
      val resId = resources.getIdentifier("rounded_corner_radius", "dimen", "android")
      if (resId > 0) {
        val px = resources.getDimensionPixelSize(resId)
        if (px > 0) {
          return@Function (px / density).toDouble()
        }
      }

      // 3) Nichts gefunden.
      0.0
    }
  }
}
