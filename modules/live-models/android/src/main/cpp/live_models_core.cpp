/**
 * DIE 3D-FAHRZEUGE DER LIVE-ANSICHT — eine eigene Ebene IN der Karte
 * (MapLibre `CustomLayerHost`, OpenGL ES 3).
 *
 * Warum nativ: Vorgerenderte Ansichten (Bilder, die zur Kamera schauen)
 * stimmen beim Zoomen, Drehen und Neigen nie ganz mit der Karte — das
 * Flugzeug rutschte von seiner Linie, die Wagen drehten mit dem Blick. Hier
 * stehen echte Netze fest in der Welt, nach Fahrtrichtung ausgerichtet, und
 * die Karte zeichnet sie mit ihrer eigenen Perspektive, flach wie auf der
 * Kugel (Übergang wie in `_prelude.vertex.glsl` des Forks).
 *
 * JE BILD gerechnet, nicht je JS-Takt: JS schickt nur, wo auf der Strecke das
 * Fahrzeug jetzt und in einem Moment ist (`setMotion`); Lage, Wagenkette,
 * Richtung und Größe zum aktuellen Zoom entstehen hier in jedem Bild — auch
 * mitten in einer Geste, ohne Sägezahn.
 *
 * TIEFE: eigene, lineare Tiefe in einem schmalen vordersten Band (0 … ε) —
 * die Modelle liegen über der Karte, verdecken sich untereinander aber genau
 * (Räder hinter dem Bus). Den Tiefenpuffer der Karte (Kugel-Rückseite,
 * Atmosphäre) lassen wir dabei unangetastet.
 *
 * FARBEN malt der Shader aus der Lage auf dem Körper (Fenster, Stege, Türen,
 * Zierstreifen, Frontscheibe) — wie die vorgerenderten Bilder vorher, aber
 * je Bildpunkt scharf.
 *
 * SCHATTEN: dasselbe Netz noch einmal, entlang des Lichts flach auf den Boden
 * gedrückt (beim Flugzeug senkrecht darunter, wie vorher sein Umriss aus JS) —
 * ein Durchgang mehr je Teil mit einem Shader, der nur Schwarz schreibt. Damit
 * sich Dreiecke nicht doppelt abdunkeln, liegt jeder Schatten auf EINER festen
 * Tiefe knapp hinter dem Band der Körper: Der erste Bildpunkt schreibt sie, jeder
 * weitere an derselben Stelle fällt durch den Tiefentest. Die Körper liegen
 * davor und decken ihn zu.
 */
#include "live_models_core.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstring>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#ifdef __ANDROID__
#include <GLES3/gl3.h>
#include <android/log.h>
#define LM_LOG(...) __android_log_print(ANDROID_LOG_WARN, "LiveModels", __VA_ARGS__)
#else
// Linux-Probe im Fork (mbgl-render-Umgebung): dessen GL-Funktionen und -Konstanten.
#include <mln/gl/defines.hpp>
#include <mln/platform/gl_functions.hpp>
#include <cstdio>
using namespace mln::platform;
#define LM_LOG(...) (std::fprintf(stderr, __VA_ARGS__), std::fprintf(stderr, "\n"))
#endif

