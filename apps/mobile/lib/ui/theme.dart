import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// Design tokens in the spirit of the DeepSeek Harness web UI: white surfaces,
/// near-black type and primary actions, hairline borders, one blue accent, no
/// ink ripples. The platform font is kept so the shell matches DSH Web, which
/// renders in the same WebView font.
@immutable
class Tokens extends ThemeExtension<Tokens> {
  const Tokens({
    required this.background,
    required this.muted,
    required this.hover,
    required this.border,
    required this.text,
    required this.textSecondary,
    required this.textTertiary,
    required this.accent,
    required this.accentSoft,
    required this.success,
    required this.danger,
  });

  /// Page background.
  final Color background;

  /// Sidebar / input / grouped-row tone.
  final Color muted;

  /// Pressed or selected row (DSH's session-row grey).
  final Color hover;

  /// Hairlines.
  final Color border;
  final Color text;
  final Color textSecondary;
  final Color textTertiary;

  /// DeepSeek blue: links, focus, progress, badges. Never large fills.
  final Color accent;
  final Color accentSoft;
  final Color success;
  final Color danger;

  static const light = Tokens(
    background: Color(0xFFFFFFFF),
    muted: Color(0xFFF7F8FA),
    hover: Color(0xFFEEEFF2),
    border: Color(0xFFE8EAEE),
    text: Color(0xFF0E0F11),
    textSecondary: Color(0xFF656B75),
    textTertiary: Color(0xFF9DA3AD),
    accent: Color(0xFF4D6BFE),
    accentSoft: Color(0xFFEEF1FF),
    success: Color(0xFF22A55B),
    danger: Color(0xFFE5484D),
  );

  static const dark = Tokens(
    background: Color(0xFF0F1012),
    muted: Color(0xFF17181B),
    hover: Color(0xFF212328),
    border: Color(0xFF26282D),
    text: Color(0xFFECEDEF),
    textSecondary: Color(0xFF9BA1AA),
    textTertiary: Color(0xFF6B7078),
    accent: Color(0xFF7088FF),
    accentSoft: Color(0xFF1D2340),
    success: Color(0xFF3DBE77),
    danger: Color(0xFFF2555A),
  );

  static Tokens of(BuildContext context) => Theme.of(context).extension<Tokens>()!;

  @override
  Tokens copyWith() => this;

  @override
  Tokens lerp(Tokens? other, double t) => t < 0.5 || other == null ? this : other;
}

/// Corner radii: cards and groups, buttons and inputs, dialogs and sheets.
abstract final class Radii {
  static const card = 16.0;
  static const control = 12.0;
  static const sheet = 20.0;
}

/// Status and navigation bars in the shell's colours. Screens without a top
/// bar need it too, or Android keeps white icons on the white page.
SystemUiOverlayStyle overlayStyle(Brightness brightness) {
  final t = brightness == Brightness.light ? Tokens.light : Tokens.dark;
  final icons = brightness == Brightness.light ? Brightness.dark : Brightness.light;
  return SystemUiOverlayStyle(
    statusBarColor: Colors.transparent,
    statusBarIconBrightness: icons,
    statusBarBrightness: brightness,
    systemNavigationBarColor: t.background,
    systemNavigationBarIconBrightness: icons,
  );
}

