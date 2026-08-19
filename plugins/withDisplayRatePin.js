/**
 * Expo-Config-Plugin: Scroll-Judder-Fix für Androids Adaptive Refresh Rate.
 *
 * Hintergrund (Diagnose per Perfetto + AOSP-Quellcode, Juli 2026):
 * Android 15 QPR+/16 „voted" die Panel-Frequenz nach Scroll-Geschwindigkeit
 * (View.convertVelocityToFrameRate: <125dp/s → 60Hz). Auf 120Hz-LTPO-Panels
 * (z.B. Xiaomi HyperOS) schaltet das Display dadurch MITTEN in der ersten
 * Scroll-Geste nach einem Tab-Wechsel zwischen 60/80/120Hz um → sichtbares
 * Judder, obwohl jeder Frame pünktlich ist (gfxinfo 0,2% janky, JS idle).
 *
 * Zwei Hebel, beide beim Prebuild injiziert (android/ ist gitignored — CNG!):
 * 1. styles.xml: android:windowIsFrameRatePowerSavingsBalanced=false
 *    → offizielles dVRR-Gate (ViewRootImpl.shouldEnableDvrr), stoppt das
 *    Anwenden der Votes.
 * 2. MainActivity: preferredDisplayModeId auf den höchsten Hz-Mode der
 *    aktuellen Auflösung + setFrameRatePowerSavingsBalanced(false) zur
 *    Laufzeit — der auf Xiaomi erprobte harte Pin (flutter_displaymode-
 *    Ansatz), erneuert in onResume.
 */
const { withMainActivity, withAndroidStyles } = require("@expo/config-plugins");

const PIN_METHODS = `
  override fun onResume() {
    super.onResume()
    // Pin erneuern, falls das System/Expo die Window-LayoutParams neu aufbaut.
    pinDisplayRate()
  }

  /**
   * Judder-Fix: Androids Adaptive-Refresh-Rate voted die Frequenz nach
   * Scroll-Speed (<125dp/s → 60Hz) — Umschalten mitten in der Geste ruckelt
   * auf LTPO-Panels. Wir pinnen den höchsten Mode der aktuellen Auflösung
   * und schalten das dVRR-Gate ab. Details: plugins/withDisplayRatePin.js
   */
  private fun pinDisplayRate() {
    val lp = window.attributes
    if (android.os.Build.VERSION.SDK_INT >= 35) {
      lp.setFrameRatePowerSavingsBalanced(false)
    }
    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
      val display = windowManager.defaultDisplay
      val current = display?.mode
      val best = display?.supportedModes
        ?.filter {
          it.physicalWidth == current?.physicalWidth &&
            it.physicalHeight == current?.physicalHeight
        }
        ?.maxByOrNull { it.refreshRate }
      if (best != null) lp.preferredDisplayModeId = best.modeId
    }
    window.attributes = lp
  }
`;

function injectMainActivity(src) {
  if (src.includes("pinDisplayRate")) return src; // idempotent

  // 1) Aufruf direkt nach super.onCreate(...) — der Anker existiert in jedem
  //    Expo-Template (mit registerOnActivity davor).
  const onCreateAnchor = /super\.onCreate\((?:null|savedInstanceState)\)/;
  if (!onCreateAnchor.test(src)) {
    throw new Error(
      "withDisplayRatePin: super.onCreate-Anker nicht in MainActivity gefunden — Template geändert?",
    );
  }
  src = src.replace(onCreateAnchor, (m) => `${m}\n    pinDisplayRate()`);

  // 2) Methoden vor der letzten schließenden Klammer (Klassenende) einfügen.
  const lastBrace = src.lastIndexOf("}");
  src = src.slice(0, lastBrace) + PIN_METHODS + "}\n";
  return src;
}

function withDisplayRatePin(config) {
  config = withMainActivity(config, (config) => {
    if (config.modResults.language !== "kt") {
      throw new Error("withDisplayRatePin: erwartet Kotlin-MainActivity.");
    }
    config.modResults.contents = injectMainActivity(config.modResults.contents);
    return config;
  });

  config = withAndroidStyles(config, (config) => {
    const styles = config.modResults;
    const appTheme = (styles.resources.style ?? []).find(
      (s) => s.$?.name === "AppTheme",
    );
    if (appTheme) {
      appTheme.item = appTheme.item ?? [];
      const NAME = "android:windowIsFrameRatePowerSavingsBalanced";
      if (!appTheme.item.some((i) => i.$?.name === NAME)) {
        appTheme.item.push({ _: "false", $: { name: NAME } });
      }
      // Fenster-Hintergrund explizit auf die App-Farbe #1A1A1A. Ohne das fällt er
      // auf den Material3-DayNight-Default zurück (hell #FEF7FF / dunkel #141218)
      // und blitzt bei kurzen Lücken (Tab-Crossfade, Freeze-Commit) durch.
      const BG = "android:windowBackground";
      if (!appTheme.item.some((i) => i.$?.name === BG)) {
        appTheme.item.push({ _: "#1A1A1A", $: { name: BG } });
      }
    }
    return config;
  });

  return config;
}

module.exports = withDisplayRatePin;
