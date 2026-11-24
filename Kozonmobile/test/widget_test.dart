import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kozonmobile/auth/auth_controller.dart';
import 'package:kozonmobile/auth/secure_store.dart';
import 'package:kozonmobile/main.dart';

import 'fake_server.dart';

void main() {
  const bob = {'id': 2, 'username': 'bob', 'name': 'Bob Diallo', 'avatar': null};

  testWidgets('connexion puis liste des discussions, puis déconnexion', (tester) async {
    final server = FakeServer()
      ..conversations = [
        conversationJson(id: 10, peer: bob, last: messageJson(text: 'On se voit demain ?'), unread: 3),
        conversationJson(id: 11, kind: 'group', title: 'Équipe Kozons', last: messageJson(kind: 'voice', senderName: 'Carol'), pinned: true),
        conversationJson(id: 12, peer: {'id': 3, 'username': 'dan', 'name': 'Dan', 'avatar': null}, archived: true),
      ];
    final store = MemoryStore();
    await tester.pumpWidget(KozonsApp(api: server.client(), store: store));
    await tester.pumpAndSettle();
    expect(find.text('Se connecter'), findsOneWidget);

    // Champs vides : validation locale, aucune requête.
    await tester.tap(find.text('Se connecter'));
    await tester.pumpAndSettle();
    expect(find.text("Saisissez votre nom d'utilisateur ou votre e-mail."), findsOneWidget);

    // Mauvais mot de passe : message du serveur.
    await tester.enterText(find.byType(TextFormField).at(0), 'alice');
    await tester.enterText(find.byType(TextFormField).at(1), 'faux');
    await tester.tap(find.text('Se connecter'));
    await tester.pumpAndSettle();
    expect(find.text('Identifiants incorrects.'), findsOneWidget);

    await tester.enterText(find.byType(TextFormField).at(1), 'Secret123');
    await tester.tap(find.text('Se connecter'));
    await tester.pumpAndSettle();

    // Liste : épinglée en premier, archivée rangée à part.
    expect(find.text('Équipe Kozons'), findsOneWidget);
    expect(find.text('Bob Diallo'), findsOneWidget);
    expect(find.text('On se voit demain ?'), findsOneWidget);
    expect(find.text('3'), findsOneWidget);
    expect(find.text('Carol : 🎤 Message vocal'), findsOneWidget);
    expect(find.text('Dan'), findsNothing);
    expect(tester.getTopLeft(find.text('Équipe Kozons')).dy, lessThan(tester.getTopLeft(find.text('Bob Diallo')).dy));
    expect(store.values[AuthController.tokenKey], startsWith('kz_'));

    await tester.tap(find.text('Archivées'));
    await tester.pumpAndSettle();
    expect(find.text('Dan'), findsOneWidget);
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();

    // Déconnexion (avec confirmation) : jeton révoqué et effacé.
    await tester.tap(find.byTooltip('Menu'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Se déconnecter'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, 'Se déconnecter'));
    await tester.pumpAndSettle();
    expect(find.text('Se connecter'), findsOneWidget);
    expect(store.values, isEmpty);
    expect(server.validTokens, isEmpty);
  });

  testWidgets('jeton déjà enregistré : liste directe, sans écran de connexion', (tester) async {
    final server = FakeServer()..validTokens.add('kz_enregistre');
    final store = MemoryStore()..values[AuthController.tokenKey] = 'kz_enregistre';
    await tester.pumpWidget(KozonsApp(api: server.client(), store: store));
    await tester.pumpAndSettle();
    expect(find.text('Se connecter'), findsNothing);
    expect(find.text('Aucune discussion'), findsOneWidget);
  });
}
