// Thème visuel : polices, palette de couleurs, espacements.
// C'est ici que se joue l'essentiel du « joli ».

use eframe::egui;
use egui::{
    Color32, CornerRadius, FontData, FontDefinitions, FontFamily, FontId, Shadow, Stroke,
    TextStyle, Theme, ThemePreference, Vec2,
};
use std::sync::Arc;

/// Couleurs de l'application pour un thème donné.
#[derive(Clone, Copy)]
pub struct Palette {
    pub chrome_bg: Color32,  // barres d'outils / d'état
    pub editor_bg: Color32,  // zone d'édition
    pub preview_bg: Color32, // zone d'aperçu
    pub segment_bg: Color32, // fond du sélecteur de mode
    pub border: Color32,
    pub text: Color32,
    pub muted: Color32,
    pub accent: Color32,
    pub hover: Color32,
    pub code_bg: Color32,
}

const fn hex(rgb: u32) -> Color32 {
    Color32::from_rgb((rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8)
}

impl Palette {
    pub fn new(dark: bool) -> Self {
        if dark {
            Self {
                chrome_bg: hex(0x16171B),
                editor_bg: hex(0x1A1B20),
                preview_bg: hex(0x1F2026),
                segment_bg: hex(0x24262D),
                border: hex(0x2A2C34),
                text: hex(0xE4E5EA),
                muted: hex(0x8A8D99),
                accent: hex(0x8AA4FF),
                hover: hex(0x2C2F38),
                code_bg: hex(0x272932),
            }
        } else {
            Self {
                chrome_bg: hex(0xF5F5F7),
                editor_bg: hex(0xFAFAFB),
                preview_bg: hex(0xFFFFFF),
                segment_bg: hex(0xE9EAEE),
                border: hex(0xE2E3E8),
                text: hex(0x1E1F24),
                muted: hex(0x6B6E7A),
                accent: hex(0x4A63E7),
                hover: hex(0xE6E8EE),
                code_bg: hex(0xF1F2F5),
            }
        }
    }
}

/// Charge les polices système de Windows (Segoe UI + Cascadia Mono),
/// en gardant les polices d'egui en secours pour les emojis / symboles.
pub fn install_fonts(ctx: &egui::Context) {
    let mut fonts = FontDefinitions::default();

    let load = |names: &[&str]| -> Option<Vec<u8>> {
        names
            .iter()
            .find_map(|n| std::fs::read(format!("C:\\Windows\\Fonts\\{n}")).ok())
    };

    if let Some(bytes) = load(&["segoeui.ttf"]) {
        fonts
            .font_data
            .insert("ui".into(), Arc::new(FontData::from_owned(bytes)));
        fonts
            .families
            .entry(FontFamily::Proportional)
            .or_default()
            .insert(0, "ui".into());
    }
    if let Some(bytes) = load(&["CascadiaMono.ttf", "consola.ttf"]) {
        fonts
            .font_data
            .insert("mono".into(), Arc::new(FontData::from_owned(bytes)));
        fonts
            .families
            .entry(FontFamily::Monospace)
            .or_default()
            .insert(0, "mono".into());
    }

    ctx.set_fonts(fonts);
}

fn style_for(pal: Palette, dark: bool) -> egui::Style {
    let mut visuals = if dark {
        egui::Visuals::dark()
    } else {
        egui::Visuals::light()
    };

    let radius = CornerRadius::same(6);

    visuals.override_text_color = Some(pal.text);
    visuals.panel_fill = pal.preview_bg;
    visuals.window_fill = pal.preview_bg;
    visuals.window_stroke = Stroke::new(1.0, pal.border);
    visuals.window_corner_radius = CornerRadius::same(10);
    visuals.window_shadow = Shadow {
        offset: [0, 8],
        blur: 24,
        spread: 0,
        color: Color32::from_black_alpha(if dark { 110 } else { 40 }),
    };
    visuals.popup_shadow = visuals.window_shadow;
    visuals.menu_corner_radius = CornerRadius::same(8);
    visuals.extreme_bg_color = pal.editor_bg;
    visuals.faint_bg_color = pal.code_bg;
    visuals.code_bg_color = pal.code_bg;
    visuals.hyperlink_color = pal.accent;

    // Sélection (texte sélectionné et bouton actif du sélecteur de mode)
    let [r, g, b, _] = pal.accent.to_array();
    visuals.selection.bg_fill = Color32::from_rgba_unmultiplied(r, g, b, if dark { 70 } else { 50 });
    visuals.selection.stroke = Stroke::new(1.0, pal.text);
    visuals.text_cursor.stroke = Stroke::new(2.0, pal.accent);

    // Boutons « plats » : pas de bordure, fond seulement au survol
    let w = &mut visuals.widgets;
    w.noninteractive.bg_stroke = Stroke::new(1.0, pal.border);
    w.noninteractive.fg_stroke = Stroke::new(1.0, pal.text);
    w.noninteractive.corner_radius = radius;

    w.inactive.weak_bg_fill = Color32::TRANSPARENT;
    w.inactive.bg_fill = pal.segment_bg;
    w.inactive.bg_stroke = Stroke::NONE;
    w.inactive.fg_stroke = Stroke::new(1.0, pal.text);
    w.inactive.corner_radius = radius;

    w.hovered.weak_bg_fill = pal.hover;
    w.hovered.bg_fill = pal.hover;
    w.hovered.bg_stroke = Stroke::NONE;
    w.hovered.fg_stroke = Stroke::new(1.0, pal.text);
    w.hovered.corner_radius = radius;
    w.hovered.expansion = 0.0;

    w.active.weak_bg_fill = pal.segment_bg;
    w.active.bg_fill = pal.segment_bg;
    w.active.bg_stroke = Stroke::NONE;
    // fg de « active » sert aussi de couleur au texte en gras : on garde la couleur du texte
    w.active.fg_stroke = Stroke::new(1.0, if dark { Color32::WHITE } else { Color32::BLACK });
    w.active.corner_radius = radius;
    w.active.expansion = 0.0;

    w.open = w.active;

    let mut style = egui::Style {
        visuals,
        ..Default::default()
    };

    style.text_styles = [
        (TextStyle::Small, FontId::proportional(12.0)),
        (TextStyle::Body, FontId::proportional(15.0)),
        (TextStyle::Button, FontId::proportional(14.0)),
        (TextStyle::Heading, FontId::proportional(26.0)),
        (TextStyle::Monospace, FontId::monospace(14.0)),
    ]
    .into();

    style.spacing.item_spacing = Vec2::new(8.0, 7.0);
    style.spacing.button_padding = Vec2::new(10.0, 5.0);
    style.spacing.interact_size.y = 28.0;
    style.spacing.scroll.floating = true;
    style.spacing.scroll.bar_width = 8.0;

    style
}

/// Applique le thème clair ou sombre.
pub fn apply(ctx: &egui::Context, dark: bool) {
    ctx.set_style_of(Theme::Dark, style_for(Palette::new(true), true));
    ctx.set_style_of(Theme::Light, style_for(Palette::new(false), false));
    ctx.set_theme(if dark {
        ThemePreference::Dark
    } else {
        ThemePreference::Light
    });
}
