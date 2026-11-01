//! Checksums a rule names in `checksum.algorithm`. Each answers whether a
//! value's own check digits hold; none knows what kind of value it is.

pub(super) fn known(algorithm: &str) -> bool {
    algorithm == "crc32_base62"
}

pub(super) fn verify(algorithm: &str, value: &str) -> bool {
    known(algorithm) && crc32_base62(value)
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

/// Prefixed tokens whose last six characters are the base62 CRC32 of the
/// random part before them (the token format GitHub and npm publish).
fn crc32_base62(v: &str) -> bool {
    const B62: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let body = v.rsplit('_').next().unwrap_or(v);
    if body.len() < 12 || !body.is_ascii() {
        return false;
    }
    let (random, check) = body.split_at(body.len() - 6);
    let mut n = crc32(random.as_bytes());
    let mut digits = [b'0'; 6];
    for slot in digits.iter_mut().rev() {
        *slot = B62[(n % 62) as usize];
        n /= 62;
    }
    n == 0 && check.as_bytes() == digits
}
