/**
 * Maße der 3D-Modelle der Live-Ansicht — ERZEUGT von
 * `server/scripts/build-live-models.mjs`, nicht von Hand ändern. Gehen an die
 * Karten-Ebene (`modules/live-models`): Länge für die Wagenkette, der Rest für
 * die Farben, die der Shader auf den Körper malt.
 */
export const LIVE_MODEL_SPECS = {
  "rail-ice": {
    "length": 25,
    "head": {
      "a0": 2.5075000000000003,
      "H": 5.07,
      "zBot": 0.7150000000000001,
      "half": 12.5,
      "bodyEnd": 5,
      "noseLen": 7.5,
      "nose": 0,
      "window": 2.35,
      "doors": [
        -9.625,
        5.875
      ],
      "stripe": "#EC0016",
      "head": 1
    },
    "mid": {
      "a0": 2.5075000000000003,
      "H": 5.07,
      "zBot": 0.7150000000000001,
      "half": 12.5,
      "bodyEnd": 12.1,
      "noseLen": 7.5,
      "nose": 0,
      "window": 2.35,
      "doors": [
        -7.75,
        7.75
      ],
      "stripe": "#EC0016",
      "head": 0
    }
  },
  "rail-regional": {
    "length": 26,
    "head": {
      "a0": 2.465,
      "H": 5.33,
      "zBot": 0.7150000000000001,
      "half": 13,
      "bodyEnd": 10.4,
      "noseLen": 2.6,
      "nose": 1,
      "window": 2.2,
      "doors": [
        -7.670000000000001,
        6.37
      ],
      "stripe": "#E8A800",
      "head": 1
    },
    "mid": {
      "a0": 2.465,
      "H": 5.33,
      "zBot": 0.7150000000000001,
      "half": 13,
      "bodyEnd": 12.6,
      "noseLen": 2.6,
      "nose": 1,
      "window": 2.2,
      "doors": [
        -7.0200000000000005,
        7.0200000000000005
      ],
      "stripe": "#E8A800",
      "head": 0
    }
  },
  "rail-subway": {
    "length": 18,
    "head": {
      "a0": 2.2525,
      "H": 4.615,
      "zBot": 0.7150000000000001,
      "half": 9,
      "bodyEnd": 8,
      "noseLen": 1,
      "nose": 2,
      "window": 2,
      "doors": [
        -5.83,
        -0.25,
        5.33
      ],
      "stripe": "#1F3A8A",
      "head": 1
    },
    "mid": {
      "a0": 2.2525,
      "H": 4.615,
      "zBot": 0.7150000000000001,
      "half": 9,
      "bodyEnd": 8.6,
      "noseLen": 1,
      "nose": 2,
      "window": 2,
      "doors": [
        -5.58,
        0,
        5.58
      ],
      "stripe": "#1F3A8A",
      "head": 0
    }
  },
  "rail-tram": {
    "length": 10,
    "head": {
      "a0": 2.04,
      "H": 4.42,
      "zBot": 0.39,
      "half": 5,
      "bodyEnd": 3.5,
      "noseLen": 1.5,
      "nose": 1,
      "window": 1.8,
      "doors": [
        0.125
      ],
      "stripe": "#2A2A2C",
      "head": 1
    },
    "mid": {
      "a0": 2.04,
      "H": 4.42,
      "zBot": 0.39,
      "half": 5,
      "bodyEnd": 4.6,
      "noseLen": 1.5,
      "nose": 1,
      "window": 1.8,
      "doors": [
        0.5
      ],
      "stripe": "#2A2A2C",
      "head": 0
    }
  },
  "bus": {
    "length": 12.5,
    "head": {
      "a0": 1.9762499999999998,
      "H": 4.375,
      "zBot": 0.525,
      "half": 6.25,
      "length": 12.5
    }
  },
  "plane": {
    "length": 37.6
  }
} as const;

export type LiveModelSet = keyof typeof LIVE_MODEL_SPECS;
