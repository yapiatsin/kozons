import 'package:flutter/material.dart';

import '../config/api_config.dart';
import 'theme.dart';

/// Photo de profil ronde ; sans photo : initiales sur une couleur tirée du nom (comme le site).
class KAvatar extends StatelessWidget {
  const KAvatar({super.key, required this.name, this.url, this.size = 50, this.group = false});

  final String name;
  final String? url;
  final double size;
  final bool group;

  @override
  Widget build(BuildContext context) {
    final fallback = _fallback();
    final src = url;
    if (src == null || src.isEmpty) return fallback;
    return ClipOval(
      child: Image.network(
        ApiConfig.mediaUrl(src),
        width: size,
        height: size,
        fit: BoxFit.cover,
        errorBuilder: (_, _, _) => fallback,
      ),
    );
  }

  Widget _fallback() {
    final hash = name.codeUnits.fold<int>(0, (h, c) => (h * 31 + c) & 0x7fffffff);
    final color = KColors.avatars[hash % KColors.avatars.length];
    final initials = name.trim().split(RegExp(r'\s+')).where((w) => w.isNotEmpty).take(2).map((w) => w[0].toUpperCase()).join();
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
      child: group || initials.isEmpty
          ? Icon(group ? Icons.group : Icons.person, color: Colors.white, size: size * .55)
          : Text(initials, style: TextStyle(color: Colors.white, fontSize: size * .38, fontWeight: FontWeight.w600)),
    );
  }
}