ThemeData buildTheme(Brightness brightness) {
  final t = brightness == Brightness.light ? Tokens.light : Tokens.dark;
  final scheme = ColorScheme(
    brightness: brightness,
    primary: t.text,
    onPrimary: t.background,
    secondary: t.accent,
    onSecondary: Colors.white,
    tertiary: t.accent,
    onTertiary: Colors.white,
    error: t.danger,
    onError: Colors.white,
    surface: t.background,
    onSurface: t.text,
    onSurfaceVariant: t.textSecondary,
    outline: t.border,
    outlineVariant: t.border,
    surfaceContainerLowest: t.background,
    surfaceContainerLow: t.muted,
    surfaceContainer: t.muted,
    surfaceContainerHigh: t.hover,
    surfaceContainerHighest: t.hover,
    primaryContainer: t.accentSoft,
    onPrimaryContainer: t.accent,
    secondaryContainer: t.hover,
    onSecondaryContainer: t.text,
    inverseSurface: t.text,
    onInverseSurface: t.background,
  );
  final base = ThemeData(brightness: brightness, useMaterial3: true, colorScheme: scheme);
  final text = base.textTheme.apply(bodyColor: t.text, displayColor: t.text).copyWith(
        headlineSmall: base.textTheme.headlineSmall?.copyWith(fontSize: 24, fontWeight: FontWeight.w700, letterSpacing: -0.4, color: t.text),
        titleLarge: base.textTheme.titleLarge?.copyWith(fontSize: 20, fontWeight: FontWeight.w600, letterSpacing: -0.2, color: t.text),
        titleMedium: base.textTheme.titleMedium?.copyWith(fontSize: 16, fontWeight: FontWeight.w600, color: t.text),
        titleSmall: base.textTheme.titleSmall?.copyWith(fontSize: 13, fontWeight: FontWeight.w500, color: t.textSecondary),
        bodyLarge: base.textTheme.bodyLarge?.copyWith(fontSize: 16, color: t.text),
        bodyMedium: base.textTheme.bodyMedium?.copyWith(fontSize: 15, color: t.text),
        bodySmall: base.textTheme.bodySmall?.copyWith(fontSize: 13, color: t.textSecondary, height: 1.4),
        labelLarge: base.textTheme.labelLarge?.copyWith(fontSize: 15, fontWeight: FontWeight.w600),
        labelSmall: base.textTheme.labelSmall?.copyWith(fontSize: 12, color: t.textSecondary),
      );
  final controlShape = RoundedRectangleBorder(borderRadius: BorderRadius.circular(Radii.control));
  final overlay = overlayStyle(brightness);
  return base.copyWith(
    extensions: [t],
    scaffoldBackgroundColor: t.background,
    textTheme: text,
    splashFactory: NoSplash.splashFactory,
    highlightColor: t.hover.withValues(alpha: 0.6),
    hoverColor: t.hover,
    dividerColor: t.border,
    appBarTheme: AppBarTheme(
      backgroundColor: t.background,
      foregroundColor: t.text,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      toolbarHeight: 52,
      titleSpacing: 4,
      systemOverlayStyle: overlay,
      titleTextStyle: text.titleMedium,
      iconTheme: IconThemeData(color: t.text, size: 20),
      actionsIconTheme: IconThemeData(color: t.textSecondary, size: 20),
    ),
    iconTheme: IconThemeData(color: t.textSecondary, size: 20),
    iconButtonTheme: IconButtonThemeData(style: IconButton.styleFrom(foregroundColor: t.textSecondary, iconSize: 20, splashFactory: NoSplash.splashFactory)),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: t.text,
        foregroundColor: t.background,
        disabledBackgroundColor: t.hover,
        disabledForegroundColor: t.textTertiary,
        minimumSize: const Size.fromHeight(48),
        shape: controlShape,
        textStyle: text.labelLarge,
        elevation: 0,
        splashFactory: NoSplash.splashFactory,
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: t.text,
        side: BorderSide(color: t.border),
        minimumSize: const Size.fromHeight(48),
        shape: controlShape,
        textStyle: text.labelLarge?.copyWith(fontWeight: FontWeight.w500),
        splashFactory: NoSplash.splashFactory,
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(foregroundColor: t.text, shape: controlShape, textStyle: text.labelLarge?.copyWith(fontWeight: FontWeight.w500), splashFactory: NoSplash.splashFactory),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: t.muted,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
      hintStyle: TextStyle(color: t.textTertiary),
      labelStyle: TextStyle(color: t.textSecondary),
      floatingLabelStyle: TextStyle(color: t.textSecondary),
      helperStyle: TextStyle(color: t.textTertiary, fontSize: 12),
      counterStyle: TextStyle(color: t.textTertiary, fontSize: 12),
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(Radii.control), borderSide: BorderSide(color: t.border)),
      enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(Radii.control), borderSide: BorderSide(color: t.border)),
      focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(Radii.control), borderSide: BorderSide(color: t.text, width: 1.2)),
    ),
    cardTheme: CardThemeData(
      color: t.background,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Radii.card), side: BorderSide(color: t.border)),
    ),
    listTileTheme: ListTileThemeData(
      contentPadding: const EdgeInsets.symmetric(horizontal: 16),
      iconColor: t.textSecondary,
      titleTextStyle: text.bodyMedium?.copyWith(fontWeight: FontWeight.w500),
      subtitleTextStyle: text.bodySmall,
      minLeadingWidth: 20,
      horizontalTitleGap: 12,
    ),
    dividerTheme: DividerThemeData(color: t.border, thickness: 1, space: 1),
    dialogTheme: DialogThemeData(
      backgroundColor: t.background,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Radii.sheet)),
      titleTextStyle: text.titleLarge,
      contentTextStyle: text.bodyMedium?.copyWith(color: t.textSecondary, height: 1.5),
    ),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: t.background,
      surfaceTintColor: Colors.transparent,
      showDragHandle: true,
      dragHandleColor: t.border,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Radii.sheet))),
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: t.text,
      contentTextStyle: TextStyle(color: t.background, fontSize: 14),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Radii.control)),
      elevation: 0,
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(color: t.accent, linearTrackColor: Colors.transparent, circularTrackColor: Colors.transparent),
    textSelectionTheme: TextSelectionThemeData(cursorColor: t.accent, selectionColor: t.accent.withValues(alpha: 0.2), selectionHandleColor: t.accent),
    pageTransitionsTheme: const PageTransitionsTheme(builders: {
      TargetPlatform.android: PredictiveBackPageTransitionsBuilder(),
      TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
    }),
  );
}
