#pragma once
/**
 * Schnittstelle der Live-Modell-Ebene — portabel (Android und die Linux-Probe
 * im Fork). Umsetzung und Begründungen: live_models_core.cpp.
 */
#include <mln/style/layers/custom_layer_host.hpp>

#include <cstddef>
#include <cstdint>
#include <string>

namespace lm {

/** Neue Ebene für die Karte — die Karte übernimmt den Zeiger und löscht ihn. */
mln::style::CustomLayerHost* createHost();
/** Netz „BLM1" (build-live-models.mjs). */
void loadMesh(const std::string& name, const uint8_t* data, size_t len);
/** Strecke: n Punkte (Länge, Breite abwechselnd) und Meter ab Beginn. */
void setRoute(const double* lngLat, const double* cum, size_t n);
/** Fahrzeug, siehe Belegung von `p` in live_models_core.cpp (`setVehicle`). */
void setVehicle(int kind, const std::string& headMesh, const std::string& midMesh, const double* p, size_t n);
/** Boden: t0, d0, t1, d1. Flug: t0, Länge, Breite, Höhe, Kurs, t1, Länge, Breite, Höhe, Kurs. */
void setMotion(const double* p, size_t n);
void clear();
/** Bewegt es sich gerade? Sonst braucht die Karte keine neuen Bilder. */
bool isMoving();

}  // namespace lm