namespace {

constexpr double PI = 3.14159265358979323846;
constexpr double DEG = PI / 180.0;
/** MapLibres Mercator — Meter je Bildpunkt rechnet sie mit dem Äquatorradius. */
constexpr double MERC_R = 6378137.0;
/** Die Kugel der Globus-Shader (`GLOBE_RADIUS`). */
constexpr double GLOBE_R = 6371008.8;
/** Vorderstes Tiefenband für die Modelle. */
constexpr double DEPTH_BAND = 0.002;
/** Deckkraft der Schatten — wie der Flugzeug-Schatten vorher (`fill-opacity` 0.3). */
constexpr float SHADE = 0.3f;

struct Mesh {
    std::vector<float> verts;  // je Ecke: x y z nx ny nz mat
    std::vector<uint16_t> idx;
    float lo[3]{1e9f, 1e9f, 1e9f};
    float hi[3]{-1e9f, -1e9f, -1e9f};
};

/** Was fährt — vom Sitzungsbeginn bis zum Ende fest. */
struct Vehicle {
    int kind = -1;  // 0 Bahn, 1 Bus, 2 Flugzeug
    std::string headMesh;
    std::string midMesh;
    int units = 1;
    double carLength = 26;
    double coupling = 0.3;
    double minUnitDp = 30;
    double minPlaneDp = 56;
    double z3d = 14;
    double fade = 0.6;
    float accent[3]{1, 1, 1};
    float head[12]{};
    float mid[12]{};
};

/**
 * Wo es gerade ist: zwei Zeitpunkte (ms seit 1970) und je der Stand.
 * Boden: a[0]/b[0] = Meter entlang der Strecke. Flug: Länge, Breite, Höhe (m), Kurs.
 */
struct Motion {
    double t0 = 0;
    double t1 = 0;
    double a[4]{};
    double b[4]{};
    bool valid = false;
};

struct Store {
    std::mutex m;
    std::unordered_map<std::string, Mesh> meshes;
    uint64_t meshVersion = 1;
    std::vector<double> lng, lat, cum;
    Vehicle veh;
    bool hasVehicle = false;
    Motion mot;
};
Store& store() {
    static Store s;
    return s;
}

double nowMs() {
    using namespace std::chrono;
    return static_cast<double>(duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count());
}

// --- Strecke ------------------------------------------------------------------
struct LngLat {
    double lng;
    double lat;
};
LngLat pointAt(const Store& s, double d) {
    const size_t n = s.cum.size();
    if (n == 0) return {0, 0};
    if (n == 1 || d <= s.cum[0]) return {s.lng[0], s.lat[0]};
    if (d >= s.cum[n - 1]) return {s.lng[n - 1], s.lat[n - 1]};
    size_t lo = 0;
    size_t hi = n - 1;
    while (hi - lo > 1) {
        const size_t mid = (lo + hi) / 2;
        if (s.cum[mid] <= d) lo = mid; else hi = mid;
    }
    const double span = s.cum[hi] - s.cum[lo];
    const double f = span > 0 ? (d - s.cum[lo]) / span : 0;
    return {s.lng[lo] + (s.lng[hi] - s.lng[lo]) * f, s.lat[lo] + (s.lat[hi] - s.lat[lo]) * f};
}
/** Kurs von a nach b, Grad im Uhrzeigersinn ab Norden. */
double bearingDeg(LngLat a, LngLat b) {
    const double p1 = a.lat * DEG;
    const double p2 = b.lat * DEG;
    const double dl = (b.lng - a.lng) * DEG;
    const double y = std::sin(dl) * std::cos(p2);
    const double x = std::cos(p1) * std::sin(p2) - std::sin(p1) * std::cos(p2) * std::cos(dl);
    return std::atan2(y, x) / DEG;
}
/** Meter je Punkt am Bildschirm (512er-Kacheln), wie MapLibre. */
double metersPerDp(double zoom, double lat) {
    return 2 * PI * MERC_R * std::cos(lat * DEG) / (512.0 * std::pow(2.0, zoom));
}

// --- Matrizen (Spaltenweise, wie MapLibre) ----------------------------------------
using Mat = std::array<double, 16>;
Mat mul(const Mat& a, const Mat& b) {
    Mat o{};
    for (int c = 0; c < 4; c++)
        for (int r = 0; r < 4; r++) {
            double v = 0;
            for (int k = 0; k < 4; k++) v += a[k * 4 + r] * b[c * 4 + k];
            o[c * 4 + r] = v;
        }
    return o;
}
std::array<double, 4> apply(const Mat& m, double x, double y, double z) {
    return {m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14], m[3] * x + m[7] * y + m[11] * z + m[15]};
}

/**
 * Modell (m; x rechts, y vorn, z oben) → Welt der flachen Karte: x, y in
 * Weltbildpunkten (512 · 2^Zoom), z in Metern — so erwartet es MapLibres
 * Projektionsmatrix (`Camera::getWorldToCamera`: „z in meters").
 */
Mat mercatorModel(double lng, double lat, double alt, double hdg, double k, double zoom) {
    const double W = 512.0 * std::pow(2.0, zoom);
    const double X = (lng + 180.0) / 360.0 * W;
    const double Y = (180.0 - (180.0 / PI) * std::log(std::tan(PI / 4 + lat * PI / 360.0))) / 360.0 * W;
    const double ppm = W / (2 * PI * MERC_R * std::cos(lat * DEG));
    const double c = std::cos(hdg * DEG);
    const double s = std::sin(hdg * DEG);
    // Ost = x·cos + y·sin, Nord = −x·sin + y·cos; Y wächst nach Süden.
    return {ppm * k * c, ppm * k * s, 0, 0,  ppm * k * s, -ppm * k * c, 0, 0,  0, 0, k, 0,  X, Y, alt, 1};
}

/** Modell → Einheitskugel (x nach 90° Ost, y zum Nordpol, z zum Nullpunkt). */
Mat globeModel(double lng, double lat, double alt, double hdg, double k, std::array<double, 3>* center) {
    const double ph = lat * DEG;
    const double la = lng * DEG;
    const double up[3]{std::cos(ph) * std::sin(la), std::sin(ph), std::cos(ph) * std::cos(la)};
    const double east[3]{std::cos(la), 0, -std::sin(la)};
    const double north[3]{-std::sin(ph) * std::sin(la), std::cos(ph), -std::sin(ph) * std::cos(la)};
    const double c = std::cos(hdg * DEG);
    const double s = std::sin(hdg * DEG);
    const double f = k / GLOBE_R;
    Mat m{};
    for (int i = 0; i < 3; i++) {
        m[0 + i] = (east[i] * c - north[i] * s) * f;
        m[4 + i] = (east[i] * s + north[i] * c) * f;
        m[8 + i] = up[i] * f;
        m[12 + i] = up[i] * (1 + alt / GLOBE_R);
    }
    m[15] = 1;
    if (center) *center = {up[0], up[1], up[2]};
    return m;
}

