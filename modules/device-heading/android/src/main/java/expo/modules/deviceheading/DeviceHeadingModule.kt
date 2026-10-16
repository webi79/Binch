package expo.modules.deviceheading

import android.content.Context
import android.hardware.GeomagneticField
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.SystemClock
import androidx.core.os.bundleOf
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.hypot

/**
 * Wohin das Telefon zeigt — für den Blickrichtungs-Kegel am Standortpunkt.
 *
 * WARUM EIN EIGENES MODUL: `expo-location` hat `watchHeadingAsync`, aber auf
 * Android taugt es dafür nicht, nachgelesen in `LocationModule.kt`: Es liest
 * den rohen Beschleunigungs- und den rohen Magnetsensor, beide mit
 * `SENSOR_DELAY_NORMAL` — das sind fünf Messungen pro Sekunde —, rechnet sie
 * ungefiltert zusammen und meldet erst ab zwei Grad Änderung. Ein Kegel daran
 * springt in groben Stufen und zittert, sobald die Hand ruhig ist. Und er
 * kippt, wenn man das Telefon aufrecht hält, weil `getOrientation` dort in den
 * Kardanfehler läuft.
 *
 * Dieses Modul nimmt stattdessen den ROTATIONSVEKTOR — Androids fusionierten
 * Lagesensor aus Beschleunigung, Kreisel und Magnetfeld. Der Kreisel macht ihn
 * ruhig und schnell, das Magnetfeld hält ihn am Norden.
 *
 * Nur Android: Auf iOS liefert `expo-location` den Systemkompass (`CLHeading`),
 * den das System selbst aus seinen Lagesensoren bildet.
 */
class DeviceHeadingModule : Module(), SensorEventListener {
  private var sensorManager: SensorManager? = null
  private var sensor: Sensor? = null
  /** Hat JS um Meldungen gebeten? Übersteht den Wechsel in den Hintergrund. */
  private var wanted = false
  private var registered = false

  /** Missweisung am Standort — Magnetnord zu geografisch Nord, in Grad. */
  private var declination = 0f

  /** Geglättete Richtung als Einheitsvektor — siehe `onSensorChanged`. */
  private var smoothX = 0.0
  private var smoothY = 0.0
  private var hasSmooth = false

  private var lastSentDeg = Double.NaN
  private var lastSentAt = 0L
  private var lastAccuracyDeg = -1.0
  /** Genauigkeit aus `onAccuracyChanged`, falls der Sensor keine eigene mitliefert. */
  private var statusAccuracyDeg = -1.0

  private val rotation = FloatArray(9)

  override fun definition() = ModuleDefinition {
    Name("DeviceHeading")

    Events("onHeading")

    Function("isAvailable") {
      resolveSensor() != null
    }

    Function("start") {
      wanted = true
      register()
      Unit
    }

    Function("stop") {
      wanted = false
      unregister()
      Unit
    }

    /**
     * Den Standort für die Missweisung setzen.
     *
     * Der Rotationsvektor zeigt nach MAGNETISCH Nord, die Karte nach
     * geografisch Nord. In Mitteleuropa liegen dazwischen zwei bis fünf Grad —
     * sichtbar, wenn man an einer geraden Straße entlangschaut.
     */
    Function("setLocation") { latitude: Double, longitude: Double ->
      declination = GeomagneticField(
        latitude.toFloat(),
        longitude.toFloat(),
        0f,
        System.currentTimeMillis(),
      ).declination
      Unit
    }

    // Im Hintergrund schweigt der Sensor — er kostet sonst Strom, und niemand
    // sieht hin. Zurück im Vordergrund geht es weiter, wenn JS noch will.
    OnActivityEntersBackground {
      unregister()
    }

    OnActivityEntersForeground {
      if (wanted) register()
    }

    OnDestroy {
      wanted = false
      unregister()
    }
  }

  private fun resolveSensor(): Sensor? {
    if (sensor != null) return sensor
    val context = appContext.reactContext ?: return null
    val manager = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager ?: return null
    sensorManager = manager
    // Ohne Kreisel gibt es den geomagnetischen Rotationsvektor — unruhiger,
    // aber immer noch besser als die rohe Rechnung von `expo-location`.
    sensor = manager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
      ?: manager.getDefaultSensor(Sensor.TYPE_GEOMAGNETIC_ROTATION_VECTOR)
    return sensor
  }

  private fun register() {
    if (registered) return
    val target = resolveSensor() ?: return
    hasSmooth = false
    lastSentDeg = Double.NaN
    registered = sensorManager?.registerListener(
      this,
      target,
      SensorManager.SENSOR_DELAY_GAME,
    ) == true
  }

