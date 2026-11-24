/// Utilisateur tel que renvoyé par l'API (`user_brief` / `user_private` côté serveur).
class KUser {
  const KUser({required this.id, required this.username, required this.name, this.avatar, this.online});

  factory KUser.fromJson(Map<String, dynamic> json) => KUser(
        id: json['id'] as int,
        username: (json['username'] as String?) ?? '',
        name: (json['name'] as String?) ?? (json['username'] as String?) ?? '',
        avatar: json['avatar'] as String?,
        online: json['online'] as bool?,
      );

  final int id;
  final String username;
  final String name;
  final String? avatar;
  final bool? online;

  Map<String, dynamic> toJson() => {'id': id, 'username': username, 'name': name, 'avatar': avatar, 'online': online};
}
