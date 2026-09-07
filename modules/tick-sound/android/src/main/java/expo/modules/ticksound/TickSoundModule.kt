package expo.modules.ticksound

import android.media.AudioAttributes
import android.media.SoundPool
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Der Klick des Zahlenrades — über `SoundPool`, nicht über einen Media-Player.
 *
 * Warum überhaupt nativ: `expo-audio` fährt auf Android einen ExoPlayer, und der
 * ist für Streams gebaut. Sein `play()` reicht über den Haupt-Looper zum Player,
 * der Ton beginnt erst, wenn die Ausgabe angelaufen ist — für Musik unerheblich,
 * für einen Klick, der zu einer Zahl gehört, deutlich zu spät. Dazu endet ein
 * Media-Player nach dem Stück; jeder weitere Klick braucht erst ein Zurückspulen,
 * und das ist eine Zusage, die später eingelöst wird. Genau daher kamen „kommt
 * verzögert" und „kommt gar nicht".
 *
 * `SoundPool` ist für diesen Fall gemacht: Der Klang liegt entpackt im Speicher,
 * `play()` startet ihn sofort, und mehrere Anschläge dürfen sich überlagern,
 * ohne dass ein Abspieler zurückgespult werden müsste.
 *
 * Zwei Entscheidungen, die man der Ausgabe nicht ansieht:
 *
 *  - `USAGE_MEDIA` statt `USAGE_ASSISTANCE_SONIFICATION`: Der Klick hängt damit
 *    an der Medien-Lautstärke, so wie bisher — er bleibt hörbar, wenn das
 *    Klingeln stumm ist. An der System-Lautstärke wäre er auf vielen Geräten
 *    schlicht weg.
 *  - `SoundPool` fordert KEINEN Audio-Fokus an. Laufende Musik wird also weder
 *    angehalten noch leiser — anders als beim Media-Player, wo genau das
 *    verhindert werden musste.
 */
class TickSoundModule : Module() {
  private var pool: SoundPool? = null
  private var soundId = 0
  private var loaded = false

  override fun definition() = ModuleDefinition {
    Name("TickSound")

    /**
     * Anlegen und den Klang in den Speicher laden. Das Laden läuft nebenher;
     * bis es fertig ist, bleibt `play()` still — beim Blatt passiert das lange
     * vor dem ersten Anschlag.
     */
    // Kein `return@Function` in diesen Blöcken: Der Rückgabetyp der Lambdas
    // wird abgeleitet, und ein vorzeitiges Unit passt dann nicht zum Rest.
    Function("prime") {
      val context = appContext.reactContext
      if (pool == null && context != null) {
        val attributes = AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
          .build()
        val created = SoundPool.Builder()
          .setMaxStreams(MAX_STREAMS)
          .setAudioAttributes(attributes)
          .build()
        created.setOnLoadCompleteListener { _, _, status -> loaded = status == 0 }
        soundId = created.load(context, R.raw.tick, 1)
        pool = created
      }
      Unit
    }

    Function("play") { volume: Float ->
      val current = pool
      if (current != null && loaded) {
        val level = volume.coerceIn(0f, 1f)
        current.play(soundId, level, level, 1, 0, 1f)
      }
      Unit
    }

    Function("release") {
      pool?.release()
      pool = null
      loaded = false
      soundId = 0
      Unit
    }

    OnDestroy {
      pool?.release()
      pool = null
    }
  }

  companion object {
    /** Mehr als vier Anschläge liegen bei 60ms Mindestabstand nie übereinander. */
    private const val MAX_STREAMS = 4
  }
}
