import 'package:flutter_test/flutter_test.dart';
import 'package:kozonmobile/models/conversation.dart';

import 'fake_server.dart';

void main() {
  const bob = {'id': 2, 'username': 'bob', 'name': 'Bob Diallo', 'avatar': null};

  test('titre, aperçu et ordre des discussions', () {
    final direct = Conversation.fromJson(conversationJson(id: 1, peer: bob, last: messageJson(text: 'Salut !'), unread: 2));
    expect(direct.displayTitle(1), 'Bob Diallo');
    expect(direct.preview(1), 'Salut !');
    expect(direct.unread, 2);

    final mine = Conversation.fromJson(conversationJson(id: 2, peer: bob, last: messageJson(kind: 'image', text: 'Plage', senderId: 1)));
    expect(mine.preview(1), 'Vous : 📷 Plage');

    final group = Conversation.fromJson(conversationJson(
        id: 3, kind: 'group', title: 'Famille', peer: bob, last: messageJson(kind: 'video_note'), pinned: true));
    expect(group.displayTitle(1), 'Famille');
    expect(group.preview(1), 'Bob : 📹 Note vidéo');

    final old = Conversation.fromJson(conversationJson(id: 4, peer: bob, last: messageJson(text: 'vieux', createdAt: '2026-01-01T10:00:00Z')));
    expect(sortConversations([old, direct, group]).map((c) => c.id), [3, 1, 4]);  // épinglée d'abord
  });

  test("heure de la liste façon WhatsApp", () {
    final now = DateTime(2026, 11, 24, 18, 30);
    expect(listTime(DateTime(2026, 11, 24, 9, 5), now), '09:05');
    expect(listTime(DateTime(2026, 11, 23, 22, 0), now), 'Hier');
    expect(listTime(DateTime(2026, 11, 20, 8, 0), now), 'vendredi');
    expect(listTime(DateTime(2026, 10, 2, 8, 0), now), '02/10/2026');
    expect(listTime(null, now), '');
  });
}