  private fun unregister() {
    if (!registered) return
    sensorManager?.unregisterListener(this)
    registered = false
  }

  override fun onSensorChanged(event: SensorEvent) {
    SensorManager.getRotationMatrixFromVector(rotation, event.values)

    /**
     * Die Blickrichtung ohne Kardanfehler.
     *
     * Die Matrix bildet Gerätachsen auf die Welt ab (x Ost, y Nord, z oben).
     * Gebraucht werden zwei Gerätachsen: y, die zur Oberkante zeigt, und −z,
     * die aus der Rückseite heraus zeigt. Liegt das Telefon flach, zeigt y
     * nach vorn und −z in den Boden; hält man es aufrecht, zeigt y in den
     * Himmel und −z nach vorn. In jeder Haltung dazwischen zeigen beide
     * waagrechten Anteile in dieselbe Richtung — ihre Summe verschwindet also
     * nie, und die Richtung springt an keiner Stelle. `getOrientation` dagegen
     * hat genau bei aufrechter Haltung seine Polstelle.
     *
     * Die App ist fest im Hochformat (`app.config.js`), eine Drehung des
     * Bildschirms muss also nicht verrechnet werden.
     */
    val east = (rotation[1] - rotation[2]).toDouble()
    val north = (rotation[4] - rotation[5]).toDouble()
    val length = hypot(east, north)
    if (length < 1e-6) return
    val x = east / length
    val y = north / length

    /**
     * Glätten — als VEKTOR, nicht als Winkel.
     *
     * Ein Winkel liefe beim Übergang von 359 auf 0 Grad durch die falsche
     * Richtung, einmal ganz herum. Der Vektor kennt diese Naht nicht. Der
     * Anteil von einem Viertel je Messung ergibt bei 50 Messungen pro Sekunde
     * eine Nachlaufzeit von rund 80 Millisekunden: Das Zittern der Hand ist
     * weg, eine echte Drehung kommt ohne spürbare Verzögerung an.
     */
    if (!hasSmooth) {
      smoothX = x
      smoothY = y
      hasSmooth = true
    } else {
      smoothX += SMOOTHING * (x - smoothX)
      smoothY += SMOOTHING * (y - smoothY)
    }

    val magnetic = Math.toDegrees(atan2(smoothX, smoothY))
    val heading = ((magnetic + declination) % 360.0 + 360.0) % 360.0

    /**
     * Die Genauigkeit — der Kegel wird breiter, wenn der Kompass unsicher ist.
     *
     * Der Rotationsvektor liefert an fünfter Stelle eine eigene Schätzung in
     * Bogenmaß (−1, wenn unbekannt). Fehlt sie, bleibt die grobe Stufe aus
     * `onAccuracyChanged`.
     */
    val accuracy = if (event.values.size > 4 && event.values[4] >= 0f) {
      Math.toDegrees(event.values[4].toDouble())
    } else {
      statusAccuracyDeg
    }

    // Nicht jede Messung über die Brücke schicken: höchstens dreißig pro
    // Sekunde, und nur, wenn sich sichtbar etwas getan hat.
    val now = SystemClock.uptimeMillis()
    if (now - lastSentAt < MIN_INTERVAL_MS) return
    val moved = lastSentDeg.isNaN() || angleDelta(heading, lastSentDeg) >= MIN_DELTA_DEG
    val accuracyChanged = abs(accuracy - lastAccuracyDeg) >= 5.0
    if (!moved && !accuracyChanged) return
    lastSentAt = now
    lastSentDeg = heading
    lastAccuracyDeg = accuracy
    sendEvent(
      "onHeading",
      bundleOf(
        "heading" to heading,
        "accuracy" to accuracy,
      ),
    )
  }

  override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) {
    statusAccuracyDeg = when (accuracy) {
      SensorManager.SENSOR_STATUS_ACCURACY_HIGH -> 10.0
      SensorManager.SENSOR_STATUS_ACCURACY_MEDIUM -> 25.0
      SensorManager.SENSOR_STATUS_ACCURACY_LOW -> 45.0
      else -> 60.0
    }
  }

  private fun angleDelta(a: Double, b: Double): Double {
    val d = abs(a - b) % 360.0
    return if (d > 180.0) 360.0 - d else d
  }

  companion object {
    private const val SMOOTHING = 0.25
    private const val MIN_INTERVAL_MS = 33L
    private const val MIN_DELTA_DEG = 0.7
  }
}
