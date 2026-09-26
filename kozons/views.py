import json
from functools import lru_cache
from pathlib import Path

from django.conf import settings
from django.http import HttpResponse, JsonResponse
from django.shortcuts import render
from django.templatetags.static import static
from django.views.decorators.csrf import ensure_csrf_cookie

ASSETS_DIR = Path(__file__).resolve().parent / 'static' / 'kozons'


def _scan_assets():
    """URL versionnée (?v=date de modification) de chaque fichier JS/CSS de l'application."""
    versions = {}
    for path in ASSETS_DIR.rglob('*'):
        if path.suffix in ('.js', '.css'):
            rel = path.relative_to(ASSETS_DIR).as_posix()
            versions[rel] = f"{static('kozons/' + rel)}?v={int(path.stat().st_mtime)}"
    return versions


_cached_assets = lru_cache(maxsize=1)(_scan_assets)


def asset_versions():
    # En développement les fichiers changent sans redémarrage : on relit à chaque requête.
    return _scan_assets() if settings.DEBUG else _cached_assets()


@ensure_csrf_cookie
def app(request):
    """Coquille de l'application monopage : toutes les routes front mènent ici.

    L'import map redirige chaque module JS (imports statiques et dynamiques) vers son URL
    versionnée : après une mise à jour, le navigateur ne peut pas mélanger ancienne et
    nouvelle version d'un fichier gardé en cache."""
    assets = asset_versions()
    import_map = {'imports': {static('kozons/' + rel): url for rel, url in assets.items() if rel.endswith('.js')}}
    return render(request, 'kozons/app.html', {
        'import_map': json.dumps(import_map),
        'css_url': assets.get('css/app.css', static('kozons/css/app.css')),
        'app_js_url': assets.get('js/app.js', static('kozons/js/app.js')),
        'idle_logout_minutes': settings.IDLE_LOGOUT_MINUTES,
    })


def manifest(request):
    return JsonResponse({
        'name': 'Kozons',
        'short_name': 'Kozons',
        'start_url': '/',
        'display': 'standalone',
        'background_color': '#0b141a',
        'theme_color': '#0099cc',
        'icons': [
            {'src': static('kozons/icon-192.png'), 'sizes': '192x192', 'type': 'image/png'},
            {'src': static('kozons/icon-512.png'), 'sizes': '512x512', 'type': 'image/png'},
            {'src': static('kozons/icon-512.png'), 'sizes': '512x512', 'type': 'image/png', 'purpose': 'maskable'},
            {'src': static('kozons/icon.svg'), 'sizes': 'any', 'type': 'image/svg+xml'},
        ],
    })


def service_worker(request):
    """Service worker : installation (PWA) et réception des notifications push, application fermée."""
    response = render(request, 'kozons/sw.js', content_type='application/javascript')
    response['Service-Worker-Allowed'] = '/'
    response['Cache-Control'] = 'no-cache'  # les mises à jour du worker sont prises en compte aussitôt
    return response
