//! Design tokens taken from the upstream theme source
//! (packages/client/ui-theme/src/styles/*.css at the pinned revision), so the
//! native window matches the web product: white page, near-white sidebar,
//! near-black label text, a single blue accent and half-pixel hairline borders.

use gpui::{px, Pixels, Rgba};

// Static palette (light theme).
pub const BG_BASE: u32 = 0xffffff;
pub const SIDEBAR: u32 = 0xf9fafb;
pub const COMPOSER: u32 = 0xffffff;
pub const USER_BUBBLE: u32 = 0xedf3fe;
pub const CODE_BLOCK: u32 = 0xf9fafb;
pub const LABEL_PRIMARY: u32 = 0x0f1115;
pub const LABEL_SECONDARY: u32 = 0x61666b;
pub const LABEL_TERTIARY: u32 = 0x81858c;
pub const ACCENT: u32 = 0x4176e6;
pub const BRAND: u32 = 0x5686fe;
pub const DANGER: u32 = 0xd93a3a;

/// border-l1: rgba(0, 0, 0, 0.04)
pub const HAIRLINE: u32 = 0x0000000a;
/// border-l2: rgba(0, 0, 0, 0.1)
pub const BORDER: u32 = 0x0000001a;
/// border-l3: rgba(0, 0, 0, 0.12)
pub const BORDER_STRONG: u32 = 0x0000001f;

pub fn page() -> Rgba {
    rgb(BG_BASE)
}

pub fn sidebar() -> Rgba {
    rgb(SIDEBAR)
}

pub fn composer() -> Rgba {
    rgb(COMPOSER)
}

pub fn user_bubble() -> Rgba {
    rgb(USER_BUBBLE)
}

pub fn code_block() -> Rgba {
    rgb(CODE_BLOCK)
}

pub fn label() -> Rgba {
    rgb(LABEL_PRIMARY)
}

pub fn secondary() -> Rgba {
    rgb(LABEL_SECONDARY)
}

pub fn tertiary() -> Rgba {
    rgb(LABEL_TERTIARY)
}

pub fn accent() -> Rgba {
    rgb(ACCENT)
}

pub fn hairline() -> Rgba {
    rgba(HAIRLINE)
}

pub fn border() -> Rgba {
    rgba(BORDER)
}

pub fn border_strong() -> Rgba {
    rgba(BORDER_STRONG)
}

fn rgba(value: u32) -> Rgba {
    gpui::rgba(value)
}

fn rgb(value: u32) -> Rgba {
    gpui::rgb(value)
}

// Typography scale: 24/32, 20/28, 16/24, 14/22, 13/20, 12/18, 11/14.
// Body content defaults to 14px with a 24px line box.
pub fn body_size() -> Pixels {
    px(14.)
}

pub fn body_line_height() -> Pixels {
    px(24.)
}

pub fn title_size() -> Pixels {
    px(20.)
}

pub fn heading_size() -> Pixels {
    px(16.)
}

pub fn meta_size() -> Pixels {
    px(13.)
}

pub fn micro_size() -> Pixels {
    px(11.)
}

// Radii: xs 4 / sm 8 / md 12 / lg 16 / xl 20 / panel 28.
pub fn radius_xs() -> Pixels {
    px(4.)
}

pub fn radius_sm() -> Pixels {
    px(8.)
}

pub fn radius_md() -> Pixels {
    px(12.)
}

pub fn radius_lg() -> Pixels {
    px(16.)
}

pub fn radius_xl() -> Pixels {
    px(20.)
}

pub fn radius_panel() -> Pixels {
    px(28.)
}

// Layout constants from the layout modules.
pub const SIDEBAR_DEFAULT: f32 = 280.;
pub const SIDEBAR_MIN: f32 = 264.;
pub const SIDEBAR_MAX: f32 = 420.;
pub const SIDEBAR_COLLAPSED: f32 = 56.;
pub const CENTER_MIN: f32 = 400.;
pub const TOP_STRIP_HEIGHT: f32 = 52.;
pub const LOGO_ROW_HEIGHT: f32 = 60.;
pub const NEW_SESSION_HEIGHT: f32 = 38.;
pub const LIST_ROW_HEIGHT: f32 = 36.;
pub const PROJECT_ROW_HEIGHT: f32 = 34.;
pub const SESSION_ROW_HEIGHT: f32 = 32.;
pub const HEADER_MIN_HEIGHT: f32 = 76.;
pub const CHAT_COLUMN_MIN: f32 = 680.;
pub const CHAT_COLUMN_MAX: f32 = 920.;
pub const CHAT_COLUMN_RATIO: f32 = 0.64;
pub const COMPOSER_MIN_HEIGHT: f32 = 36.;
