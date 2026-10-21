cmake_minimum_required(VERSION 3.22.1)
project(livemodels CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Nur die Header der Ebenen-Schnittstelle (Prefab aus dem MapLibre-AAR).
find_package(MapLibreAndroid REQUIRED CONFIG)

add_library(livemodels SHARED live_models_core.cpp live_models_jni.cpp)
target_link_libraries(livemodels MapLibreAndroid::maplibre GLESv3 log)
