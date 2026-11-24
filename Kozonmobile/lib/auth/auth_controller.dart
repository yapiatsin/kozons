import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import '../models/user.dart';
import 'secure_store.dart';

enum AuthStatus { unknown, signedOut, signedIn }

/// État de connexion de l'application : jeton d'API gardé dans le stockage sécurisé du téléphone.
///
/// Au démarrage, le jeton enregistré est vérifié auprès du serveur (`GET /api/me`) ; hors ligne,
/// le dernier profil connu est utilisé. Un jeton refusé (déconnexion à distance, mot de passe
/// changé sur un autre appareil, accès retiré) ramène à l'écran de connexion.
class AuthController extends ChangeNotifier {
  AuthController({required this.api, required this.store}) {
    api.onUnauthorized = _expired;
  }

  static const tokenKey = 'kozons.token';
  static const userKey = 'kozons.user';

  final ApiClient api;
  final KeyValueStore store;

  AuthStatus status = AuthStatus.unknown;
  KUser? user;

  /// Message affiché sur l'écran de connexion (ex. session expirée).
  String? notice;

  Future<void> restore() async {
    final token = await store.read(tokenKey);
    if (token == null || token.isEmpty) return _setSignedOut();
    api.token = token;
    final cached = await store.read(userKey);
    try {
      final data = await api.get('me');
      final json = data['user'];
      if (json is! Map<String, dynamic>) return _clear();
      await _signedIn(KUser.fromJson(json));
    } on ApiException catch (e) {
      if (e.status == 401) return; // _expired() s'en est chargé
      if (cached != null) {
        // Hors ligne : on garde la session, la liste se rechargera au retour du réseau.
        try {
          return _setSignedIn(KUser.fromJson(jsonDecode(cached) as Map<String, dynamic>));
        } on FormatException {
          // profil illisible : nouvelle connexion
        }
      }
      return _clear();
    }
  }

  /// Connexion : identifiant (nom d'utilisateur ou e-mail) + mot de passe → jeton.
  Future<void> login(String identifier, String password) async {
    final data = await api.post('auth/token', {
      'username': identifier.trim(),
      'password': password,
      'device': 'Kozons ${defaultTargetPlatform.name}',
    });
    final token = data['token'];
    final json = data['user'];
    if (token is! String || json is! Map<String, dynamic>) {
      throw const ApiException('Réponse inattendue du serveur.', 500);
    }
    api.token = token;
    await store.write(tokenKey, token);
    notice = null;
    await _signedIn(KUser.fromJson(json));
  }

  /// Déconnexion : le jeton est révoqué sur le serveur (s'il est joignable) et effacé du téléphone.
  Future<void> logout() async {
    if (api.token != null) {
      _loggingOut = true;
      try {
        await api.post('auth/logout');
      } on ApiException {
        // hors ligne ou jeton déjà révoqué : il est quand même oublié ici
      } finally {
        _loggingOut = false;
      }
    }
    notice = null;
    await _clear();
  }

  bool _loggingOut = false;

  Future<void> _signedIn(KUser u) async {
    await store.write(userKey, jsonEncode(u.toJson()));
    _setSignedIn(u);
  }

  void _setSignedIn(KUser u) {
    user = u;
    status = AuthStatus.signedIn;
    notifyListeners();
  }

  void _setSignedOut() {
    status = AuthStatus.signedOut;
    notifyListeners();
  }

  Future<void> _clear() async {
    api.token = null;
    user = null;
    await store.delete(tokenKey);
    await store.delete(userKey);
    _setSignedOut();
  }

  void _expired() {
    if (_loggingOut) return;
    notice = 'Votre session a expiré. Reconnectez-vous.';
    _clear();
  }
}
