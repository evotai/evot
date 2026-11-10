use base64::Engine;
use evotengine::resize_image;

#[test]
fn small_image_passthrough() {
    // 10×10 PNG — well within 2000×2000, should pass through unchanged
    let mut img = image::RgbImage::new(10, 10);
    for pixel in img.pixels_mut() {
        *pixel = image::Rgb([128, 128, 128]);
    }
    let mut buf = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(img)
        .write_to(&mut buf, image::ImageFormat::Png)
        .unwrap();
    let data = base64::engine::general_purpose::STANDARD.encode(buf.into_inner());

    let result = resize_image(&data, "image/png").unwrap();
    assert_eq!(result.0, data, "small image should pass through unchanged");
    assert_eq!(result.1, "image/png");
}

#[test]
fn oversize_image_resized() {
    // 3000×2000 black JPEG — should be resized to fit within 2000×2000
    let mut img = image::RgbImage::new(3000, 2000);
    for pixel in img.pixels_mut() {
        *pixel = image::Rgb([0, 0, 0]);
    }
    let mut buf = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(img)
        .write_to(&mut buf, image::ImageFormat::Jpeg)
        .unwrap();
    let data = base64::engine::general_purpose::STANDARD.encode(buf.into_inner());

    let (resized_data, mime) = resize_image(&data, "image/jpeg").unwrap();
    assert_eq!(mime, "image/jpeg", "resized image should be JPEG");

    // Decode to verify dimensions
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(&resized_data)
        .unwrap();
    let resized = image::load_from_memory(&decoded).unwrap();
    assert!(resized.width() <= 2000, "width should be <= 2000");
    assert!(resized.height() <= 2000, "height should be <= 2000");
    assert_eq!(resized.width(), 2000, "3000-wide should resize to 2000");
}

#[test]
fn invalid_base64_returns_error() {
    let result = resize_image("not-valid-base64!@#", "image/png");
    assert!(result.is_err());
}

#[test]
fn large_within_dimensions_gets_compressed() {
    // 1500×1500 noise PNG — fits dimensions but base64 will be >5MB
    // Should be compressed to JPEG q60 → under 5MB base64
    let mut img = image::RgbImage::new(1500, 1500);
    for pixel in img.pixels_mut() {
        *pixel = image::Rgb([
            rand::random::<u8>(),
            rand::random::<u8>(),
            rand::random::<u8>(),
        ]);
    }
    let mut buf = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(img)
        .write_to(&mut buf, image::ImageFormat::Png)
        .unwrap();
    let data = base64::engine::general_purpose::STANDARD.encode(buf.into_inner());
    assert!(
        data.len() > 5 * 1024 * 1024,
        "noise PNG should be >5MB base64"
    );

    let (compressed_data, mime) = resize_image(&data, "image/png").unwrap();
    assert_eq!(mime, "image/jpeg", "large PNG should become JPEG");
    assert!(
        compressed_data.len() <= 5 * 1024 * 1024,
        "compressed should be ≤5MB base64: was {}",
        compressed_data.len()
    );
}
