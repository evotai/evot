//! Checksums a rule names in `checksum.algorithm`. Each answers whether a
//! value's own check digits hold; none knows what kind of value it is.
use sha2::Digest;
use sha2::Sha256;

pub(super) fn known(algorithm: &str) -> bool {
    matches!(
        algorithm,
        "luhn" | "cn_id" | "iban" | "crc32_base62" | "bech32" | "base58check"
    )
}

pub(super) fn verify(algorithm: &str, value: &str) -> bool {
    match algorithm {
        "luhn" => luhn(value),
        "cn_id" => cn_id(value),
        "iban" => iban(value),
        "crc32_base62" => crc32_base62(value),
        "bech32" => bech32(value),
        "base58check" => base58check(value),
        _ => false,
    }
}

fn luhn(v: &str) -> bool {
    let digits: Vec<u32> = v.chars().filter_map(|c| c.to_digit(10)).collect();
    if digits.len() < 12 {
        return false;
    }
    let sum: u32 = digits
        .iter()
        .rev()
        .enumerate()
        .map(|(i, &d)| match (i % 2, d * 2) {
            (1, doubled) if doubled > 9 => doubled - 9,
            (1, doubled) => doubled,
            _ => d,
        })
        .sum();
    sum.is_multiple_of(10)
}

/// Mainland resident ID: ISO 7064 MOD 11-2 over 17 digits.
fn cn_id(v: &str) -> bool {
    const WEIGHTS: [u32; 17] = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
    let b = v.as_bytes();
    if b.len() != 18 || !b[..17].iter().all(u8::is_ascii_digit) {
        return false;
    }
    let sum: u32 = WEIGHTS
        .iter()
        .zip(b)
        .map(|(w, c)| w * u32::from(c - b'0'))
        .sum();
    b[17].to_ascii_uppercase() == b"10X98765432"[(sum % 11) as usize]
}

/// ISO 13616: the first four characters moved to the end, letters as
/// 10..35, the number mod 97 is 1.
fn iban(v: &str) -> bool {
    let chars: Vec<char> = v.chars().filter(|c| !c.is_whitespace()).collect();
    if !(15..=34).contains(&chars.len()) {
        return false;
    }
    let mut rem = 0u32;
    for c in chars[4..].iter().chain(&chars[..4]) {
        let Some(d) = c.to_digit(36) else {
            return false;
        };
        rem = if d >= 10 {
            (rem * 100 + d) % 97
        } else {
            (rem * 10 + d) % 97
        };
    }
    rem == 1
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

/// BIP-173 / BIP-350 addresses: bech32 or bech32m checksum.
fn bech32(v: &str) -> bool {
    const CHARSET: &[u8] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    let lower = v.to_ascii_lowercase();
    let Some(sep) = lower.rfind('1') else {
        return false;
    };
    let (hrp, data) = (&lower[..sep], &lower[sep + 1..]);
    if hrp.is_empty() || data.len() < 6 {
        return false;
    }
    let mut values: Vec<u32> = hrp.bytes().map(|c| u32::from(c >> 5)).collect();
    values.push(0);
    values.extend(hrp.bytes().map(|c| u32::from(c & 31)));
    for c in data.bytes() {
        match CHARSET.iter().position(|&x| x == c) {
            Some(i) => values.push(i as u32),
            None => return false,
        }
    }
    const GEN: [u32; 5] = [
        0x3b6a_57b2,
        0x2650_8e6d,
        0x1ea1_19fa,
        0x3d42_33dd,
        0x2a14_62b3,
    ];
    let mut chk = 1u32;
    for value in values {
        let top = chk >> 25;
        chk = ((chk & 0x1ff_ffff) << 5) ^ value;
        for (i, g) in GEN.iter().enumerate() {
            if (top >> i) & 1 == 1 {
                chk ^= g;
            }
        }
    }
    chk == 1 || chk == 0x2bc8_30a3
}

/// Base58 with a double-SHA-256 checksum in its last four bytes.
fn base58check(v: &str) -> bool {
    const B58: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut bytes: Vec<u8> = Vec::new();
    for c in v.bytes() {
        let Some(mut carry) = B58.iter().position(|&x| x == c).map(|i| i as u32) else {
            return false;
        };
        for byte in bytes.iter_mut() {
            carry += u32::from(*byte) * 58;
            *byte = (carry & 0xff) as u8;
            carry >>= 8;
        }
        while carry > 0 {
            bytes.push((carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    bytes.extend(v.bytes().take_while(|&c| c == b'1').map(|_| 0));
    bytes.reverse();
    if bytes.len() < 5 {
        return false;
    }
    let (payload, check) = bytes.split_at(bytes.len() - 4);
    let hash = Sha256::digest(Sha256::digest(payload));
    hash[..4] == *check
}
