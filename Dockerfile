# Image de production Kozons : Django + Channels servis par Daphne (HTTP + WebSocket).
FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Dépendances d'abord : la couche reste en cache tant que requirements.txt ne change pas.
COPY requirements.txt .
RUN pip install -r requirements.txt

# Utilisateur non-root (uid 1000) : les dossiers montés sur l'hôte doivent lui appartenir.
RUN useradd --uid 1000 --create-home --shell /bin/bash kozons \
    && mkdir -p /app/data /app/media /app/staticfiles \
    && chown -R kozons:kozons /app

COPY --chown=kozons:kozons . .
RUN chmod +x docker/entrypoint.sh

USER kozons
EXPOSE 8000

ENTRYPOINT ["docker/entrypoint.sh"]
CMD ["daphne", "-b", "0.0.0.0", "-p", "8000", "--proxy-headers", "koz.asgi:application"]
