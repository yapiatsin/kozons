# Kozons

Réseau social façon WhatsApp / Instagram. Le dépôt contient deux projets :

```
kozons/
├── KozonWeb/          Application web Django + API JSON (déployée sur le VPS)
│   ├── manage.py
│   ├── koz/           Réglages Django, ASGI (Daphne + Channels)
│   ├── accounts/  chat/  social/  live/  meet/  brady/  shop/
│   ├── kozons/        Front SPA (static/kozons/js) + routes de l'API (urls_api.py)
│   ├── Dockerfile  docker-compose.yml  Makefile  caddy/  docker/
│   ├── requirements.txt  .env.example  .env.prod.example
│   └── (non suivis) .env  env/  media/  db.sqlite3  backups/
├── Kozonmobile/       Application mobile Flutter (Android / iOS), cliente de l'API
│   ├── lib/config/api_config.dart   Adresse de l'API (local / production)
│   └── lib/main.dart
├── .claude/launch.json  Serveur de dev (prévisualisation dans Claude Code)
└── README.md
```

Les API utilisées par le mobile s'écrivent dans **KozonWeb** : JSON sous `/api/`
(`KozonWeb/kozons/urls_api.py`), temps réel sous `/ws/`, fichiers sous `/media/`.

## Lancer le web (KozonWeb)

Depuis `KozonWeb/` :

```powershell
cd KozonWeb
env\Scripts\python.exe manage.py migrate
env\Scripts\python.exe manage.py runserver 127.0.0.1:8030
```

Puis http://127.0.0.1:8030. Tests : `env\Scripts\python.exe manage.py test`.

**Recréer le virtualenv** (nouveau poste, ou si `env\` est cassé — il a été déplacé avec
le reste, et les lanceurs `.exe` secondaires gardent l'ancien chemin) :

```powershell
cd KozonWeb
Remove-Item -Recurse -Force env
py -3.14 -m venv env
env\Scripts\python.exe -m pip install -r requirements.txt
```

`.env` (modèle `.env.example`) est lu dans `KozonWeb/`. Détails fonctionnels : [KozonWeb/README.md](KozonWeb/README.md).

## Lancer le mobile (Kozonmobile)

Flutter 3.44+ requis. Depuis `Kozonmobile/` :

```powershell
cd Kozonmobile
flutter pub get
flutter run                                  # API locale (KozonWeb sur le port 8030)
flutter run --dart-define=KOZONS_ENV=prod    # API de production https://kozonstic.com
```

En local, l'émulateur Android joint le PC via `http://10.0.2.2:8030`, le simulateur iOS via
`http://127.0.0.1:8030`. Autre adresse : `--dart-define=KOZONS_API_URL=http://IP:8030`.
Détails : [Kozonmobile/README.md](Kozonmobile/README.md).

**Connexion du mobile** : le site utilise le cookie de session + jeton CSRF ; l'application, elle,
obtient un **jeton d'API** (`POST /api/auth/token`, mêmes identifiants et mêmes règles que le site)
et l'envoie à chaque requête (`Authorization: Token kz_…`), y compris à l'ouverture du WebSocket `/ws/`.
Déconnexion = jeton révoqué ; changer de mot de passe ou retirer l'accès (`can_connect`) ferme aussi
les téléphones. Les appareils connectés sont visibles (et révocables) dans l'admin Django, « Api tokens ».
Code : `KozonWeb/accounts/tokens.py`, `accounts/middleware.py`, `accounts/ws_auth.py`.

## Déploiement sur le VPS

Le dépôt reste cloné dans `/opt/kozons`, mais **toutes les commandes `make` se lancent désormais
depuis `/opt/kozons/KozonWeb`**. Le Caddy partagé (`eprinters_caddy`), les dossiers
`/srv/apps/kozons/{media,static}` et les conteneurs `kozons-*` ne changent pas.
Le projet Docker Compose garde le nom `kozons` (fixé par `name: kozons` dans `docker-compose.yml`),
donc la base PostgreSQL existante (volume `kozons_pgdata`) est réutilisée.

### Déploiement courant

```bash
cd /opt/kozons/KozonWeb
make rebuild      # git pull + build + redémarrage + Caddy
make migrate      # si des migrations sont en attente
```

### ⚠ Première fois après la réorganisation (à faire à la main, une seule fois)

`git pull` déplace les fichiers suivis, mais **pas** les fichiers non suivis du serveur :
`.env` et `backups/` restent dans `/opt/kozons` et doivent être déplacés dans `KozonWeb/`.

```bash
cd /opt/kozons
make backup                      # par prudence, avec l'ancien Makefile, AVANT le pull
git pull --ff-only               # les fichiers passent dans KozonWeb/
mv .env KozonWeb/.env            # obligatoire : sinon make rebuild s'arrête
[ -d backups ] && mv backups KozonWeb/backups   # sauvegardes PostgreSQL (make backup/restore)
cd KozonWeb
docker compose config | head -1   # doit afficher : name: kozons
make rebuild
make migrate
```

Points d'attention :

- **Ne pas lancer `docker compose` depuis `/opt/kozons`** : il n'y a plus de `docker-compose.yml` à la racine.
- `media/` n'a rien à déplacer en production : les fichiers envoyés sont dans `/srv/apps/kozons/media`
  (chemin absolu, monté par Docker et servi par Caddy).
- `make rebuild` vérifie que `.env` est bien dans `KozonWeb/` et prévient s'il est resté dans `/opt/kozons`.
- Les anciens conteneurs sont repris tels quels (mêmes noms `kozons-*`, même projet `kozons`) ;
  aucune donnée n'est recréée.
