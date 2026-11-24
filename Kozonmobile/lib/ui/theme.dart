import 'package:flutter/material.dart';

/// Couleurs du site Kozons (app.css) : même identité sur le web et le mobile.
class KColors {
  static const accent = Color(0xFF0099CC);
  static const danger = Color(0xFFEA0038);

  static const darkBg = Color(0xFF0B141A);
  static const darkPanel = Color(0xFF111B21);
  static const darkPanel2 = Color(0xFF202C33);
  static const darkBorder = Color(0xFF222D34);
  static const darkText = Color(0xFFE9EDEF);
  static const darkMuted = Color(0xFF8696A0);

  static const lightBg = Color(0xFFF0F2F5);
  static const lightPanel = Color(0xFFFFFFFF);
  static const lightPanel2 = Color(0xFFF0F2F5);
  static const lightBorder = Color(0xFFE9EDEF);
  static const lightText = Color(0xFF111B21);
  static const lightMuted = Color(0xFF667781);

  /// Couleurs des avatars sans photo (ui.js → COLORS).
  static const avatars = [
    Color(0xFF0099CC), Color(0xFFE1306C), Color(0xFF7C4DFF), Color(0xFFFF9800), Color(0xFF03A9F4),
    Color(0xFF8BC34A), Color(0xFFF44336), Color(0xFF009688), Color(0xFF795548), Color(0xFF3F51B5),
  ];

  static Color muted(BuildContext context) =>
      Theme.of(context).brightness == Brightness.dark ? darkMuted : lightMuted;
}

ThemeData kozonsTheme(Brightness brightness) {
  final dark = brightness == Brightness.dark;
  final scheme = ColorScheme.fromSeed(seedColor: KColors.accent, brightness: brightness).copyWith(
    primary: KColors.accent,
    onPrimary: Colors.white,
    surface: dark ? KColors.darkPanel : KColors.lightPanel,
    onSurface: dark ? KColors.darkText : KColors.lightText,
    error: KColors.danger,
  );
  return ThemeData(
    colorScheme: scheme,
    scaffoldBackgroundColor: dark ? KColors.darkPanel : KColors.lightPanel,
    appBarTheme: AppBarTheme(
      backgroundColor: dark ? KColors.darkPanel : KColors.lightPanel,
      foregroundColor: dark ? KColors.darkText : KColors.lightText,
      elevation: 0,
      scrolledUnderElevation: 0,
      titleTextStyle: TextStyle(
        fontSize: 22, fontWeight: FontWeight.w600, color: dark ? KColors.darkText : KColors.lightText),
    ),
    dividerColor: dark ? KColors.darkBorder : KColors.lightBorder,
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: dark ? KColors.darkPanel2 : KColors.lightPanel2,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide.none),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10), borderSide: const BorderSide(color: KColors.accent, width: 1.5)),
      hintStyle: TextStyle(color: dark ? KColors.darkMuted : KColors.lightMuted),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: KColors.accent,
        foregroundColor: Colors.white,
        minimumSize: const Size.fromHeight(48),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
        textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
      ),
    ),
    snackBarTheme: const SnackBarThemeData(behavior: SnackBarBehavior.floating),
  );
}
