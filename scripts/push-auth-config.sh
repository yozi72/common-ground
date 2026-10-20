#!/usr/bin/env bash
# Pushes the hosted project's auth settings (site URL, redirect URLs, custom
# SMTP, email rate limit) from .env.local to Supabase, without changing the
# committed config.toml that local development uses.
#
#   SITE_URL=https://your-domain.example ./scripts/push-auth-config.sh
#
# Requires: `npx supabase login` done, project linked, SMTP_* set in .env.local.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env.local; set +a
: "${SITE_URL:=https://common-ground-dusky-nine.vercel.app}"
: "${SMTP_HOST:?set SMTP_HOST in .env.local}"; : "${SMTP_PASS:?set SMTP_PASS in .env.local}"

cp supabase/config.toml /tmp/config.toml.local-backup
trap 'cp /tmp/config.toml.local-backup supabase/config.toml' EXIT

python3 - "$SITE_URL" <<'EOF'
import re, sys, os
site = sys.argv[1]
p = "supabase/config.toml"
s = open(p).read()
s = re.sub(r'^site_url = .*$', f'site_url = "{site}"', s, flags=re.M)
s = re.sub(r'^additional_redirect_urls = .*$', f'additional_redirect_urls = ["{site}/auth/callback", "http://localhost:3000/auth/callback"]', s, flags=re.M)
s = re.sub(r'^email_sent = \d+', 'email_sent = 200', s, flags=re.M)
# replace the commented smtp block with a live one
smtp = f'''[auth.email.smtp]
enabled = true
host = "{os.environ['SMTP_HOST']}"
port = {os.environ.get('SMTP_PORT', '587')}
user = "{os.environ['SMTP_USER']}"
pass = "env(SMTP_PASS)"
admin_email = "{os.environ['SMTP_USER']}"
sender_name = "{os.environ.get('SMTP_SENDER_NAME', 'Common Ground')}"
'''
s = re.sub(r'^# \[auth\.email\.smtp\]\n(?:# .*\n)*', smtp, s, count=1, flags=re.M)
open(p, "w").write(s)
EOF

npx supabase config push --yes
echo "Pushed auth config for $SITE_URL"
