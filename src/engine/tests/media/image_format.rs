//! The media type of an image comes from its bytes; formats providers do
//! not accept are not images.

use evotengine::detect_image_mime_type;

fn png(chunks: &[(&[u8; 4], &[u8])]) -> Vec<u8> {
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    for (kind, body) in chunks {
        out.extend_from_slice(&(body.len() as u32).to_be_bytes());
        out.extend_from_slice(*kind);
        out.extend_from_slice(body);
        out.extend_from_slice(&[0, 0, 0, 0]);
    }
    out
}

#[test]
fn recognises_every_provider_format_by_header() {
    assert_eq!(
        detect_image_mime_type(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 16]),
        Some("image/jpeg")
    );
    assert_eq!(
        detect_image_mime_type(&png(&[(b"IHDR", &[0; 13]), (b"IDAT", &[])])),
        Some("image/png")
    );
    assert_eq!(
        detect_image_mime_type(b"GIF89a\x01\x00\x01\x00"),
        Some("image/gif")
    );
    assert_eq!(
        detect_image_mime_type(b"RIFF\x00\x00\x00\x00WEBPVP8 "),
        Some("image/webp")
    );
    let mut bmp = vec![0u8; 30];
    bmp[..2].copy_from_slice(b"BM");
    bmp[10..14].copy_from_slice(&54u32.to_le_bytes());
    bmp[14..18].copy_from_slice(&40u32.to_le_bytes());
    bmp[26..28].copy_from_slice(&1u16.to_le_bytes());
    bmp[28..30].copy_from_slice(&24u16.to_le_bytes());
    assert_eq!(detect_image_mime_type(&bmp), Some("image/bmp"));
}

#[test]
fn rejects_what_providers_cannot_decode() {
    assert_eq!(detect_image_mime_type(b""), None);
    assert_eq!(detect_image_mime_type(b"fake-jpeg-data"), None);
    assert_eq!(
        detect_image_mime_type(&[0xFF, 0xD8, 0xFF, 0xF7]),
        None,
        "JPEG-LS"
    );
    assert_eq!(
        detect_image_mime_type(&png(&[
            (b"IHDR", &[0; 13]),
            (b"acTL", &[0; 8]),
            (b"IDAT", &[])
        ])),
        None,
        "APNG"
    );
    assert_eq!(
        detect_image_mime_type(b"\x89PNG\r\n\x1a\nnot-a-chunk"),
        None,
        "PNG signature without IHDR"
    );
    assert_eq!(
        detect_image_mime_type(b"BMW is a car maker, not a bitmap."),
        None
    );
}
