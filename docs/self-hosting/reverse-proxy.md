---
title: "Put SlugBase Behind a Reverse Proxy"
description: "Run SlugBase behind a TLS-terminating reverse proxy with the right origin, headers, trusted proxy hops, body limit and cache rules, using a complete nginx or Caddy file."
edition: ce
order: 30
---

SlugBase does not terminate TLS. You put a reverse proxy in front of it that serves your public HTTPS address and passes the requests on to the SlugBase server. This page lists what the proxy must do, how to set `TRUSTED_PROXY_HOPS` so rate limits count real clients, and gives a complete nginx file and a complete Caddy file.

## Prerequisites

- A SlugBase that runs on a `compose.yml` installation. The server publishes its port on `127.0.0.1:3000` unless you set `SLUGBASE_BIND` or `PORT` in `.env`.
- A domain name that points at the machine that runs the proxy, and a TLS certificate for it. Caddy gets one by itself. For nginx, you bring the certificate.
- Access to the `.env` file next to `compose.yml`.

## What the proxy must do

SlugBase serves the web app, the API (`/api/*`) and the slug forwarding (`/go/*`) from one origin. One public address therefore reaches everything, and the proxy needs no rules per path.

| Requirement | Why |
| ----------- | --- |
| Serve the public HTTPS address and pass every path to the server's port. | The app, the API and `/go` share one origin. |
| Send the `Host` header on, unchanged. | It is the convention for a proxy. SlugBase does not read the host name to decide what its own address is. `APP_ORIGIN` decides that. |
| Add the address of the client to `X-Forwarded-For`. | The rate limits count the client's address. |
| Pass `Origin` and `Sec-Fetch-Site` on, and never strip or rewrite them. | The server refuses a browser request that changes data unless its `Origin` is exactly `APP_ORIGIN`. A proxy that removes the header breaks sign-in and every save. |
| Allow a request body of at least 6 MiB. | An import file is up to 5 MiB. |
| Leave the response headers alone, and never cache `/api/*` or `/go/*`. | See [Caching](#caching). |

SlugBase never reads `X-Forwarded-Proto`, `X-Forwarded-Host`, `X-Real-IP` or `Forwarded`. It takes the scheme from `APP_ORIGIN`, so the proxy can send those headers or not.

## Set the origin

Set `APP_ORIGIN` in `.env` to the address your members type, as an origin: the scheme, the host and a port only if it is not the default, and nothing else.

```sh
APP_ORIGIN=https://links.example.com
```

In production, SlugBase refuses to start unless `APP_ORIGIN` starts with `https://`. A path, a query, a fragment or credentials in it make it invalid. The origin sets three things: the name and the `Secure` attribute of the session cookie, the `Strict-Transport-Security` header, and the address that links in mail point at. Serve the app on one origin only. A second host name that reaches the same server is not a second origin, and requests from it fail the origin check.

## Trusted proxy hops

The rate limits count requests per client address. SlugBase reads the address from `X-Forwarded-For`, and only across the number of proxies you tell it to trust. Set `TRUSTED_PROXY_HOPS` to the number of reverse proxies between the browser and the server, each of which adds the address it received the request from to the end of `X-Forwarded-For`.

SlugBase counts from the right. With `TRUSTED_PROXY_HOPS=1` it takes the last entry. With `2` it takes the second from the right. Everything left of that entry is text that the client could have written, and SlugBase ignores it. If the header has fewer entries than hops, or the chosen entry is not an IP address, SlugBase uses the address of the connection instead.

A wrong value breaks one of two things:

- **Too low, or `0`.** At the default of `0` SlugBase ignores `X-Forwarded-For` and sees only the proxy's address. Every client then shares one bucket for each per-IP limit, so one client can use up the sign-in limit for everyone. A production start with `0` logs a warning.
- **Too high.** SlugBase trusts an entry that a client wrote, so a client chooses its own address for the rate limit. It can then dodge the per-IP limits by changing the header on each request.

### Count the hops

Count the reverse proxies that write to `X-Forwarded-For`, from your server outwards.

| Setup | `X-Forwarded-For` that the server receives, from the left | `TRUSTED_PROXY_HOPS` |
| ----- | ------------------------------------------ | -------------------- |
| One proxy (nginx or Caddy) in front of SlugBase | `<client>`, which a client can put text in front of | `1` |
| A CDN or load balancer in front of your proxy, both adding the address they see | `<client>, <the CDN's address>` | `2` |
| Clients reach the server's port directly, with no proxy | none | `0` |

Set it in `.env`, then start the containers again so that they read it.

```sh
TRUSTED_PROXY_HOPS=1
```

```sh
docker compose up -d
```

If a proxy in the chain does not add to `X-Forwarded-For`, it does not count. Count it only when it writes the header. A tunnel or CDN product has its own rules, which this page does not cover.

Keep the server's port reachable from the proxy only. By default `compose.yml` publishes it on `127.0.0.1`. Anyone who can connect to that port directly writes `X-Forwarded-For` themselves, and with `TRUSTED_PROXY_HOPS=1` SlugBase believes the entry they write.

### Check the value

SlugBase does not write the client address to its log, so check the setting from the outside. Sign-in allows 10 attempts a minute for each address by default (`RATE_LIMIT_LOGIN_IP`). From one machine, send 12 attempts for an address that has no account. The answers turn from `401` to `429` after about 10.

```sh
for i in $(seq 1 12); do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST https://links.example.com/api/v1/auth/login \
    -H 'Content-Type: application/json' -H 'Origin: https://links.example.com' \
    -d '{"email":"nobody@example.com","password":"not-a-real-password"}'
done
```

At once, from a second machine with another address, send one attempt. It must not answer `429`. If it does, both machines share one bucket, and `TRUSTED_PROXY_HOPS` is too low or your proxy does not add the address.

## Caching

The server sets the cache headers, and the proxy must not change them.

- `/api/*` and `/go/*` answer with `Cache-Control: no-store`. They are per member, and a cached `/go` redirect would send one member to another member's bookmark. Never cache them, and never add a rule that overrides the header. Two API responses carry their own policy: `GET /api/config` is public for 60 seconds, and a site icon is private and long-lived. Leave those as the server sends them.
- The files of the web app below `/assets/` have a content hash in their name and answer with `Cache-Control: public, max-age=31536000, immutable`. A proxy or CDN may cache them.
- `index.html` and other files answer with `Cache-Control: no-cache`. A proxy may keep a copy only if it revalidates it.
- `/health`, `/ready` and `/version` answer with `no-store`.

The nginx and Caddy files below cache nothing. That is the safe default, and both obey the headers above.

SlugBase sets its own security headers (the content security policy, `Strict-Transport-Security`, `X-Content-Type-Options` and others). Do not add them in the proxy. A second copy of a header can conflict with the first.

## Upload size and timeouts

- **Body size.** Importing a bookmark file sends up to 5 MiB. A Netscape HTML import adds up to 16 KiB for the form around the file. Set the limit of the proxy to 6 MiB, which covers both. The server refuses a larger body itself with `413`. Every other request is far smaller, and the server limits each route on its own.
- **Exports.** An export is generated while it downloads. The server reads the bookmarks page by page and sends them as it goes, and stores nothing. A long export of a large library can take a while, so the proxy must not end a download that is still sending. The timeouts in the files below allow 5 minutes for the export route. Turn response buffering off for it, so that the download starts at once and the proxy does not write the file to its own disk first.

## nginx

Save this as `/etc/nginx/conf.d/slugbase.conf`. It is a complete site file for nginx 1.25.1 or later. Replace `links.example.com` and the two certificate paths with your own.

```nginx
# The SlugBase server on this machine. The default compose.yml publishes it here.
upstream slugbase {
    server 127.0.0.1:3000;
}

# Send plain http to https.
server {
    listen 80;
    listen [::]:80;
    server_name links.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name links.example.com;

    ssl_certificate     /etc/ssl/slugbase/fullchain.pem;
    ssl_certificate_key /etc/ssl/slugbase/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    # An import is up to 5 MiB, plus 16 KiB for a Netscape HTML upload.
    client_max_body_size 6m;

    # The host name the browser used, and the address of the client. One proxy in
    # front of SlugBase means TRUSTED_PROXY_HOPS=1: $proxy_add_x_forwarded_for
    # appends the address nginx saw to whatever the client sent, and SlugBase reads
    # the last entry. Every other request header, Origin included, is passed on
    # as the browser sent it.
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Lets a request be matched to a line in SlugBase's log.
    proxy_set_header X-Request-Id $request_id;

    # Do not rewrite the Location of a /go redirect.
    proxy_redirect off;

    # Nothing is cached here. /api/ and /go/ must never be.
    proxy_cache off;

    proxy_connect_timeout 5s;
    proxy_read_timeout 60s;
    proxy_send_timeout 60s;

    location / {
        proxy_pass http://slugbase;
    }

    # Exports are streamed while they are generated: no buffering, and time to finish.
    location /api/v1/export/ {
        proxy_pass http://slugbase;
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    # Do not add a rule for /metrics, and do not publish the metrics port or the
    # worker. SlugBase serves /metrics on its own port (METRICS_PORT), never on this one.
}
```

Check the file, then reload nginx.

```sh
sudo nginx -t && sudo systemctl reload nginx
```

nginx adds the client address to `X-Forwarded-For` by itself, so this file needs `TRUSTED_PROXY_HOPS=1`. If another proxy or a CDN sits in front of nginx, set `2` and read [Count the hops](#count-the-hops). nginx then appends the address of that outer proxy to the entry the outer proxy wrote, so the header holds both. Only the outer proxy may be able to reach nginx.

## Caddy

Save this as `/etc/caddy/Caddyfile`. It is a complete Caddyfile. Replace `links.example.com` with your own host name. Caddy asks for the certificate and renews it by itself, and redirects plain `http` to `https`, so the file needs nothing for TLS.

```caddyfile
links.example.com {
	# An import is up to 5 MiB, plus 16 KiB for a Netscape HTML upload.
	request_body {
		max_size 6MiB
	}

	# Caddy sends the Host header on as it came and sets X-Forwarded-For to the
	# address of the client, so one Caddy in front of SlugBase means
	# TRUSTED_PROXY_HOPS=1. Origin and every other request header are passed on
	# as they came. Caddy caches nothing, and it sets no time limit on a response,
	# so a long export is not cut.
	reverse_proxy 127.0.0.1:3000
}
```

Reload Caddy after you save the file.

```sh
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

By default Caddy replaces an `X-Forwarded-For` that a client sends with the client's own address. That is what you want when Caddy is the first proxy. When Caddy sits behind another proxy or a CDN, it would discard what that proxy wrote, so list the proxy's addresses as trusted in the global options block at the top of the Caddyfile. Caddy then keeps the existing header and adds the address it saw. Use the real addresses of your outer proxy, and set `TRUSTED_PROXY_HOPS=2`.

```caddyfile
{
	servers {
		trusted_proxies static 203.0.113.0/24
	}
}
```

## What not to publish

- **`/metrics`.** It is on its own port, `METRICS_PORT`, and not on the public one. The metrics show request rates, queue depths and other facts about your installation. Leave `METRICS_PORT` unset unless you scrape it, and never publish it or add a proxy rule for it. `compose.yml` does not publish that port.
- **The worker.** The worker has no public listener. It needs no proxy rule and no open port. When you set `METRICS_PORT` for it, the same advice applies.
- **The database.** `compose.yml` publishes no port for PostgreSQL, and you should not add one.
- **`/api/docs`.** The interactive API reference and the OpenAPI document are on by default. Set `API_DOCS_ENABLED=false` in `.env` if you do not want them public.

## Check the setup

1. Open `https://links.example.com/version` in a browser. It answers with the name, version, commit and build time of your SlugBase.
2. Open `https://links.example.com/ready`. It answers `200` and a body that shows `"database":"ok"`.
3. Open the app, sign in and save a bookmark. If saving answers `403`, the proxy changed or removed the `Origin` header, or `APP_ORIGIN` is not the address in the browser's address bar.
4. Open `https://links.example.com/go/<a slug of yours>`. The browser must be sent to the bookmark.
5. Run the rate-limit check under [Check the value](#check-the-value).

## Troubleshooting

**Everyone is told `429` after a few sign-ins.** Every client shares one address. Set `TRUSTED_PROXY_HOPS` to the number of proxies in front of SlugBase and start the containers again.

**Saving, and signing in, answer `403`.** The server received no `Origin` header, or one that is not `APP_ORIGIN`. Check that `APP_ORIGIN` is exactly the address in the browser, including the host name and any port, and that the proxy passes `Origin` on.

**An import fails with `413`.** The proxy refused the body before it reached SlugBase. Raise its limit to 6 MiB, as in the files above.

**An export stops part way.** A timeout in the proxy ended the download. Raise the timeout of the export route, and turn off buffering for it.

**SlugBase does not start and names `APP_ORIGIN`.** In production the origin must start with `https://` and must have no path.

## Related pages

- [Self-Hosting SlugBase](index.md)
- [Environment Settings](environment.md)
- [Back Up and Restore SlugBase](backup-restore.md)
