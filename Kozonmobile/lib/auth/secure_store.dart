import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Petit stockage clé → valeur pour le jeton et le profil de l'utilisateur connecté.
abstract class KeyValueStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

/// Stockage chiffré du téléphone (Keystore Android, trousseau iOS) : le jeton n'est jamais en clair.
class SecureStore implements KeyValueStore {
  const SecureStore([this._storage = const FlutterSecureStorage()]);

  final FlutterSecureStorage _storage;

  @override
  Future<String?> read(String key) async {
    try {
      return await _storage.read(key: key);
    } catch (_) {
      return null; // stockage illisible (ex. sauvegarde restaurée sur un autre téléphone) : reconnexion
    }
  }

  @override
  Future<void> write(String key, String value) => _storage.write(key: key, value: value);

  @override
  Future<void> delete(String key) async {
    try {
      await _storage.delete(key: key);
    } catch (_) {
      // déjà absent ou illisible : rien à faire
    }
  }
}

/// Stockage en mémoire (tests).
class MemoryStore implements KeyValueStore {
  final Map<String, String> values = {};

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async => values[key] = value;

  @override
  Future<void> delete(String key) async => values.remove(key);
}
