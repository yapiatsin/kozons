import 'package:flutter_test/flutter_test.dart';

import 'package:kozonmobile/config/api_config.dart';
import 'package:kozonmobile/main.dart';

void main() {
  test('URL de l\'API locale par défaut', () {
    expect(ApiConfig.env, KozonsEnv.local);
    expect(ApiConfig.apiUrl, endsWith(':8030/api'));
    expect(ApiConfig.wsUrl, startsWith('ws://'));
    expect(ApiConfig.wsUrl, endsWith('/ws/'));
    expect(ApiConfig.mediaUrl('/media/a.jpg'), '${ApiConfig.serverUrl}/media/a.jpg');
  });

  testWidgets('L\'accueil affiche le serveur visé', (WidgetTester tester) async {
    await tester.pumpWidget(const KozonsApp());
    expect(find.text('Environnement : local'), findsOneWidget);
    expect(find.text('API : ${ApiConfig.apiUrl}'), findsOneWidget);
  });
}
