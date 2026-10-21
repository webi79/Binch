package expo.modules.livemodels

/** Brücke zur C++-Ebene (`src/main/cpp/live_models_jni.cpp`). */
object LiveModelsNative {
  init {
    System.loadLibrary("livemodels")
  }

  /** Neue Ebene — die Karte übernimmt den Zeiger (`CustomLayer`) und löscht ihn. */
  @JvmStatic external fun nativeCreateHost(): Long
  @JvmStatic external fun nativeLoadMesh(name: String, data: ByteArray)
  @JvmStatic external fun nativeSetRoute(lngLat: DoubleArray, cum: DoubleArray)
  @JvmStatic external fun nativeSetVehicle(kind: Int, headMesh: String, midMesh: String, params: DoubleArray)
  @JvmStatic external fun nativeSetMotion(motion: DoubleArray)
  @JvmStatic external fun nativeClear()
  @JvmStatic external fun nativeIsMoving(): Boolean
}
