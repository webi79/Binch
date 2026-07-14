/** tz-lookup bringt keine Typen mit: Koordinate → IANA-Zonenname, offline. */
declare module "tz-lookup" {
  export default function tzLookup(latitude: number, longitude: number): string;
}
