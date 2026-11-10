//! Image sniffing and resizing, independent of context management.

pub mod image_format;
pub mod image_resize;

pub use image_format::detect_image_mime_type;
pub use image_format::IMAGE_SNIFF_BYTES;
pub use image_resize::resize_image;
