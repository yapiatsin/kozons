import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:kozonmobile/api/api_client.dart';
import 'package:kozonmobile/auth/auth_controller.dart';
import 'package:kozonmobile/auth/secure_store.dart';
import 'package:kozonmobile/config/api_config.dart';

import 'fake_server.dart';

void main() {
  test("URL de l'API locale par défaut", () {
    expect(ApiConfig.env, KozonsEnv.local);
    expect(ApiConfig.apiUrl, endsWith(':8030/api'));
    expect(ApiConfig.wsUrl, startsWith('ws://'));
    expect(ApiConfig.mediaUrl('/media/a.jpg'), '${ApiConfig.serverUrl}/media/a.jpg');
  });

  group('ApiClient', () {
    test('envoie le jeton et lit les erreurs du serveur', () async {
      final server = FakeServer();
      final api = server.client();
      await expectLater(
        api.post('auth/token', {'username': 'alice', 'password': 'non'}),
        throwsA(isA<ApiException>().having((e) => e.message, 'message', 'Identifiants incorrects.').having((e) => e.status, 'status', 401)),
      );
      expect(server.requests.last.headers['Authorization'], isNull);
      api.token = 'kz_abc';
      server.validTokens.add('kz_abc');
      await api.get('me');
      expect(server.requests.last.headers['Authorization'], 'Token kz_abc');
      expect(server.requests.last.headers['Cookie'], isNull);
    });

    test('jeton refusé : onUnauthorized est appelé', () async {
      final server = FakeServer();
      final api = server.client()..token = 'kz_revoque';
      var called = 0;
      api.onUnauthorized = () => called++;
      await expectLater(api.get('conversations'), throwsA(isA<ApiException>()));
      expect(called, 1);
    });

    test('réseau indisponible : message clair', () async {
      final api = ApiClient(httpClient: MockClient((_) => throw http.ClientException('hors ligne')), baseUrl: 'https://x/api');
      await expectLater(
        api.get('me'),
        throwsA(isA<ApiException>().having((e) => e.isNetwork, 'isNetwork', true).having((e) => e.message, 'message', contains('Vérifiez votre connexion'))),
      );
    });

    test('réponse non JSON : erreur générique', () async {
      final api = ApiClient(httpClient: MockClient((_) async => http.Response('<html>502</html>', 502)), baseUrl: 'https://x/api');
      await expectLater(api.get('me'), throwsA(isA<ApiException>().having((e) => e.message, 'message', 'Erreur du serveur (502).')));
    });
  });

  group('AuthController', () {
    test('connexion, redémarrage, déconnexion', () async {
      final server = FakeServer();
      final store = MemoryStore();
      final auth = AuthController(api: server.client(), store: store);
      await auth.restore();
      expect(auth.status, AuthStatus.signedOut);

      await auth.login(' alice ', 'Secret123');
      expect(auth.status, AuthStatus.signedIn);
      expect(auth.user!.name, 'Alice Martin');
      final token = store.values[AuthController.tokenKey]!;
      expect(token, startsWith('kz_'));

      // Redémarrage de l'application : le jeton enregistré suffit.
      final again = AuthController(api: server.client(), store: store);
      await again.restore();
      expect(again.status, AuthStatus.signedIn);
      expect(again.user!.username, 'alice');

      await again.logout();
      expect(again.status, AuthStatus.signedOut);
      expect(again.notice, isNull);
      expect(store.values, isEmpty);
      expect(server.validTokens, isNot(contains(token)));  // révoqué sur le serveur
    });

    test('jeton révoqué ailleurs : retour à la connexion avec un message', () async {
      final server = FakeServer();
      final store = MemoryStore();
      final auth = AuthController(api: server.client(), store: store);
      await auth.login('alice', 'Secret123');
      server.validTokens.clear();  // ex. mot de passe changé sur le site
      await expectLater(auth.api.get('conversations'), throwsA(isA<ApiException>()));
      await Future<void>.delayed(Duration.zero);
      expect(auth.status, AuthStatus.signedOut);
      expect(auth.notice, contains('expiré'));
      expect(store.values, isEmpty);
    });

    test('hors ligne au démarrage : le dernier profil connu est gardé', () async {
      final store = MemoryStore();
      final online = AuthController(api: FakeServer().client(), store: store);
      await online.login('alice', 'Secret123');
      final offline = AuthController(
        api: ApiClient(httpClient: MockClient((_) => throw http.ClientException('hors ligne')), baseUrl: 'https://x/api'),
        store: store,
      );
      await offline.restore();
      expect(offline.status, AuthStatus.signedIn);
      expect(offline.user!.name, 'Alice Martin');
    });
  });
}
