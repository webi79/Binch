# Produktions-Deploy mit TLS (verschlüsselte Client↔Server-Strecke)

Im **Dev-Betrieb ist die Verbindung NICHT verschlüsselt** (Klartext-HTTP über die
LAN-IP — ein Zertifikat auf eine reine IP ist nicht möglich, und das Handy muss
den Server im WLAN erreichen). Das ist ok fürs lokale Entwickeln, **niemals** für
echte Nutzer.

Sobald der Server öffentlich erreichbar wird, MUSS dieser Ablauf her. Er ist so
gebaut, dass die drei Footguns (offener Klartext-Port, kaputtes Rate-Limit hinter
dem Proxy, versehentlicher http-Client) alle geschlossen sind — aber nur, wenn
**alle** Env-Werte gesetzt sind.

## 1. Domain

Eine (Sub-)Domain per DNS-A-Record auf die Server-IP zeigen lassen, z.B.
`api.binch.app → <Hetzner-IP>`. Caddy holt das Let's-Encrypt-Zertifikat dann
vollautomatisch (Port 80 + 443 müssen von außen erreichbar sein).

## 2. Server-Env (`server/.env`)

```dotenv
# TLS-Proxy: an welche Domain Caddy sein Zertifikat bindet.
DOMAIN=api.binch.app

# Klartext-Port 3000 NUR host-lokal binden → vom Netz nicht erreichbar, kein
# Bypass um Caddy herum. PFLICHT in Prod.
SERVER_BIND=127.0.0.1

# Rate-Limits zählen die ECHTE Client-IP aus X-Forwarded-For (das Caddy setzt)
# statt Caddys Container-IP. OHNE das teilen sich alle Nutzer einen Bucket.
# Nur sicher, WEIL SERVER_BIND den Port host-lokal einsperrt — sonst könnte ein
# Angreifer XFF über den offenen Port fälschen.
TRUST_PROXY=true
```

## 3. Client-Env (Build-Zeit)

```dotenv
# Die App spricht ab jetzt HTTPS. Sobald diese URL https:// ist, schaltet der
# Build usesCleartextTraffic automatisch AUS (Android blockt dann jeden
# http-Fetch), und ein Release-Build mit versehentlicher http-URL crasht beim
# Start statt still Klartext zu senden.
EXPO_PUBLIC_API_BASE_URL=https://api.binch.app
```

## 4. Starten

```bash
# Mit dem tls-Profil — startet zusätzlich Caddy (443/80).
docker compose --profile tls up -d
```

## 5. Prüfen (alle drei müssen stimmen)

```bash
# a) HTTPS erreichbar, echtes Zertifikat (kein -k):
curl -sSI https://api.binch.app/health | head -1        # HTTP/2 200

# b) Klartext-Port NICHT vom Netz erreichbar (von einem anderen Host):
curl -m5 http://api.binch.app:3000/health               # muss timeouten/refused

# c) Rate-Limit zählt echte IPs: zwei verschiedene Clients dürfen sich NICHT
#    gegenseitig ins 429 treiben (nur der jeweils hämmernde).
```

## Was WOMIT zusammenhängt (nicht einzeln kippen)

- `SERVER_BIND=127.0.0.1` **und** `TRUST_PROXY=true` gehören zusammen. Nur eines
  von beiden ist unsicher: TRUST_PROXY ohne localhost-Bind = XFF-Spoofing über
  den offenen Port; localhost-Bind ohne TRUST_PROXY = alle Nutzer in einem
  Rate-Limit-Bucket.
- `DOMAIN` (Server) und die https-`EXPO_PUBLIC_API_BASE_URL` (Client) müssen auf
  dieselbe Domain zeigen, sonst schlägt die Zertifikatsprüfung im Client fehl.

## Andere Proxy-Topologie (Cloudflare / Hetzner LB)

Wenn statt des compose-Caddy ein Edge-Proxy davor soll: Origin-TLS trotzdem
nötig (sonst ist der letzte Hop übers Internet Klartext). Entweder Caddy behalten
und Cloudflare „Full (strict)" fahren, oder die TLS-Terminierung ganz in den
LB/Edge verlagern und den Caddy-Service aus dem Compose nehmen — dann greifen
SERVER_BIND/TRUST_PROXY sinngemäß für den neuen Proxy.
