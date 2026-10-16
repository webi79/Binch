#!/usr/bin/env python3
"""Bettet milkyway.jpg als C++-Header in den MapLibre-Quelltext ein.

Aufruf (im MapLibre-Checkout, nach dem Patch):
    python3 <binch>/vendor/maplibre-native/sky/embed.py src/mln/renderer/binch_milkyway.hpp
"""
import sys
from pathlib import Path

data = (Path(__file__).parent / "milkyway.jpg").read_bytes()
lines = ["    " + ",".join("0x%02x" % b for b in data[i:i + 24]) + "," for i in range(0, len(data), 24)]
head = """#pragma once

// Binch: die Milchstraße hinter dem Globus, als JPEG eingebettet (4096 x 1138).
//
// Quelle: "The Milky Way panorama", ESO/S. Brunier (eso0932a), lizenziert unter
// Creative Commons Attribution 4.0 International. Die Nennung "ESO/S. Brunier" ist
// Pflicht und steht in der App bei den Kartenquellen. Bearbeitet: gleichabständig
// in galaktischen Koordinaten (Mitte = galaktisches Zentrum, l wächst nach links),
// auf +-50 Grad galaktische Breite zugeschnitten, Sterne per Medianfilter (7 px)
// entfernt (die zeichnet der Shader scharf selbst), auf 4096 px Breite verkleinert.
//
// Erzeugt von vendor/maplibre-native/sky/embed.py im Binch-Repo; nicht von Hand ändern.

#include <cstddef>

namespace mln {
namespace binch {

inline constexpr unsigned char milkyWayJpeg[] = {
"""
tail = """
};
inline constexpr std::size_t milkyWayJpegSize = sizeof(milkyWayJpeg);

} // namespace binch
} // namespace mln
"""
Path(sys.argv[1]).write_text(head + "\n".join(lines) + tail)
print(f"{len(data)} Bytes -> {sys.argv[1]}")
