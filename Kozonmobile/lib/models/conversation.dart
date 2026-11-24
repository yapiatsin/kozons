import 'user.dart';

/// Dernier message d'une discussion (aperçu de la liste).
class MessagePreview {
  const MessagePreview({
    required this.kind,
    required this.text,
    required this.senderId,
    required this.senderName,
    required this.createdAt,
    this.fileName = '',
    this.deleted = false,
    this.viewOnce = false,
  });

  factory MessagePreview.fromJson(Map<String, dynamic> json) {
    final sender = json['sender'];
    return MessagePreview(
      kind: (json['kind'] as String?) ?? 'text',
      text: (json['text'] as String?) ?? '',
      senderId: json['sender_id'] as int?,
      senderName: sender is Map<String, dynamic> ? ((sender['name'] as String?) ?? '') : '',
      createdAt: DateTime.tryParse((json['created_at'] as String?) ?? '')?.toLocal(),
      fileName: (json['file_name'] as String?) ?? '',
      deleted: json['deleted'] == true,
      viewOnce: json['view_once'] == true,
    );
  }

  final String kind;
  final String text;
  final int? senderId;
  final String senderName;
  final DateTime? createdAt;
  final String fileName;
  final bool deleted;
  final bool viewOnce;

  /// Même texte que la liste des discussions du site (chatdata.js → previewText).
  String get label {
    if (deleted) return '🚫 Ce message a été supprimé';
    if (viewOnce) {
      if (kind == 'voice') return '🎤 Vocal (vue unique)';
      return '① ${kind == 'video' ? 'Vidéo' : 'Photo'} (vue unique)';
    }
    if (kind == 'text' || kind == 'system') return text;
    const labels = {
      'image': '📷 Photo',
      'video': '🎥 Vidéo',
      'video_note': '📹 Note vidéo',
      'audio': '🎵 Audio',
      'voice': '🎤 Message vocal',
      'sticker': '🏷️ Autocollant',
      'location': '📍 Position',
      'contact': '👤 Contact',
      'post': '🖼️ Publication',
    };
    if (kind == 'file') return '📄 ${fileName.isEmpty ? 'Document' : fileName}';
    if (kind == 'poll') return '📊 $text';
    if (kind == 'story_reply') return '↩️ ${text.isEmpty ? 'A répondu à une story' : text}';
    final base = labels[kind] ?? text;
    if (text.isNotEmpty && (kind == 'image' || kind == 'video')) return '${base.split(' ').first} $text';
    return base;
  }
}

/// Discussion privée ou groupe, vue par l'utilisateur connecté.
class Conversation {
  const Conversation({
    required this.id,
    required this.kind,
    required this.title,
    required this.participants,
    this.avatar,
    this.lastMessage,
    this.unread = 0,
    this.pinned = false,
    this.archived = false,
    this.markedUnread = false,
    this.mutedUntil,
    this.updatedAt,
  });

  factory Conversation.fromJson(Map<String, dynamic> json) {
    final me = (json['me'] as Map<String, dynamic>?) ?? const {};
    final last = json['last_message'];
    return Conversation(
      id: json['id'] as int,
      kind: (json['kind'] as String?) ?? 'direct',
      title: (json['title'] as String?) ?? '',
      avatar: json['avatar'] as String?,
      participants: [
        for (final p in (json['participants'] as List<dynamic>? ?? const []))
          if (p is Map<String, dynamic> && p['user'] is Map<String, dynamic>) KUser.fromJson(p['user'] as Map<String, dynamic>),
      ],
      lastMessage: last is Map<String, dynamic> ? MessagePreview.fromJson(last) : null,
      unread: (json['unread'] as int?) ?? 0,
      pinned: me['pinned'] == true,
      archived: me['archived'] == true,
      markedUnread: me['marked_unread'] == true,
      mutedUntil: DateTime.tryParse((me['muted_until'] as String?) ?? ''),
      updatedAt: DateTime.tryParse((json['updated_at'] as String?) ?? '')?.toLocal(),
    );
  }

  final int id;
  final String kind;
  final String title;
  final String? avatar;
  final List<KUser> participants;
  final MessagePreview? lastMessage;
  final int unread;
  final bool pinned;
  final bool archived;
  final bool markedUnread;
  final DateTime? mutedUntil;
  final DateTime? updatedAt;

  bool get isGroup => kind == 'group';

  bool isMuted([DateTime? now]) => mutedUntil != null && mutedUntil!.isAfter(now ?? DateTime.now());

  /// L'autre personne d'une discussion privée.
  KUser? peer(int meId) {
    if (isGroup) return null;
    for (final u in participants) {
      if (u.id != meId) return u;
    }
    return null;
  }

  String displayTitle(int meId) => isGroup ? title : (peer(meId)?.name ?? 'Discussion');

  String? displayAvatar(int meId) => isGroup ? avatar : peer(meId)?.avatar;

  /// Aperçu : « Vous : … » pour mes messages, « Nom : … » dans un groupe.
  String preview(int meId) {
    final m = lastMessage;
    if (m == null) return '';
    if (m.kind == 'system' || m.deleted) return m.label;
    if (m.senderId == meId) return 'Vous : ${m.label}';
    if (isGroup && m.senderName.isNotEmpty) return '${m.senderName.split(' ').first} : ${m.label}';
    return m.label;
  }

  DateTime? get activityAt => lastMessage?.createdAt ?? updatedAt;
}

/// Ordre de la liste, comme le site (store.js → sortedConversations) : épinglées, puis les plus récentes.
List<Conversation> sortConversations(Iterable<Conversation> items) {
  final list = items.toList();
  final epoch = DateTime.fromMillisecondsSinceEpoch(0);
  list.sort((a, b) {
    if (a.pinned != b.pinned) return a.pinned ? -1 : 1;
    return (b.activityAt ?? epoch).compareTo(a.activityAt ?? epoch);
  });
  return list;
}

const _weekdays = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

/// Heure de la liste, comme WhatsApp : 14:05 aujourd'hui, « Hier », jour de la semaine, puis 24/11/2026.
String listTime(DateTime? date, [DateTime? now]) {
  if (date == null) return '';
  final today = now ?? DateTime.now();
  final d0 = DateTime(date.year, date.month, date.day);
  final t0 = DateTime(today.year, today.month, today.day);
  final days = t0.difference(d0).inDays;
  String two(int n) => n.toString().padLeft(2, '0');
  if (days <= 0) return '${two(date.hour)}:${two(date.minute)}';
  if (days == 1) return 'Hier';
  if (days < 7) return _weekdays[date.weekday - 1];
  return '${two(date.day)}/${two(date.month)}/${date.year}';
}
