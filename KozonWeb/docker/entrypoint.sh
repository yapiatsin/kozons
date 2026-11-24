#!/bin/sh
# Démarrage du conteneur kozons-web.
# Les migrations ne sont PAS lancées ici : après un déploiement qui en contient,
#   make migrate            (ou : make kozons-web  puis  python manage.py migrate)
set -e

# Fichiers statiques copiés dans le dossier partagé avec Caddy (/srv/apps/kozons/static).
python manage.py collectstatic --noinput --verbosity 0

exec "$@"
