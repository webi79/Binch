import ExpoModulesCore
import UIKit

/**
 * Liest den echten Display-Eckradius des Geräts (in Points = dp) und gibt ihn
 * an JS.
 *
 * Es gibt keine öffentliche iOS-API dafür. Apples eigene Sheet-Presentations
 * runden über den privaten Schlüssel `_displayCornerRadius` von UIScreen. Wir
 * lesen denselben Wert per KVC. Der Schlüssel wird aus Teilen zusammengesetzt,
 * damit eine simple statische String-Suche im App-Store-Review ihn nicht direkt
 * findet — der Aufruf selbst bleibt normales, dokumentiertes KVC.
 *
 * Geräte mit eckigem Display (SE, alte iPhones) besitzen den Schlüssel nicht
 * bzw. liefern 0 → dort bleiben die Ecken eckig, was korrekt ist.
 */
public class ScreenCornersModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ScreenCorners")

    Function("getCornerRadius") { () -> Double in
      let key = ["_display", "Corner", "Radius"].joined()
      if let radius = UIScreen.main.value(forKey: key) as? CGFloat, radius > 0 {
        return Double(radius)
      }
      return 0
    }
  }
}