// --- Shader -------------------------------------------------------------------------
const char* VERT = R"(#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_nrm;
layout(location = 2) in float a_mat;
uniform mat4 u_merc;
uniform mat4 u_globe;
uniform float u_t;
uniform vec3 u_depth;
// 0 Körper, 1 Schatten (in beiden Shadern gleich genau deklariert, sonst scheitert das Binden).
uniform highp int u_pass;
// Schatten: Versatz am Boden je Meter Höhe (Modellraum), entgegen dem Licht.
uniform vec2 u_cast;
out vec3 v_pos;
out vec3 v_nrm;
flat out int v_mat;
void main() {
    vec3 q = u_pass == 1 ? vec3(a_pos.xy + a_pos.z * u_cast, 0.0) : a_pos;
    vec4 p = u_merc * vec4(q, 1.0);
    if (u_t > 0.0) {
        vec4 g = u_globe * vec4(q, 1.0);
        p = u_t > 0.999 ? g : mix(p, g, u_t);
    }
    // Eigene, lineare Tiefe im vordersten Band; Schatten fest knapp dahinter.
    float lin = u_pass == 1 ? 1.04 : clamp((p.w - u_depth.x) * u_depth.y, 0.0, 1.0);
    p.z = (-1.0 + 2.0 * u_depth.z * lin) * p.w;
    gl_Position = p;
    v_pos = a_pos;
    v_nrm = a_nrm;
    v_mat = int(a_mat + 0.5);
}
)";

const char* FRAG = R"(#version 300 es
precision highp float;
in vec3 v_pos;
in vec3 v_nrm;
flat in int v_mat;
uniform int u_kind;
uniform vec4 u_p0;
uniform vec4 u_p1;
uniform vec4 u_doors;
uniform float u_head;
uniform vec3 u_accent;
uniform vec3 u_light;
uniform vec3 u_viewer;
uniform float u_alpha;
uniform highp int u_pass;
uniform float u_shade;
out vec4 fragColor;

const vec3 WHITE = vec3(0.953, 0.961, 0.973);
const vec3 ROOF = vec3(0.773, 0.800, 0.831);
const vec3 ROOFBOX = vec3(0.702, 0.729, 0.769);
const vec3 GLASS = vec3(0.133, 0.157, 0.188);
const vec3 SKIRT = vec3(0.227, 0.251, 0.282);
const vec3 BOGIE = vec3(0.137, 0.153, 0.176);
const vec3 JOINT = vec3(0.243, 0.267, 0.294);
const vec3 DOOR = vec3(0.851, 0.871, 0.894);
const vec3 LAMP = vec3(1.0, 0.957, 0.839);

vec3 lit(vec3 base, vec3 n, float spec, float gloss) {
    float diff = max(0.0, dot(n, u_light));
    float sky = 0.36 + 0.16 * n.z;
    vec3 h = normalize(u_light + u_viewer);
    float s = pow(max(0.0, dot(n, h)), gloss) * spec;
    float rim = 0.05 * pow(1.0 - max(0.0, dot(n, u_viewer)), 3.0);
    return min(vec3(1.0), base * (sky + 0.6 * diff) + s + rim);
}
vec3 glass(vec3 n) { return lit(GLASS, n, 0.6, 70.0); }

// Querschnitt eines Bahnwagens (wie build-live-models.mjs): x = halbe Breite.
float railHalfWidth(float y) {
    float a0 = u_p0.x;
    float bodyEnd = u_p1.x;
    float noseLen = u_p1.y;
    if (u_head < 0.5 || y <= bodyEnd) return a0;
    float t = min(1.0, (y - bodyEnd) / noseLen);
    if (u_p1.z < 0.5) return a0 * (1.0 - 0.78 * pow(t, 1.8));
    if (u_p1.z < 1.5) return a0 * (1.0 - 0.22 * pow(t, 2.4));
    return a0 * (1.0 - 0.07 * t * t);
}

vec3 rail(vec3 p, vec3 n, vec3 nm, int mat) {
    if (mat == 4) return lit(BOGIE, n, 0.05, 36.0);
    if (mat == 3) return lit(JOINT, n, 0.05, 36.0);
    if (mat == 5) return lit(ROOFBOX, n, 0.15, 36.0);
    if (mat == 2) return lit(WHITE, n, 0.1, 36.0);
    float H = u_p0.y;
    float zBot = u_p0.z;
    float halfLen = u_p0.w;
    float bodyEnd = u_p1.x;
    float noseLen = u_p1.y;
    float span = H - zBot;
    float zf = (p.z - zBot) / span;
    bool inNose = u_head > 0.5 && p.y > bodyEnd;
    float tn = inNose ? (p.y - bodyEnd) / noseLen : 0.0;
    bool sleek = u_p1.z < 0.5;
    bool front = mat == 1 || (inNose && !sleek && nm.y > 0.5);
    if (inNose && sleek) {
        if (tn > 0.16 && tn < 0.64 && nm.z > 0.22 && zf > 0.4) return glass(n);
        if (tn > 0.86 && zf > 0.12 && zf < 0.32 && abs(p.x) > 0.08 && abs(p.x) < 0.4) return lit(LAMP, n, 0.2, 36.0);
    }
    if (front) {
        float a = railHalfWidth(p.y);
        if (zf > 0.46 && zf < 0.88 && abs(p.x) < 0.84 * a) return glass(n);
        if (zf > 0.2 && zf < 0.3 && abs(abs(p.x) - 0.62 * a) < 0.14 * a) return lit(LAMP, n, 0.2, 36.0);
        if (zf >= 0.36 && zf <= 0.42) return lit(u_accent, n, 0.25, 36.0);
        return lit(WHITE, n, 0.3, 36.0);
    }
    if (nm.z > 0.72 && zf > 0.82) return lit(ROOF, n, 0.12, 36.0);
    if (zf < 0.16) return lit(SKIRT, n, 0.08, 36.0);
    if (abs(nm.x) > 0.5) {
        for (int i = 0; i < 3; i++) {
            if (float(i) >= u_doors.w) break;
            float dy = abs(p.y - u_doors[i]);
            if (dy < 0.72 && zf > 0.04 && zf < 0.8) {
                if (dy < 0.04) return lit(SKIRT, n, 0.05, 36.0);
                if (zf > 0.46 && zf < 0.74 && dy < 0.6 && dy > 0.1) return glass(n);
                return lit(DOOR, n, 0.2, 36.0);
            }
        }
        float windowsTo = inNose ? 0.1 : 1.0;
        float end = u_head > 0.5 ? bodyEnd + 0.1 * noseLen : halfLen - 0.9;
        if (zf > 0.47 && zf < 0.76 && tn < windowsTo && p.y > -halfLen + 0.9 && p.y < end) {
            float frac = fract((p.y + 100.0) / u_p1.w);
            return frac > 0.11 ? glass(n) : lit(WHITE, n, 0.3, 36.0);
        }
        if (zf > 0.37 && zf < 0.43) return lit(u_accent, n, 0.25, 36.0);
    }
    return lit(WHITE, n, 0.3, 36.0);
}

