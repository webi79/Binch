/**
 * Route-Map als Push-Screen IM Search-Stack — KEIN Tab-Switch mehr.
 *
 * Vorher öffnete „Karte anzeigen" den Surroundings-Tab via
 * router.navigate("/(tabs)/surroundings") und beim Back wurde der
 * Results-Screen via router.replace neu gemountet → Loader spielte
 * unnötig nochmal → gefühlter Lag.
 *
 * Jetzt: Map ist eine eigene Route innerhalb des Search-Stacks.
 * router.push → liegt OBEN auf Results, das drunter bleibt gemountet.
 * Back-Button → router.back() poppt sauber, Results sofort wieder sichtbar
 * ohne Re-Mount.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useAppBg } from "@/lib/theme/appBg";
import Animated, { FadeOut } from "react-native-reanimated";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSearchStore } from "@/stores/searchStore";
import { MapSurface, type MapSurfaceHandle } from "@/components/surroundings/MapSurface";
import { useResolvedMapStyle } from "@/lib/theme/mapStyleChoice";
import { MapSkeleton } from "@/components/surroundings/MapSkeleton";
import { RouteLayer } from "@/components/surroundings/RouteLayer";
import { RouteBanner } from "@/components/surroundings/RouteBanner";
import { scaledStyles } from "@/lib/ui/compact";

const C = { bg: "#0D0D0D" };

export default function RouteMapScreen() {
  const appBg = useAppBg();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const pendingRoute = useSearchStore((s) => s.pendingRoute);
  const clearRoute = useSearchStore((s) => s.clearRoute);
  const mapRef = useRef<MapSurfaceHandle>(null);
  const mapStyleName = useResolvedMapStyle();
  /** Die Beschriftung folgt der App-Sprache — siehe `locale` an der Kartenfläche. */
  const locale = useSearchStore((s) => s.locale);
  /** Kartentyp UND Sprache: Ändert sich eins, entsteht eine neue Karte (`key`). */
  const mapKey = `${mapStyleName}:${locale}`;

  // Die native MapLibre-Surface ist die ersten Frames WEISS, bis Style und
  // Tiles gerendert sind — dieser Screen mountet die Map frisch, also blitzte
  // beim Öffnen kurz Weiß auf. Gleiches Muster wie im Surroundings-Tab: das
  // dunkle Skelett liegt oben, bis onMapRendered feuert, dann fadet es weg.
  //
  // „Gezeichnet" gilt je KARTE, nicht je Bildschirm: Nach einem Wechsel von
  // Kartentyp oder Sprache (in den Einstellungen, während dieser Bildschirm im
  // Stapel liegt) entsteht eine neue Karte. Sie startet ohne Ausschnitt weit
  // draußen — das Skelett deckt sie wieder ab, bis sie gezeichnet ist, und der
  // Rahmen um die Route wird für sie neu gesetzt (Effekt unten).
  const [renderedKey, setRenderedKey] = useState<string | null>(null);
  const mapTilesRendered = renderedKey === mapKey;

  // Bei Mount Auto-fit auf alle Waypoints. Berechne die Bbox aus allen
  // Koordinaten der Route.
  const bbox = useMemo(() => {
    if (!pendingRoute || pendingRoute.waypoints.length === 0) return null;
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLng = Infinity;
    let maxLng = -Infinity;
    for (const wp of pendingRoute.waypoints) {
      if (wp.latitude < minLat) minLat = wp.latitude;
      if (wp.latitude > maxLat) maxLat = wp.latitude;
      if (wp.longitude < minLng) minLng = wp.longitude;
      if (wp.longitude > maxLng) maxLng = wp.longitude;
    }
    if (!Number.isFinite(minLat)) return null;
    return {
      sw: [minLng, minLat] as [number, number],
      ne: [maxLng, maxLat] as [number, number],
    };
  }, [pendingRoute]);

  useEffect(() => {
    // Auf das ECHTE Signal warten, nicht auf eine Schätzung.
    //
    // Hier stand ein fester Timer von 150ms mit der Begründung „damit die Map
    // zuerst mountet". Ob MapLibre in 150ms so weit ist, hängt aber vom Gerät,
    // vom Cache und vom Netz ab — mal ja, mal nein. War sie es nicht, lief
    // fitBounds ins Leere: Die Karte blieb auf ihrem Startausschnitt stehen
    // statt die Route zu zeigen. Genau das ist das gelegentliche „buggt rum"
    // beim Wechsel zur Karte, und es ließ sich nie zuverlässig nachstellen.
    //
    // onMapRendered feuert, wenn die Karte wirklich gezeichnet hat — dasselbe
    // Signal, das auch das Skelett wegblendet. Der Ausschnitt springt damit noch
    // hinter dem ausblendenden Skelett an seinen Platz.
    if (!bbox || !mapTilesRendered) return;
    mapRef.current?.fitBounds(bbox.sw, bbox.ne, 80);
  }, [bbox, mapTilesRendered]);

  // Wenn pendingRoute fehlt (z.B. Hot-Reload Edge-Case oder direkter Aufruf),
  // sofort zurück.
  useEffect(() => {
    if (!pendingRoute) {
      if (router.canGoBack()) router.back();
    }
  }, [pendingRoute, router]);

  const handleBack = () => {
    // Erst Map raus, dann State leeren (kleiner Versatz damit der Map-Clear
    // nicht sichtbar während der Pop-Animation flackert).
    //
    // Guard gegen einen Race: Öffnet der User innerhalb der 400 ms schon die
    // NÄCHSTE Route („Karte anzeigen" am nächsten Ergebnis), würde der Timer
    // deren pendingRoute löschen — und der frisch gepushte Karten-Screen poppt
    // sich sofort selbst wieder zu (siehe !pendingRoute-Effekt oben). Deshalb
    // löschen wir nur, wenn die Route noch DIESELBE ist wie beim Zurücktippen.
    const closing = pendingRoute;
    if (router.canGoBack()) router.back();
    setTimeout(() => {
      if (useSearchStore.getState().pendingRoute === closing) clearRoute();
    }, 400);
  };

  if (!pendingRoute) return <View style={[styles.root, { backgroundColor: appBg }]} />;

  return (
    <View style={[styles.root, { backgroundColor: appBg }]}>
      {/**
        * Dieselbe Karten-Wahl wie im Umgebungs-Tab.
        *
        * Hier fehlte die Angabe ganz, und ohne sie greift die Vorgabe „dunkel".
        * Wer Satellit eingestellt hatte, bekam die Zugstrecke trotzdem auf der
        * dunklen Karte — die Einstellung sah aus, als hätte sie sich
        * zurückgesetzt. Es gibt nur EINE Karten-Wahl in dieser App, und beide
        * Karten lesen sie jetzt aus derselben Quelle.
        *
        * Der `key` hat denselben Grund wie im Umgebungs-Tab — siehe dort.
        */}
      <MapSurface
        key={mapKey}
        styleName={mapStyleName}
        locale={locale}
        ref={mapRef}
        onMapRendered={() => setRenderedKey(mapKey)}
      >
        <RouteLayer
          waypoints={pendingRoute.waypoints}
          legs={pendingRoute.legs}
          mode={pendingRoute.mode}
        />
      </MapSurface>
      {!mapTilesRendered && (
        <Animated.View
          style={StyleSheet.absoluteFill}
          exiting={FadeOut.duration(280)}
          pointerEvents="none"
        >
          <MapSkeleton />
        </Animated.View>
      )}
      <RouteBanner
        title={pendingRoute.title ?? "Route"}
        waypointCount={pendingRoute.waypoints.length}
        onBack={handleBack}
        topInset={insets.top}
      />
    </View>
  );
}

const styles = scaledStyles({
  root: { flex: 1, backgroundColor: C.bg },
});
