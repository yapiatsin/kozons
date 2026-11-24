import 'package:flutter/material.dart';

import 'api/api_client.dart';
import 'auth/auth_controller.dart';
import 'auth/secure_store.dart';
import 'screens/conversations_screen.dart';
import 'screens/login_screen.dart';
import 'ui/theme.dart';

void main() {
  runApp(KozonsApp());
}

/// Application mobile Kozons : cliente de l'API KozonWeb (adresse : lib/config/api_config.dart).
class KozonsApp extends StatefulWidget {
  /// `api` et `store` sont remplaçables pour les tests.
  KozonsApp({super.key, ApiClient? api, KeyValueStore? store})
      : api = api ?? ApiClient(),
        store = store ?? const SecureStore();

  final ApiClient api;
  final KeyValueStore store;

  @override
  State<KozonsApp> createState() => _KozonsAppState();
}

class _KozonsAppState extends State<KozonsApp> {
  late final AuthController auth = AuthController(api: widget.api, store: widget.store);

  @override
  void initState() {
    super.initState();
    auth.restore();
  }

  @override
  void dispose() {
    auth.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Kozons',
      debugShowCheckedModeBanner: false,
      theme: kozonsTheme(Brightness.light),
      darkTheme: kozonsTheme(Brightness.dark),
      home: ListenableBuilder(
        listenable: auth,
        builder: (context, _) => switch (auth.status) {
          AuthStatus.unknown => const _Splash(),
          AuthStatus.signedOut => LoginScreen(key: const ValueKey('login'), auth: auth),
          AuthStatus.signedIn => ConversationsScreen(key: ValueKey('chats-${auth.user!.id}'), auth: auth),
        },
      ),
    );
  }
}

class _Splash extends StatelessWidget {
  const _Splash();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: ClipRRect(
          borderRadius: BorderRadius.circular(22),
          child: Image.asset('assets/logo.png', width: 88, height: 88),
        ),
      ),
    );
  }
}