vec3 bus(vec3 p, vec3 n, vec3 nm, int mat) {
    if (mat == 6) return lit(BOGIE, n, 0.05, 36.0);
    if (mat == 7) return lit(vec3(0.557, 0.584, 0.624), n, 0.3, 36.0);
    if (mat == 5) return lit(ROOFBOX, n, 0.15, 36.0);
    float a0 = u_p0.x;
    float H = u_p0.y;
    float zBot = u_p0.z;
    float halfLen = u_p0.w;
    float zf = (p.z - zBot) / (H - zBot);
    if (mat == 1 || nm.y > 0.6) {
        if (zf > 0.36 && zf < 0.9 && abs(p.x) < 0.84 * a0) return glass(n);
        if (zf > 0.1 && zf < 0.2 && abs(abs(p.x) - 0.65 * a0) < 0.14 * a0) return lit(LAMP, n, 0.2, 36.0);
        return zf < 0.32 ? lit(u_accent, n, 0.25, 36.0) : lit(WHITE, n, 0.3, 36.0);
    }
    if (mat == 8 || nm.y < -0.6) {
        if (zf > 0.55 && zf < 0.85 && abs(p.x) < 0.7 * a0) return glass(n);
        return zf < 0.32 ? lit(u_accent, n, 0.25, 36.0) : lit(WHITE, n, 0.3, 36.0);
    }
    if (nm.z > 0.72 && zf > 0.86) return lit(vec3(0.804, 0.827, 0.855), n, 0.12, 36.0);
    if (abs(nm.x) > 0.45) {
        if (p.x > 0.0 && p.y > halfLen - 2.4 && p.y < halfLen - 1.15 && zf > 0.06 && zf < 0.86) return glass(n);
        if (zf > 0.42 && zf < 0.84 && p.y > -halfLen + 0.6 && p.y < halfLen - 0.8) {
            float frac = fract((p.y + 100.0) / 1.55);
            return frac > 0.09 ? glass(n) : lit(WHITE, n, 0.3, 36.0);
        }
        if (zf < 0.34) return lit(u_accent, n, 0.25, 36.0);
    }
    return lit(WHITE, n, 0.3, 36.0);
}

// Flugzeug: Rumpfquerschnitt wie build-live-models.mjs (Fenster, Cockpit, Bauch).
vec3 fuselage(float y) {
    const float RF = 1.98;
    const float ZT = -0.42;
    if (y > 11.8) {
        float t = min(1.0, (y - 11.8) / 7.0);
        return vec3(RF * pow(max(0.0, 1.0 - pow(t, 2.6)), 0.55),
                    ZT + (RF - ZT) * pow(max(0.0, 1.0 - t * t), 0.6),
                    ZT + (-RF - ZT) * pow(max(0.0, 1.0 - pow(t, 3.2)), 0.5));
    }
    if (y < -8.8) {
        float t = min(1.0, (-8.8 - y) / 10.0);
        return vec3(RF * (1.0 - 0.86 * pow(t, 1.15)), RF + (1.25 - RF) * pow(t, 1.6), -RF + (0.75 + RF) * pow(t, 1.1));
    }
    return vec3(RF, RF, -RF);
}
vec3 plane(vec3 p, vec3 n, int mat) {
    if (mat == 9) return lit(vec3(0.863, 0.882, 0.906), n, 0.3, 36.0);
    if (mat == 10) return lit(vec3(0.784, 0.808, 0.839), n, 0.3, 36.0);
    if (mat == 11) return lit(vec3(0.149, 0.169, 0.196), n, 0.3, 36.0);
    if (mat == 12) return lit(vec3(0.353, 0.380, 0.420), n, 0.3, 36.0);
    if (mat == 13) return lit(vec3(0.620, 0.651, 0.690), n, 0.3, 36.0);
    if (mat == 14) return lit(u_accent, n, 0.18, 36.0);
    vec3 f = fuselage(p.y);
    float c = (f.y + f.z) * 0.5;
    float b = max(1e-3, (f.y - f.z) * 0.5);
    float v = (p.z - c) / b;
    float side = f.x > 0.0 ? abs(p.x) / f.x : 0.0;
    if (p.y > 14.9 && p.y < 16.7 && v > 0.2 && v < 0.62) return glass(n);
    if (p.y > -9.2 && p.y < 12.6 && v > 0.08 && v < 0.3 && side > 0.8) {
        float frac = fract((p.y + 9.2) / 0.51);
        if (frac > 0.18 && frac < 0.72) return glass(n);
    }
    if (v < -0.58) return lit(vec3(0.827, 0.847, 0.875), n, 0.3, 36.0);
    return lit(vec3(0.953, 0.961, 0.973), n, 0.3, 36.0);
}

