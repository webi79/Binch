package expo.modules.mapcover

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Choreographer
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import com.facebook.react.bridge.ReactContext
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.common.UIManagerType
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.Promise
import expo.modules.kotlin.views.ExpoView
import org.maplibre.android.maps.MapView
import kotlin.math.pow

/**
 * DAS STANDBILD BEIM WECHSEL DES KARTENTYPS.
 *
 * Ein neuer Kartentyp ist in der App eine NEUE Karte (`key` an der
 * Kartenfläche), und die ist leer, bis sie gezeichnet hat. Darüber liegt so
 * lange ein Bild der alten Karte. Das lag bis 06.11.2026 als JPEG-Datei in
 * einem `<Image>` (blitzfrei, aber langsam: „es dauert voll lange, vor allem
 * beim Satelliten"). Gemessen am Gerät (Sonde im Server-Protokoll) kostete die
 * Kette bis zum Tausch rund 300 ms — JPEG schreiben, Datei, ein React-Durchgang
 * fürs Bild, Dekodieren, zwei Bilder Vorlauf, noch ein Durchgang. Und am Ende
 * wartete das Bild auf die LETZTE Kachel samt Einblenden aller Beschriftungen,
 * plus 120 ms Pause — beim Luftbild bis zu 2,3 s pro Kachel vom Server.
 *
 * Diese Ansicht macht beides an Ort und Stelle:
 *  - `capture`: Kartenfläche (`TextureView`) in ein Bitmap kopieren und sofort
 *    selbst zeichnen — kein Kodieren, keine Datei, kein JS dazwischen, und das
 *    Bild ist pixelgenau (vorher JPEG).
 *  - `reveal`: an der neuen Karte lauschen und ausblenden, sobald sie da ist —
 *    ohne Umweg über JS (dessen Strang ist gerade da mit dem Neuaufbau
 *    beschäftigt) und ohne React-Werte: Das Ausblenden schreibt nur den Pinsel
 *    dieser Ansicht, kein React-Durchgang kann es zurücksetzen.
 *
 * WANN „DA": Das erste Bild, in dem MapLibre ALLE Kacheln und Symbole geladen
 * hat (`fully` im Bild-Rückruf), plus `FULL_SETTLE_MS` — die Beschriftungen
 * blenden dann gerade ein und sind beim Überblenden schon zur Hälfte da.
 * Spätestens `capMs` nach dem geladenen Stil: Beim Luftbild kommt die letzte
 * hochauflösende Kachel oft erst nach Sekunden; das grobe Satellitenbild
 * darunter (EOX, auf dem Gerät zwischengespeichert) steht dann längst, und die
 * scharfen Kacheln blenden einzeln darüber ein (MapLibre, 300 ms). Und ganz
 * spätestens `maxMs` nach dem Auftrag (kein Netz, Stil hängt).
 */
