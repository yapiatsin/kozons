/// Adresse de l'API KozonWeb (Django) consommée par l'application mobile.
///
/// L'API JSON est servie sous `/api/` (voir KozonWeb/kozons/urls_api.py),
/// le temps réel par WebSocket sous `/ws/` et les fichiers envoyés sous `/media/`.
///
/// Choix de l'environnement au lancement (aucune modification de code) :
///
///   flutter run                                   → local (par défaut)
///   flutter run --dart-define=KOZONS_ENV=prod     → production (https://kozonstic.com)
///   flutter build apk --dart-define=KOZONS_ENV=prod
///
/// Adresse locale personnalisée (téléphone réel sur le même Wi-Fi que le PC) :
///
///   flutter run --dart-define=KOZONS_API_URL=http://192.168.1.20:8030
///
/// Dans ce cas, lancer Django avec `manage.py runserver 0.0.0.0:8030` et ajouter
/// l'IP du PC à ALLOWED_HOSTS dans KozonWeb/.env.
library;

import 'package:flutter/foundation.dart';

enum KozonsEnv { local, prod }

class ApiConfig {
  ApiConfig._();

  /// Serveur de développement : `manage.py runserver 127.0.0.1:8030` (voir .claude/launch.json).
  static const int localPort = 8030;

  /// Production : VPS derrière Caddy.
  static const String prodUrl = 'https://kozonstic.com';

  static const String _envName = String.fromEnvironment('KOZONS_ENV', defaultValue: 'local');
  static const String _override = String.fromEnvironment('KOZONS_API_URL');

  /// Production si KOZONS_ENV=prod, ou si KOZONS_API_URL désigne le serveur de production.
  static KozonsEnv get env {
    if (_envName == 'prod') return KozonsEnv.prod;
    if (_override.isNotEmpty && _strip(_override) == prodUrl) return KozonsEnv.prod;
    return KozonsEnv.local;
  }

  /// Racine du serveur, sans barre finale (ex. https://kozonstic.com).
  static String get serverUrl {
    if (_override.isNotEmpty) return _strip(_override);
    if (env == KozonsEnv.prod) return prodUrl;
    return 'http://${_localHost()}:$localPort';
  }

  /// Racine de l'API JSON : `<serveur>/api`.
  static String get apiUrl => '$serverUrl/api';

  /// WebSocket temps réel (messages, présence, appels) : `ws(s)://<serveur>/ws/`.
  static String get wsUrl {
    final uri = Uri.parse(serverUrl);
    final scheme = uri.scheme == 'https' ? 'wss' : 'ws';
    return uri.replace(scheme: scheme, path: '/ws/').toString();
  }

  /// URL absolue d'un fichier média renvoyé par l'API (`/media/...`).
  static String mediaUrl(String path) =>
      path.startsWith('http') ? path : '$serverUrl${path.startsWith('/') ? '' : '/'}$path';

  /// L'émulateur Android voit le PC hôte sous 10.0.2.2 ; iOS, le web et le bureau sous 127.0.0.1.
  static String _localHost() {
    if (!kIsWeb && defaultTargetPlatform == TargetPlatform.android) return '10.0.2.2';
    return '127.0.0.1';
  }

  static String _strip(String url) => url.endsWith('/') ? url.substring(0, url.length - 1) : url;
}
