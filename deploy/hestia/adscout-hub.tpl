#=============================================================================#
# AdScout — HestiaCP nginx proxy template (extraction hub, port 8788)          #
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

    location / {
        proxy_pass http://127.0.0.1:8788;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        # oauthRedirectUri() in src/server/app.ts reads this to decide http vs
        # https when it builds the Gmail OAuth callback. Drop it and the app
        # hands Google an http:// callback that will not match the registered one.
        proxy_set_header X-Forwarded-Proto $scheme;

        # The worker POSTs an extracted reply back, and attachments ride along
        # inline as base64 — the hub itself accepts up to 96 MB. nginx defaults
        # to 1 MB, which would reject exactly the replies that matter with a 413
        # the worker reports as a failed extraction.
        client_max_body_size 128m;

        # /work/claim is a 20-second long-poll and a worker holds a lease for up
        # to 20 minutes. Anything shorter severs the claim mid-extraction.
        proxy_buffering    off;
        proxy_cache        off;
        proxy_read_timeout 30m;
        proxy_send_timeout 30m;

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