class MapCoverView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val main = Handler(Looper.getMainLooper())
  private val paint = Paint(Paint.FILTER_BITMAP_FLAG)
  private val dst = Rect()

  /** Das festgehaltene Kartenbild — `null`: nichts zu zeigen, die Ansicht ist durchsichtig. */
  private var shot: Bitmap? = null
  /** Wo die Kartenfläche relativ zu dieser Ansicht liegt (Bildpunkte). */
  private var offX = 0
  private var offY = 0
  /**
   * Deckkraft des Bildes (0…255) — über den Pinsel, NICHT über `alpha` der
   * Ansicht: Die gehört React (Fabric setzt sie aus `opacity`), und eine
   * Ansicht mit Kindern bekäme für `alpha` eine eigene Zwischenebene in
   * Bildschirmgröße.
   */
  private var coverAlpha = 255

  /** Jeder Auftrag bekommt eine Nummer; verspätete Rückrufe älterer tun nichts. */
  private var token = 0
  private var watched: MapView? = null
  private var styleLoaded = false
  private var fullSeen = false
  private var capDelay = 0L
  private var revealFadeMs = DEFAULT_FADE_MS
  private var revealPromise: Promise? = null

  private var fading = false
  private var fadeStartNs = 0L
  private var fadeMs = DEFAULT_FADE_MS

  init {
    // Eine Gruppen-Ansicht zeichnet sich sonst selbst nicht (nur ihre Kinder).
    setWillNotDraw(false)
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val b = shot ?: return
    paint.alpha = coverAlpha
    dst.set(offX, offY, offX + b.width, offY + b.height)
    canvas.drawBitmap(b, null, dst, paint)
  }

  // ── Festhalten ──────────────────────────────────────────────────────────────

  fun capture(mapTag: Int, promise: Promise) {
    val id = ++token
    stopWatching()
    stopFade()
    settleReveal(false)
    val texture = findMap(mapTag)?.let { findTexture(it) }
    val bitmap =
      try {
        if (texture != null && texture.isAvailable) texture.bitmap else null
      } catch (e: Exception) {
        Log.w(TAG, "capture", e)
        null
      }
    if (texture == null || bitmap == null) {
      dropShot()
      promise.resolve(false)
      return
    }
    val at = IntArray(2)
    val me = IntArray(2)
    texture.getLocationInWindow(at)
    getLocationInWindow(me)
    offX = at[0] - me[0]
    offY = at[1] - me[1]
    // Die Textur schon jetzt hochladen lassen statt im ersten Bild.
    bitmap.prepareToDraw()
    shot = bitmap
    coverAlpha = 255
    invalidate()
    // Im nächsten Bild wird es gezeichnet, ab dem übernächsten steht es auf dem
    // Schirm — erst dann darf JS die alte Karte abbauen.
    afterFrames(2) { promise.resolve(id == token && shot != null) }
  }

  // ── Freigeben ───────────────────────────────────────────────────────────────

  fun reveal(mapTag: Int, capMs: Long, maxMs: Long, fadeMs: Long, promise: Promise) {
    settleReveal(false)
    if (shot == null) {
      promise.resolve(false)
      return
    }
    if (fading) {
      // Blendet schon aus (Berührung) — für JS ist es damit freigegeben.
      promise.resolve(true)
      return
    }
    val id = ++token
    stopWatching()
    revealPromise = promise
    revealFadeMs = fadeMs
    capDelay = capMs
    main.postDelayed(maxRunnable, maxMs)
    watch(mapTag, id, 0)
  }

  fun fadeNow(ms: Long) {
    if (shot == null || fading) return
    startFade(ms)
  }

  /** Alles abbrechen und loslassen (Ansicht abgebaut). */
  fun release() {
    token++
    stopWatching()
    stopFade()
    settleReveal(false)
    dropShot()
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    release()
  }

  /**
   * Die neue Karte suchen — Fabric hängt sie womöglich erst im nächsten Bild
   * ein (wie in modules/live-models) — und an ihr lauschen.
   */
  private fun watch(tag: Int, id: Int, attempt: Int) {
    if (id != token) return
    val v = findMap(tag)
    if (v == null || v.isDestroyed) {
      if (attempt < FIND_TRIES) {
        main.postDelayed({ watch(tag, id, attempt + 1) }, FIND_RETRY_MS)
      } else {
        // Keine Karte, auf die man warten könnte: lieber jetzt freigeben als
        // mit dem Standbild auf `maxMs` warten.
        Log.w(TAG, "reveal: Karte $tag nicht gefunden")
        startFade(revealFadeMs)
      }
      return
    }
    watched = v
    v.addOnDidFinishLoadingStyleListener(styleListener)
    v.addOnDidFinishRenderingFrameListener(frameListener)
    v.addOnDidFinishRenderingMapListener(mapListener)
    v.getMapAsync { m ->
      if (id != token || watched !== v || v.isDestroyed) return@getMapAsync
      // Stil schon geladen, bevor hier gelauscht wurde (JS war spät dran)? Dann
      // jetzt zählen und ein Bild anfordern — eine ruhende Karte meldet sonst
      // keins mehr.
      if (m.style?.isFullyLoaded == true) {
        onStyleLoaded()
        try {
          m.triggerRepaint()
        } catch (e: Exception) {
          Log.w(TAG, "repaint", e)
        }
      }
    }
  }

  private val styleListener = MapView.OnDidFinishLoadingStyleListener { onStyleLoaded() }

  /** Jedes Bild der neuen Karte: Ist es das erste, in dem alles geladen ist? */
  private val frameListener =
    MapView.OnDidFinishRenderingFrameListener { fully, _, _ ->
      if (fully && styleLoaded && !fullSeen) {
        fullSeen = true
        main.postDelayed(fullRunnable, FULL_SETTLE_MS)
      }
    }

  /** Fertig gezeichnet samt aller Einblendungen — dann sofort. */
  private val mapListener =
    MapView.OnDidFinishRenderingMapListener { fully ->
      if (fully && styleLoaded) startFade(revealFadeMs)
    }

  private val fullRunnable = Runnable { startFade(revealFadeMs) }
  private val capRunnable = Runnable { startFade(revealFadeMs) }
  private val maxRunnable = Runnable { startFade(revealFadeMs) }

  private fun onStyleLoaded() {
    if (styleLoaded) return
    styleLoaded = true
    main.postDelayed(capRunnable, capDelay)
  }

  private fun stopWatching() {
    watched?.let { v ->
      // Die Listen in MapLibre sind Kopie-beim-Schreiben — Abmelden mitten im
      // Rückruf ist sicher.
      try {
        v.removeOnDidFinishLoadingStyleListener(styleListener)
        v.removeOnDidFinishRenderingFrameListener(frameListener)
        v.removeOnDidFinishRenderingMapListener(mapListener)
      } catch (e: Exception) {
        Log.w(TAG, "unwatch", e)
      }
    }
    watched = null
    styleLoaded = false
    fullSeen = false
    main.removeCallbacks(fullRunnable)
    main.removeCallbacks(capRunnable)
    main.removeCallbacks(maxRunnable)
  }

  // ── Ausblenden ──────────────────────────────────────────────────────────────

  private fun startFade(ms: Long) {
    if (shot == null || fading) return
    stopWatching()
    fading = true
    fadeStartNs = 0L
    fadeMs = ms.coerceAtLeast(1L)
    settleReveal(true)
    Choreographer.getInstance().postFrameCallback(fadeFrame)
  }

  /**
   * Bild für Bild im Display-Takt, nach der Uhr des Takts — unabhängig von
   * der Animations-Skala des Systems (Entwickleroptionen, Energiesparen), die
   * ein `ValueAnimator` mitnähme.
   */
  private val fadeFrame =
    object : Choreographer.FrameCallback {
      override fun doFrame(frameTimeNanos: Long) {
        if (!fading) return
        if (fadeStartNs == 0L) fadeStartNs = frameTimeNanos
        val p = ((frameTimeNanos - fadeStartNs) / 1_000_000.0 / fadeMs).coerceIn(0.0, 1.0)
        // Weich an beiden Enden (wie `Easing.inOut(Easing.quad)`).
        val e = if (p < 0.5) 2 * p * p else 1 - (-2 * p + 2).pow(2) / 2
        coverAlpha = (255 * (1 - e)).toInt().coerceIn(0, 255)
        invalidate()
        if (p >= 1.0) {
          fading = false
          dropShot()
          return
        }
        Choreographer.getInstance().postFrameCallback(this)
      }
    }

  private fun stopFade() {
    if (!fading) return
    fading = false
    Choreographer.getInstance().removeFrameCallback(fadeFrame)
  }

  /**
   * Bild loslassen. KEIN `recycle()`: Die Zeichenliste des letzten Bildes kann
   * es noch einen Takt lang halten — der Speicher geht mit der Müllabfuhr.
   */
  private fun dropShot() {
    shot = null
    coverAlpha = 255
    invalidate()
  }

  private fun settleReveal(started: Boolean) {
    val p = revealPromise ?: return
    revealPromise = null
    p.resolve(started)
  }

  // ── Hilfen ──────────────────────────────────────────────────────────────────

  private fun afterFrames(n: Int, block: () -> Unit) {
    Choreographer.getInstance().postFrameCallback {
      if (n <= 1) block() else afterFrames(n - 1, block)
    }
  }

  private fun findMap(tag: Int): MapView? {
    if (tag < 0) return null
    val ctx = appContext.reactContext as? ReactContext ?: return null
    return try {
      UIManagerHelper.getUIManager(ctx, UIManagerType.FABRIC)?.resolveView(tag) as? MapView
    } catch (e: Exception) {
      null
    }
  }

  private fun findTexture(v: View): TextureView? {
    if (v is TextureView) return v
    if (v is ViewGroup) {
      for (i in 0 until v.childCount) findTexture(v.getChildAt(i))?.let { return it }
    }
    return null
  }

  companion object {
    private const val TAG = "MapCover"
    private const val DEFAULT_FADE_MS = 320L
    /**
     * Nach dem ersten vollständigen Bild noch so lange stehen lassen: Die
     * Beschriftungen blenden gerade ein (MapLibre, 300 ms) und sind beim
     * Überblenden dann schon zur Hälfte da — die Namen „atmen" nicht.
     */
    private const val FULL_SETTLE_MS = 140L
    /** Die neu aufgebaute Karte suchen: so oft, so lange Abstand (ms) — zusammen rund 1 s. */
    private const val FIND_TRIES = 60
    private const val FIND_RETRY_MS = 16L
  }
}
