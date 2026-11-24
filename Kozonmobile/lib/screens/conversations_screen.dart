import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../auth/auth_controller.dart';
import '../models/conversation.dart';
import '../ui/avatar.dart';
import '../ui/theme.dart';

/// Liste des discussions (GET /api/conversations), dans l'ordre du serveur : épinglées puis récentes.
class ConversationsScreen extends StatefulWidget {
  const ConversationsScreen({super.key, required this.auth});

  final AuthController auth;

  @override
  State<ConversationsScreen> createState() => _ConversationsScreenState();
}

class _ConversationsScreenState extends State<ConversationsScreen> {
  List<Conversation>? _items;
  String? _error;
  bool _showArchived = false;

  AuthController get auth => widget.auth;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final data = await auth.api.get('conversations');
      final list = sortConversations([
        for (final c in (data['results'] as List<dynamic>? ?? const []))
          if (c is Map<String, dynamic>) Conversation.fromJson(c),
      ]);
      if (mounted) setState(() { _items = list; _error = null; });
    } on ApiException catch (e) {
      if (e.status == 401) return; // retour automatique à l'écran de connexion
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _logout() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Se déconnecter ?'),
        content: const Text('Vous devrez saisir à nouveau vos identifiants sur ce téléphone.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Annuler')),
          TextButton(onPressed: () => Navigator.pop(context, true), child: const Text('Se déconnecter')),
        ],
      ),
    );
    if (ok == true) await auth.logout();
  }

  @override
  Widget build(BuildContext context) {
    final me = auth.user!;
    final items = _items;
    return Scaffold(
      appBar: AppBar(
        title: Text(_showArchived ? 'Archivées' : 'Kozons'),
        leading: _showArchived ? BackButton(onPressed: () => setState(() => _showArchived = false)) : null,
        actions: [
          PopupMenuButton<String>(
            tooltip: 'Menu',
            onSelected: (v) {
              if (v == 'logout') _logout();
            },
            itemBuilder: (context) => [
              PopupMenuItem<String>(
                enabled: false,
                child: Row(children: [
                  KAvatar(name: me.name, url: me.avatar, size: 32),
                  const SizedBox(width: 10),
                  Expanded(child: Text('${me.name}\n@${me.username}', maxLines: 2, overflow: TextOverflow.ellipsis)),
                ]),
              ),
              const PopupMenuDivider(),
              const PopupMenuItem(value: 'logout', child: ListTile(leading: Icon(Icons.logout), title: Text('Se déconnecter'), contentPadding: EdgeInsets.zero)),
            ],
          ),
        ],
      ),
      body: RefreshIndicator(
        color: KColors.accent,
        onRefresh: _load,
        child: _body(context, me.id, items),
      ),
    );
  }

  Widget _body(BuildContext context, int meId, List<Conversation>? items) {
    final muted = KColors.muted(context);
    if (items == null && _error == null) return const Center(child: CircularProgressIndicator());
    if (items == null) {
      return _Message(
        icon: Icons.cloud_off_outlined,
        title: 'Discussions indisponibles',
        text: _error!,
        action: FilledButton(onPressed: () { setState(() => _error = null); _load(); }, child: const Text('Réessayer')),
      );
    }
    final archived = items.where((c) => c.archived).toList();
    final shown = _showArchived ? archived : items.where((c) => !c.archived).toList();
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        if (_error != null)
          MaterialBanner(content: Text(_error!), actions: [TextButton(onPressed: _load, child: const Text('Réessayer'))]),
        if (!_showArchived && archived.isNotEmpty)
          ListTile(
            leading: SizedBox(width: 50, child: Icon(Icons.archive_outlined, color: muted)),
            title: const Text('Archivées', style: TextStyle(fontWeight: FontWeight.w600)),
            trailing: Text('${archived.length}', style: const TextStyle(color: KColors.accent, fontWeight: FontWeight.w600)),
            onTap: () => setState(() => _showArchived = true),
          ),
        if (shown.isEmpty)
          _Message(
            icon: Icons.chat_bubble_outline,
            title: _showArchived ? 'Aucune discussion archivée' : 'Aucune discussion',
            text: _showArchived ? '' : 'Vos discussions avec vos contacts apparaîtront ici.',
          ),
        for (final c in shown) _ConversationTile(conversation: c, meId: meId),
      ],
    );
  }
}

class _ConversationTile extends StatelessWidget {
  const _ConversationTile({required this.conversation, required this.meId});

  final Conversation conversation;
  final int meId;

  @override
  Widget build(BuildContext context) {
    final c = conversation;
    final muted = KColors.muted(context);
    final unread = c.unread > 0 || c.markedUnread;
    final title = c.displayTitle(meId);
    return InkWell(
      onTap: () => ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(const SnackBar(content: Text("L'ouverture des discussions arrive dans la prochaine version."))),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        child: Row(
          children: [
            KAvatar(name: title, url: c.displayAvatar(meId), group: c.isGroup && c.avatar == null),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(children: [
                    Expanded(
                      child: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 16.5, fontWeight: FontWeight.w600)),
                    ),
                    const SizedBox(width: 8),
                    Text(listTime(c.activityAt),
                        style: TextStyle(fontSize: 12, color: unread ? KColors.accent : muted, fontWeight: unread ? FontWeight.w600 : null)),
                  ]),
                  const SizedBox(height: 3),
                  Row(children: [
                    Expanded(
                      child: Text(c.preview(meId), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: muted, fontSize: 14.5)),
                    ),
                    if (c.isMuted()) Padding(padding: const EdgeInsets.only(left: 6), child: Icon(Icons.volume_off, size: 18, color: muted)),
                    if (c.pinned) Padding(padding: const EdgeInsets.only(left: 6), child: Icon(Icons.push_pin, size: 17, color: muted)),
                    if (unread)
                      Container(
                        margin: const EdgeInsets.only(left: 8),
                        constraints: const BoxConstraints(minWidth: 22),
                        height: 22,
                        padding: const EdgeInsets.symmetric(horizontal: 6),
                        alignment: Alignment.center,
                        decoration: BoxDecoration(color: c.isMuted() ? muted : KColors.accent, borderRadius: BorderRadius.circular(11)),
                        child: Text(c.unread > 0 ? (c.unread > 99 ? '99+' : '${c.unread}') : '',
                            style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w700)),
                      ),
                  ]),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Message extends StatelessWidget {
  const _Message({required this.icon, required this.title, required this.text, this.action});

  final IconData icon;
  final String title;
  final String text;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final muted = KColors.muted(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(32, 96, 32, 32),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 56, color: muted),
          const SizedBox(height: 14),
          Text(title, textAlign: TextAlign.center, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
          if (text.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(text, textAlign: TextAlign.center, style: TextStyle(color: muted)),
          ],
          if (action != null) ...[const SizedBox(height: 18), SizedBox(width: 200, child: action)],
        ],
      ),
    );
  }
}