void main() {
    if (u_pass == 1) {
        fragColor = vec4(0.0, 0.0, 0.0, u_shade * u_alpha);
        return;
    }
    vec3 nm = normalize(v_nrm);
    // Netze ohne einheitlichen Umlauf: die Normale zur Kamera drehen.
    if (dot(nm, u_viewer) < -0.05) nm = -nm;
    vec3 c = u_kind == 0 ? rail(v_pos, nm, nm, v_mat) : u_kind == 1 ? bus(v_pos, nm, nm, v_mat) : plane(v_pos, nm, v_mat);
    fragColor = vec4(c * u_alpha, u_alpha);
}
)";

GLuint compile(GLenum type, const char* src) {
    GLuint s = glCreateShader(type);
    glShaderSource(s, 1, &src, nullptr);
    glCompileShader(s);
    GLint ok = 0;
    glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
    if (!ok) {
        char log[1024];
        glGetShaderInfoLog(s, sizeof log, nullptr, log);
        LM_LOG("Shader: %s", log);
        glDeleteShader(s);
        return 0;
    }
    return s;
}

struct Instance {
    std::string meshName;
    std::array<float, 12> params;
    float head;
    std::array<float, 16> merc;
    std::array<float, 16> globe;
    float light[3];
    float viewer[3];
    /** Schatten: Matrizen am Boden (Flugzeug: ohne Höhe) und Versatz je Meter Höhe. */
    std::array<float, 16> shadowMerc;
    std::array<float, 16> shadowGlobe;
    float cast[2];
};

class LiveModelsHost final : public mln::style::CustomLayerHost {
public:
    void initialize(const mln::style::CustomLayerInitParameters&) override {}

