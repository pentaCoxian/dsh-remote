import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'theme.dart';

/// The shell's top bar: flat, a chevron instead of Material's arrow, a hairline under it.
/// Every screen with one sits below the hosts list; one opened from a link has
/// nothing to pop, so its chevron goes home instead.
PreferredSizeWidget shellBar(BuildContext context, {Widget? title, List<Widget>? actions, double height = 52}) {
  final t = Tokens.of(context);
  return AppBar(
    toolbarHeight: height,
    automaticallyImplyLeading: false,
    leading: IconButton(tooltip: 'Back', icon: const Icon(LucideIcons.chevronLeft, size: 22), onPressed: () => leave(context)),
    titleSpacing: 0,
    title: title,
    actions: [...?actions, const SizedBox(width: 6)],
    shape: Border(bottom: BorderSide(color: t.border)),
  );
}

/// Back to the previous screen, or home when there is none.
void leave(BuildContext context) => context.canPop() ? context.pop() : context.go('/');

/// Text whose `backticked` spans (commands such as `dsh-remote pair`) are set in monospace.
class CodeText extends StatelessWidget {
  const CodeText(this.text, {super.key, this.style, this.textAlign});
  final String text;
  final TextStyle? style;
  final TextAlign? textAlign;

  @override
  Widget build(BuildContext context) {
    final t = Tokens.of(context);
    final parts = text.split('`');
    return Text.rich(
      TextSpan(children: [
        for (var i = 0; i < parts.length; i++)
          if (parts[i].isNotEmpty)
            TextSpan(text: parts[i], style: i.isOdd ? TextStyle(fontFamily: 'monospace', color: t.text, backgroundColor: t.muted) : null),
      ]),
      style: style,
      textAlign: textAlign,
    );
  }
}

/// A small grey label above a group, like DSH Web's "Workspaces".
class SectionLabel extends StatelessWidget {
  const SectionLabel(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(20, 24, 20, 8),
        child: Text(text, style: Theme.of(context).textTheme.titleSmall),
      );
}

/// Rows in one rounded, hairline-bordered group, separated by hairlines.
class Group extends StatelessWidget {
  const Group({super.key, required this.children});
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final t = Tokens.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: DecoratedBox(
        decoration: BoxDecoration(border: Border.all(color: t.border), borderRadius: BorderRadius.circular(Radii.card)),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(Radii.card),
          child: Column(children: [
            for (var i = 0; i < children.length; i++) ...[
              if (i > 0) Divider(indent: 16, endIndent: 0, color: t.border),
              children[i],
            ],
          ]),
        ),
      ),
    );
  }
}

/// One row of a [Group]: icon, label, optional value under it, optional trailing action.
class InfoRow extends StatelessWidget {
  const InfoRow({super.key, required this.icon, required this.label, this.value, this.valueWidget, this.trailing, this.mono = false, this.onTap});
  final Widget icon;
  final String label;
  final String? value;
  final Widget? valueWidget;
  final Widget? trailing;
  final bool mono;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final t = Tokens.of(context);
    final valueStyle = theme.textTheme.bodySmall?.copyWith(fontFamily: mono ? 'monospace' : null, color: t.textSecondary);
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 8, 12),
        child: Row(children: [
          SizedBox(width: 20, child: IconTheme(data: IconThemeData(color: t.textSecondary, size: 18), child: icon)),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(label, style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w500)),
              if (value != null) ...[const SizedBox(height: 2), Text(value!, style: valueStyle)],
              if (valueWidget != null) ...[const SizedBox(height: 4), valueWidget!],
            ]),
          ),
          if (trailing != null) trailing! else const SizedBox(width: 8),
        ]),
      ),
    );
  }
}

/// A tinted pill, like DSH Web's "Preview" badge.
class Pill extends StatelessWidget {
  const Pill(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) {
    final t = Tokens.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(color: t.accentSoft, borderRadius: BorderRadius.circular(8)),
      child: Text(text, style: TextStyle(color: t.accent, fontSize: 12, fontWeight: FontWeight.w500)),
    );
  }
}

/// A short inline notice (errors, hints) on the muted tone, with an optional action.
class Notice extends StatelessWidget {
  const Notice({super.key, required this.text, this.action, this.onAction, this.danger = false});
  final String text;
  final String? action;
  final VoidCallback? onAction;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final t = Tokens.of(context);
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 8, 12, 0),
      padding: const EdgeInsets.fromLTRB(14, 10, 6, 10),
      decoration: BoxDecoration(color: t.muted, borderRadius: BorderRadius.circular(Radii.control), border: Border.all(color: t.border)),
      child: Row(children: [
        Expanded(child: CodeText(text, style: Theme.of(context).textTheme.bodySmall?.copyWith(color: danger ? t.danger : t.textSecondary))),
        if (action != null) TextButton(onPressed: onAction, child: Text(action!)),
      ]),
    );
  }
}
