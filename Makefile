###############################################################################
# Kozons — pilotage de la pile Docker sur le VPS
#
#   Déployer la dernière version du dépôt :  cd /opt/kozons && make rebuild
#   Entrer dans le conteneur Django       :  make kozons-web
#   Aide                                  :  make
#
# Caddy est partagé avec eprinters et autopiece (conteneur eprinters_caddy) :
# les cibles caddy-* installent notre fichier de site et rechargent ce conteneur.
###############################################################################

SHELL := /bin/bash
.DEFAULT_GOAL := help

COMPOSE     := docker compose
WEB         := kozons-web
REDIS       := kozons-redis
DJANGO      := $(COMPOSE) exec -T $(WEB) python manage.py
CADDY       ?= eprinters_caddy
CADDY_SITE  ?= /opt/caddy-sites/30-kozons.caddy
SHARED_DIR  ?= /srv/apps/kozons
HEALTH_URL  ?= http://127.0.0.1:8020/manifest.webmanifest

.PHONY: help rebuild pull build up down restart reload status ps health \
		logs logs-web logs-redis kozons-web kozons-redis shell \
		migrate migrate-check makemigrations superuser check backup \
		dirs caddy-install caddy-validate caddy-reload caddy-logs prune

help: ## Affiche cette aide
	@echo ""
	@echo "  Kozons — commandes disponibles"
	@echo "  ────────────────────────────────────────────────────────────"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
	@echo ""

# =============================================================================
# DÉPLOIEMENT
# =============================================================================
rebuild: ## ⭐ git pull + build de l'image + redémarrage + Caddy
	@test -f .env || { echo "  .env manquant : cp .env.prod.example .env puis complétez-le"; exit 1; }
	@echo "==> Récupération du code depuis GitHub..."
	git pull --ff-only
	@$(MAKE) --no-print-directory dirs
	@echo "==> Construction de l'image..."
	$(COMPOSE) build --pull $(WEB)
	@echo "==> Recréation des conteneurs..."
	$(COMPOSE) up -d --remove-orphans
	@$(MAKE) --no-print-directory caddy-install
	-docker image prune -f
	@$(MAKE) --no-print-directory health
	@$(DJANGO) migrate --check >/dev/null 2>&1 \
		|| echo -e "\n  \033[33m⚠ Migrations en attente : lancez  make migrate\033[0m\n"

dirs: ## Crée les dossiers persistants (propriétaire uid 1000 du conteneur)
	@mkdir -p data $(SHARED_DIR)/media $(SHARED_DIR)/static
	@chown -R 1000:1000 data $(SHARED_DIR)

pull: ## Récupère le code sans redéployer
	git pull --ff-only

build: ## Construit l'image sans redémarrer
	$(COMPOSE) build $(WEB)

# =============================================================================
# CYCLE DE VIE
# =============================================================================
up: ## Démarre la pile
	$(COMPOSE) up -d

down: ## Arrête la pile (base et médias conservés)
	$(COMPOSE) down

restart: ## Redémarre les conteneurs (ne relit PAS .env — voir reload)
	$(COMPOSE) restart

reload: ## Applique les modifications de .env (recrée les conteneurs)
	$(COMPOSE) up -d --force-recreate
	@$(MAKE) --no-print-directory health

status: ## État des conteneurs
	@$(COMPOSE) ps

ps: status

health: ## Attend que l'application réponde
	@echo "==> Attente de l'application..."
	@curl -s --retry 20 --retry-delay 3 --retry-all-errors --retry-connrefused \
		-o /dev/null -w "    kozons-web [HTTP %{http_code}]\n" $(HEALTH_URL) || true
	@$(COMPOSE) ps

# =============================================================================
# JOURNAUX
# =============================================================================
logs: ## Logs de tous les services (Ctrl-C pour quitter)
	$(COMPOSE) logs -f --tail=100

logs-web: ## Logs de Django / Daphne
	$(COMPOSE) logs -f --tail=100 $(WEB)

logs-redis: ## Logs de Redis
	$(COMPOSE) logs -f --tail=100 $(REDIS)

caddy-logs: ## Logs du Caddy partagé
	docker logs -f --tail=100 $(CADDY)

# =============================================================================
# ACCÈS AUX CONTENEURS
# =============================================================================
kozons-web: ## ⭐ Ouvre un shell dans le conteneur Django (migrations, etc.)
	$(COMPOSE) exec $(WEB) bash

kozons-redis: ## Ouvre redis-cli dans le conteneur Redis
	$(COMPOSE) exec $(REDIS) redis-cli

shell: ## Shell Django (python manage.py shell)
	$(COMPOSE) exec $(WEB) python manage.py shell

# =============================================================================
# DJANGO
# =============================================================================
migrate: ## Applique les migrations
	$(DJANGO) migrate

migrate-check: ## Liste les migrations et leur état
	$(DJANGO) showmigrations

makemigrations: ## (refusé en production)
	@echo ""
	@echo "  Les migrations se génèrent sur le poste de développement :"
	@echo "    python manage.py makemigrations && git add -A && git commit && git push"
	@echo "  puis ici :  make rebuild && make migrate"
	@echo ""
	@exit 1

superuser: ## Crée un compte administrateur
	$(COMPOSE) exec $(WEB) python manage.py createsuperuser

check: ## Vérifications Django de production
	$(DJANGO) check --deploy

backup: ## Sauvegarde la base SQLite dans backups/
	@mkdir -p backups
	$(COMPOSE) exec -T $(WEB) python -c "import sqlite3; s=sqlite3.connect('/app/data/db.sqlite3'); d=sqlite3.connect('/app/data/backup.sqlite3'); s.backup(d); d.close()"
	mv data/backup.sqlite3 backups/db-$$(date +%Y%m%d-%H%M%S).sqlite3
	@ls -lh backups | tail -5

# =============================================================================
# CADDY (partagé)
# =============================================================================
caddy-install: ## Installe caddy/kozons.caddy dans Caddy et recharge (si modifié)
	@if cmp -s caddy/kozons.caddy $(CADDY_SITE); then \
		echo "==> Caddy : site inchangé"; \
	else \
		echo "==> Caddy : installation du site Kozons..."; \
		[ -f $(CADDY_SITE) ] && cp $(CADDY_SITE) $(CADDY_SITE).bak; \
		cp caddy/kozons.caddy $(CADDY_SITE); \
		if docker exec $(CADDY) caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then \
			docker exec $(CADDY) caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile && echo "    Caddy rechargé"; \
		else \
			echo "    ✗ Config Caddy invalide, retour à la version précédente (les autres sites ne sont pas touchés)"; \
			if [ -f $(CADDY_SITE).bak ]; then mv $(CADDY_SITE).bak $(CADDY_SITE); else rm -f $(CADDY_SITE); fi; \
			docker exec $(CADDY) caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -5; \
			exit 1; \
		fi; \
	fi

caddy-validate: ## Vérifie la configuration Caddy complète
	docker exec $(CADDY) caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

caddy-reload: ## Recharge Caddy
	docker exec $(CADDY) caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile

prune: ## Supprime les images Docker inutilisées
	docker image prune -f