    void render(const mln::style::CustomLayerRenderParameters& p) override {
        std::vector<Instance> list;
        float accent[3]{};
        int kind = -1;
        double minW = 1e30;
        double maxW = -1e30;
        float alpha = 1;
        const double t = p.globe ? p.projectionTransition : 0.0;
        {
            Store& s = store();
            std::lock_guard<std::mutex> lock(s.m);
            if (!s.hasVehicle || !s.mot.valid) return;
            if (!ensureGpu(s)) return;
            const Vehicle& v = s.veh;
            kind = v.kind;
            std::memcpy(accent, v.accent, sizeof accent);
            alpha = static_cast<float>(std::clamp((p.zoom - (v.z3d - v.fade)) / v.fade, 0.0, 1.0));
            if (alpha <= 0) return;
            const double now = nowMs();
            const double u = s.mot.t1 > s.mot.t0 ? std::clamp((now - s.mot.t0) / (s.mot.t1 - s.mot.t0), 0.0, 1.0) : 1.0;
            const double bearing = p.bearing;
            const double pitch = p.pitch;  // Bogenmaß
            auto lerp = [u](double a, double b) { return a + (b - a) * u; };
            // `straightDown`: Schatten senkrecht darunter am Boden (Flugzeug), sonst entlang des Lichts.
            auto add = [&](const std::string& meshName, const float* params, float head, double lng, double lat, double alt,
                           double hdg, double k, bool straightDown) {
                auto it = s.meshes.find(meshName);
                if (it == s.meshes.end()) return;
                const Mat merc = mul(arr(p.projectionMatrix), mercatorModel(lng, lat, alt, hdg, k, p.zoom));
                Mat globe{};
                if (t > 0) {
                    std::array<double, 3> c{};
                    globe = mul(arr(p.globeProjectionMatrix), globeModel(lng, lat, alt, hdg, k, &c));
                    // Rückseite der Kugel: gar nicht zeichnen.
                    const auto& pl = p.globeClippingPlane;
                    if (t > 0.5 && c[0] * pl[0] + c[1] * pl[1] + c[2] * pl[2] + pl[3] < 0) return;
                }
                // Tiefe: die Ecken des Rahmens um das Netz.
                const Mesh& m = it->second;
                for (int corner = 0; corner < 8; corner++) {
                    const double x = corner & 1 ? m.hi[0] : m.lo[0];
                    const double y = corner & 2 ? m.hi[1] : m.lo[1];
                    const double z = corner & 4 ? m.hi[2] : m.lo[2];
                    double w = apply(merc, x, y, z)[3];
                    if (t > 0) w = w + (apply(globe, x, y, z)[3] - w) * t;
                    minW = std::min(minW, w);
                    maxW = std::max(maxW, w);
                }
                Instance in{meshName, {}, head, {}, {}, {}, {}, {}, {}, {}};
                std::copy(params, params + 12, in.params.begin());
                for (int i = 0; i < 16; i++) {
                    in.merc[i] = static_cast<float>(merc[i]);
                    in.globe[i] = static_cast<float>(globe[i]);
                }
                if (straightDown) {
                    const Mat sm = mul(arr(p.projectionMatrix), mercatorModel(lng, lat, 0, hdg, k, p.zoom));
                    Mat sg{};
                    if (t > 0) sg = mul(arr(p.globeProjectionMatrix), globeModel(lng, lat, 0, hdg, k, nullptr));
                    for (int i = 0; i < 16; i++) {
                        in.shadowMerc[i] = static_cast<float>(sm[i]);
                        in.shadowGlobe[i] = static_cast<float>(sg[i]);
                    }
                } else {
                    in.shadowMerc = in.merc;
                    in.shadowGlobe = in.globe;
                }
                // Licht wie MapLibres Standardlicht (am Bildschirm verankert:
                // 210° ab oben, 30° vom Zenit) und Blick zur Kamera — beides
                // in den Modellraum gedreht.
                const double az = (bearing + 210.0) * DEG;
                const double L[3]{std::sin(az) * std::sin(30 * DEG), std::cos(az) * std::sin(30 * DEG), std::cos(30 * DEG)};
                const double V[3]{-std::sin(bearing * DEG) * std::sin(pitch), -std::cos(bearing * DEG) * std::sin(pitch), std::cos(pitch)};
                const double c = std::cos(hdg * DEG);
                const double sn = std::sin(hdg * DEG);
                in.light[0] = static_cast<float>(L[0] * c - L[1] * sn);
                in.light[1] = static_cast<float>(L[0] * sn + L[1] * c);
                in.light[2] = static_cast<float>(L[2]);
                in.viewer[0] = static_cast<float>(V[0] * c - V[1] * sn);
                in.viewer[1] = static_cast<float>(V[0] * sn + V[1] * c);
                in.viewer[2] = static_cast<float>(V[2]);
                // Vom Licht weg: je Meter Höhe so weit am Boden versetzt.
                in.cast[0] = straightDown ? 0.f : -in.light[0] / in.light[2];
                in.cast[1] = straightDown ? 0.f : -in.light[1] / in.light[2];
                list.push_back(std::move(in));
            };
            if (v.kind == 2) {
                const double lng = lerp(s.mot.a[0], s.mot.b[0]);
                const double lat = lerp(s.mot.a[1], s.mot.b[1]);
                const double alt = lerp(s.mot.a[2], s.mot.b[2]);
                const double dh = std::remainder(s.mot.b[3] - s.mot.a[3], 360.0);
                const double hdg = s.mot.a[3] + dh * u;
                const double k = std::max(1.0, v.minPlaneDp * metersPerDp(p.zoom, lat) / v.carLength);
                add(v.headMesh, v.head, 1, lng, lat, alt, hdg, k, true);
            } else if (!s.cum.empty()) {
                const double d = lerp(s.mot.a[0], s.mot.b[0]);
                const LngLat here = pointAt(s, d);
                const double zRef = std::log2(v.minUnitDp * metersPerDp(0, here.lat) / v.carLength);
                const double k = std::clamp(std::pow(2.0, zRef - p.zoom), 1.0, 4.0);
                const double L = v.carLength * k;
                const double c = v.coupling * k;
                const double total = v.units * L + (v.units - 1) * c;
                const double headCenter = d + total / 2 - L / 2;
                for (int i = 0; i < v.units; i++) {
                    const double di = headCenter - i * (L + c);
                    // Starr von Ende zu Ende auf dem Gleis — wie eine echte Wagenkette.
                    const LngLat front = pointAt(s, di + L / 2);
                    const LngLat back = pointAt(s, di - L / 2);
                    const bool tail = v.units > 1 && i == v.units - 1;
                    const bool isHead = i == 0 || tail || v.midMesh.empty();
                    const double hdg = bearingDeg(back, front) + (tail ? 180.0 : 0.0);
                    add(isHead ? v.headMesh : v.midMesh, isHead ? v.head : v.mid, isHead ? 1.f : 0.f,
                        (front.lng + back.lng) / 2, (front.lat + back.lat) / 2, 0, hdg, k, false);
                }
            }
        }
        if (list.empty()) return;
        const double spanW = std::max(1e-6, maxW - minW);

        glUseProgram(prog);
        // Die Karte stellt vor dem Aufruf den Tiefenbereich ihrer Ebene ein — wir brauchen den ganzen.
        glDepthRangef(0.0f, 1.0f);
        glEnable(GL_DEPTH_TEST);
        glDepthFunc(GL_LESS);
        glDepthMask(GL_TRUE);
        glDisable(GL_CULL_FACE);
        glDisable(GL_STENCIL_TEST);
        glUniform1f(uT, static_cast<float>(t));
        glUniform3f(uDepth, static_cast<float>(minW), static_cast<float>(1.0 / spanW), static_cast<float>(DEPTH_BAND));
        glUniform1i(uKind, kind);
        glUniform3fv(uAccent, 1, accent);
        glUniform1f(uAlpha, alpha);
        // Erst die Schatten (immer durchscheinend), dann die Körper darüber.
        glEnable(GL_BLEND);
        glBlendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
        glUniform1i(uPass, 1);
        glUniform1f(uShade, SHADE);
        for (const auto& in : list) {
            const auto& gpu = gpuMeshes[in.meshName];
            glUniformMatrix4fv(uMerc, 1, GL_FALSE, in.shadowMerc.data());
            glUniformMatrix4fv(uGlobe, 1, GL_FALSE, in.shadowGlobe.data());
            glUniform2f(uCast, in.cast[0], in.cast[1]);
            glBindVertexArray(gpu.vao);
            glDrawElements(GL_TRIANGLES, gpu.count, GL_UNSIGNED_SHORT, nullptr);
        }
        glUniform1i(uPass, 0);
        if (alpha >= 1) glDisable(GL_BLEND);
        for (const auto& in : list) {
            const auto& gpu = gpuMeshes[in.meshName];
            glUniformMatrix4fv(uMerc, 1, GL_FALSE, in.merc.data());
            glUniformMatrix4fv(uGlobe, 1, GL_FALSE, in.globe.data());
            glUniform4f(uP0, in.params[0], in.params[1], in.params[2], in.params[3]);
            glUniform4f(uP1, in.params[4], in.params[5], in.params[6], in.params[7]);
            glUniform4f(uDoors, in.params[8], in.params[9], in.params[10], in.params[11]);
            glUniform1f(uHead, in.head);
            glUniform3fv(uLight, 1, in.light);
            glUniform3fv(uViewer, 1, in.viewer);
            glBindVertexArray(gpu.vao);
            glDrawElements(GL_TRIANGLES, gpu.count, GL_UNSIGNED_SHORT, nullptr);
        }
        glBindVertexArray(0);
        glDisable(GL_BLEND);
    }

