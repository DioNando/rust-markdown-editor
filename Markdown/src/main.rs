// Lecteur / éditeur Markdown minimal en Rust (egui)
// Éditeur à gauche, aperçu à droite, ouvrir / enregistrer, raccourcis clavier.

mod theme;

use eframe::egui;
use egui::{CornerRadius, Frame, Margin, RichText};
use egui_commonmark::{CommonMarkCache, CommonMarkViewer};
use std::path::PathBuf;
use theme::Palette;

fn main() -> eframe::Result<()> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1100.0, 680.0])
            .with_min_inner_size([640.0, 400.0])
            .with_title("Éditeur Markdown"),
        ..Default::default()
    };
    eframe::run_native(
        "md_editor",
        options,
        Box::new(|cc| {
            theme::install_fonts(&cc.egui_ctx);
            let app = App::default();
            theme::apply(&cc.egui_ctx, app.dark);
            Ok(Box::new(app))
        }),
    )
}

#[derive(PartialEq, Clone, Copy)]
enum Mode {
    Split,
    Edit,
    Preview,
}

struct App {
    text: String,
    path: Option<PathBuf>,
    dirty: bool, // modifications non enregistrées
    mode: Mode,
    dark: bool,
    cache: CommonMarkCache,
    status: String,
}

impl Default for App {
    fn default() -> Self {
        Self {
            text: "# Bienvenue\n\nÉcris du **Markdown** à gauche, l'aperçu s'affiche à droite.\n\n## Raccourcis\n\n- `Ctrl+O` : ouvrir\n- `Ctrl+S` : enregistrer\n- `Ctrl+Maj+S` : enregistrer sous\n\n> Astuce : le bouton ☀/🌙 en haut à droite change de thème.\n\n```rust\nfn main() {\n    println!(\"Bonjour Rust !\");\n}\n```\n".into(),
            path: None,
            dirty: false,
            mode: Mode::Split,
            dark: true,
            cache: CommonMarkCache::default(),
            status: "Prêt".into(),
        }
    }
}

impl App {
    fn palette(&self) -> Palette {
        Palette::new(self.dark)
    }

    fn open(&mut self) {
        if let Some(p) = rfd::FileDialog::new()
            .add_filter("Markdown", &["md", "markdown", "txt"])
            .pick_file()
        {
            match std::fs::read_to_string(&p) {
                Ok(s) => {
                    self.text = s;
                    self.status = format!("Ouvert : {}", p.display());
                    self.path = Some(p);
                    self.dirty = false;
                }
                Err(e) => self.status = format!("Erreur de lecture : {e}"),
            }
        }
    }

    fn save(&mut self, save_as: bool) {
        let target = if save_as || self.path.is_none() {
            rfd::FileDialog::new()
                .add_filter("Markdown", &["md"])
                .set_file_name("document.md")
                .save_file()
        } else {
            self.path.clone()
        };
        if let Some(p) = target {
            match std::fs::write(&p, &self.text) {
                Ok(()) => {
                    self.status = format!("Enregistré : {}", p.display());
                    self.path = Some(p);
                    self.dirty = false;
                }
                Err(e) => self.status = format!("Erreur d'écriture : {e}"),
            }
        }
    }

    fn file_name(&self) -> String {
        self.path
            .as_ref()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Sans titre".into())
    }

    fn title(&self) -> String {
        format!(
            "{}{} - Éditeur Markdown",
            if self.dirty { "• " } else { "" },
            self.file_name()
        )
    }

    fn editor(&mut self, ui: &mut egui::Ui) {
        let pal = self.palette();
        egui::ScrollArea::vertical()
            .id_salt("editor")
            .show(ui, |ui| {
                let resp = ui.add_sized(
                    ui.available_size(),
                    egui::TextEdit::multiline(&mut self.text)
                        .font(egui::TextStyle::Monospace)
                        .frame(
                            Frame::NONE
                                .fill(pal.editor_bg)
                                .inner_margin(Margin::symmetric(28, 24)),
                        )
                        .desired_width(f32::INFINITY),
                );
                if resp.changed() {
                    self.dirty = true;
                }
            });
    }

    fn preview(&mut self, ui: &mut egui::Ui) {
        egui::ScrollArea::vertical()
            .id_salt("preview")
            .show(ui, |ui| {
                // Colonne de lecture centrée, largeur limitée : bien plus agréable à lire.
                let avail = ui.available_width();
                let width = (avail - 64.0).clamp(200.0, 760.0);
                let pad = ((avail - width) / 2.0).max(0.0);
                ui.add_space(28.0);
                ui.horizontal(|ui| {
                    ui.add_space(pad);
                    ui.vertical(|ui| {
                        ui.set_width(width);
                        CommonMarkViewer::new().show(ui, &mut self.cache, &self.text);
                    });
                });
                ui.add_space(40.0);
            });
    }

