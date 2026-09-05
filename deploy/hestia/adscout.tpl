#=============================================================================#
# AdScout — HestiaCP nginx proxy template (dashboard + API, port 8787)        #
#                                                                             #
# Install:                                                                    #
#   sudo cp deploy/hestia/adscout*.tpl deploy/hestia/adscout*.stpl \          #
#           /usr/local/hestia/data/templates/web/nginx/                       #
#   sudo chmod 644 /usr/local/hestia/data/templates/web/nginx/adscout*        #
#   # then pick template "adscout" for the domain in the Hestia panel, and:   #
#   sudo v-rebuild-web-domain <user> <domain>                                         #
#                                                                             #
# Hestia templates cannot take the backend port as a variable, so the port is #
# literal below and there is a second pair (adscout-hub) for the hub on 8788. #
#                                                                             #
# Differs from Hestia's stock proxy template in two ways that matter here:    #
#                                                                             #
#  1. NO static-file shortcut. The stock template serves %proxy_extensions%   #
#     (js, css, …) from the domain's docroot and only falls back to the app.  #
#     AdScout's assets live in web/dist and are served BY the Node process, so #
#     that shortcut would 404 the whole dashboard.                            #
#  2. proxy_buffering off. /api/stream is Server-Sent Events; with buffering  #
#     on, nginx holds the frames and the UI silently stops updating.          #
#=============================================================================#

server {
    listen      %ip%:%proxy_port%;
    server_name %domain_idn% %alias_idn%;
    error_log   /var/log/%web_system%/domains/%domain%.error.log error;

    # Hestia's own force-SSL switch. Toggling "Enforce SSL" for the domain in the
    # panel writes this file; the stock template includes it and ours must too,
    # or the switch silently does nothing and the whole API stays answerable over
    # plain HTTP — which means an Authorization: Bearer <Firebase ID token>
    # crossing the wire in the clear, valid for an hour, with full admin access.
    #
    # Using Hestia's file rather than a hand-written `return 301` is deliberate:
    # Let's Encrypt renews over HTTP-01 and must keep reaching
    # /.well-known/acme-challenge/. Hestia's redirect already accounts for that;
    # a hand-rolled one that forgets it fails silently, 60-90 days later, when
    # the certificate expires.
    include %home%/%user%/conf/web/%domain%/nginx.forcessl.conf*;

    location / {
        proxy_pass http://127.0.0.1:8787;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        # oauthRedirectUri() in src/server/app.ts reads this to decide http vs
        # https when it builds the Gmail OAuth callback. Drop it and the app
        # hands Google an http:// callback that will not match the registered one.
        proxy_set_header X-Forwarded-Proto $scheme;

        # A deal reply can carry an attachment, and a bulk import posts a large
        # JSON body. nginx's 1 MB default would reject both with a 413.
        client_max_body_size 32m;

        # SSE: never buffer, and let the connection stay open. The change feed
        # is a single response that lasts as long as the tab does.
        proxy_buffering    off;
        proxy_cache        off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;

        access_log /var/log/%web_system%/domains/%domain%.log combined;
        access_log /var/log/%web_system%/domains/%domain%.bytes bytes;
    }

    location /error/ {
        alias %home%/%user%/web/%domain%/document_errors/;
    }

    location ~ /\.(?!well-known\/|file) {
        deny all;
        return 404;
    }

    include %home%/%user%/conf/web/%domain%/nginx.conf_*;
}