    void contextLost() override {
        // Die Objekte gehören zum verlorenen Kontext — nur vergessen, nicht löschen.
        prog = 0;
        gpuMeshes.clear();
        uploaded = 0;
    }

    void deinitialize() override {
        for (auto& [name, g] : gpuMeshes) {
            glDeleteVertexArrays(1, &g.vao);
            glDeleteBuffers(1, &g.vbo);
            glDeleteBuffers(1, &g.ibo);
        }
        gpuMeshes.clear();
        if (prog) glDeleteProgram(prog);
        prog = 0;
        uploaded = 0;
    }

private:
    struct Gpu {
        GLuint vao = 0;
        GLuint vbo = 0;
        GLuint ibo = 0;
        GLsizei count = 0;
    };
    GLuint prog = 0;
    std::unordered_map<std::string, Gpu> gpuMeshes;
    uint64_t uploaded = 0;
    GLint uMerc = -1, uGlobe = -1, uT = -1, uDepth = -1, uKind = -1, uP0 = -1, uP1 = -1, uDoors = -1, uHead = -1, uAccent = -1,
          uLight = -1, uViewer = -1, uAlpha = -1, uPass = -1, uCast = -1, uShade = -1;

    static Mat arr(const std::array<double, 16>& a) {
        Mat m{};
        for (int i = 0; i < 16; i++) m[i] = a[i];
        return m;
    }

    /** Programm und Netze auf der Grafikkarte — beim ersten Bild und nach neuen Netzen. */
    bool ensureGpu(const Store& s) {
        if (!prog) {
            GLuint vs = compile(GL_VERTEX_SHADER, VERT);
            GLuint fs = compile(GL_FRAGMENT_SHADER, FRAG);
            if (!vs || !fs) return false;
            prog = glCreateProgram();
            glAttachShader(prog, vs);
            glAttachShader(prog, fs);
            glLinkProgram(prog);
            glDeleteShader(vs);
            glDeleteShader(fs);
            GLint ok = 0;
            glGetProgramiv(prog, GL_LINK_STATUS, &ok);
            if (!ok) {
                char log[1024];
                glGetProgramInfoLog(prog, sizeof log, nullptr, log);
                LM_LOG("Programm: %s", log);
                glDeleteProgram(prog);
                prog = 0;
                return false;
            }
            uMerc = glGetUniformLocation(prog, "u_merc");
            uGlobe = glGetUniformLocation(prog, "u_globe");
            uT = glGetUniformLocation(prog, "u_t");
            uDepth = glGetUniformLocation(prog, "u_depth");
            uKind = glGetUniformLocation(prog, "u_kind");
            uP0 = glGetUniformLocation(prog, "u_p0");
            uP1 = glGetUniformLocation(prog, "u_p1");
            uDoors = glGetUniformLocation(prog, "u_doors");
            uHead = glGetUniformLocation(prog, "u_head");
            uAccent = glGetUniformLocation(prog, "u_accent");
            uLight = glGetUniformLocation(prog, "u_light");
            uViewer = glGetUniformLocation(prog, "u_viewer");
            uAlpha = glGetUniformLocation(prog, "u_alpha");
            uPass = glGetUniformLocation(prog, "u_pass");
            uCast = glGetUniformLocation(prog, "u_cast");
            uShade = glGetUniformLocation(prog, "u_shade");
        }
        if (uploaded != s.meshVersion) {
            for (const auto& [name, m] : s.meshes) {
                if (gpuMeshes.count(name)) continue;
                Gpu g;
                glGenVertexArrays(1, &g.vao);
                glBindVertexArray(g.vao);
                glGenBuffers(1, &g.vbo);
                glBindBuffer(GL_ARRAY_BUFFER, g.vbo);
                glBufferData(GL_ARRAY_BUFFER, static_cast<GLsizeiptr>(m.verts.size() * sizeof(float)), m.verts.data(), GL_STATIC_DRAW);
                glGenBuffers(1, &g.ibo);
                glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, g.ibo);
                glBufferData(GL_ELEMENT_ARRAY_BUFFER, static_cast<GLsizeiptr>(m.idx.size() * sizeof(uint16_t)), m.idx.data(), GL_STATIC_DRAW);
                const GLsizei stride = 7 * sizeof(float);
                glEnableVertexAttribArray(0);
                glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, stride, reinterpret_cast<void*>(0));
                glEnableVertexAttribArray(1);
                glVertexAttribPointer(1, 3, GL_FLOAT, GL_FALSE, stride, reinterpret_cast<void*>(3 * sizeof(float)));
                glEnableVertexAttribArray(2);
                glVertexAttribPointer(2, 1, GL_FLOAT, GL_FALSE, stride, reinterpret_cast<void*>(6 * sizeof(float)));
                glBindVertexArray(0);
                glBindBuffer(GL_ARRAY_BUFFER, 0);
                g.count = static_cast<GLsizei>(m.idx.size());
                gpuMeshes[name] = g;
            }
            uploaded = s.meshVersion;
        }
        return true;
    }
};

}  // namespace


