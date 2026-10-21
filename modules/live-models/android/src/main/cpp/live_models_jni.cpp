/**
 * JNI-Hülle der Live-Modell-Ebene für `expo.modules.livemodels.LiveModelsNative`.
 */
#include <jni.h>

#include <string>
#include <vector>

#include "live_models_core.hpp"

namespace {
std::string str(JNIEnv* env, jstring s) {
    const char* c = env->GetStringUTFChars(s, nullptr);
    std::string out(c);
    env->ReleaseStringUTFChars(s, c);
    return out;
}
std::vector<double> doubles(JNIEnv* env, jdoubleArray a) {
    std::vector<double> v(static_cast<size_t>(env->GetArrayLength(a)));
    env->GetDoubleArrayRegion(a, 0, static_cast<jsize>(v.size()), v.data());
    return v;
}
}  // namespace

extern "C" {

JNIEXPORT jlong JNICALL Java_expo_modules_livemodels_LiveModelsNative_nativeCreateHost(JNIEnv*, jclass) {
    return reinterpret_cast<jlong>(lm::createHost());
}

JNIEXPORT void JNICALL Java_expo_modules_livemodels_LiveModelsNative_nativeLoadMesh(JNIEnv* env, jclass, jstring name, jbyteArray data) {
    std::vector<uint8_t> buf(static_cast<size_t>(env->GetArrayLength(data)));
    env->GetByteArrayRegion(data, 0, static_cast<jsize>(buf.size()), reinterpret_cast<jbyte*>(buf.data()));
    lm::loadMesh(str(env, name), buf.data(), buf.size());
}

JNIEXPORT void JNICALL Java_expo_modules_livemodels_LiveModelsNative_nativeSetRoute(JNIEnv* env, jclass, jdoubleArray lngLat, jdoubleArray cum) {
    const auto ll = doubles(env, lngLat);
    const auto c = doubles(env, cum);
    if (ll.size() < c.size() * 2) return;
    lm::setRoute(ll.data(), c.data(), c.size());
}

JNIEXPORT void JNICALL Java_expo_modules_livemodels_LiveModelsNative_nativeSetVehicle(JNIEnv* env, jclass, jint kind, jstring head, jstring mid, jdoubleArray params) {
    const auto p = doubles(env, params);
    lm::setVehicle(kind, str(env, head), str(env, mid), p.data(), p.size());
}

JNIEXPORT void JNICALL Java_expo_modules_livemodels_LiveModelsNative_nativeSetMotion(JNIEnv* env, jclass, jdoubleArray m) {
    const auto p = doubles(env, m);
    lm::setMotion(p.data(), p.size());
}

JNIEXPORT void JNICALL Java_expo_modules_livemodels_LiveModelsNative_nativeClear(JNIEnv*, jclass) { lm::clear(); }

JNIEXPORT jboolean JNICALL Java_expo_modules_livemodels_LiveModelsNative_nativeIsMoving(JNIEnv*, jclass) {
    return lm::isMoving() ? JNI_TRUE : JNI_FALSE;
}

}  // extern "C"