    fn toolbar(&mut self, ui: &mut egui::Ui) {
        let pal = self.palette();
        ui.horizontal_centered(|ui| {
            ui.spacing_mut().item_spacing.x = 6.0;

            // Nom du fichier + pastille « modifié »
            ui.label(RichText::new("◆").color(pal.accent).size(16.0));
            ui.label(RichText::new(self.file_name()).strong().size(15.0));
            if self.dirty {
                ui.label(RichText::new("●").color(pal.accent).size(10.0))
                    .on_hover_text("Modifications non enregistrées");
            }

            ui.add_space(16.0);
            if ui.button("📂  Ouvrir").on_hover_text("Ctrl+O").clicked() {
                self.open();
            }
            if ui.button("💾  Enregistrer").on_hover_text("Ctrl+S").clicked() {
                self.save(false);
            }
            if ui.button("Enregistrer sous…").on_hover_text("Ctrl+Maj+S").clicked() {
                self.save(true);
            }

            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                let icon = if self.dark { "☀" } else { "🌙" };
                if ui
                    .button(RichText::new(icon).size(16.0))
                    .on_hover_text("Changer de thème")
                    .clicked()
                {
                    self.dark = !self.dark;
                    theme::apply(ui.ctx(), self.dark);
                }
                ui.add_space(8.0);

                // Sélecteur de mode façon « segmented control »
                Frame::NONE
                    .fill(pal.segment_bg)
                    .corner_radius(CornerRadius::same(8))
                    .inner_margin(Margin::same(3))
                    .show(ui, |ui| {
                        ui.horizontal(|ui| {
                            ui.spacing_mut().item_spacing.x = 2.0;
                            // right_to_left : ordre inversé
                            ui.selectable_value(&mut self.mode, Mode::Preview, "Lire");
                            ui.selectable_value(&mut self.mode, Mode::Split, "Côte à côte");
                            ui.selectable_value(&mut self.mode, Mode::Edit, "Éditer");
                        });
                    });
            });
        });
    }
}

impl eframe::App for App {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        let pal = self.palette();

        // Raccourcis clavier
        let (open, save, save_as) = ctx.input_mut(|i| {
            (
                i.consume_key(egui::Modifiers::COMMAND, egui::Key::O),
                i.consume_key(egui::Modifiers::COMMAND | egui::Modifiers::SHIFT, egui::Key::S),
                i.consume_key(egui::Modifiers::COMMAND, egui::Key::S),
            )
        });
        if open {
            self.open();
        }
        if save_as {
            self.save(true);
        } else if save {
            self.save(false);
        }

        ctx.send_viewport_cmd(egui::ViewportCommand::Title(self.title()));

        // Barre d'outils
        egui::Panel::top("toolbar")
            .exact_size(52.0)
            .frame(
                Frame::NONE
                    .fill(pal.chrome_bg)
                    .inner_margin(Margin::symmetric(16, 0))
                    .stroke(egui::Stroke::new(1.0, pal.border)),
            )
            .show_separator_line(false)
            .show(ui, |ui| self.toolbar(ui));

        // Barre d'état
        egui::Panel::bottom("status")
            .exact_size(28.0)
            .frame(
                Frame::NONE
                    .fill(pal.chrome_bg)
                    .inner_margin(Margin::symmetric(16, 0)),
            )
            .show_separator_line(false)
            .show(ui, |ui| {
                ui.horizontal_centered(|ui| {
                    ui.label(RichText::new(&self.status).color(pal.muted).size(12.5));
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.label(
                            RichText::new(format!(
                                "{} mots   ·   {} lignes   ·   {} caractères",
                                self.text.split_whitespace().count(),
                                self.text.lines().count(),
                                self.text.chars().count()
                            ))
                            .color(pal.muted)
                            .size(12.5),
                        );
                    });
                });
            });

        let editor_frame = Frame::NONE.fill(pal.editor_bg);
        let preview_frame = Frame::NONE.fill(pal.preview_bg);

        // Zone principale
        match self.mode {
            Mode::Edit => {
                egui::CentralPanel::default()
                    .frame(editor_frame)
                    .show(ui, |ui| self.editor(ui));
            }
            Mode::Preview => {
                egui::CentralPanel::default()
                    .frame(preview_frame)
                    .show(ui, |ui| self.preview(ui));
            }
            Mode::Split => {
                let half = ui.available_width() / 2.0;
                egui::Panel::left("editor_panel")
                    .resizable(true)
                    .default_size(half)
                    .frame(editor_frame.stroke(egui::Stroke::new(1.0, pal.border)))
                    .show(ui, |ui| self.editor(ui));
                egui::CentralPanel::default()
                    .frame(preview_frame)
                    .show(ui, |ui| self.preview(ui));
            }
        }
    }
}
