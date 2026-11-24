# Kozonmobile — application mobile Kozons (Flutter)

Client Android / iOS de Kozons. Il consomme l'API de [KozonWeb](../KozonWeb) :
API JSON sous `/api/`, temps réel par WebSocket sous `/ws/`, fichiers sous `/media/`.

Aujourd'hui : connexion (nom d'utilisateur ou e-mail + mot de passe, mêmes comptes que le site),
liste des discussions (épinglées, non lus, archivées, sourdine), déconnexion. Thème clair / sombre
du téléphone, aux couleurs du site.

## Organisation

| Fichier | Rôle |
|---|---|
| `lib/config/api_config.dart` | Adresse du serveur (local / production) |
| `lib/api/api_client.dart` | Appels à l'API, en-tête `Authorization: Token kz_…`, messages d'erreur |
| `lib/auth/auth_controller.dart` | Connexion, déconnexion, reprise au démarrage, session expirée |
| `lib/auth/secure_store.dart` | Jeton gardé dans le stockage chiffré du téléphone (`flutter_secure_storage`) |
| `lib/models/` | Utilisateur, discussion, aperçu du dernier message, heure de la liste |
| `lib/screens/` | Écran de connexion, liste des discussions |
| `lib/ui/` | Thème (couleurs du site), avatars |

Le jeton est obtenu par `POST /api/auth/token` ; un jeton refusé par le serveur (déconnexion à
distance, mot de passe changé, accès retiré) ramène à l'écran de connexion.

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

Les tests utilisent un faux serveur (`test/fake_server.dart`) : aucun réseau nécessaire.
