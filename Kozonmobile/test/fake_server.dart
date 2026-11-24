import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:kozonmobile/api/api_client.dart';

/// Faux serveur KozonWeb pour les tests : un seul compte (alice / Secret123).
class FakeServer {
  final requests = <http.Request>[];
  final validTokens = <String>{};
  List<Map<String, dynamic>> conversations = [];
  int _n = 0;

  static const alice = {'id': 1, 'username': 'alice', 'name': 'Alice Martin', 'avatar': null, 'online': true};

  ApiClient client() => ApiClient(httpClient: MockClient(handle), baseUrl: 'https://kozons.test/api');

  Future<http.Response> handle(http.Request req) async {
    requests.add(req);
    final path = req.url.path.replaceFirst('/api/', '');
    final auth = req.headers['Authorization'];
    final token = auth?.startsWith('Token ') == true ? auth!.substring(6) : null;
    if (token != null && !validTokens.contains(token) && path != 'auth/token') {
      return _json({'error': 'Session expirée. Reconnectez-vous.'}, 401);
    }
    final signedIn = token != null;
    switch ('${req.method} $path') {
      case 'POST auth/token':
        final body = jsonDecode(req.body) as Map<String, dynamic>;
        if (body['username'] != 'alice' || body['password'] != 'Secret123') {
          return _json({'error': 'Identifiants incorrects.'}, 401);
        }
        final t = 'kz_test${++_n}';
        validTokens.add(t);
        return _json({'token': t, 'user': alice});
      case 'GET me':
        return _json({'user': signedIn ? alice : null});
      case 'POST auth/logout':
        if (!signedIn) return _json({'error': 'Non authentifié'}, 401);
        validTokens.remove(token);
        return _json({'ok': true});
      case 'GET conversations':
        if (!signedIn) return _json({'error': 'Non authentifié'}, 401);
        return _json({'results': conversations});
    }
    return _json({'error': 'Introuvable'}, 404);
  }

  http.Response _json(Object data, [int status = 200]) =>
      http.Response.bytes(utf8.encode(jsonEncode(data)), status, headers: {'content-type': 'application/json'});
}

Map<String, dynamic> conversationJson({
  required int id,
  String kind = 'direct',
  String title = '',
  Map<String, dynamic>? peer,
  Map<String, dynamic>? last,
  int unread = 0,
  bool pinned = false,
  bool archived = false,
  String updatedAt = '2026-11-24T10:00:00Z',
}) =>
    {
      'id': id,
      'kind': kind,
      'title': title,
      'avatar': null,
      'updated_at': updatedAt,
      'participants': [
        {'user': FakeServer.alice},
        if (peer != null) {'user': peer},
      ],
      'me': {'pinned': pinned, 'archived': archived, 'muted_until': null, 'marked_unread': false},
      'unread': unread,
      'last_message': last,
    };

Map<String, dynamic> messageJson({
  String kind = 'text',
  String text = '',
  int senderId = 2,
  String senderName = 'Bob Diallo',
  String createdAt = '2026-11-24T10:00:00Z',
}) =>
    {
      'id': 99,
      'kind': kind,
      'text': text,
      'sender_id': senderId,
      'sender': {'id': senderId, 'name': senderName},
      'created_at': createdAt,
      'file_name': '',
      'deleted': false,
      'view_once': false,
    };
