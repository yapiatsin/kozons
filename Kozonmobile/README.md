# Kozonmobile — application mobile Kozons (Flutter)

Client Android / iOS de Kozons. Il consomme l'API de [KozonWeb](../KozonWeb) :
API JSON sous `/api/`, temps réel par WebSocket sous `/ws/`, fichiers sous `/media/`.

## Lancer

```bash
flutter pub get
flutter run                                  # serveur local (KozonWeb sur le port 8030)
flutter run --dart-define=KOZONS_ENV=prod    # serveur de production https://kozonstic.com
```

Compiler pour la production :

```bash
flutter build apk --dart-define=KOZONS_ENV=prod
flutter build ios --dart-define=KOZONS_ENV=prod      # sur macOS uniquement
```

## Adresse de l'API

Tout est dans [`lib/config/api_config.dart`](lib/config/api_config.dart) :

| Cible | Adresse utilisée |
|---|---|
| Local, émulateur Android | `http://10.0.2.2:8030` (le PC hôte vu depuis l'émulateur) |
| Local, simulateur iOS / bureau | `http://127.0.0.1:8030` |
| Production (`KOZONS_ENV=prod`) | `https://kozonstic.com` |
| Adresse libre | `--dart-define=KOZONS_API_URL=http://192.168.1.20:8030` |

Téléphone réel sur le même Wi-Fi : lancez Django avec `manage.py runserver 0.0.0.0:8030`,
ajoutez l'IP du PC à `ALLOWED_HOSTS` dans `KozonWeb/.env`, puis passez `KOZONS_API_URL`.

Le HTTP en clair n'est autorisé qu'en debug sur Android (`android/app/src/debug/AndroidManifest.xml`)
et pour le réseau local sur iOS (`NSAllowsLocalNetworking`) ; la production passe en HTTPS.

## Tests

```bash
flutter analyze
flutter test
```
