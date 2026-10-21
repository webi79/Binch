package expo.modules.livemodels

import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Choreographer
import com.facebook.react.bridge.ReactContext
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.common.UIManagerType
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.maplibre.android.maps.MapLibreMap
import org.maplibre.android.maps.MapView
import org.maplibre.android.maps.Style
import org.maplibre.android.style.layers.CustomLayer

/**
 * DIE 3D-FAHRZEUGE DER LIVE-ANSICHT als eigene Ebene IN der Karte.
 *
 * Hängt eine MapLibre-`CustomLayer` (C++/OpenGL, `src/main/cpp`) in die Karte
 * von maplibre-react-native — gefunden über deren Ansichts-Kennung
 * (`getNativeTag`, Patch an MLRN). Die Ebene zeichnet echte 3D-Netze fest in
 * der Welt; Lage, Wagenkette und Größe rechnet sie in jedem Bild selbst
 * (Begründung in live_models_core.cpp).
 *
 * Steht die Kamera still, zeichnet die Karte keine neuen Bilder — solange das
 * Fahrzeug fährt, stößt sie dieses Modul deshalb in jedem Display-Takt an.
 *
 * EIN NEUER KARTENSTIL wirft alle Ebenen weg, auch diese („wechsle ich den
 * Stil, sind die Modelle weg"). MLRN hängt danach nur seine eigenen wieder ein —
 * diese hier hängt sich deshalb selbst wieder ein, sobald der Stil geladen ist
 * (MapLibre meldet das zuerst an MLRN, die Halte-Beschriftung steht also schon
 * da). Zur Sicherheit sieht der Takt zweimal je Sekunde nach, ob sie noch da ist
 * und unter der Beschriftung liegt.
 */
class LiveModelsModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private var map: MapLibreMap? = null
  private var view: MapView? = null
  /** Unter dieser Ebene einhängen (die Halte-Beschriftung bleibt lesbar). */
  private var below: String? = null
  /** Liegt sie unter `below`? Fehlte die beim Einhängen, rückt sie später nach. */
  private var placed = false
  private var repainting = false
  private var lastCheck = 0L
  /** Zählt jedes attach/detach — ein verspäteter Rückruf eines früheren gilt nicht. */
  private var gen = 0

  private val styleLoaded = MapView.OnDidFinishLoadingStyleListener {
    try {
      ensureLayer()
    } catch (e: Exception) {
      Log.w(TAG, "style", e)
    }
  }

  private val frame = object : Choreographer.FrameCallback {
    override fun doFrame(frameTimeNanos: Long) {
      val m = map ?: run { repainting = false; return }
      if (LiveModelsNative.nativeIsMoving()) m.triggerRepaint()
      if (frameTimeNanos - lastCheck > CHECK_NS) {
        lastCheck = frameTimeNanos
        try {
          ensureLayer()
        } catch (e: Exception) {
          Log.w(TAG, "check", e)
        }
      }
      Choreographer.getInstance().postFrameCallback(this)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("LiveModels")

    /** Ebene einhängen; die Netze (Assets „livemodels“) einmal je Prozess laden. */
    AsyncFunction("attach") { tag: Int, belowId: String?, promise: Promise ->
      val ctx = appContext.reactContext as? ReactContext
      if (ctx == null) {
        promise.resolve(false)
        return@AsyncFunction
      }
      main.post {
        val myGen = ++gen
        try {
          loadMeshes(ctx)
          val v = UIManagerHelper.getUIManager(ctx, UIManagerType.FABRIC)?.resolveView(tag) as? MapView
          if (v == null) {
            promise.resolve(false)
            return@post
          }
          view?.removeOnDidFinishLoadingStyleListener(styleLoaded)
          view = v
          below = belowId
          placed = false
          v.addOnDidFinishLoadingStyleListener(styleLoaded)
          v.getMapAsync { m ->
            if (gen != myGen) return@getMapAsync
            map = m
            // Lädt der Stil gerade, kommt dieser Rückruf erst danach.
            m.getStyle { if (gen == myGen) ensureLayer() }
            if (!repainting) {
              repainting = true
              Choreographer.getInstance().postFrameCallback(frame)
            }
            promise.resolve(true)
          }
        } catch (e: Exception) {
          Log.w(TAG, "attach", e)
          promise.resolve(false)
        }
      }
    }

    /**
     * Ebene abnehmen. Die Daten im Speicher bleiben stehen: Hängt sich gleich
     * eine neue Ebene ein (Neuaufbau des Bauteils), hat die ihre Strecke und
     * ihr Fahrzeug schon geschickt — synchron, also VOR diesem Auftrag hier.
     * Ein Löschen träfe genau die. Ohne Ebene zeichnet ohnehin nichts.
     */
    AsyncFunction("detach") { promise: Promise ->
      main.post {
        gen++
        try {
          map?.style?.let { style -> style.getLayer(LAYER_ID)?.let { style.removeLayer(it) } }
        } catch (e: Exception) {
          Log.w(TAG, "detach", e)
        }
        view?.removeOnDidFinishLoadingStyleListener(styleLoaded)
        view = null
        map = null
        placed = false
        promise.resolve(true)
      }
    }

    Function("setRoute") { lngLat: DoubleArray, cum: DoubleArray ->
      LiveModelsNative.nativeSetRoute(lngLat, cum)
    }

    Function("setVehicle") { kind: Int, headMesh: String, midMesh: String, params: DoubleArray ->
      LiveModelsNative.nativeSetVehicle(kind, headMesh, midMesh, params)
    }

    Function("setMotion") { motion: DoubleArray ->
      LiveModelsNative.nativeSetMotion(motion)
    }
  }

  /** Fehlt die Ebene im aktuellen Stil oder liegt sie noch nicht unter `below`: neu einhängen. */
  private fun ensureLayer() {
    val m = map ?: return
    // Null, solange ein Stil lädt — dann kommt `styleLoaded`.
    val style = m.style ?: return
    val missing = style.getLayer(LAYER_ID) == null
    val anchor = below?.let { style.getLayer(it) } != null
    if (missing || (!placed && anchor)) place(style)
  }

  private fun place(style: Style) {
    style.getLayer(LAYER_ID)?.let { style.removeLayer(it) }
    val layer = CustomLayer(LAYER_ID, LiveModelsNative.nativeCreateHost())
    val b = below
    if (b != null && style.getLayer(b) != null) {
      style.addLayerBelow(layer, b)
      placed = true
    } else {
      style.addLayer(layer)
      placed = b == null
    }
  }

  private fun loadMeshes(ctx: ReactContext) {
    if (meshesLoaded) return
    val assets = ctx.assets
    for (file in assets.list("livemodels") ?: emptyArray()) {
      if (!file.endsWith(".bin")) continue
      val bytes = assets.open("livemodels/$file").use { it.readBytes() }
      LiveModelsNative.nativeLoadMesh(file.removeSuffix(".bin"), bytes)
    }
    meshesLoaded = true
  }

  companion object {
    private const val TAG = "LiveModels"
    private const val LAYER_ID = "binch-live-models"
    /** So oft (ns) nachsehen, ob die Ebene noch im Stil hängt. */
    private const val CHECK_NS = 500_000_000L
    @Volatile private var meshesLoaded = false
  }
}
