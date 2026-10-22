/**
 * „Steig 3" — der Zusatz eines einzelnen Bus-Steigs einer Station, in der
 * Sprache der App und vor einen eigenen Zusatz gestellt („Steig 3 · → Truro").
 *
 * Der Server liefert nur die Bezeichnung (`platform`, „3"); das Wort davor
 * setzt die App. So behält auch eine gespeicherte Station ihren Zusatz — in
 * jeder Sprache, und über den Abgleich der Namen beim Start hinweg.
 */
export function standDetail(
  t: (key: string) => string,
  platform: string | undefined,
  detail: string | undefined,
): string | undefined {
  const stand = platform ? `${t("stop.stand.prefix")} ${platform}` : undefined;
  return [stand, detail].filter(Boolean).join(" · ") || undefined;
}

/** Das Wort vor der Steig-/Gleisangabe einer Abfahrt: „Steig" beim Bus, sonst „Gl.". */
export function platformPrefixFor(t: (key: string) => string, product: string | null | undefined): string {
  return product === "bus" ? t("stop.stand.prefix") : t("stop.platform.prefix");
}
