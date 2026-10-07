//! Image format detection from bytes.
//!
//! The media type an image is sent with is decided by its bytes, never by a
//! file name or by what a sender declared: a `.png` downloaded from a chat is
//! often a JPEG, and Anthropic rejects the whole request when the declared
//! type and the data disagree. Mirrors pi's `detectSupportedImageMimeType`:
//! only formats providers accept are reported, and a PNG that is animated or
//! a BMP with an implausible header are not reported as images at all.

/// Bytes needed to classify an image; enough for PNG's `acTL` scan and BMP's DIB header.
pub const IMAGE_SNIFF_BYTES: usize = 4100;

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

/// The media type of `bytes` if they are an image a model provider accepts.
pub fn detect_image_mime_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        // FF D8 FF F7 is JPEG-LS, which no provider decodes.
        return (bytes.get(3) != Some(&0xF7)).then_some("image/jpeg");
    }
    if bytes.starts_with(PNG_SIGNATURE) {
        return (is_png(bytes) && !is_animated_png(bytes)).then_some("image/png");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(b"BM") && is_bmp(bytes) {
        return Some("image/bmp");
    }
    None
}

fn is_png(bytes: &[u8]) -> bool {
    bytes.len() >= 16 && u32_be(bytes, 8) == 13 && &bytes[12..16] == b"IHDR"
}

/// APNG carries an `acTL` chunk before the first `IDAT`.
fn is_animated_png(bytes: &[u8]) -> bool {
    let mut offset = PNG_SIGNATURE.len();
    while offset + 8 <= bytes.len() {
        let chunk_len = u32_be(bytes, offset) as usize;
        let chunk_type = &bytes[offset + 4..offset + 8];
        if chunk_type == b"acTL" {
            return true;
        }
        if chunk_type == b"IDAT" {
            return false;
        }
        let next = offset + 8 + chunk_len + 4;
        if next <= offset || next > bytes.len() {
            return false;
        }
        offset = next;
    }
    false
}

/// "BM" is two ASCII letters; check the header is a plausible bitmap before trusting it.
fn is_bmp(bytes: &[u8]) -> bool {
    if bytes.len() < 26 {
        return false;
    }
    let declared_size = u32_le(bytes, 2);
    let pixel_offset = u32_le(bytes, 10);
    let dib_size = u32_le(bytes, 14);
    if declared_size != 0 && declared_size < 26 {
        return false;
    }
    if pixel_offset < 14 + dib_size {
        return false;
    }
    if declared_size != 0 && pixel_offset >= declared_size {
        return false;
    }
    let (planes, bpp) = match dib_size {
        12 => (u16_le(bytes, 22), u16_le(bytes, 24)),
        40..=124 if bytes.len() >= 30 => (u16_le(bytes, 26), u16_le(bytes, 28)),
        _ => return false,
    };
    planes == 1 && matches!(bpp, 1 | 4 | 8 | 16 | 24 | 32)
}

fn u16_le(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}

fn u32_le(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn u32_be(b: &[u8], at: usize) -> u32 {
    u32::from_be_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}
