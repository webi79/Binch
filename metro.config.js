const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

const config = getDefaultConfig(__dirname);

// Optional installierte Plattform-Native-Binaries (sharp, ngrok-bin-*) tauchen
// für ALLE Plattformen im node_modules-Tree auf. Wenn npm sie pruned (weil
// nicht für unsere Plattform), aber Metro sie schon gewatcht hat, crasht
// der FallbackWatcher mit ENOENT. Hier explizit ausschließen.
config.resolver.blockList = [
  /node_modules\/@img\/.*/,
  /node_modules\/@expo\/ngrok-bin-.*/,
];

module.exports = withNativeWind(config, { input: "./global.css" });
