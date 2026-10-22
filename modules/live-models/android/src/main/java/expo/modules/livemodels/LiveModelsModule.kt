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
 *
 * Der Kartentyp-Wechsel in der App baut die Karte sogar ganz NEU auf (`key` an
 * der Kartenfläche): Das alte Bauteil nimmt seine Ebene ab, das neue hängt
 * seine ein — an eine Kartenansicht, die Fabric womöglich erst im nächsten Bild
 * einhängt. Deshalb wird sie mit Wiederholung gesucht (`ATTACH_TRIES`), und
 * jede Einhängung trägt eine Nummer aus JS: `detach` nimmt nur die eigene ab.
 * Beide Aufträge laufen über den Modul-Strang erst auf den UI-Strang — kam das
 * alte `detach` nach dem neuen `attach` an, nahm es die frische Ebene wieder
 * ab, und das Fahrzeug blieb weg („fährt der Zug beim Wechsel, ist er weg").
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
  /** Nummer der Einhängung, die gerade gilt (aus JS) — 0: keine. */
  private var current = 0

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
      // Die Karte schon abgebaut (Kartentyp-Wechsel baut sie neu, und das
      // `detach` aus JS kommt erst danach an)? Dann nichts mehr an ihr anfassen:
      // Ausgerechnet `triggerRepaint` prüft das in MapLibre nicht selbst und
      // stürzt im nativen Teil ab („invalid native peer“) — nur, solange das
      // Fahrzeug fährt, also genau beim Stilwechsel in der Nähe eines Zugs.
      if (view?.isDestroyed != false) {
        release()
        repainting = false
        return
      }
      if (LiveModelsNative.nativeIsMoving()) {
        try {
          m.triggerRepaint()
        } catch (e: IllegalStateException) {
          Log.w(TAG, "repaint", e)
          release()
          repainting = false
          return
        }
      }
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
    AsyncFunction("attach") { tag: Int, belowId: String?, id: Int, promise: Promise ->
      val ctx = appContext.reactContext as? ReactContext
      if (ctx == null) {
        promise.resolve(false)
        return@AsyncFunction
      }
      main.post {
        // Ab jetzt gilt diese Einhängung — ein später ankommendes `detach` der
        // vorigen (andere Nummer) lässt sie in Ruhe.
        current = id
        try {
          loadMeshes(ctx)
        } catch (e: Exception) {
          Log.w(TAG, "attach", e)
          promise.resolve(false)
          return@post
        }
        attachTo(ctx, tag, belowId, id, promise, 0)
      }
    }

    /**
     * Ebene abnehmen. Die Daten im Speicher bleiben stehen: Hängt sich gleich
     * eine neue Ebene ein (Neuaufbau des Bauteils), hat die ihre Strecke und
     * ihr Fahrzeug schon geschickt — synchron, also VOR diesem Auftrag hier.
     * Ein Löschen träfe genau die. Ohne Ebene zeichnet ohnehin nichts.
     */
    AsyncFunction("detach") { id: Int, promise: Promise ->
      main.post {
        // Schon eine neuere Einhängung da (Reihenfolge vertauscht): nichts abnehmen.
        if (id != current) {
          promise.resolve(true)
          return@post
        }
        current = 0
        try {
          if (view?.isDestroyed == false) {
            map?.style?.let { style -> style.getLayer(LAYER_ID)?.let { style.removeLayer(it) } }
          }
        } catch (e: Exception) {
          Log.w(TAG, "detach", e)
        }
        release()
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

  /** Die Kartenansicht suchen (notfalls im nächsten Bild noch einmal) und die Ebene einhängen. */
  private fun attachTo(ctx: ReactContext, tag: Int, belowId: String?, id: Int, promise: Promise, attempt: Int) {
    if (current != id) {
      promise.resolve(false)
      return
    }
    val v =
      try {
        UIManagerHelper.getUIManager(ctx, UIManagerType.FABRIC)?.resolveView(tag) as? MapView
      } catch (e: Exception) {
        null
      }
    if (v == null) {
      if (attempt < ATTACH_TRIES) {
        main.postDelayed({ attachTo(ctx, tag, belowId, id, promise, attempt + 1) }, ATTACH_RETRY_MS)
      } else {
        Log.w(TAG, "attach: Karte $tag nicht gefunden")
        promise.resolve(false)
      }
      return
    }
    try {
      view?.removeOnDidFinishLoadingStyleListener(styleLoaded)
      view = v
      // Die Karte der VORIGEN Ansicht nicht weiter benutzen, bis die neue sich
      // meldet (`getMapAsync` antwortet erst später) — der Takt hätte sonst an
      // der neuen Ansicht vorbei die alte, womöglich schon abgebaute angestoßen.
      map = null
      below = belowId
      placed = false
      v.addOnDidFinishLoadingStyleListener(styleLoaded)
      v.getMapAsync { m ->
        if (current != id) return@getMapAsync
        map = m
        // Lädt der Stil gerade, kommt dieser Rückruf erst danach.
        m.getStyle { if (current == id) ensureLayer() }
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

  /** Karte und Ansicht loslassen (abgenommen oder abgebaut). */
  private fun release() {
    view?.removeOnDidFinishLoadingStyleListener(styleLoaded)
    view = null
    map = null
    placed = false
  }

  /** Fehlt die Ebene im aktuellen Stil oder liegt sie noch nicht unter `below`: neu einhängen. */
  private fun ensureLayer() {
    if (view?.isDestroyed != false) return
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
    /** Die neu aufgebaute Karte suchen: so oft, so lange Abstand (ms) — zusammen 3 s. */
    private const val ATTACH_TRIES = 60
    private const val ATTACH_RETRY_MS = 50L
    @Volatile private var meshesLoaded = false
  }
}