// --- Schnittstelle (live_models_core.hpp) ---------------------------------------------
namespace lm {

mln::style::CustomLayerHost* createHost() { return new LiveModelsHost(); }

void loadMesh(const std::string& name, const uint8_t* data, size_t len) {
    if (len < 12 || std::memcmp(data, "BLM1", 4) != 0) {
        LM_LOG("Netz %s: falsches Format", name.c_str());
        return;
    }
    uint32_t nv = 0;
    uint32_t ni = 0;
    std::memcpy(&nv, data + 4, 4);
    std::memcpy(&ni, data + 8, 4);
    const size_t need = 12 + static_cast<size_t>(nv) * 7 * 4 + static_cast<size_t>(ni) * 2;
    if (len < need) {
        LM_LOG("Netz %s: zu kurz", name.c_str());
        return;
    }
    Mesh m;
    m.verts.resize(static_cast<size_t>(nv) * 7);
    std::memcpy(m.verts.data(), data + 12, m.verts.size() * 4);
    m.idx.resize(ni);
    std::memcpy(m.idx.data(), data + 12 + m.verts.size() * 4, m.idx.size() * 2);
    for (size_t i = 0; i < nv; i++) {
        for (int k = 0; k < 3; k++) {
            m.lo[k] = std::min(m.lo[k], m.verts[i * 7 + k]);
            m.hi[k] = std::max(m.hi[k], m.verts[i * 7 + k]);
        }
    }
    Store& s = store();
    std::lock_guard<std::mutex> lock(s.m);
    s.meshes[name] = std::move(m);
    s.meshVersion++;
}

void setRoute(const double* lngLat, const double* cum, size_t n) {
    Store& s = store();
    std::lock_guard<std::mutex> lock(s.m);
    s.lng.resize(n);
    s.lat.resize(n);
    s.cum.assign(cum, cum + n);
    for (size_t i = 0; i < n; i++) {
        s.lng[i] = lngLat[i * 2];
        s.lat[i] = lngLat[i * 2 + 1];
    }
}

void setVehicle(int kind, const std::string& headMesh, const std::string& midMesh, const double* p, size_t n) {
    Vehicle v;
    v.kind = kind;
    v.headMesh = headMesh;
    v.midMesh = midMesh;
    if (n >= 34) {
        v.units = static_cast<int>(p[0]);
        v.carLength = p[1];
        v.coupling = p[2];
        v.minUnitDp = p[3];
        v.minPlaneDp = p[4];
        v.z3d = p[5];
        v.fade = std::max(0.01, p[6]);
        for (int i = 0; i < 3; i++) v.accent[i] = static_cast<float>(p[7 + i]);
        for (int i = 0; i < 12; i++) {
            v.head[i] = static_cast<float>(p[10 + i]);
            v.mid[i] = static_cast<float>(p[22 + i]);
        }
    }
    Store& s = store();
    std::lock_guard<std::mutex> lock(s.m);
    s.veh = v;
    s.hasVehicle = kind >= 0;
    s.mot.valid = false;
}

void setMotion(const double* p, size_t n) {
    Motion mo;
    if (n == 4) {
        mo.t0 = p[0];
        mo.a[0] = p[1];
        mo.t1 = p[2];
        mo.b[0] = p[3];
        mo.valid = true;
    } else if (n == 10) {
        mo.t0 = p[0];
        for (int i = 0; i < 4; i++) mo.a[i] = p[1 + i];
        mo.t1 = p[5];
        for (int i = 0; i < 4; i++) mo.b[i] = p[6 + i];
        mo.valid = true;
    }
    Store& s = store();
    std::lock_guard<std::mutex> lock(s.m);
    s.mot = mo;
}

void clear() {
    Store& s = store();
    std::lock_guard<std::mutex> lock(s.m);
    s.hasVehicle = false;
    s.mot.valid = false;
    s.lng.clear();
    s.lat.clear();
    s.cum.clear();
}

bool isMoving() {
    Store& s = store();
    std::lock_guard<std::mutex> lock(s.m);
    if (!s.hasVehicle || !s.mot.valid) return false;
    if (nowMs() > s.mot.t1 + 50) return false;
    for (int i = 0; i < 4; i++)
        if (std::abs(s.mot.b[i] - s.mot.a[i]) > 1e-9) return true;
    return false;
}

}  // namespace lm
