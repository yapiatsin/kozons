import 'package:flutter/material.dart';

import 'config/api_config.dart';

void main() {
  runApp(const KozonsApp());
}

/// Application mobile Kozons : cliente de l'API KozonWeb (voir lib/config/api_config.dart).
class KozonsApp extends StatelessWidget {
  const KozonsApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Kozons',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF25D366)),
      ),
      darkTheme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF25D366),
          brightness: Brightness.dark,
        ),
      ),
      home: const HomeScreen(),
    );
  }
}

/// Écran d'accueil provisoire : affiche le serveur visé, en attendant les vrais écrans.
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final env = ApiConfig.env == KozonsEnv.prod ? 'production' : 'local';
    return Scaffold(
      appBar: AppBar(title: const Text('Kozons')),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text('Environnement : $env', style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 8),
              SelectableText('API : ${ApiConfig.apiUrl}'),
              SelectableText('Temps réel : ${ApiConfig.wsUrl}'),
            ],
          ),
        ),
      ),
    );
  }
}
