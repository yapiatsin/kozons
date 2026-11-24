import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../config/api_config.dart';

/// Erreur renvoyée par l'API KozonWeb (`{"error": "..."}`), ou problème de réseau (status 0).
class ApiException implements Exception {
  const ApiException(this.message, this.status);

  final String message;
  final int status;

  bool get isNetwork => status == 0;

  @override
  String toString() => message;
}

/// Client de l'API JSON de KozonWeb (`<serveur>/api/...`).
///
/// L'application s'identifie avec un jeton (`Authorization: Token kz_…`) obtenu par
/// `POST /api/auth/token` : ni cookie, ni jeton CSRF.
class ApiClient {
  ApiClient({http.Client? httpClient, String? baseUrl})
      : _http = httpClient ?? http.Client(),
        baseUrl = baseUrl ?? ApiConfig.apiUrl;

  final http.Client _http;
  final String baseUrl;

  /// Jeton de l'appareil (null tant que l'utilisateur n'est pas connecté).
  String? token;

  /// Appelé quand le serveur refuse le jeton (déconnexion à distance, mot de passe changé…).
  void Function()? onUnauthorized;

  static const timeout = Duration(seconds: 20);

  Future<Map<String, dynamic>> get(String path) => _send('GET', path);

  Future<Map<String, dynamic>> post(String path, [Map<String, dynamic>? body]) => _send('POST', path, body ?? const {});

  Future<Map<String, dynamic>> _send(String method, String path, [Map<String, dynamic>? body]) async {
    final request = http.Request(method, Uri.parse('$baseUrl/$path'))
      ..headers['Accept'] = 'application/json';
    final sentToken = token;
    if (sentToken != null) request.headers['Authorization'] = 'Token $sentToken';
    if (body != null) {
      request.headers['Content-Type'] = 'application/json';
      request.body = jsonEncode(body);
    }

    final http.Response response;
    try {
      response = await http.Response.fromStream(await _http.send(request).timeout(timeout)).timeout(timeout);
    } on TimeoutException {
      throw const ApiException('Le serveur ne répond pas. Réessayez dans un instant.', 0);
    } catch (_) {
      // Pas de réseau, serveur injoignable, certificat refusé…
      throw const ApiException('Impossible de joindre le serveur. Vérifiez votre connexion Internet.', 0);
    }

    Map<String, dynamic> data = const {};
    try {
      final decoded = jsonDecode(utf8.decode(response.bodyBytes));
      if (decoded is Map<String, dynamic>) data = decoded;
    } on FormatException {
      // Réponse non JSON (page d'erreur du serveur) : message générique ci-dessous.
    }

    if (response.statusCode >= 400) {
      if (response.statusCode == 401 && sentToken != null) onUnauthorized?.call();
      final message = data['error'];
      throw ApiException(
        message is String && message.isNotEmpty ? message : 'Erreur du serveur (${response.statusCode}).',
        response.statusCode,
      );
    }
    return data;
  }

  void close() => _http.close();
}
